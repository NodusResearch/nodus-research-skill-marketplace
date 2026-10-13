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
MAX_REPAIR_ROUNDS = 3       # how many link bonds may be put back before we stop trying
MAX_SUSPECT_BONDS = 24      # candidates examined per round, so a long target stays bounded
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
            # Bracketed nitrogens retain NoImplicit across the cut. Allow RDKit to restore the
            # lost hydrogen, or an explicitly written amide yields a radical instead of an amine.
            if len(neighbours) == 1 and neighbours[0].GetAtomicNum() == 7:
                rw.GetAtomWithIdx(neighbours[0].GetIdx()).SetNoImplicit(False)
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
    from rdkit import Chem

    forms = []
    path = os.path.join(library_dir or "", "monomers.json")
    try:
        stat = os.stat(path) if library_dir else None
        stamp = (stat.st_mtime_ns, stat.st_size, stat.st_ino) if stat else None
    except OSError:
        stamp = None
    previous = _libraries.get(library_dir)
    if previous is not None and previous[0] == stamp:
        return previous[1]
    if library_dir and os.path.isfile(path):
        try:
            with open(path) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
        entries = data.get("entries") if isinstance(data, dict) else None
        for entry in entries if isinstance(entries, list) else ():
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
                continue
            chain_forms = entry.get("inChainForms")
            for form in chain_forms if isinstance(chain_forms, list) else ():
                if not isinstance(form, dict) or not isinstance(form.get("smarts"), str):
                    continue
                condensed = form.get("condensed") or []
                if not isinstance(condensed, list) or not all(isinstance(c, str) for c in condensed):
                    continue
                query = Chem.MolFromSmarts(form["smarts"])
                if query is not None and query.GetNumAtoms() >= MIN_FRAGMENT_ATOMS:
                    forms.append((entry.get("id"), query, query.GetNumAtoms(),
                                  tuple(condensed)))
    forms.sort(key=lambda f: -f[2])
    _libraries[library_dir] = (stamp, forms)
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


def strip_one(mol):
    """(fragment, group name) with one protecting group cut off, or (mol, None) if none applies."""
    from rdkit import Chem

    for name, patt in _compiled()["protectors"]:
        if patt is None:
            continue
        for match in mol.GetSubstructMatches(patt, uniquify=True):
            anchor, group = match[0], match[1]
            bond = mol.GetBondBetweenAtoms(anchor, group)
            if bond is None or bond.GetBondType().name != "SINGLE" or bond.IsInRing():
                continue
            broken = Chem.FragmentOnBonds(mol, [bond.GetIdx()], addDummies=False)
            mapping = []
            pieces = Chem.GetMolFrags(broken, asMols=True, sanitizeFrags=False,
                                     fragsMolAtomMapping=mapping)
            keep = next((p for p, idxs in zip(pieces, mapping) if anchor in idxs), None)
            if keep is None:
                continue
            try:
                Chem.SanitizeMol(keep)
            except Exception:
                continue
            return keep, name
    return mol, None


def deprotect(mol, forms=()):
    """(fragment, group names removed, ids) — stripping only as far as it has to.

    A group is taken off only when the fragment cannot be identified as it stands. Stripping first
    and identifying afterwards destroyed units that genuinely contain one of these groups: the
    library holds building blocks whose own structure is a methanesulfonamide, and the sulfonyl rule
    tore it off and reported the plain unit instead — a different compound, silently. Auditing the
    whole library found four of them.

    So: identify, and only if nothing is named take one group off and ask again."""
    removed = []
    hits, where = identify(mol, forms) if forms else ([], {})
    if hits:
        return mol, removed, (hits, where)
    for _ in range(MAX_DEPROTECT):
        mol, name = strip_one(mol)
        if name is None:
            break
        removed.append(name)
        if forms:
            hits, where = identify(mol, forms)
            if hits:
                break
    return mol, removed, (hits, where)


