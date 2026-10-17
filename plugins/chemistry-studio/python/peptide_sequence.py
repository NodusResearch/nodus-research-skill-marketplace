"""Read a linear peptide as an ORDERED sequence of one-letter residues.

`decompose()` says which residues a target is made of — a multiset. Aggregation is positional: its
length window is counted from the resin and its spacing rule is a distance, so it needs the order.
Nothing else here returns residues in order, which is what this module is for.

HOW IT WALKS. From the C-terminal carboxyl (or the ester to the support, which stands in for it)
to the alpha carbon, then to the backbone nitrogen, then to the previous residue's carbonyl, and
round again. Each alpha carbon's side chain is whatever hangs off it that is not backbone, and it
is named by canonical SMILES against the table below. Proline is the one special case: its side
chain closes onto its own backbone nitrogen, so the ring is recognised before the generic walk.

WHY THE TARGET AND NOT AN INTERMEDIATE. The target is the free peptide, so its side chains are the
canonical ones. An on-resin intermediate carries tBu, Trt, Pbf and Boc, and naming those would mean
a table of every protected form of every residue. Since aggregation is a property of the sequence
being assembled, the target is also the right thing to ask about.

IT REFUSES RATHER THAN GUESSES. A chain with a residue it cannot name comes back with the letters
it did read, a `?` where the unknown sat, and a reason. The monomer recognition has known gaps, and
an empty answer is indistinguishable from "nothing to worry about" — so the caller can say "could
not read the chain" instead of going quiet.
"""

from collections import namedtuple

from rdkit import Chem

# Side chain as canonical SMILES of the fragment rooted at the beta atom, with the alpha carbon
# replaced by a dummy so the attachment point is explicit. Glycine has no side chain at all, and
# proline is handled by its ring before this table is consulted.
Read = namedtuple("Read", "sequence problem")


_ACID = Chem.MolFromSmarts("[CX3](=[OX1])[OX2H1,OX1-]")
_SUPPORT_ESTER = Chem.MolFromSmarts("[#0][OX2][CX3](=[OX1])")
_AMIDE_N = Chem.MolFromSmarts("[NX3][CX3]=[OX1]")


def _side_chain_atoms(mol, alpha, backbone):
    """The atom indices of the side chain hanging off one alpha carbon, or None if it branches."""
    start = [atom.GetIdx() for atom in mol.GetAtomWithIdx(alpha).GetNeighbors()
             if atom.GetIdx() not in backbone and atom.GetAtomicNum() > 1]
    if not start:
        return frozenset()                         # glycine
    if len(start) > 1:
        return None                                # two branches off the alpha carbon
    seen, stack = set(), [start[0]]
    while stack:
        index = stack.pop()
        if index in seen:
            continue
        seen.add(index)
        for neighbour in mol.GetAtomWithIdx(index).GetNeighbors():
            if neighbour.GetIdx() not in backbone and neighbour.GetIdx() != alpha:
                stack.append(neighbour.GetIdx())
    return frozenset(seen)


def _side_chain_key(mol, atoms):
    """A canonical string for a side chain, from its atoms alone.

    Deliberately NOT a hand-written SMILES: the lookup table below is built by running this same
    function over the twenty canonical amino acids, so a residue is named by construction rather
    than by my guess at how RDKit will canonicalise a fragment. Two residues that differ only in
    branching (leucine's CH2-CH(CH3)2 against isoleucine's CH(CH3)-CH2CH3) come out distinct."""
    if not atoms:
        return ""
    return Chem.MolFragmentToSmiles(mol, atomsToUse=sorted(atoms), canonical=True)


def _build_lookup():
    """Side-chain key -> letter, derived from the free amino acids themselves."""
    residues = {
        "A": "N[C@@H](C)C(=O)O", "R": "N[C@@H](CCCNC(N)=N)C(=O)O", "N": "N[C@@H](CC(N)=O)C(=O)O",
        "D": "N[C@@H](CC(=O)O)C(=O)O", "C": "N[C@@H](CS)C(=O)O", "Q": "N[C@@H](CCC(N)=O)C(=O)O",
        "E": "N[C@@H](CCC(=O)O)C(=O)O", "H": "N[C@@H](Cc1c[nH]cn1)C(=O)O",
        "I": "N[C@@H]([C@@H](C)CC)C(=O)O", "L": "N[C@@H](CC(C)C)C(=O)O",
        "K": "N[C@@H](CCCCN)C(=O)O", "M": "N[C@@H](CCSC)C(=O)O",
        "F": "N[C@@H](Cc1ccccc1)C(=O)O", "S": "N[C@@H](CO)C(=O)O",
        "T": "N[C@@H]([C@@H](C)O)C(=O)O", "W": "N[C@@H](Cc1c[nH]c2ccccc21)C(=O)O",
        "Y": "N[C@@H](Cc1ccc(O)cc1)C(=O)O", "V": "N[C@@H](C(C)C)C(=O)O",
    }
    out = {}
    for letter, smiles in residues.items():
        mol = Chem.MolFromSmiles(smiles)
        # Aspartate and glutamate have TWO carboxyls, and only one of them is the alpha one: take
        # the acid whose neighbouring carbon carries the amino nitrogen. Picking the first match
        # named their side chain as the residue, which is how this was found.
        found = None
        for acid in mol.GetSubstructMatches(_ACID):
            for atom in mol.GetAtomWithIdx(acid[0]).GetNeighbors():
                if atom.GetAtomicNum() != 6:
                    continue
                nitrogens = [n.GetIdx() for n in atom.GetNeighbors() if n.GetAtomicNum() == 7]
                if nitrogens:
                    found = (acid, atom.GetIdx(), nitrogens[0])
        if not found:
            raise AssertionError(f"no alpha-amino acid centre found in {letter}: {smiles}")
        acid, alpha, nitrogen = found
        atoms = _side_chain_atoms(mol, alpha, {acid[0], acid[1], acid[2], alpha, nitrogen})
        key = _side_chain_key(mol, atoms)
        if key in out:
            raise AssertionError(f"side chains of {out[key]} and {letter} collide as {key!r}")
        out[key] = letter
    return out


