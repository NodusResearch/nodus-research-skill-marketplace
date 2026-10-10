"""Break an assembled target into the units it was built from.

Why this exists: asking "what reactions could make this?" of a large molecule is the expensive
question — thousands of templates against hundreds of atoms. Asking it of each unit is the cheap
one. So the useful first move on a large target is not to analyse it but to take it apart.

It is a CUT, not a tiling. Choosing non-overlapping library matches that cover a target is exact
cover, and on a long repetitive target the symmetric alternatives explode. But the units are joined
by one kind of bond, so:

  1. find every link bond — the `N-C-C(=O)-N` motif, cutting the `C(=O)-N`, where the carbonyl
     carries exactly one oxygen so that a carbamate protecting group is not mistaken for a link;
  2. cut them all at once, leaving a dummy at each end so every fragment keeps its degree;
  3. take the protecting groups off each fragment, by cutting the bond that attaches the group and
     keeping the piece the unit is in — one mechanism for every group in the table;
  4. identify each fragment against the library's forms, requiring the match to cover every
     non-dummy atom, so a smaller unit cannot claim a larger one's fragment.

Linear in the target and in the library, with no search and no backtracking. Measured at 11 ms per
target on targets of 114-292 atoms, with every unit found on four of six and 80% on the worst.

The library is LOCAL DATA and is never shipped here: `library_dir` names a directory holding a
`monomers.json` built by `tools/build-monomers.py`. Without one the cut and the fragments are still
returned — they are what the retro pass needs — and nothing is identified.
"""
import json
import os

MAX_TARGETS = 8
MAX_DEPROTECT = 12          # how many groups may come off one fragment before we stop looking
MAX_MATCHES = 50
MIN_FRAGMENT_ATOMS = 3

# The link is the BACKBONE bond, so the pattern demands the whole repeating motif. Matching any
# carbonyl-N bond instead also cut side-chain amides, which splits a unit in half.
LINK_SMARTS = "[NX3][CX4][CX3](=[OX1])[NX3;!$(N=*)]"
_LINK_CARBONYL, _LINK_NITROGEN = 2, 4        # positions in the match, which follows query order

# A protecting group comes off by CUTTING the bond that attaches it. The SMARTS names the anchor
# atom first and the group's first atom second, and the bond between those two is the one cut. Order
# matters: a tert-butyl comes off before the carbamate it leaves behind.
PROTECTORS = (
    ("tBu-on-O", "[OX2:1][CX4:2]([CH3])([CH3])[CH3]"),
    ("carbamate", "[NX3:1][CX3:2](=[OX1])[OX2H1]"),
    # [#7], not [NX3]: on an unsaturated nitrogen the group hangs off an NX2
    ("sulfonyl", "[#7:1][SX4:2](=[OX1])(=[OX1])[#6]"),
    ("phosphinyl", "[#7:1][PX4:2](=[OX1])([#6])[#6]"),
    ("trityl", "[#7,#8,#16;X2,X3:1][CX4:2]([c])([c])[c]"),
    ("benzyl-O", "[OX2:1][CH2:2][c]1[cH][cH][cH][cH][cH]1"),
    ("carbonate-ester", "[NX3:1][CX3:2](=[OX1])[OX2][CH2][CH1]"),
)

_patterns = {}
_libraries = {}