def identify(piece, forms):
    """Every library id whose form covers ALL of the fragment — its atoms AND its bonds.

    Covering the atoms is not enough, and auditing the whole library is what showed it. A query
    written from an open-chain unit maps happily onto the atoms of a ring of the same size, because
    a ring contains such a path; with only the atom set compared, cyclohexylglycine came back also
    claimed by 2-aminooctanoic acid, and the bicyclic Tic by N-methylphenylalanine. Same formula,
    same atom count, different compound. Requiring the bond count to agree as well makes the match
    a true isomorphism: the matched bonds are a subset of the fragment's, so equal counts means
    equal sets.

    Chirality is part of the question too, not a refinement: without it the two configurations of a
    unit are indistinguishable. Several ids means the library holds forms that genuinely cannot be
    told apart, which is reported rather than guessed at."""
    real = {a.GetIdx() for a in piece.GetAtoms() if a.GetAtomicNum() > 0}
    bonds = sum(1 for b in piece.GetBonds()
                if b.GetBeginAtomIdx() in real and b.GetEndAtomIdx() in real)
    hits, where = [], {}
    for mid, query, count, condensed in forms:
        if count != len(real) or query.GetNumBonds() != bonds or mid in where:
            continue
        for match in piece.GetSubstructMatches(query, uniquify=True, maxMatches=MAX_MATCHES,
                                               useChirality=True):
            if set(match) == real:
                hits.append(mid)
                where[mid] = condensed
                break
    return hits, where


def _resolve(mol, bonds, forms):
    """Cut at `bonds` and identify each fragment: [(piece, original atoms, groups, hits, where)]."""
    resolved = []
    for piece, original in cut(mol, bonds):
        piece, gone, (hits, where) = deprotect(piece, forms)
        resolved.append((piece, original, gone, hits, where))
    return resolved


def _covered(resolved):
    """Atoms that lie in an identified fragment.

    The objective has to be atoms, not the NUMBER of fragments named. Merging a split unit back
    together replaces one named half and one unknown half with a single named unit, so the count
    does not move and a count-based objective rejects the very repair it was written for — measured:
    the repair pass changed nothing until this was atoms."""
    return sum(len(entry[1]) for entry in resolved if entry[3])


def repair(mol, bonds, forms):
    """Put back any link bond that turns out to lie INSIDE a unit.

    The link pattern is a motif, and a few building blocks contain that motif in their own
    structure — a unit built from two smaller ones joined the same way, or one carrying an internal
    amide. Cutting there splits a unit in half, and the halves are then reported as two unknown
    fragments: the atoms all balance, so nothing looks wrong unless the answer is known. Auditing
    the whole library found four such units.

    No way to tell from the bond alone which case it is, so this asks the library: uncut a bond next
    to an unidentified fragment, and keep the change only if it names MORE fragments than before.
    Greedy, bounded, and it cannot make the answer worse because a round that does not improve the
    count is discarded."""
    best = _resolve(mol, bonds, forms)
    if not forms:
        return bonds, best
    for _ in range(MAX_REPAIR_ROUNDS):
        unresolved = {i for entry in best if not entry[3] for i in entry[1]}
        if not unresolved:
            break
        suspects = []
        for idx in bonds:
            bond = mol.GetBondWithIdx(idx)
            if bond.GetBeginAtomIdx() in unresolved or bond.GetEndAtomIdx() in unresolved:
                suspects.append(idx)
            if len(suspects) >= MAX_SUSPECT_BONDS:
                break
        improved = None
        for idx in suspects:
            trial = [b for b in bonds if b != idx]
            got = _resolve(mol, trial, forms)
            if _covered(got) > _covered(best):
                if improved is None or _covered(got) > _covered(improved[1]):
                    improved = (trial, got)
        if improved is None:
            break
        bonds, best = improved[0], improved[1]
    return bonds, best


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
        found = link_bonds(mol)
        bonds, resolved = repair(mol, found, forms)
        record = {"input": raw, "target": Chem.MolToSmiles(mol), "atoms": mol.GetNumAtoms(),
                  "linkBonds": len(bonds), "units": [], "unidentified": [],
                  "protectingGroups": {}, "hasLibrary": bool(forms),
                  **({"linkBondsInsideAUnit": len(found) - len(bonds)} if len(found) != len(bonds) else {})}
        covered = 0
        for piece, original, gone, hits, where in resolved:
            for name in gone:
                record["protectingGroups"][name] = record["protectingGroups"].get(name, 0) + 1
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
