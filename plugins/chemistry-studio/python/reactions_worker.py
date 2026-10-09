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
import subprocess
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


class _ExactView:
    """`exact` counts or `samples` of the index, looked up by key on first use. The table ships a
    `.blocks` sidecar, so one key costs one small zstd frame rather than the whole table."""

    def __init__(self, store, field):
        self._store, self._field = store, field

    def _row(self, key):
        rows = self._store._exact_rows
        if key not in rows:
            rows[key] = None
            rows.update(_lookup(os.path.join(self._store.dir, "exact.tsv.zst"), [key]))
        return rows[key]

    def get(self, key, default=None):
        row = self._row(key)
        if row is None:
            return default
        if self._field == "count":
            return int(row[1])
        return row[2] if len(row) > 2 and row[2] else default

    def __contains__(self, key):
        return self.get(key) is not None

    def __getitem__(self, key):
        value = self.get(key)
        if value is None:
            raise KeyError(key)
        return value


class _ProductsView:
    """`products` entries by key. The table has no `.blocks` sidecar, so the wanted keys are
    collected in one streamed pass (`prefetch`) instead of a dict of the whole table."""

    def __init__(self, store):
        self._store, self._entries = store, {}

    def prefetch(self, keys):
        wanted = {key for key in keys if key and key not in self._entries}
        if not wanted:
            return
        found = _lookup(os.path.join(self._store.dir, "products.tsv.zst"), wanted)
        for key in wanted:
            row = found.get(key)
            self._entries[key] = {"count": int(row[1]), "keys": row[2].split(",") if len(row) > 2 and row[2] else []} if row else None

    def get(self, key, default=None):
        self.prefetch([key])
        entry = self._entries.get(key)
        return default if entry is None else entry


class _LazyStore:
    """The index, read only as far as a request needs it.

    `_load` used to decompress the whole index and build dicts of every row before answering:
    1.94 M exact keys and 1.38 M product entries, 3.9 s and a 3 GB peak, in a fresh process per
    call, for a request that asks about a few dozen keys (measured 2026-10-09; 18 such calls in a
    nine-turn trace). The fingerprint index and the key list are loaded only for `similar`."""

    def __init__(self, index_dir):
        self.dir = index_dir
        self._exact_rows = {}
        self._index = None
        self._keys = None
        self.views = {"exact": _ExactView(self, "count"), "samples": _ExactView(self, "samples"), "products": _ProductsView(self)}

    def __getitem__(self, name):
        if name in self.views:
            return self.views[name]
        if name == "smiles_path":
            return os.path.join(self.dir, "reaction-smiles.tsv.zst")
        if name == "index":
            if self._index is None:
                import faiss

                plain = os.path.join(self.dir, "reactions.faiss")
                if os.path.isfile(plain):
                    # Written uncompressed by newer builds: mapped, not unpacked (77 MB -> 248 MB a call).
                    try:
                        self._index = faiss.read_index_binary(plain, faiss.IO_FLAG_MMAP)
                    except Exception:
                        self._index = faiss.read_index_binary(plain)
                else:
                    import numpy as np
                    import zstandard as zstd

                    with open(os.path.join(self.dir, "reactions.faiss.zst"), "rb") as fh:
                        blob = zstd.ZstdDecompressor().stream_reader(fh).read()
                    self._index = faiss.deserialize_index_binary(np.frombuffer(blob, dtype=np.uint8))
            return self._index
        if name == "keys":
            if self._keys is None:
                self._keys = list(_zst_lines(os.path.join(self.dir, "reaction-keys.txt.zst")))
            return self._keys
        raise KeyError(name)


def _open_store(index_dir):
    """The lazy store, after the same completeness check `_load` makes."""
    missing = [name for name in INDEX_FILES if not os.path.isfile(os.path.join(index_dir, name))]
    if missing:
        raise SystemExit(f"the reaction index is missing {', '.join(missing)}")
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")
    return _LazyStore(index_dir)


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


def _step_classes(reaction):
    """Reaction classes for a route step written as reactants>agents>products (or r>>p): the
    reactants against its main (largest organic) product. Agents are left out, since a solvent
    listed as an agent would read as a reactant group."""
    parts = reaction.split(">")
    if len(parts) != 3 or not parts[0] or not parts[2]:
        return []
    products = [m for m in parts[2].split(".") if m and _is_organic(m)]
    if not products:
        return []
    try:
        return _reaction_classes(parts[0], max(products, key=len))
    except Exception:
        return []


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
    # An ester that disappears is a hydrolysis only when the ACID appears: saponification gives the
    # acid (or its salt) alongside the alcohol. A hydride reduction gives an alcohol and NO acid,
    # and used to be labelled "ester hydrolysis" — LiAlH4 on an ester was read that way. These
    # classes are search terms, and a wrong term retrieves the wrong textbook page, which is worse
    # than no term. The alcohol test alone is not enough either: in `ester + X -> Y + ethanol` the
    # leaving group IS an alcohol, so an alcohol appears in almost every ester reaction. A new
    # carbonyl therefore rules the reduction out — an ester consumed with a ketone appearing is an
    # organometallic addition, and this claims nothing rather than claiming the wrong thing.
    if down("ester") and up("acid"): classes.append("ester hydrolysis")
    elif down("ester") and up("alcohol") and not (up("ketone") or up("aldehyde")):
        classes.append("reduction of an ester to an alcohol")
    if down("amide") and (up("arylamine") or up("amine")): classes.append("amide hydrolysis (deprotection of an acetamide)")
    if up("acid") and down("nitrile"): classes.append("nitrile hydrolysis")
    if up("acyl_halide") and before["acid"]: classes.append("acid chloride formation with thionyl chloride")
    if up("acid") and before["phenol"] and after["phenol"]: classes.append("Kolbe-Schmitt carboxylation of a phenol")
    elif up("acid") and not down("ester") and not down("nitrile") and not down("ketone") and (before["alcohol"] or before["aldehyde"] or down("benzylic_methyl")): classes.append("oxidation to a carboxylic acid")
    # Only an alcohol consumed makes it an alcohol oxidation; a methylarene oxidised to the aldehyde
    # is a benzylic oxidation (4-nitrotoluene → 4-nitrobenzaldehyde named "oxidation of an alcohol").
    if (up("aldehyde") or up("ketone")) and down("alcohol"): classes.append("oxidation of an alcohol")
    elif up("aldehyde") and down("benzylic_methyl"): classes.append("benzylic oxidation")
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
    if not wanted or not os.path.isfile(path):
        # A table an older index does not ship (format 3 has no molecules table) reads as empty.
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
            # Find each wanted key's line directly (anchored at a line start) instead of splitting
            # the whole frame: a proposal set touches hundreds of frames for a few keys each.
            text = "\n" + decompressor.decompress(fh.read(length)).decode("utf-8")
            for key in keys:
                start = text.find("\n" + key + "\t")
                if start < 0:
                    # A key with no further fields fills its whole line.
                    start = text.find("\n" + key + "\n")
                    if start < 0 and text.endswith("\n" + key):
                        start = len(text) - len(key) - 1
                    if start < 0:
                        continue
                end = text.find("\n", start + 1)
                found[key] = text[start + 1:end if end >= 0 else len(text)].split("\t")
    return found


