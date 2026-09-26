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


# ---------------------------------------------------------------- reaction classes

# Functional-group SMARTS counted on each side of a step. A class is named from how the counts
# change, so textbook search can ask for "Fischer esterification" rather than a reaction SMILES.
_GROUPS = {
    "nitro": "[N+](=O)[O-]",
    "arylamine": "c[NX3;H2,H1;!$(NC=O)]",
    "amine": "[NX3;H2,H1,H0;!$(NC=O);!$(N-[N+](=O)[O-]);!$(N=*);!$(N#*);!$(N-a)]",
    "acid": "[CX3](=O)[OX2H1]",
    "ester": "[#6][CX3](=O)[OX2][#6;!$(C=O)]",
    "benzylic_methyl": "c[CH3]",
    "amide": "[CX3](=O)[NX3]",
    "acyl_halide": "[CX3](=O)[Cl,Br]",
    "anhydride": "[CX3](=O)O[CX3](=O)",
    "aldehyde": "[CX3H1](=O)[#6]",
    "ketone": "[#6][CX3](=O)[#6]",
    "alcohol": "[CX4][OX2H]",
    "phenol": "c[OX2H]",
    "aryl_halide": "c[F,Cl,Br,I]",
    "alkyl_halide": "[CX4][Cl,Br,I]",
    "nitrile": "C#N",
    "alkene": "[CX3]=[CX3]",
    "alkyne": "C#C",
    "boron": "[B]",
    "biaryl": "c-c",
    "aryl_ketone": "c[CX3](=O)[#6]",
    "oxime": "[CX3]=N[OX2H]",
    "diazonium": "[N+]#N",
    "phosphonium": "[P+]",
    "magnesium": "[Mg]",
    "sulfonyl_chloride": "S(=O)(=O)Cl",
    "sulfonamide": "S(=O)(=O)N",
    "ether": "[#6][OX2][#6;!$(C=O)]",
}
_group_queries = {}


def _counts(smiles):
    from rdkit import Chem

    if not _group_queries:
        for name, smarts in _GROUPS.items():
            _group_queries[name] = Chem.MolFromSmarts(smarts)
    counts = dict.fromkeys(_GROUPS, 0)
    for part in smiles.split("."):
        mol = Chem.MolFromSmiles(part)
        if mol is None:
            continue
        for name, query in _group_queries.items():
            counts[name] += len(mol.GetSubstructMatches(query))
    return counts