# Built once, from the twenty free amino acids, by the same extraction the walk uses. If two side
# chains ever canonicalise to the same key this raises at import rather than silently misnaming a
# residue.
_SIDE_CHAIN_LOOKUP = _build_lookup()


def read_sequence(smiles):
    """Residues N to C as one letter each, or a `problem` saying why it could not be read."""
    if not smiles or not isinstance(smiles, str):
        return Read("", "no structure to read")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return Read("", "the structure does not parse")

    # Where the chain ends: a free C-terminal acid, or the ester holding it to the support.
    candidates = {match[2] for match in mol.GetSubstructMatches(_SUPPORT_ESTER)}
    if not candidates:
        candidates = {match[0] for match in mol.GetSubstructMatches(_ACID)}
    # Asp/Glu side chains have free acids too. Only a carbonyl next to an alpha
    # carbon bearing nitrogen can be the tail; SMILES atom order cannot choose it.
    candidates = {index for index in candidates
                  if any(atom.GetAtomicNum() == 6
                         and atom.GetHybridization() == Chem.HybridizationType.SP3
                         and any(n.GetAtomicNum() == 7 for n in atom.GetNeighbors())
                         for atom in mol.GetAtomWithIdx(index).GetNeighbors())}
    if not candidates:
        return Read("", "no C-terminal carboxyl or support ester: not a linear peptide chain "
                        "(a cyclic or fully amidated peptide is read elsewhere)")
    if len(candidates) != 1:
        return Read("", "multiple peptide termini: not one unambiguous linear chain")
    tail = next(iter(candidates))

    letters, backbone, carbonyl = [], set(), tail
    while True:
        alphas = [atom.GetIdx() for atom in mol.GetAtomWithIdx(carbonyl).GetNeighbors()
                  if atom.GetAtomicNum() == 6 and atom.GetIdx() not in backbone
                  and atom.GetHybridization() == Chem.HybridizationType.SP3]
        if len(alphas) != 1:
            break
        alpha = alphas[0]
        nitrogens = [atom.GetIdx() for atom in mol.GetAtomWithIdx(alpha).GetNeighbors()
                     if atom.GetAtomicNum() == 7 and atom.GetIdx() not in backbone]
        if len(nitrogens) != 1:
            break
        nitrogen = nitrogens[0]
        backbone |= {carbonyl, alpha, nitrogen}
        # Proline: the side chain closes back onto its own backbone nitrogen.
        in_ring = mol.GetRingInfo().NumAtomRings(alpha) and mol.GetRingInfo().NumAtomRings(nitrogen)
        if in_ring and _ring_is_pyrrolidine(mol, alpha, nitrogen):
            letters.append("P")
        else:
            atoms = _side_chain_atoms(mol, alpha, backbone)
            if atoms is None:
                letters.append("?")
            elif not atoms:
                letters.append("G")
            else:
                letters.append(_SIDE_CHAIN_LOOKUP.get(_side_chain_key(mol, atoms), "?"))
        # Step to the previous residue: this nitrogen's other carbonyl.
        previous = [atom.GetIdx() for atom in mol.GetAtomWithIdx(nitrogen).GetNeighbors()
                    if atom.GetIdx() not in backbone and atom.GetAtomicNum() == 6
                    and any(bond.GetBondType() == Chem.BondType.DOUBLE
                            and bond.GetOtherAtom(atom).GetAtomicNum() == 8
                            for bond in atom.GetBonds())]
        if len(previous) != 1:
            break
        carbonyl = previous[0]

    sequence = "".join(reversed(letters))
    if len(sequence) < 2:
        return Read("", "only one residue could be read: not a chain")
    if "?" in sequence:
        return Read(sequence, f"could not name {sequence.count('?')} residue(s) in the chain "
                              f"(shown as ? in {sequence}); the monomer recognition does not cover "
                              "every non-natural residue, so this is a partial read, not a clean one")
    return Read(sequence, None)


def _ring_is_pyrrolidine(mol, alpha, nitrogen):
    """Five-membered, all carbon but the one nitrogen — proline's ring and not a histidine's."""
    for ring in mol.GetRingInfo().AtomRings():
        if alpha in ring and nitrogen in ring and len(ring) == 5:
            if sum(1 for index in ring if mol.GetAtomWithIdx(index).GetAtomicNum() == 7) == 1 \
                    and not any(mol.GetAtomWithIdx(index).GetIsAromatic() for index in ring):
                return True
    return False