def _audit_flags(index_dir, keys):
    """The bond-edit audit's flags for recorded reactions that stay cited although the audit flagged
    them (audit-flags.tsv.zst: key, who decided, flags) — e.g. a rearrangement a record could not
    declare. Empty for an index built without the audit."""
    rows = _lookup(os.path.join(index_dir, "audit-flags.tsv.zst"), {k for k in keys if k})
    return {key: row[2].split(",") for key, row in rows.items() if len(row) > 2 and row[2]}


def _tag(items, flags):
    for item in items:
        if item.get("key") in flags:
            item["auditFlags"] = flags[item["key"]]


_retro_cache = {}
_rdchiral_cache = {}
_retro_screen = {}


def _screen_cache_path(path):
    """Where the pattern screen of a templates file is cached: beside it, named for the file's
    bytes and everything else the screen depends on, so a changed file or RDKit is a miss."""
    import hashlib
    from rdkit import rdBase

    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    digest.update(f"screen-v1|{SCREEN_BITS}|{rdBase.rdkitVersion}".encode())
    return f"{path}.screen-{digest.hexdigest()[:16]}.npz"


def _retro_templates(index_dir):
    """The shipped retro templates, parsed once per process. Each row is
    [count, rdchiral, smarts, query]; `query` is parsed on first use when the screen is cached.

    The screen — one pattern fingerprint per template — took 4.8 s of the 5.7 s this cost per call
    over 82,940 templates, in a fresh process every call (25 calls in a nine-turn trace, 2026-10-09).
    It depends only on the file, so it is cached beside it, with the rows it covers."""
    if index_dir in _retro_cache:
        return _retro_cache[index_dir]
    from rdkit import Chem

    rows = []
    path = os.path.join(index_dir, "retro-templates.tsv.zst")
    if not os.path.isfile(path):
        # A format-3 index has no retro templates: proposals then come only from recorded reactions.
        _retro_cache[index_dir] = rows
        return rows
    lines = list(_zst_lines(path))
    cache = None
    try:
        import numpy as np

        cache = _screen_cache_path(path)
        if os.path.isfile(cache):
            with np.load(cache, allow_pickle=False) as data:
                screen, valid = data["screen"], data["valid"]
            if len(screen) == len(valid) and (not len(valid) or int(valid.max()) < len(lines)):
                for i in valid.tolist():
                    count, rdchiral, smarts = lines[i].split("\t", 2)
                    rows.append([int(count), int(rdchiral), smarts, None])
                _retro_cache[index_dir] = rows
                _retro_screen[index_dir] = screen
                return rows
    except Exception:
        rows = []
    valid = []
    for i, line in enumerate(lines):
        count, rdchiral, smarts = line.split("\t", 2)
        query = Chem.MolFromSmarts(smarts.split(">>")[0])
        if query is not None:
            rows.append([int(count), int(rdchiral), smarts, query])
            valid.append(i)
    _retro_cache[index_dir] = rows
    screen = _pattern_screen([row[3] for row in rows])
    _retro_screen[index_dir] = screen
    if cache and screen is not None:
        # Best effort: an unwritable index directory just means the next call computes it again.
        try:
            import numpy as np

            tmp = f"{cache}.{os.getpid()}.tmp.npz"
            np.savez(tmp, screen=screen, valid=np.asarray(valid, dtype=np.int64))
            os.replace(tmp, cache)
            # One screen per templates file: an older one (different bytes or RDKit) is dead weight,
            # and an index rebuilt by cloning the previous one would carry it forward for ever.
            stem = os.path.basename(path) + ".screen-"
            for name in os.listdir(os.path.dirname(cache)):
                if name.startswith(stem) and name.endswith(".npz") and os.path.join(os.path.dirname(cache), name) != cache:
                    os.remove(os.path.join(os.path.dirname(cache), name))
        except Exception:
            pass
    return rows


SCREEN_BITS = 2048


def _pattern_bits(mol):
    """A molecule's or query's RDKit pattern fingerprint as 64-bit words."""
    import numpy as np
    from rdkit import Chem, DataStructs
    bits = np.zeros((SCREEN_BITS,), dtype=np.uint8)
    DataStructs.ConvertToNumpyArray(Chem.PatternFingerprint(mol, fpSize=SCREEN_BITS), bits)
    return np.packbits(bits).view(np.uint64)


def _pattern_screen(queries):
    """The templates' product-side pattern fingerprints, one row each. A query can only match a
    molecule whose pattern fingerprint holds every one of its bits, so one bitwise pass over all
    templates replaces a substructure search per template (a large index has tens of thousands).
    None when numpy is unavailable: the plain per-template search then runs."""
    try:
        import numpy as np
        return np.stack([_pattern_bits(q) for q in queries]) if queries else None
    except Exception:
        return None


def _screened(index_dir, templates, mol):
    """The templates that may match `mol`, in their ranked order."""
    screen = _retro_screen.get(index_dir)
    if screen is None:
        return templates
    try:
        import numpy as np
        target = _pattern_bits(mol)
        keep = ~np.any(screen & ~target, axis=1)
        return [templates[i] for i in np.flatnonzero(keep)]
    except Exception:
        return templates


def _makes(reaction, target):
    """Whether a recorded reaction genuinely makes the target: the target is not already among
    its reactants (a salt formation or purification) and is one of at most two organic products
    (not a mixture record)."""
    reactants, _, products = reaction.partition(">>")
    if target in reactants.split("."):
        return False
    organic = [m for m in products.split(".") if _is_organic(m)]
    return target in organic and len(organic) <= 2