def _reaction_classes(precursors, product):
    """Named reaction classes for a step, from functional-group changes (heuristic, for search terms)."""
    before, after = _counts(precursors), _counts(product)
    up = lambda g: after[g] > before[g]
    down = lambda g: after[g] < before[g]
    ring_count = lambda smiles: sum(1 for c in smiles if c.isdigit())
    molecules = [m for m in precursors.split(".") if m]
    single = len(molecules) == 1
    classes = []
    if down("nitro") and (up("arylamine") or up("amine")): classes.append("nitro group reduction to amine")
    if up("nitro") and not down("nitro"): classes.append("aromatic nitration")
    if up("ester") and before["acid"] and not before["acyl_halide"] and not before["anhydride"]: classes.append("Fischer esterification")
    if up("ester") and (before["acyl_halide"] or before["anhydride"]): classes.append("acylation of an alcohol or phenol")
    if up("amide") and (before["acyl_halide"] or before["anhydride"] or before["ester"] or before["acid"]): classes.append("amide formation by acylation of an amine")
    if down("ester") and (up("acid") or up("alcohol") or up("ketone")): classes.append("ester hydrolysis")
    if down("amide") and (up("arylamine") or up("amine")): classes.append("amide hydrolysis (deprotection of an acetamide)")
    if up("acid") and down("nitrile"): classes.append("nitrile hydrolysis")
    if up("acyl_halide") and before["acid"]: classes.append("acid chloride formation with thionyl chloride")
    if up("acid") and before["phenol"] and after["phenol"]: classes.append("Kolbe-Schmitt carboxylation of a phenol")
    elif up("acid") and not down("ester") and not down("nitrile") and not down("ketone") and (before["alcohol"] or before["aldehyde"] or down("benzylic_methyl")): classes.append("oxidation to a carboxylic acid")
    if up("aldehyde") or (up("ketone") and down("alcohol")): classes.append("oxidation of an alcohol")
    if up("alcohol") and (down("ketone") or down("aldehyde")): classes.append("reduction of a carbonyl compound")
    if up("biaryl") and before["boron"]: classes.append("Suzuki cross-coupling")
    if down("aryl_halide") and (up("arylamine") or up("amine") or up("ether")) and before["nitro"]: classes.append("nucleophilic aromatic substitution")
    if up("aryl_ketone") and not down("alcohol"): classes.append("Friedel-Crafts acylation")
    if up("aryl_halide") or (up("alkyl_halide") and not before["alcohol"]): classes.append("halogenation")
    if up("alkyl_halide") and down("alcohol"): classes.append("conversion of an alcohol to an alkyl halide")
    if down("alkyl_halide") and (up("ether") or up("amine") or up("nitrile") or up("ester")): classes.append("SN2 alkylation")
    if before["magnesium"]: classes.append("Grignard reaction")
    if before["phosphonium"] or "P(" in precursors and up("alkene"): classes.append("Wittig reaction")
    if before["diazonium"] or (down("arylamine") and (up("aryl_halide") or up("phenol"))): classes.append("diazonium salt substitution (Sandmeyer)")
    if down("alkyne") and up("alkene"): classes.append("partial hydrogenation of an alkyne")
    if down("alkene") and not up("alkene") and single: classes.append("hydrogenation of an alkene")
    if down("alkene") and before["ketone"] and not single: classes.append("Michael addition")
    if before["alkyne"] and before["alkyl_halide"] and down("alkyl_halide"): classes.append("alkylation of an acetylide")
    if before["ester"] and before["alkyl_halide"] and down("alkyl_halide") and not up("ether"): classes.append("enolate alkylation (malonic or acetoacetic ester synthesis)")
    if up("alkene") and down("ketone") and ring_count(product) > ring_count(precursors): classes.append("intramolecular aldol condensation (Robinson annulation)")
    if before["aldehyde"] and single is False and up("ketone") and up("alcohol") and not after["aldehyde"]: classes.append("benzoin condensation")
    if before["ketone"] >= 2 and up("acid") and up("alcohol"): classes.append("benzilic acid rearrangement")
    if up("oxime"): classes.append("oxime formation")
    if before["oxime"] and up("amide"): classes.append("Beckmann rearrangement")
    if down("acid") and after["acid"] >= 0 and "O=C=O" not in precursors and before["acid"] >= 2: classes.append("decarboxylation")
    if up("sulfonyl_chloride"): classes.append("chlorosulfonation")
    if up("sulfonamide") and before["sulfonyl_chloride"]: classes.append("sulfonamide formation")
    if ring_count(product) > ring_count(precursors) and before["alkene"] >= 2: classes.append("Diels-Alder cycloaddition")
    if not classes and single:
        from rdkit.Chem.rdMolDescriptors import CalcMolFormula
        from rdkit import Chem

        a, b = Chem.MolFromSmiles(precursors), Chem.MolFromSmiles(product)
        if a is not None and b is not None and CalcMolFormula(a) == CalcMolFormula(b):
            classes.append("rearrangement or isomerization")
    seen, out = set(), []
    for name in classes:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out[:3]


# ---------------------------------------------------------------- one-step disconnections

# A precursor used this often in ORD counts as readily available (a proxy for buyable).
AVAILABLE_AS_REACTANT = 50


def _zst_lines(path):
    import io
    import zstandard as zstd

    with open(path, "rb") as fh:
        for line in io.TextIOWrapper(zstd.ZstdDecompressor().stream_reader(fh), encoding="utf-8"):
            yield line.rstrip("\n")


def _scan(path, wanted, width=None):
    """Rows of a sorted-by-key tsv whose first field is wanted, streamed (no full table in memory)."""
    found = {}
    if not wanted:
        return found
    for line in _zst_lines(path):
        tab = line.find("\t")
        key = line[:tab] if tab >= 0 else line
        if key in wanted:
            found[key] = line.split("\t")
            if len(found) == len(wanted):
                break
    return found


_block_cache = {}