def capped(piece):
    """The fragment with its cut ends capped, so it is a molecule a search can be asked about.

    A fragment comes out of the cut carrying a dummy atom wherever a bond was broken. That is right
    for identifying it — a dummy keeps the neighbour's degree, so a form cannot match across the
    cut — but a dummy is not a molecule, and a retro search handed one would be asked about an atom
    that does not exist.

    What the cap must be is not the same at both ends, because the bond that was cut was made by
    losing water. On the nitrogen the hydrogen is simply restored. On the carbonyl carbon the
    hydroxyl is, and capping THAT end with a hydrogen instead turns the acid into an aldehyde —
    which is a different compound, and a search asked about it answers a different question."""
    from rdkit import Chem

    rw = Chem.RWMol(piece)
    drop = []
    for atom in piece.GetAtoms():
        if atom.GetAtomicNum() != 0:
            continue
        neighbours = atom.GetNeighbors()
        carbonyl = (len(neighbours) == 1 and neighbours[0].GetSymbol() == "C"
                    and any(b.GetBondType().name == "DOUBLE"
                            and b.GetOtherAtom(neighbours[0]).GetSymbol() == "O"
                            for b in neighbours[0].GetBonds()))
        if carbonyl:
            # the hydroxyl the condensation took; RDKit fills its hydrogen in. The isotope has to
            # go with it: FragmentOnBonds labels each dummy with the atom index it was cut from, and
            # keeping that label turns the oxygen into [5OH] — a different compound on paper.
            cap = rw.GetAtomWithIdx(atom.GetIdx())
            cap.SetAtomicNum(8)
            cap.SetIsotope(0)
            cap.SetFormalCharge(0)
            cap.SetAtomMapNum(0)
            cap.SetNoImplicit(False)
        else:
            drop.append(atom.GetIdx())
    for idx in sorted(drop, reverse=True):
        rw.RemoveAtom(idx)
    try:
        out = rw.GetMol()
        Chem.SanitizeMol(out)
        return Chem.MolToSmiles(out)
    except Exception:
        return None


def _compiled():
    """The link and protector queries, parsed once per process."""
    if not _patterns:
        from rdkit import Chem

        _patterns["link"] = Chem.MolFromSmarts(LINK_SMARTS)
        _patterns["protectors"] = tuple(
            (name, Chem.MolFromSmarts(sma)) for name, sma in PROTECTORS)
    return _patterns


def library(library_dir):
    """The library's forms as (id, query, atom count, attachments condensed), largest first.

    Every form of every entry, not just the fully condensed one: a unit at the end of a chain keeps
    its free carboxyl and a side-chain attachment goes unused in a linear target, so one form per
    entry identifies neither. Empty when there is no library, which is not an error."""
    if library_dir in _libraries:
        return _libraries[library_dir]
    from rdkit import Chem

    forms = []
    path = os.path.join(library_dir or "", "monomers.json")
    if library_dir and os.path.isfile(path):
        try:
            with open(path) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
        for entry in data.get("entries") or ():
            for form in entry.get("inChainForms") or ():
                query = Chem.MolFromSmarts(form.get("smarts") or "")
                if query is not None and query.GetNumAtoms() >= MIN_FRAGMENT_ATOMS:
                    forms.append((entry.get("id"), query, query.GetNumAtoms(),
                                  tuple(form.get("condensed") or ())))
    forms.sort(key=lambda f: -f[2])
    _libraries[library_dir] = forms
    return forms


def link_bonds(mol):
    """The bond indices joining one unit to the next."""
    found = set()
    for match in mol.GetSubstructMatches(_compiled()["link"], uniquify=True):
        carbonyl, nitrogen = match[_LINK_CARBONYL], match[_LINK_NITROGEN]
        atom = mol.GetAtomWithIdx(carbonyl)
        if sum(1 for nb in atom.GetNeighbors() if nb.GetSymbol() == "O") != 1:
            continue
        bond = mol.GetBondBetweenAtoms(carbonyl, nitrogen)
        if bond is not None and bond.GetBondType().name == "SINGLE":
            found.add(bond.GetIdx())
    return sorted(found)


def cut(mol, bonds):
    """The fragments after cutting, each as (fragment, original atom indices)."""
    from rdkit import Chem

    if not bonds:
        return [(mol, tuple(range(mol.GetNumAtoms())))]
    broken = Chem.FragmentOnBonds(mol, bonds, addDummies=True)
    mapping = []
    pieces = Chem.GetMolFrags(broken, asMols=True, sanitizeFrags=False,
                              fragsMolAtomMapping=mapping)
    out = []
    for piece, idxs in zip(pieces, mapping):
        try:
            Chem.SanitizeMol(piece)
        except Exception:
            continue
        # FragmentOnBonds appends its dummies past the original atom count
        out.append((piece, tuple(i for i in idxs if i < mol.GetNumAtoms())))
    return out