def _disconnect(index_dir, targets, limit, starting=(), stock_dir=None, budget_seconds=None):
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
    # Only ready-to-ship lists make a proposal purchasable; make-on-demand lists do not.
    stock = _load_stock(stock_dir, "stock")
    stock_seen = {}

    def vendors(smiles):
        if smiles not in stock_seen:
            stock_seen[smiles] = _vendors_for(stock, smiles)
        return stock_seen[smiles]

    try:
        from rdchiral.main import rdchiralReaction, rdchiralReactants, rdchiralRun
    except ImportError:
        rdchiralReaction = None
    templates = _retro_templates(index_dir) if rdchiralReaction else []
    # The template pass stops at the deadline and keeps what it found; templates run best-ranked
    # first, so what is cut is the tail. A target cut short, or never reached, is marked partial.
    import time
    deadline = time.monotonic() + budget_seconds if budget_seconds else None
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
            for row in _screened(index_dir, templates, mol):
                if deadline is not None and time.monotonic() > deadline:
                    entry["partial"] = True
                    break
                count, rdchiral, smarts, query = row
                if query is None:
                    query = row[3] = Chem.MolFromSmarts(smarts.split(">>")[0])
                if not mol.HasSubstructMatch(query):
                    continue
                try:
                    rxn = _rdchiral_cache.get(smarts)
                    if rxn is None:
                        # Parsing a template costs ~2 ms; a route search applies the same ones to every molecule.
                        rxn = _rdchiral_cache[smarts] = rdchiralReaction(smarts)
                    outcomes = rdchiralRun(rxn, reactants)
                except Exception:
                    continue
                for outcome in outcomes:
                    side = _side(outcome)
                    if not side or target in side.split("."):
                        continue
                    best = proposals.get(side)
                    proposals[side] = {"precursors": side, "templateCount": (best or {}).get("templateCount", 0) + count,
                                       "rdchiral": max((best or {}).get("rdchiral", 0), rdchiral),
                                       # which templates proposed it (most common first), so an index that
                                       # documents its templates (a textbook index) can cite their sources
                                       "templates": sorted(((best or {}).get("templates", []) + [(count, smarts)]), key=lambda t: -t[0])[:3]}
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
                "templates": [smarts for _count, smarts in proposal.get("templates", [])],
                "recorded": int(row[1]) if row else 0,
                "samples": (row[2].split(",")[:3] if row and len(row) > 2 and row[2] else []),
                **({"key": row[0]} if row else {}),
                "availability": availability,
                "available": bool(organic) and availability >= AVAILABLE_AS_REACTANT,
                "uses": {m: as_reactant(m) for m in organic},
                "classes": _reaction_classes(side, entry["target"]),
            })
        # Purchasable: every organic precursor is on one of the user's stock lists. It ranks
        # beside ORD availability (common as a reactant), which stays the fallback.
        if stock:
            for proposal in ranked:
                organic = [m for m in proposal["precursors"].split(".") if _is_organic(m)]
                proposal["inStock"] = {m: vendors(m) for m in organic}
                proposal["purchasable"] = bool(organic) and all(proposal["inStock"][m] for m in organic)
        if starts:
            for proposal in ranked:
                organic = [m for m in proposal["precursors"].split(".") if _is_organic(m)]
                proposal["fromStarts"] = bool(organic) and all(m in starts or (as_reactant(m) >= AVAILABLE_AS_REACTANT and Chem.MolFromSmiles(m).GetNumHeavyAtoms() <= 6) for m in organic)
                similarities = [max(DataStructs.BulkTanimotoSimilarity(fp, start_fps)) for fp in (fingerprint(m) for m in organic) if fp is not None]
                proposal["startSimilarity"] = round(max(similarities, default=0.0), 3)
            ranked.sort(key=lambda p: (-(p["recorded"] > 0), -p["fromStarts"], -p["startSimilarity"], -p.get("purchasable", False), -p["available"], -p["templateCount"]))
        else:
            ranked.sort(key=lambda p: (-(p["recorded"] > 0), -p.get("purchasable", False), -p["available"], -p["recorded"], -p["templateCount"]))
        entry["proposals"] = ranked[:limit]
        entry["proposalsConsidered"] = len(ranked)
    return results


# ---------------------------------------------------------------- multi-step route search

# A small (at most this many heavy atoms), commonly used organic counts as a routine reagent.
ROUTINE_REAGENT_ATOMS = 6
ROUTINE_REAGENT_USES = 500
# A recorded reaction with more organic inputs than this is a screening or mixture record.
MAX_STEP_PRECURSORS = 3


def _index_label(index_dir):
    """'ord' or 'textbook' (from the index's manifest source), else the directory's name."""
    try:
        with open(os.path.join(index_dir, "manifest.json")) as fh:
            source = str(json.load(fh).get("source", ""))
    except (OSError, ValueError):
        source = ""
    if "textbook" in source:
        return "textbook"
    if "reaction-database" in source or source.startswith("open-reaction"):
        return "ord"
    return os.path.basename(os.path.normpath(index_dir))


# Common solvents (canonical SMILES) that recorded reactions list among their inputs.
COMMON_SOLVENTS = frozenset(filter(None, (_canon(x) for x in (
    "CCCCCC", "CCCCCCC", "C1CCCCC1", "CCOC(C)=O", "CCOCC", "C1CCOC1", "C1COCCO1", "ClCCl", "ClC(Cl)Cl", "ClCCCl",
    "CO", "CCO", "CC(C)O", "CC(C)=O", "CC#N", "CN(C)C=O", "CS(C)=O", "Cc1ccccc1", "c1ccccc1", "COCCOC",
    "CC(=O)N(C)C", "CN1CCCC1=O", "Cc1ccccc1C", "CC(C)(C)OC", "O=C1CCCN1C", "CC(C)CO", "CCCCO", "OCCO"))))


