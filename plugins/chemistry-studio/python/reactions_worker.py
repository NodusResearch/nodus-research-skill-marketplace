"""Reaction lookup against a local Open Reaction Database index.

Reads one JSON request from stdin and writes one JSON result to stdout:

    {"indexDir": "/path", "reactions": ["r>>p", ...], "products": ["...", ...],
     "similar": ["r>>p", ...]}

    -> {"reactions": [{"input", "key", "count", "samples"}],
        "products":  [{"input", "key", "count", "keys"}],
        "similar":   [{"input", "neighbors": [{"key", "distance", "count"}]}]}

`--check` prints the toolchain versions and exits, so the host can confirm the runtime
before trusting it. Canonicalisation and the DRFP fingerprint match the offline builder
(tools/reaction-index) exactly; nothing is resolved from a network at query time.
"""

import hashlib
import json
import os
import sys

INDEX_FILES = (
    "exact.tsv.zst",
    "products.tsv.zst",
    "reactions.faiss.zst",
    "reaction-keys.txt.zst",
)

_stores = {}


def _versions():
    import faiss
    import numpy
    import rdkit
    import zstandard

    return {
        "ok": True,
        "rdkit": rdkit.__version__,
        "numpy": numpy.__version__,
        "faiss": faiss.__version__,
        "zstandard": zstandard.__version__,
    }


def _load(index_dir):
    """Load the index once per process. Each worker invocation is a fresh process, so this
    runs per call; the caller batches its lookups into one request to amortise it."""
    if index_dir in _stores:
        return _stores[index_dir]
    import zstandard as zstd

    missing = [name for name in INDEX_FILES if not os.path.isfile(os.path.join(index_dir, name))]
    if missing:
        raise SystemExit(f"the reaction index is missing {', '.join(missing)}")

    def read_text(name):
        with open(os.path.join(index_dir, name), "rb") as fh:
            return zstd.ZstdDecompressor().stream_reader(fh).read().decode()

    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")

    exact = {}
    for line in read_text("exact.tsv.zst").splitlines():
        key, count, *_ = line.split("\t")
        exact[key] = int(count)

    products = {}
    for line in read_text("products.tsv.zst").splitlines():
        key, count, ids = line.split("\t")
        products[key] = {"count": int(count), "keys": ids.split(",") if ids else []}

    keys = read_text("reaction-keys.txt.zst").splitlines()

    import faiss
    import numpy as np

    with open(os.path.join(index_dir, "reactions.faiss.zst"), "rb") as fh:
        blob = zstd.ZstdDecompressor().stream_reader(fh).read()
    index = faiss.deserialize_index_binary(np.frombuffer(blob, dtype=np.uint8))

    store = {"exact": exact, "products": products, "keys": keys, "index": index}
    _stores[index_dir] = store
    return store


def _canon(smiles):
    from rdkit import Chem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    for atom in mol.GetAtoms():
        atom.SetAtomMapNum(0)
    return Chem.MolToSmiles(mol)


def _side(side):
    cans = []
    for frag in side.split("."):
        c = _canon(frag)
        if c and c not in ("[H]", "[H+]"):
            cans.append(c)
    return ".".join(sorted(cans)) if cans else None


def _exact_key(reaction):
    reactants, _, products = reaction.partition(">>")
    rk, pk = _side(reactants), _side(products)
    if not rk or not pk:
        return None
    return hashlib.sha1(f"{rk}>>{pk}".encode()).hexdigest()[:32]


def _canonical_reaction(reaction):
    reactants, _, products = reaction.partition(">>")
    rk, pk = _side(reactants), _side(products)
    if not rk or not pk:
        return None
    return f"{rk}>>{pk}"


def _similar(store, reaction, k=5):
    from drfp import DrfpEncoder
    import numpy as np

    canonical = _canonical_reaction(reaction)
    if canonical is None:
        return []
    fp = DrfpEncoder.encode([canonical], n_folded_length=1024)[0]
    vec = np.packbits(np.asarray(fp, dtype=np.uint8)).reshape(1, -1)
    distance, index = store["index"].search(vec, k)
    out = []
    for dist, i in zip(distance[0], index[0]):
        if i < 0:
            continue
        key = store["keys"][i]
        out.append({"key": key, "distance": int(dist), "count": store["exact"].get(key, 0)})
    return out


def handle(request):
    index_dir = request.get("indexDir")
    if not isinstance(index_dir, str) or not index_dir:
        raise SystemExit("indexDir is required")
    store = _load(index_dir)

    reactions = []
    for reaction in request.get("reactions", [])[:32]:
        key = _exact_key(reaction)
        reactions.append({
            "input": reaction,
            "key": key,
            "count": store["exact"].get(key, 0) if key else 0,
        })

    products = []
    for product in request.get("products", [])[:32]:
        key = _side(product)
        entry = store["products"].get(key) if key else None
        products.append({
            "input": product,
            "key": key,
            "count": entry["count"] if entry else 0,
            "keys": entry["keys"] if entry else [],
        })

    similar = []
    for reaction in request.get("similar", [])[:16]:
        similar.append({"input": reaction, "neighbors": _similar(store, reaction)})

    return {"reactions": reactions, "products": products, "similar": similar}


def main():
    if "--check" in sys.argv[1:]:
        print(json.dumps(_versions()))
        return
    request = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(handle(request)))


if __name__ == "__main__":
    main()