def _lookup(path, wanted):
    """Rows whose first field is wanted. With a `<path>.blocks` index (a sorted table written as
    independent zstd frames), only the frames that can hold a wanted key are read: milliseconds
    instead of a full scan. Without one, the table is streamed."""
    import bisect

    wanted = set(wanted)
    if not wanted:
        return {}
    blocks_path = path + ".blocks"
    if not os.path.isfile(blocks_path):
        return _scan(path, wanted)
    if path not in _block_cache:
        firsts, spans = [], []
        with open(blocks_path, encoding="utf-8") as fh:
            for line in fh:
                first, offset, length = line.rstrip("\n").split("\t")
                firsts.append(first)
                spans.append((int(offset), int(length)))
        _block_cache[path] = (firsts, spans)
    firsts, spans = _block_cache[path]
    import zstandard as zstd

    by_block = {}
    for key in wanted:
        index = bisect.bisect_right(firsts, key) - 1
        if index >= 0:
            by_block.setdefault(index, set()).add(key)
    found = {}
    decompressor = zstd.ZstdDecompressor()
    with open(path, "rb") as fh:
        for index, keys in by_block.items():
            offset, length = spans[index]
            fh.seek(offset)
            for line in decompressor.decompress(fh.read(length)).decode("utf-8").splitlines():
                tab = line.find("\t")
                key = line[:tab] if tab >= 0 else line
                if key in keys:
                    found[key] = line.split("\t")
    return found


_retro_cache = {}


def _retro_templates(index_dir):
    """The shipped retro templates with their product-side screen query, parsed once per process."""
    if index_dir in _retro_cache:
        return _retro_cache[index_dir]
    from rdkit import Chem

    rows = []
    for line in _zst_lines(os.path.join(index_dir, "retro-templates.tsv.zst")):
        count, rdchiral, smarts = line.split("\t", 2)
        query = Chem.MolFromSmarts(smarts.split(">>")[0])
        if query is not None:
            rows.append((int(count), int(rdchiral), smarts, query))
    _retro_cache[index_dir] = rows
    return rows


def _makes(reaction, target):
    """Whether a recorded reaction genuinely makes the target: the target is not already among
    its reactants (a salt formation or purification) and is one of at most two organic products
    (not a mixture record)."""
    reactants, _, products = reaction.partition(">>")
    if target in reactants.split("."):
        return False
    organic = [m for m in products.split(".") if _is_organic(m)]
    return target in organic and len(organic) <= 2