def _search_routes(index_dirs, target, starting, max_steps=4, expansions=60, branch=4, keep=3, stock_dir=None, budget_seconds=90.0):
    """Best-first backward search from the target to the starting materials over one or more
    indexes (the ORD snapshot, the user's textbook-scheme index). A molecule is expanded into the
    recorded reactions that make it (filtered) and its top template disconnections from every
    index; a recorded step costs less than a template step, and precursors resembling the starting
    materials cost less. A route is complete when every molecule left is a starting material, on
    the user's stock list, inorganic, or a routine reagent. Each step keeps its provenance: the
    index, recorded or template, sample ids (ORD ids, or textbook 'tb-' record ids) and, for a
    textbook template, the templates that proposed it (the host cites their schemes). The search
    stops at `budget_seconds` and returns the complete routes found by then."""
    import heapq
    import time
    from rdkit import Chem

    if isinstance(index_dirs, str):
        index_dirs = [index_dirs]
    deadline = time.monotonic() + max(1.0, float(budget_seconds))
    labels = {d: _index_label(d) for d in index_dirs}
    target = _canon(target)
    starts = {c for c in (_canon(s) for s in starting) if c}
    if not target:
        return {"target": None, "routes": [], "expanded": 0, "indexes": list(labels.values())}
    cache, heavy = {}, {}

    def atoms(m):
        if m not in heavy:
            mol = Chem.MolFromSmiles(m)
            heavy[m] = mol.GetNumHeavyAtoms() if mol is not None else 99
        return heavy[m]

    def lookup(m):
        if m not in cache:
            entries = []
            for d in index_dirs:
                if time.monotonic() >= deadline:
                    break
                try:
                    entries.append((labels[d], _disconnect(d, [m], branch * 3, sorted(starts), stock_dir)[0]))
                except Exception:
                    continue
            cache[m] = entries
        return cache[m]

    stock, stocked = _load_stock(stock_dir, "stock"), {}

    def purchasable(m):
        if m not in stocked:
            stocked[m] = bool(_vendors_for(stock, m)) if stock else False
        return stocked[m]

    def free(m, uses):
        # A precursor on the user's stock list is bought, not made; the target is always made.
        return m in starts or not _is_organic(m) or (m != target and purchasable(m)) or (atoms(m) <= ROUTINE_REAGENT_ATOMS and uses.get(m, 0) >= ROUTINE_REAGENT_USES)

    uses = {}

    def note_uses(found):
        for molecule, count in found.items():
            if count > uses.get(molecule, 0):
                uses[molecule] = count

    def options(m):
        out, seen = [], set()
        for label, entry in lookup(m):
            for reaction in (entry.get("madeBy") or {}).get("reactions", []):
                note_uses(reaction.get("uses", {}))
            for proposal in entry.get("proposals", []):
                note_uses(proposal.get("uses", {}))
        for label, entry in lookup(m):
            for reaction in (entry.get("madeBy") or {}).get("reactions", [])[:branch]:
                precursors = sorted({x for x in reaction["reaction"].split(">>")[0].split(".") if _is_organic(x) and x != m})
                # Recorded solvents are not precursors, unless the product needs their atoms (ethanol in
                # an esterification); a record left with nothing that can make the product is skipped.
                solvents_out = [x for x in precursors if x not in COMMON_SOLVENTS]
                if len(solvents_out) < len(precursors):
                    if sum(atoms(x) for x in solvents_out) >= atoms(m) - 1:
                        precursors = solvents_out
                    elif not solvents_out:
                        continue
                # More than three organic inputs is a screening or mixture record, not a step.
                if precursors and len(precursors) <= MAX_STEP_PRECURSORS and tuple(precursors) not in seen:
                    seen.add(tuple(precursors))
                    out.append({"precursors": precursors, "recorded": reaction["count"], "samples": reaction["samples"],
                                "kind": "recorded", "index": label, "cost": 1.0})
            for proposal in entry.get("proposals", [])[:branch]:
                precursors = sorted({x for x in proposal["precursors"].split(".") if _is_organic(x)})
                if precursors and not proposal["recorded"] and sum(atoms(x) for x in precursors) < atoms(m) - 1:
                    continue  # a template step whose precursors lack the product's atoms (an unmapped partner left out)
                if precursors and tuple(precursors) not in seen:
                    seen.add(tuple(precursors))
                    cost = 1.0 if proposal["recorded"] else 1.6 - 0.5 * proposal.get("startSimilarity", 0.0)
                    option = {"precursors": precursors, "recorded": proposal["recorded"], "samples": proposal["samples"],
                              "kind": "recorded" if proposal["recorded"] else "template", "index": label,
                              "templateCount": proposal["templateCount"], "cost": cost}
                    if label == "textbook" and proposal.get("templates"):
                        option["templates"] = proposal["templates"]  # cited by the host from the index's template sources
                    out.append(option)
        return out

    # A* guidance: with starting materials given, each molecule still to be made adds how unlike
    # the starting materials it is (1 - best Morgan Tanimoto), so search heads towards them instead
    # of exhausting every two-step dead end first (uniform cost ran out of expansions on benzocaine
    # from 4-nitrotoluene). Without starting materials the estimate is 0 (plain uniform cost).
    from rdkit.Chem import AllChem, DataStructs
    start_fps = [AllChem.GetMorganFingerprintAsBitVect(mol, 2, 2048) for mol in (Chem.MolFromSmiles(s) for s in starts) if mol is not None]
    closeness = {}

    def estimate(open_set):
        if not start_fps:
            return 0.0
        total = 0.0
        for m in open_set:
            if free(m, uses):
                continue
            if m not in closeness:
                mol = Chem.MolFromSmiles(m)
                closeness[m] = max(DataStructs.BulkTanimotoSimilarity(AllChem.GetMorganFingerprintAsBitVect(mol, 2, 2048), start_fps)) if mol is not None else 0.0
            total += 1.0 - closeness[m]
        return total

    counter = 0
    heap = [(estimate((target,)), counter, (target,), (), 0.0)]
    done, expanded, seen_states, timed_out = [], 0, set(), False
    while heap and expanded < expansions and len(done) < keep:
        if time.monotonic() >= deadline:
            timed_out = True
            break
        _, _, open_set, steps, cost = heapq.heappop(heap)
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
            g = cost + option["cost"]
            heapq.heappush(heap, (g + estimate(rest), counter, rest, steps + (step,), g))
    for route in done:
        # The molecules the route starts from, and whether each is bought (stock list) or given.
        made = {step["product"] for step in route["steps"]}
        leaves = sorted({p for step in route["steps"] for p in step["precursors"] if p not in made})
        route["startingMaterials"] = [{"smiles": p, "given": p in starts, "inStock": purchasable(p)} for p in leaves]
    return {"target": target, "routes": done, "expanded": expanded, "indexes": list(labels.values()),
            "timedOut": timed_out, "seconds": round(budget_seconds - max(0.0, deadline - time.monotonic()), 1)}


def _stereo_choices(smiles, max_isomers=64):
    """The stereo choices a structure written without them really leaves open.

    Returns {"open": k, "mirrorOnly": bool}, or None when the structure is too large to
    enumerate. Unassigned centres and double bonds are enumerated and each isomer is kept only
    if a 3D structure can be built for it, so a bridgehead a small cage fixes is not a choice.
    `open` is how many independent choices remain (0: one stereoisomer only, as tropinone —
    its bridgeheads can only be cis, and cis is meso; 2 for tropinone-2,4-dicarboxylic acid,
    whose bridgeheads are fixed but whose two carboxyl carbons are not). `mirrorOnly` is true
    when the only choice is between two mirror images (camphor written without descriptors),
    which "racemic" covers."""
    import math
    from rdkit import Chem
    from rdkit.Chem import AllChem
    from rdkit.Chem.EnumerateStereoisomers import EnumerateStereoisomers, StereoEnumerationOptions

    mol = Chem.MolFromSmiles(smiles)
    if mol is None or mol.GetNumHeavyAtoms() > 60:
        return None

    def buildable(isomer):
        # A quick embedding with two seeds: RDKit's own tryEmbedding retries an impossible cage
        # for seconds. Both seeds failing marks the isomer as one that cannot exist.
        with_h = Chem.AddHs(isomer)
        for seed in (7, 11):
            params = AllChem.ETKDGv3()
            params.randomSeed = seed
            params.maxIterations = 20
            params.useRandomCoords = True
            if AllChem.EmbedMolecule(with_h, params) == 0:
                return True
        return False

    options = StereoEnumerationOptions(onlyUnassigned=True, unique=True, maxIsomers=max_isomers)
    isomers = sorted({Chem.MolToSmiles(m) for m in EnumerateStereoisomers(mol, options=options) if buildable(m)})
    if len(isomers) >= max_isomers:
        return None
    if len(isomers) <= 1:
        return {"open": 0, "mirrorOnly": False}
    mirror_only = False
    if len(isomers) == 2:
        mirror = Chem.MolFromSmiles(isomers[0])
        for atom in mirror.GetAtoms():
            atom.InvertChirality()
        mirror_only = Chem.MolToSmiles(mirror) == isomers[1]
    return {"open": math.ceil(math.log2(len(isomers))), "mirrorOnly": mirror_only}


# ── Purchasable compounds ─────────────────────────────────────────────────────────────────
# A stock list is a vendor catalogue the user downloaded (Mcule, Enamine, …), imported once into
# <stockDir>/<vendor>.u64: the sorted, unique 64-bit hashes of every compound's standard InChIKey,
# with <vendor>.json beside it (source file, date, counts). A lookup is a binary search on a
# memory map, so a 7-million-compound catalogue (56 MB) costs nothing to open per request.

