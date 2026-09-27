"""Reaction lookup against a local Open Reaction Database index.

Reads one JSON request from stdin and writes one JSON result to stdout:

    {"indexDir": "/path", "reactions": ["r>>p" | "r>agents>p", ...], "products": ["...", ...],
     "similar": ["r>>p" | "r>agents>p", ...]}

    -> {"reactions": [{"input", "key", "count", "form"?, "unchanged"?, "samples"?, "reaction"?}],
        "products":  [{"input", "key", "count", "keys"}],
        "similar":   [{"input", "neighbors": [{"key", "distance", "count", "similarity"?,
                                               "reaction"?, "svg"?}], "unchanged"?}]}

"samples" are Open Reaction Database ids of the matched reaction. "similarity" is the Tanimoto
coefficient of the two reaction fingerprints (1.0 = the same bond changes). "reaction" is the
index's representative SMILES for that reaction, present when the index ships
reaction-smiles.tsv.zst (format 3); an older index simply leaves it out. For a step with no exact
match, the closest neighbour that has a SMILES also carries "svg": an RDKit drawing of the reaction
exactly as recorded. Database records routinely omit byproducts and counter-ions, so it is drawn
unbalanced, as listed, and nothing is inferred; the application labels it as such.

Agents never enter a key, as in the builder. A step is matched in the first of these forms that
the index knows ("form" names it): as written; with only the organic reactants (dropping the bases,
salts, CO2 and H2 that ORD usually records as reagents); with the agents counted as reactants; and
each of those again against only the organic products (inorganic co-products not marked as such). A step whose
products all appear among its reactants (a purification or salt step) is "unchanged": it has no
key and no fingerprint, so it is neither matched nor searched.

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

    exact, samples = {}, {}
    for line in read_text("exact.tsv.zst").splitlines():
        key, count, *rest = line.split("\t")
        exact[key] = int(count)
        if rest and rest[0]:
            samples[key] = rest[0]

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

    store = {"exact": exact, "samples": samples, "products": products, "keys": keys, "index": index,
             "smiles_path": os.path.join(index_dir, "reaction-smiles.tsv.zst")}
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


def _split(reaction):
    """"r>>p" or "r>agents>p" -> (reactants, agents, products); agents may be empty."""
    parts = reaction.split(">")
    if len(parts) < 3:
        return None, None, None
    return parts[0], parts[1], ">".join(parts[2:])


def _is_organic(smiles):
    """A carbon bearing hydrogen: keeps substrates, drops bases, salts, CO2, carbonate, H2."""
    from rdkit import Chem

    mol = Chem.MolFromSmiles(smiles)
    return mol is not None and any(atom.GetAtomicNum() == 6 and atom.GetTotalNumHs() > 0 for atom in mol.GetAtoms())


def _organic_side(side):
    return _side(".".join(fragment for fragment in side.split(".") if _is_organic(fragment)))


def _unchanged(rk, pk):
    return set(pk.split(".")) <= set(rk.split("."))


def _sides(reaction):
    """Canonical (reactants, products) keys of a step, or (None, None)."""
    reactants, _, products = _split(reaction)
    return _side(reactants or ""), _side(products or "")


def _is_unchanged(reaction):
    rk, pk = _sides(reaction)
    return bool(rk and pk and _unchanged(rk, pk))


def _key(rk, pk):
    return hashlib.sha1(f"{rk}>>{pk}".encode()).hexdigest()[:32]


def _exact(store, reaction):
    """The first form of the step the index knows, as (key, count, form, unchanged)."""
    reactants, agents, _ = _split(reaction)
    rk, pk = _sides(reaction)
    if not rk or not pk:
        return None, 0, None, False
    if _unchanged(rk, pk):
        return None, 0, None, True
    sides = [("as-written", rk)]
    organic = _organic_side(rk)
    if organic and organic != rk:
        sides.append(("organic-reactants", organic))
    with_agents = _side(".".join(filter(None, [reactants, agents])))
    if with_agents and with_agents != rk:
        sides.append(("agents-as-reactants", with_agents))
    outcomes = [("", pk)]
    organic_products = _organic_side(pk)
    if organic_products and organic_products != pk:
        outcomes.append(("organic-products", organic_products))
    for product_form, product_side in outcomes:
        for form, side in sides:
            key = _key(side, product_side)
            count = store["exact"].get(key, 0)
            if count:
                return key, count, "+".join(filter(None, [form, product_form])), False
    return _key(rk, pk), 0, None, False


def _canonical_reaction(reaction):
    rk, pk = _sides(reaction)
    if not rk or not pk or _unchanged(rk, pk):
        return None
    return f"{rk}>>{pk}"


def _similar(store, reaction, k=5):
    from drfp import DrfpEncoder
    import numpy as np

    canonical = _canonical_reaction(reaction)
    if canonical is None:
        return []
    fp = DrfpEncoder.encode([canonical], n_folded_length=1024)[0]
    if not np.any(fp):
        # No structural change to compare: every neighbour would be arbitrary.
        return []
    vec = np.packbits(np.asarray(fp, dtype=np.uint8)).reshape(1, -1)
    distance, index = store["index"].search(vec, k)
    query_bits = int(np.count_nonzero(fp))
    out = []
    for dist, i in zip(distance[0], index[0]):
        if i < 0:
            continue
        key = store["keys"][i]
        neighbor = {"key": key, "distance": int(dist), "count": store["exact"].get(key, 0)}
        similarity = _tanimoto(store["index"], int(i), query_bits, int(dist))
        if similarity is not None:
            neighbor["similarity"] = similarity
        out.append(neighbor)
    # Equal bit distances can hide different overlaps: rank by similarity, closest first.
    out.sort(key=lambda n: (-n.get("similarity", 0.0), n["distance"]))
    return out


def _tanimoto(index, row, query_bits, distance):
    """|A∩B| / |A∪B| from the two popcounts and their Hamming distance."""
    import numpy as np

    try:
        stored = index.reconstruct(row)
    except Exception:
        return None
    total = query_bits + int(np.unpackbits(np.asarray(stored, dtype=np.uint8)).sum())
    if total + distance == 0:
        return None
    return round((total - distance) / (total + distance), 3)


def _draw_recorded(reaction):
    """An SVG of a recorded reaction, species as listed and unbalanced, or None."""
    from rdkit.Chem import rdChemReactions
    from rdkit.Chem.Draw import rdMolDraw2D

    try:
        rxn = rdChemReactions.ReactionFromSmarts(reaction, useSmiles=True)
        species = rxn.GetNumReactantTemplates() + rxn.GetNumProductTemplates()
        drawer = rdMolDraw2D.MolDraw2DSVG(min(1600, 260 * max(species, 2)), 260)
        drawer.drawOptions().clearBackground = False
        drawer.DrawReaction(rxn)
        drawer.FinishDrawing()
        svg = drawer.GetDrawingText()
    except Exception:
        return None
    start = svg.find("<svg")
    return svg[start:] if start >= 0 else None


def _reaction_smiles(store, keys):
    """The representative SMILES of each wanted key, streamed from the optional SMILES file
    (a fresh process per call, so the 1.4M-row table is never held in memory)."""
    wanted = {key for key in keys if key}
    if not wanted or not os.path.isfile(store["smiles_path"]):
        return {}
    import io
    import zstandard as zstd

    found = {}
    with open(store["smiles_path"], "rb") as fh:
        text = io.TextIOWrapper(zstd.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        for line in text:
            key = line[:32]
            if key in wanted:
                found[key] = line[33:].rstrip("\n")
                if len(found) == len(wanted):
                    break
    return found


def handle(request):
    index_dir = request.get("indexDir")
    if not isinstance(index_dir, str) or not index_dir:
        raise SystemExit("indexDir is required")
    store = _load(index_dir)

    reactions = []
    for reaction in request.get("reactions", [])[:32]:
        key, count, form, unchanged = _exact(store, reaction)
        entry = {"input": reaction, "key": key, "count": count}
        if form:
            entry["form"] = form
        if unchanged:
            entry["unchanged"] = True
        reactions.append(entry)

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
        item = {"input": reaction, "neighbors": _similar(store, reaction)}
        if _is_unchanged(reaction):
            item["unchanged"] = True
        similar.append(item)

    matched = [entry["key"] for entry in reactions if entry["count"]]
    near = [neighbor["key"] for item in similar for neighbor in item["neighbors"]]
    drawn = _reaction_smiles(store, matched + near)
    for entry in reactions:
        if entry["count"] and entry["key"] in store["samples"]:
            entry["samples"] = store["samples"][entry["key"]].split(",")[:3]
        if entry["count"] and entry["key"] in drawn:
            entry["reaction"] = drawn[entry["key"]]
    exact_inputs = {entry["input"] for entry in reactions if entry["count"]}
    for item in similar:
        for neighbor in item["neighbors"]:
            if neighbor["key"] in drawn:
                neighbor["reaction"] = drawn[neighbor["key"]]
        # Only a step with no exact match is illustrated: an exact match is the step itself.
        if item["input"] in exact_inputs:
            continue
        for neighbor in item["neighbors"]:
            if "reaction" in neighbor:
                svg = _draw_recorded(neighbor["reaction"])
                if svg:
                    neighbor["svg"] = svg
                break

    return {"reactions": reactions, "products": products, "similar": similar}


def main():
    if "--check" in sys.argv[1:]:
        print(json.dumps(_versions()))
        return
    request = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(handle(request)))


if __name__ == "__main__":
    main()