def _disconnect(index_dir, targets, limit, starting=()):
    """For each target: the recorded reactions that make it, and template disconnections ranked by
    (1) the disconnection itself being a recorded reaction, (2) every organic precursor being a
    common ORD reactant, (3) template popularity. A precursor set containing the target is dropped.
    With starting materials (a route's declared inputs), a proposal made only from them ranks first
    among the unrecorded ones, then proposals whose precursors most resemble them."""
    from rdkit import Chem
    from rdkit.Chem import AllChem, DataStructs

    def fingerprint(smiles):
        mol = Chem.MolFromSmiles(smiles)
        return AllChem.GetMorganFingerprintAsBitVect(mol, 2, 2048) if mol is not None else None

    starts = {c for c in (_canon(s) for s in starting) if c}
    start_fps = [f for f in (fingerprint(s) for s in starts) if f is not None]

    try:
        from rdchiral.main import rdchiralReaction, rdchiralReactants, rdchiralRun
    except ImportError:
        rdchiralReaction = None
    templates = _retro_templates(index_dir) if rdchiralReaction else []
    results = []
    for raw in targets:
        target = _canon(raw)
        entry = {"input": raw, "target": target, "madeBy": None, "proposals": []}
        if not target:
            results.append(entry)
            continue
        mol = Chem.MolFromSmiles(target)
        proposals = {}
        if mol is not None and templates:
            reactants = rdchiralReactants(target)
            for count, rdchiral, smarts, query in templates:
                if not mol.HasSubstructMatch(query):
                    continue
                try:
                    outcomes = rdchiralRun(rdchiralReaction(smarts), reactants)
                except Exception:
                    continue
                for outcome in outcomes:
                    side = _side(outcome)
                    if not side or target in side.split("."):
                        continue
                    best = proposals.get(side)
                    proposals[side] = {"precursors": side, "templateCount": (best or {}).get("templateCount", 0) + count,
                                       "rdchiral": max((best or {}).get("rdchiral", 0), rdchiral)}
        entry["_proposals"] = proposals
        results.append(entry)

    # One streamed pass per file for every molecule and reaction key the proposals need.
    molecules = {entry["target"] for entry in results if entry["target"]}
    for entry in results:
        for side in entry.get("_proposals", {}):
            molecules.update(side.split("."))
    rows = _lookup(os.path.join(index_dir, "molecules.tsv.zst"), molecules)
    keys = set()
    for entry in results:
        for side in entry.get("_proposals", {}):
            keys.add(_key(side, entry["target"]))
        made = rows.get(entry["target"]) if entry["target"] else None
        if made and len(made) > 3 and made[3]:
            keys.update(made[3].split(","))
    exact = _lookup(os.path.join(index_dir, "exact.tsv.zst"), keys)
    smiles = _lookup(os.path.join(index_dir, "reaction-smiles.tsv.zst"), keys)

    extra = set()
    for key, row in smiles.items():
        extra.update(m for m in row[1].split(">>")[0].split(".") if m and m not in rows)
    rows.update(_lookup(os.path.join(index_dir, "molecules.tsv.zst"), extra))

    def as_reactant(molecule):
        row = rows.get(molecule)
        return int(row[1]) if row else 0

    for entry in results:
        proposals = entry.pop("_proposals", {})
        made = rows.get(entry["target"]) if entry["target"] else None
        if made:
            recorded = []
            for key in (made[3].split(",") if len(made) > 3 and made[3] else []):
                reaction = smiles[key][1] if key in smiles else None
                if not reaction or not _makes(reaction, entry["target"]):
                    continue
                row = exact.get(key)
                recorded.append({"key": key, "count": int(row[1]) if row else 0,
                                 "samples": (row[2].split(",")[:3] if row and len(row) > 2 and row[2] else []),
                                 "reaction": reaction,
                                 "uses": {m: as_reactant(m) for m in reaction.split(">>")[0].split(".") if _is_organic(m)}})
            recorded.sort(key=lambda r: -r["count"])
            entry["madeBy"] = {"count": int(made[2]), "asReactant": int(made[1]), "reactions": recorded[:limit]}
        ranked = []
        for side, proposal in proposals.items():
            row = exact.get(_key(side, entry["target"]))
            organic = [m for m in side.split(".") if _is_organic(m)]
            availability = min((as_reactant(m) for m in organic), default=0)
            ranked.append({
                **proposal,
                "recorded": int(row[1]) if row else 0,
                "samples": (row[2].split(",")[:3] if row and len(row) > 2 and row[2] else []),
                "availability": availability,
                "available": bool(organic) and availability >= AVAILABLE_AS_REACTANT,
                "uses": {m: as_reactant(m) for m in organic},
                "classes": _reaction_classes(side, entry["target"]),
            })
        if starts:
            for proposal in ranked:
                organic = [m for m in proposal["precursors"].split(".") if _is_organic(m)]
                proposal["fromStarts"] = bool(organic) and all(m in starts or (as_reactant(m) >= AVAILABLE_AS_REACTANT and Chem.MolFromSmiles(m).GetNumHeavyAtoms() <= 6) for m in organic)
                similarities = [max(DataStructs.BulkTanimotoSimilarity(fp, start_fps)) for fp in (fingerprint(m) for m in organic) if fp is not None]
                proposal["startSimilarity"] = round(max(similarities, default=0.0), 3)
            ranked.sort(key=lambda p: (-(p["recorded"] > 0), -p["fromStarts"], -p["startSimilarity"], -p["available"], -p["templateCount"]))
        else:
            ranked.sort(key=lambda p: (-(p["recorded"] > 0), -p["available"], -p["recorded"], -p["templateCount"]))
        entry["proposals"] = ranked[:limit]
        entry["proposalsConsidered"] = len(ranked)
    return results


# ---------------------------------------------------------------- multi-step route search

# A small (at most this many heavy atoms), commonly used organic counts as a routine reagent.
ROUTINE_REAGENT_ATOMS = 6
ROUTINE_REAGENT_USES = 500