def _stock_hash(inchikey):
    return int.from_bytes(hashlib.sha1(inchikey.strip().upper().encode()).digest()[:8], "little")


def _inchikey(smiles):
    from rdkit import Chem, RDLogger
    RDLogger.DisableLog("rdApp.*")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    try:
        key = Chem.MolToInchiKey(mol)
    except Exception:
        return None
    return key or None


def _stock_records(path):
    """(inchikey or None, smiles or None) per compound of a vendor file: SMILES (.smi/.txt, first
    column), CSV/TSV (a column named like SMILES and/or InChIKey), or SDF (.sdf/.sdf.gz)."""
    import csv, gzip, io
    opener = gzip.open if path.endswith(".gz") else open
    name = path[:-3] if path.endswith(".gz") else path
    if name.endswith(".sdf"):
        from rdkit import Chem, RDLogger
        RDLogger.DisableLog("rdApp.*")
        with opener(path, "rb") as fh:
            for mol in Chem.ForwardSDMolSupplier(fh):
                if mol is None:
                    yield None, None
                    continue
                props = {k.lower(): mol.GetProp(k) for k in mol.GetPropNames()}
                key = next((v for k, v in props.items() if "inchikey" in k), None)
                yield (key, None) if key else (Chem.MolToInchiKey(mol) or None, None)
        return
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
        first = fh.readline()
        delimiter = "\t" if "\t" in first else ("," if name.endswith(".csv") else None)
        header = [h.strip().lower() for h in (first.split(delimiter) if delimiter else first.split())]
        key_col = next((i for i, h in enumerate(header) if "inchikey" in h), None)
        smi_col = next((i for i, h in enumerate(header) if "smiles" in h), None)
        rows = csv.reader(fh, delimiter=delimiter) if delimiter else (line.split() for line in fh)
        if key_col is None and smi_col is None:
            # No header: the first column is the SMILES, and the first line is a record too.
            smi_col = 0
            rows = __import__("itertools").chain([first.split(delimiter) if delimiter else first.split()], rows)
        for row in rows:
            if not row:
                continue
            key = row[key_col].strip() if key_col is not None and key_col < len(row) else None
            smiles = row[smi_col].strip() if smi_col is not None and smi_col < len(row) else None
            yield (key or None, smiles or None)


def _key_of(record):
    key, smiles = record
    if key and len(key) == 27:
        return key
    return _inchikey(smiles) if smiles else None