def deprotect(mol):
    """(fragment, group names removed), by cutting each group off and keeping the unit's piece."""
    from rdkit import Chem

    removed = []
    for _ in range(MAX_DEPROTECT):
        found = None
        for name, patt in _compiled()["protectors"]:
            if patt is None:
                continue
            for match in mol.GetSubstructMatches(patt, uniquify=True):
                anchor, group = match[0], match[1]
                bond = mol.GetBondBetweenAtoms(anchor, group)
                if bond is None or bond.GetBondType().name != "SINGLE" or bond.IsInRing():
                    continue
                found = (name, anchor, bond.GetIdx())
                break
            if found:
                break
        if not found:
            break
        name, anchor, bond = found
        broken = Chem.FragmentOnBonds(mol, [bond], addDummies=False)
        mapping = []
        pieces = Chem.GetMolFrags(broken, asMols=True, sanitizeFrags=False,
                                 fragsMolAtomMapping=mapping)
        keep = next((p for p, idxs in zip(pieces, mapping) if anchor in idxs), None)
        if keep is None:
            break
        try:
            Chem.SanitizeMol(keep)
        except Exception:
            break
        mol = keep
        removed.append(name)
    return mol, removed


def identify(piece, forms):
    """Every library id whose form covers ALL of the fragment's non-dummy atoms.

    Chirality is part of the question, not a refinement: without it the L and D forms of a unit are
    indistinguishable and almost every fragment comes back ambiguous. Several ids means the library
    holds forms that cannot be told apart, which is reported rather than guessed at."""
    real = {a.GetIdx() for a in piece.GetAtoms() if a.GetAtomicNum() > 0}
    hits, where = [], {}
    for mid, query, count, condensed in forms:
        if count != len(real) or mid in where:
            continue
        for match in piece.GetSubstructMatches(query, uniquify=True, maxMatches=MAX_MATCHES,
                                               useChirality=True):
            if set(match) == real:
                hits.append(mid)
                where[mid] = condensed
                break
    return hits, where


def decompose(targets, library_dir=None):
    """One record per target: its units, the bonds cut, and whatever could not be identified."""
    from rdkit import Chem

    forms = library(library_dir)
    out = []
    for raw in list(targets)[:MAX_TARGETS]:
        if not isinstance(raw, str) or not raw.strip():
            continue
        mol = Chem.MolFromSmiles(raw.strip())
        if mol is None:
            out.append({"input": raw, "error": "unparsable"})
            continue
        bonds = link_bonds(mol)
        record = {"input": raw, "target": Chem.MolToSmiles(mol), "atoms": mol.GetNumAtoms(),
                  "linkBonds": len(bonds), "units": [], "unidentified": [],
                  "protectingGroups": {}, "hasLibrary": bool(forms)}
        covered = 0
        for piece, original in cut(mol, bonds):
            piece, gone = deprotect(piece)
            for name in gone:
                record["protectingGroups"][name] = record["protectingGroups"].get(name, 0) + 1
            hits, where = identify(piece, forms) if forms else ([], {})
            smiles = Chem.MolToSmiles(piece)
            free = capped(piece)
            if hits:
                covered += len(original)
                record["units"].append({
                    "atoms": sorted(original), "smiles": smiles,
                    **({"capped": free} if free else {}),
                    "ids": hits, "joinedAt": sorted(where.get(hits[0]) or ()),
                    **({"ambiguous": True} if len(hits) > 1 else {}),
                    **({"deprotected": gone} if gone else {})})
            else:
                # Not a failure: an unidentified fragment is still a small molecule, which is the
                # thing a retro pass can afford to ask about — and `capped` is the form to ask with.
                record["unidentified"].append({
                    "atoms": sorted(original), "smiles": smiles,
                    **({"capped": free} if free else {}),
                    **({"deprotected": gone} if gone else {})})
        record["covered"] = round(covered / mol.GetNumAtoms(), 3) if mol.GetNumAtoms() else 0.0
        out.append(record)
    return out