def _search_routes(index_dir, target, starting, max_steps=4, expansions=40, branch=4, keep=3):
    """Best-first backward search from the target to the starting materials. A molecule is expanded
    into its recorded ORD reactions (filtered) and its top template disconnections; a recorded step
    costs less than a template step, and precursors resembling the starting materials cost less. A
    route is complete when every molecule left is a starting material, inorganic, or a routine
    reagent. Returns the cheapest complete routes, each step labelled recorded or template."""
    import heapq
    from rdkit import Chem

    target = _canon(target)
    starts = {c for c in (_canon(s) for s in starting) if c}
    if not target:
        return {"target": None, "routes": [], "expanded": 0}
    cache, heavy = {}, {}

    def atoms(m):
        if m not in heavy:
            mol = Chem.MolFromSmiles(m)
            heavy[m] = mol.GetNumHeavyAtoms() if mol is not None else 99
        return heavy[m]

    def lookup(m):
        if m not in cache:
            cache[m] = _disconnect(index_dir, [m], branch * 3, sorted(starts))[0]
        return cache[m]

    def free(m, uses):
        return m in starts or not _is_organic(m) or (atoms(m) <= ROUTINE_REAGENT_ATOMS and uses.get(m, 0) >= ROUTINE_REAGENT_USES)

    uses = {}

    def options(m):
        entry = lookup(m)
        for reaction in (entry.get("madeBy") or {}).get("reactions", []):
            uses.update(reaction.get("uses", {}))
        for proposal in entry.get("proposals", []):
            uses.update(proposal.get("uses", {}))
        out, seen = [], set()
        for reaction in (entry.get("madeBy") or {}).get("reactions", [])[:branch]:
            precursors = sorted({x for x in reaction["reaction"].split(">>")[0].split(".") if _is_organic(x) and x != m})
            if precursors and tuple(precursors) not in seen:
                seen.add(tuple(precursors))
                out.append({"precursors": precursors, "recorded": reaction["count"], "samples": reaction["samples"], "kind": "recorded", "cost": 1.0})
        for proposal in entry.get("proposals", [])[:branch]:
            precursors = sorted({x for x in proposal["precursors"].split(".") if _is_organic(x)})
            if precursors and tuple(precursors) not in seen:
                seen.add(tuple(precursors))
                cost = 1.0 if proposal["recorded"] else 1.6 - 0.5 * proposal.get("startSimilarity", 0.0)
                out.append({"precursors": precursors, "recorded": proposal["recorded"], "samples": proposal["samples"],
                            "kind": "recorded" if proposal["recorded"] else "template", "templateCount": proposal["templateCount"], "cost": cost})
        return out

    counter = 0
    heap = [(0.0, counter, (target,), ())]
    done, expanded, seen_states = [], 0, set()
    while heap and expanded < expansions and len(done) < keep:
        cost, _, open_set, steps = heapq.heappop(heap)
        pending = [m for m in open_set if not free(m, uses)]
        if not pending:
            done.append({"cost": round(cost, 2), "steps": list(reversed(steps))})
            continue
        if len(steps) >= max_steps:
            continue
        # Expand the most complex molecule still to be made.
        m = max(pending, key=atoms)
        expanded += 1
        for option in options(m):
            rest = tuple(sorted(set(open_set) - {m} | set(option["precursors"])))
            state = (rest, len(steps) + 1)
            if state in seen_states or m in option["precursors"]:
                continue
            seen_states.add(state)
            step = {"product": m, **{k: v for k, v in option.items() if k != "cost"}}
            counter += 1
            heapq.heappush(heap, (cost + option["cost"], counter, rest, steps + (step,)))
    return {"target": target, "routes": done, "expanded": expanded}


def handle(request):
    index_dir = request.get("indexDir")
    if not isinstance(index_dir, str) or not index_dir:
        raise SystemExit("indexDir is required")
    if "route" in request:
        starting = [x for x in request.get("startingMaterials", []) if isinstance(x, str) and x.strip()][:16]
        max_steps = max(1, min(int(request.get("maxSteps", 4) or 4), 8))
        return {"route": _search_routes(index_dir, str(request.get("route", "")), starting, max_steps)}
    if "disconnect" in request:
        targets = [t for t in request.get("disconnect", []) if isinstance(t, str) and t.strip()][:16]
        limit = max(1, min(int(request.get("limit", 8) or 8), 32))
        starting = [s for s in request.get("startingMaterials", []) if isinstance(s, str) and s.strip()][:16]
        return {"disconnections": _disconnect(index_dir, targets, limit, starting)}
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