def _import_stock(source, vendor, out_dir, workers=None, tier="stock"):
    """tier "stock": ready to ship — such precursors end a route search and rank first.
    tier "order": make-on-demand — reported as orderable, never treated as a starting point."""
    import multiprocessing as mp
    import time
    from array import array
    import numpy as np
    tier = "order" if tier == "order" else "stock"
    vendor = "".join(c for c in vendor.lower() if c.isalnum() or c in "-_") or "stock"
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    records = failed = 0
    hashes = array("Q")  # 8 bytes a compound: 140M is ~1.1 GB, not Python ints
    skeletons = array("Q")  # the same per InChIKey first block (connectivity: no stereo, isotopes or charge layer)
    with mp.Pool(workers or max(1, (os.cpu_count() or 2) - 1)) as pool:
        for key in pool.imap(_key_of, _stock_records(source), chunksize=2048):
            records += 1
            if key:
                hashes.append(_stock_hash(key))
                skeletons.append(_stock_hash(key.split("-")[0]))
            else:
                failed += 1
            if records % 1000000 == 0:
                print(f"  {records:,} compounds ({time.time() - started:.0f}s)", file=sys.stderr, flush=True)
    array = np.unique(np.frombuffer(hashes, dtype=np.uint64))
    del hashes
    target = os.path.join(out_dir, f"{vendor}.u64")
    array.astype("<u8").tofile(target + ".tmp")
    os.replace(target + ".tmp", target)
    # <vendor>.k1.u64: the same list by InChIKey first block, so a compound sold in another stereo
    # or isotope form (or unspecified) is still found as "same compound, another form".
    skeleton_array = np.unique(np.frombuffer(skeletons, dtype=np.uint64))
    del skeletons
    skeleton_target = os.path.join(out_dir, f"{vendor}{SKELETON_SUFFIX}")
    skeleton_array.astype("<u8").tofile(skeleton_target + ".tmp")
    os.replace(skeleton_target + ".tmp", skeleton_target)
    meta = {"vendor": vendor, "tier": tier, "source": os.path.basename(source), "importedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "records": records, "compounds": int(array.size), "skeletons": int(skeleton_array.size), "unreadable": failed, "seconds": round(time.time() - started, 1)}
    with open(os.path.join(out_dir, f"{vendor}.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    return meta


_STOCK_CACHE = {}
_SKELETON_CACHE = {}
SKELETON_SUFFIX = ".k1.u64"


def _list_tier(stock_dir, vendor):
    try:
        with open(os.path.join(stock_dir, vendor + ".json")) as fh:
            return json.load(fh).get("tier", "stock")
    except (OSError, ValueError):
        return "stock"


def _load_stock(stock_dir, tier=None):
    """The stock lists in a directory, {vendor: memmap}; with tier, only lists of that tier
    (a list imported before tiers existed counts as stock)."""
    import numpy as np
    if not stock_dir or not os.path.isdir(stock_dir):
        return {}
    if stock_dir not in _STOCK_CACHE:
        lists = {}
        for name in sorted(os.listdir(stock_dir)):
            if name.endswith(".u64") and not name.endswith(SKELETON_SUFFIX) and os.path.getsize(os.path.join(stock_dir, name)) > 0:
                vendor = name[:-4]
                lists[vendor] = (_list_tier(stock_dir, vendor), np.memmap(os.path.join(stock_dir, name), dtype="<u8", mode="r"))
        _STOCK_CACHE[stock_dir] = lists
    return {v: arr for v, (t, arr) in _STOCK_CACHE[stock_dir].items() if tier is None or t == tier}


def _load_skeletons(stock_dir, tier=None):
    """The first-block lists (<vendor>.k1.u64) in a directory, {vendor: memmap}; a list imported
    before they existed has none, and that check is skipped for it."""
    import numpy as np
    if not stock_dir or not os.path.isdir(stock_dir):
        return {}
    if stock_dir not in _SKELETON_CACHE:
        lists = {}
        for name in sorted(os.listdir(stock_dir)):
            if name.endswith(SKELETON_SUFFIX) and os.path.getsize(os.path.join(stock_dir, name)) > 0:
                vendor = name[:-len(SKELETON_SUFFIX)]
                lists[vendor] = (_list_tier(stock_dir, vendor), np.memmap(os.path.join(stock_dir, name), dtype="<u8", mode="r"))
        _SKELETON_CACHE[stock_dir] = lists
    return {v: arr for v, (t, arr) in _SKELETON_CACHE[stock_dir].items() if tier is None or t == tier}


def _skeleton_vendors_for(skeletons, smiles):
    """The vendors listing a compound with this InChIKey first block: the same compound in some
    stereo, isotope or charge form (a racemate for a single enantiomer, or the reverse)."""
    import numpy as np
    if not skeletons or not smiles:
        return []
    key = _inchikey(smiles)
    if not key:
        return []
    value = np.uint64(_stock_hash(key.split("-")[0]))
    out = []
    for vendor, array in skeletons.items():
        at = int(np.searchsorted(array, value))
        if at < array.size and array[at] == value:
            out.append(vendor)
    return out


def _vendors_for(stock, smiles):
    """The vendors whose stock list holds this compound (by standard InChIKey)."""
    import numpy as np
    if not stock or not smiles:
        return []
    key = _inchikey(smiles)
    if not key:
        return []
    value = np.uint64(_stock_hash(key))
    out = []
    for vendor, array in stock.items():
        at = int(np.searchsorted(array, value))
        if at < array.size and array[at] == value:
            out.append(vendor)
    return out



# ---------------------------------------------------------------- conditions of sample reactions

CONDITIONS_PER_REACTION = 2


def _sample_conditions(index_dir, ids):
    """ORD id -> what the reaction was run with (reagents, catalysts, solvents, temperature, time,
    atmosphere, yield, ref), from conditions.tsv.zst when the index has one (tools/reaction-index/
    conditions.py); {} otherwise."""
    path = os.path.join(index_dir, "conditions.tsv.zst")
    if not ids or not os.path.isfile(path):
        return {}
    out = {}
    for rid, row in _lookup(path, set(ids)).items():
        try:
            value = json.loads(row[1])
        except (IndexError, ValueError):
            continue
        if isinstance(value, dict) and value:
            out[rid] = value
    return out


def _attach_conditions(index_dir, items):
    """Give each item with `samples` a `conditions` list: up to two of its sample reactions'
    conditions, each with its ORD id. Items whose samples have none are left unchanged."""
    items = [item for item in items if isinstance(item, dict) and item.get("samples")]
    found = _sample_conditions(index_dir, {rid for item in items for rid in item["samples"]})
    for item in items:
        conditions = [{"id": rid, **found[rid]} for rid in item["samples"] if rid in found][:CONDITIONS_PER_REACTION]
        if conditions:
            item["conditions"] = conditions


# ---------------------------------------------------------------- functional-group compatibility

# A protecting group that disappears in a step should have a reagent that removes it.
_REMOVED_BY = {
    "boc": {"strong-acid"}, "cbz": {"hydrogenation", "strong-acid", "dissolving-metal"},
    "fmoc": {"amine-base", "hydroxide", "alkoxide", "strong-base"}, "silyl-ether": {"fluoride", "strong-acid"},
    "benzyl-ether": {"hydrogenation", "dissolving-metal", "strong-acid"}, "benzyl-ester": {"hydrogenation", "hydroxide", "alkoxide", "strong-acid"},
    "trityl": {"strong-acid", "hydrogenation"}, "acetal": {"strong-acid"}, "tbu-ester": {"strong-acid"},
}
_compat_cache = {}


def _compat_tables():
    # The worker runs with -I (no script directory on sys.path), so the tables module beside it is
    # put there explicitly.
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import compat_tables
    return compat_tables


def _protection_examples(textbook_dir, forms):
    """For each protected form (label, SMARTS, SMARTS of the free group): up to two textbook records
    that put it on (the free group in the reactants, the form in the products and not the reactants,
    the main product larger by about the group's size), from the book with the most such examples.
    Reads records.json of a textbook index; an index without one gives nothing."""
    from rdkit import Chem, RDLogger

    RDLogger.DisableLog("rdApp.*")
    path = os.path.join(textbook_dir, "records.json") if textbook_dir else None
    if not path or not os.path.isfile(path):
        return {}
    key = (path, os.path.getmtime(path))
    store = _compat_cache.get(key)
    if store is None:
        records = json.load(open(path))
        parsed = []
        for rid, record in records.items():
            reaction = record.get("reaction") or ""
            left, _, right = reaction.partition(">>")
            r = Chem.MolFromSmiles(left) if left else None
            p = Chem.MolFromSmiles(right) if right else None
            if r is not None and p is not None:
                largest = lambda mol: max((f.GetNumHeavyAtoms() for f in Chem.GetMolFrags(mol, asMols=True)), default=0)
                parsed.append((rid, record.get("book"), record.get("page") or 0, r, p, largest(p) - largest(r)))
        store = {"parsed": parsed, "forms": {}}
        _compat_cache.clear()
        _compat_cache[key] = store
    out = {}
    for label, smarts, free in forms:
        if smarts not in store["forms"]:
            query, before = Chem.MolFromSmarts(smarts), Chem.MolFromSmarts(free)
            # A protection step adds only the protecting group: the main product is larger than the
            # main reactant by about the group's size (the form less its attachment atoms).
            size = (query.GetNumAtoms() - 2) if query is not None else 0
            hits = [] if query is None or before is None else [
                (rid, book, page) for rid, book, page, r, p, grown in store["parsed"]
                if abs(grown - size) <= 1 and r.HasSubstructMatch(before) and p.HasSubstructMatch(query) and not r.HasSubstructMatch(query)]
            by_book = {}
            for rid, book, page in hits:
                by_book.setdefault(book, []).append((page, rid))
            best = max(by_book.items(), key=lambda kv: (len(kv[1]), str(kv[0])), default=(None, []))[1]
            store["forms"][smarts] = [rid for _page, rid in sorted(best)[:2]]
        if store["forms"][smarts]:
            out[label] = store["forms"][smarts]
    return out


def _compatibility(steps, textbook_dir=None):
    """Per route step: groups in the substrate that survive into the product although a reagent
    named in the step's conditions attacks them, and protecting groups that vanish with no reagent
    that removes them. Each hazard says why and how to keep the group (protecting groups as in
    Greene), with textbook examples of putting that group on when a textbook index is given."""
    from collections import Counter
    from rdkit import Chem

    T = _compat_tables()
    patterns = {g: Chem.MolFromSmarts(smarts) for g, (_label, smarts) in T.GROUPS.items()}

    def counts(smiles_list):
        found = Counter()
        for smiles in smiles_list:
            mol = Chem.MolFromSmiles(smiles) if isinstance(smiles, str) and smiles.strip() else None
            if mol is None:
                continue
            for group, query in patterns.items():
                if query is not None:
                    n = len(mol.GetSubstructMatches(query))
                    if n:
                        found[group] += n
        return found

    carbonyl_reacting = {"aldehyde", "ester", "acid-chloride", "anhydride", "lactone", "ketone"}
    results = []
    for index, step in enumerate(steps):
        step = step if isinstance(step, dict) else {}
        reactants = [s for s in step.get("reactants", []) if isinstance(s, str)][:12]
        products = [s for s in step.get("products", []) if isinstance(s, str)][:12]
        text = str(step.get("reagents") or "")[:2000]
        classes = T.classify(text)
        before, after = counts(reactants), counts(products)
        survives = {g for g in before if after.get(g, 0) > 0}
        reacted = {g for g in before if after.get(g, 0) < before[g]}
        hazards, seen = [], set()
        for cls in classes:
            for group, severity, why in T.ATTACKS.get(cls, []):
                if group not in survives or (group, cls) in seen:
                    continue
                # An enolizable ketone next to a strong base is only a competing site when another
                # carbonyl is the one meant to react.
                if group == "enolizable-ketone" and not (reacted & (carbonyl_reacting - {"ketone"})):
                    continue
                # A ketone flagged as such is not flagged again as an enolizable ketone.
                if group == "enolizable-ketone" and any(h["group"] == "ketone" and h["reagentClass"] == cls for h in hazards):
                    continue
                seen.add((group, cls))
                # Another group of the same kind reacts in this step: the step is meant to tell them
                # apart, so it is a selectivity question rather than a clash.
                selective = group in reacted
                if selective:
                    severity = "medium"
                text_hint, forms = T.suggestion(group, cls)
                hazards.append({"group": group, "groupLabel": T.GROUPS[group][0], "reagentClass": cls,
                                "reagentLabel": T.label_of(cls), "severity": severity,
                                "why": (f"another {T.GROUPS[group][0]} reacts in this step while this one must survive; under {T.label_of(cls)} conditions it {why} — check the selectivity"
                                        if selective else f"the {T.GROUPS[group][0]} survives into the product, but under {T.label_of(cls)} conditions it {why}"),
                                "suggestion": text_hint, "_forms": forms})
        for group, removers in _REMOVED_BY.items():
            if group in reacted and before[group] > after.get(group, 0) and classes and not (removers & set(classes)):
                text_hint, forms = T.suggestion(group, None)
                hazards.append({"group": group, "groupLabel": T.GROUPS[group][0], "reagentClass": None, "reagentLabel": None,
                                "severity": "medium",
                                "why": f"the {T.GROUPS[group][0]} is gone in the product, but none of the named reagents removes it",
                                "suggestion": "check the product, or name the deprotection step", "_forms": []})
        if textbook_dir:
            for hazard in hazards:
                examples = _protection_examples(textbook_dir, hazard["_forms"])
                if examples:
                    hazard["examples"] = [{"form": form, "records": ids} for form, ids in examples.items()][:2]
        for hazard in hazards:
            hazard["protectedForms"] = [form[0] for form in hazard.pop("_forms")]
        hazards.sort(key=lambda h: (h["severity"] != "high", h["group"]))
        results.append({"step": index + 1, "reagentClasses": [{"id": c, "label": T.label_of(c)} for c in classes], "hazards": hazards})
    return results


# The most names, or structures, the application sends in one call: SCHEMA_CEILINGS.names and
# .structures in src/engine/chemistryLimits.ts. A lower cap here sent the rest to the network.
LOCAL_REFERENCE_LIMIT = 512


def _pubchem_mirror(mirror_dir, names, smiles):
    """Answer name and structure lookups from a local PubChem mirror (built by the application's
    tools from NCBI's bulk files), so a route's species need no network round trip.

    Only what the mirror can answer DEFINITELY is answered: a name with exactly one CID, a structure
    whose standard InChIKey has a CID. Everything else is left out and the caller asks the network
    as before — the bulk synonym list is filtered, so the live service can know a synonym (and so a
    second match) the mirror does not. Nothing here ever reports "unresolved"."""
    import pathlib
    import sqlite3

    path = os.path.join(mirror_dir, "pubchem.sqlite")
    if not os.path.isfile(path):
        return {"names": {}, "smiles": {}, "available": False}
    # as_uri() percent-escapes the path: written raw, a "#" or "?" in a folder name cut the URI short
    # (SQLite then created an empty database there, read-write) and a "%" was decoded.
    db = sqlite3.connect(f"{pathlib.Path(path).resolve().as_uri()}?mode=ro", uri=True)
    out = {"names": {}, "smiles": {}, "available": True}
    try:
        for name in names[:LOCAL_REFERENCE_LIMIT]:
            cids = [row[0] for row in db.execute("SELECT DISTINCT cid FROM synonym WHERE name = ? COLLATE NOCASE LIMIT 2", (name,))]
            if len(cids) != 1:
                continue
            cid = cids[0]
            row = db.execute("SELECT smiles FROM smiles WHERE cid = ?", (cid,)).fetchone()
            if not row:
                continue
            formula = db.execute("SELECT formula FROM formula WHERE cid = ?", (cid,)).fetchone()
            out["names"][name] = {"cid": cid, "smiles": row[0], **({"formula": formula[0]} if formula else {})}
        if smiles:
            from rdkit import Chem, RDLogger

            RDLogger.DisableLog("rdApp.*")
            for value in smiles[:LOCAL_REFERENCE_LIMIT]:
                mol = Chem.MolFromSmiles(value)
                key = Chem.MolToInchiKey(mol) if mol is not None else ""
                if not key:
                    continue
                row = db.execute("SELECT cid FROM inchikey WHERE key = ?", (key,)).fetchone()
                if not row:
                    continue
                cid = row[0]
                name = db.execute("SELECT name FROM iupac WHERE cid = ?", (cid,)).fetchone()
                formula = db.execute("SELECT formula FROM formula WHERE cid = ?", (cid,)).fetchone()
                out["smiles"][value] = {"cid": cid, "inchikey": key, **({"name": name[0]} if name else {}), **({"formula": formula[0]} if formula else {})}
    finally:
        db.close()
    return out


def _opsin_local(opsin_dir, names):
    """Names parsed by a local OPSIN (the same parser EBI's web service runs), when the application
    has one: <opsin_dir> holds a `java` link, OPSIN's jar and the OpsinBatch wrapper, which prints
    per name what the web service returns — status, SMILES, warnings, message. Any failure to run
    is no answer at all, and the caller uses the web service exactly as before."""
    java = os.path.join(opsin_dir, "java")
    jars = [n for n in os.listdir(opsin_dir) if n.startswith("opsin-") and n.endswith(".jar")] if os.path.isdir(opsin_dir) else []
    if not names or not jars or not os.path.exists(java) or not os.path.isfile(os.path.join(opsin_dir, "OpsinBatch.class")):
        return {}
    clean = [n.replace("\n", " ").replace("\r", " ") for n in names[:LOCAL_REFERENCE_LIMIT]]
    try:
        run = subprocess.run([java, "-cp", os.pathsep.join([os.path.join(opsin_dir, jars[0]), opsin_dir]), "OpsinBatch"],
                             input="\n".join(clean) + "\n", capture_output=True, text=True, timeout=120)
    except Exception:
        return {}
    lines = run.stdout.split("\n")
    if run.returncode != 0 or len(lines) < len(clean):
        return {}
    out = {}
    for name, line in zip(names[:LOCAL_REFERENCE_LIMIT], lines):
        status, smiles, warnings, message = (line.split("\t") + ["", "", "", ""])[:4]
        out[name] = {"status": status, **({"smiles": smiles} if smiles else {}),
                     **({"warnings": warnings.split("|")} if warnings else {}), **({"message": message} if message else {})}
    return out


def handle(request):
    if "stock" in request:
        stock_dir = request.get("stockDir")
        ready, order = _load_stock(stock_dir, "stock"), _load_stock(stock_dir, "order")
        molecules = [m for m in request.get("stock", []) if isinstance(m, str) and m.strip()][:64]
        stock = {m: _vendors_for(ready, m) for m in molecules}
        orderable = {m: _vendors_for(order, m) for m in molecules}
        # Same compound in another stereo/isotope form, only where the exact compound is not listed.
        ready_k1, order_k1 = _load_skeletons(stock_dir, "stock"), _load_skeletons(stock_dir, "order")
        same = {m: v for m in molecules if not stock[m] for v in [_skeleton_vendors_for(ready_k1, m)] if v}
        same_order = {m: v for m in molecules if not stock[m] and not orderable[m] and not same.get(m)
                      for v in [_skeleton_vendors_for(order_k1, m)] if v}
        return {"stock": stock, "orderable": orderable,
                **({"sameSkeleton": same} if same else {}), **({"sameSkeletonOrderable": same_order} if same_order else {}),
                "lists": sorted(ready), "orderLists": sorted(order)}
    if "compatibility" in request:
        steps = [x for x in request.get("compatibility", []) if isinstance(x, dict)][:24]
        textbook = request.get("textbookDir")
        return {"compatibility": _compatibility(steps, textbook if isinstance(textbook, str) and textbook else None)}
    if "stereoChoices" in request:
        out = {}
        for smiles in [s for s in request.get("stereoChoices", []) if isinstance(s, str) and s.strip()][:48]:
            try:
                out[smiles] = _stereo_choices(smiles)
            except Exception:
                out[smiles] = None
        return {"stereoChoices": out}
    if isinstance(request.get("pubchemDir"), str) or isinstance(request.get("opsinDir"), str):
        names = [n for n in request.get("pubchemNames", []) if isinstance(n, str) and n.strip()]
        smiles = [m for m in request.get("pubchemSmiles", []) if isinstance(m, str) and m.strip()]
        out = {}
        # Each source fails on its own: a half-built or corrupt mirror reads as no mirror, so the
        # caller asks the network for those names, and the local OPSIN answers are still returned.
        if isinstance(request.get("pubchemDir"), str):
            try:
                out["pubchem"] = _pubchem_mirror(request["pubchemDir"], names, smiles)
            except Exception as error:
                reason = f"{type(error).__name__}: {error}"[:300]
                print(f"PubChem mirror unusable: {reason}", file=sys.stderr)
                out["pubchem"] = {"names": {}, "smiles": {}, "available": False, "error": reason}
        if isinstance(request.get("opsinDir"), str):
            try:
                out["opsin"] = _opsin_local(request["opsinDir"], names)
            except Exception as error:
                print(f"Local OPSIN unusable: {type(error).__name__}: {error}"[:300], file=sys.stderr)
                out["opsin"] = {}
        return out
    index_dir = request.get("indexDir")
    index_dirs = [d for d in request.get("indexDirs", []) if isinstance(d, str) and d][:4] if isinstance(request.get("indexDirs"), list) else []
    if not index_dirs and isinstance(index_dir, str) and index_dir:
        index_dirs = [index_dir]
    if not index_dirs:
        raise SystemExit("indexDir or indexDirs is required")
    index_dir = index_dir if isinstance(index_dir, str) and index_dir else index_dirs[0]
    if "route" in request:
        starting = [x for x in request.get("startingMaterials", []) if isinstance(x, str) and x.strip()][:16]
        max_steps = max(1, min(int(request.get("maxSteps", 4) or 4), 8))
        budget = max(5.0, min(float(request.get("budgetSeconds", 90) or 90), 240.0))
        usable = [d for d in index_dirs if os.path.isfile(os.path.join(d, "molecules.tsv.zst"))]
        return {"route": _search_routes(usable or index_dirs, str(request.get("route", "")), starting, max_steps,
                                        stock_dir=request.get("stockDir"), budget_seconds=budget)}
    if "disconnect" in request:
        targets = [t for t in request.get("disconnect", []) if isinstance(t, str) and t.strip()][:16]
        limit = max(1, min(int(request.get("limit", 8) or 8), 32))
        starting = [s for s in request.get("startingMaterials", []) if isinstance(s, str) and s.strip()][:16]
        missing = [name for name in ("retro-templates.tsv.zst", "molecules.tsv.zst") if not os.path.isfile(os.path.join(index_dir, name))]
        budget = request.get("budgetSeconds")
        budget = max(5.0, min(float(budget), 230.0)) if isinstance(budget, (int, float)) and budget > 0 else None
        disconnections = _disconnect(index_dir, targets, limit, starting, request.get("stockDir"), budget_seconds=budget)
        recorded = ([r for entry in disconnections for r in ((entry.get("madeBy") or {}).get("reactions") or [])]
                    + [p for entry in disconnections for p in entry.get("proposals", []) if p.get("recorded")])
        _attach_conditions(index_dir, recorded)
        _tag(recorded, _audit_flags(index_dir, [item.get("key") for item in recorded]))
        return {"disconnections": disconnections, **({"indexLacks": missing} if missing else {})}
    store = _open_store(index_dir)
    if isinstance(store, _LazyStore):
        store["products"].prefetch({_side(p) for p in request.get("products", [])[:32] if _side(p)})

    reactions = []
    for reaction in request.get("reactions", [])[:32]:
        key, count, form, unchanged = _exact(store, reaction)
        entry = {"input": reaction, "key": key, "count": count}
        if form:
            entry["form"] = form
        if unchanged:
            entry["unchanged"] = True
        else:
            classes = _step_classes(reaction)
            if classes:
                entry["classes"] = classes
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
    flags = _audit_flags(index_dir, matched + near)
    _tag([entry for entry in reactions if entry["count"]], flags)
    _tag([neighbor for item in similar for neighbor in item["neighbors"]], flags)
    exact_inputs = {entry["input"] for entry in reactions if entry["count"]}
    # The closest recorded reaction of a step with no exact match: its sample ids, so it can be
    # cited with its conditions like an exact match.
    closest = []
    for item in similar:
        if item["input"] not in exact_inputs and item["neighbors"] and item["neighbors"][0]["key"] in store["samples"]:
            item["neighbors"][0]["samples"] = store["samples"][item["neighbors"][0]["key"]].split(",")[:3]
            closest.append(item["neighbors"][0])
    _attach_conditions(index_dir, [entry for entry in reactions if entry.get("count")] + closest)
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
    if "--import-stock" in sys.argv[1:]:
        # reactions_worker.py --import-stock <file> <vendor> <stockDir> [stock|order]
        at = sys.argv.index("--import-stock")
        source, vendor, out_dir = sys.argv[at + 1:at + 4]
        tier = sys.argv[at + 4] if len(sys.argv) > at + 4 else "stock"
        print(json.dumps(_import_stock(source, vendor, out_dir, tier=tier)))
        return
    request = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(handle(request)))


if __name__ == "__main__":
    main()
