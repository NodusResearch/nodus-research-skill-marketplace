"""Read a peptide target as an ORDERED sequence, because aggregation is a positional question.

`decompose()` answers "which residues is this made of" — a multiset. The aggregation advisory needs
a sequence: its length window is counted from the resin and its spacing rule is a distance, and
neither can be computed from a bag of residues. Nothing in the package returned residues in order,
which is the gap this fills.

Why it reads the TARGET rather than an intermediate: the target is the free peptide, so its side
chains are the canonical ones. An on-resin intermediate carries tBu, Trt, Pbf and Boc, and matching
those would mean knowing every protected form of every residue. Aggregation is a property of the
sequence being built, so the target is also the right thing to ask about.

The orientation is pinned deliberately and in both directions: the reader returns residues N to C,
as a sequence is written, while the advisory counts positions from the resin, which is the
C-terminus. Getting that backwards would put every window at the wrong end of the chain.

It refuses rather than guesses. A target with a residue it cannot name comes back with the letters
it did read and a reason, so the caller can say "could not read the chain" instead of going quiet —
the monomer recognition has known gaps, and silence is indistinguishable from "no risk found".
"""

import os
import sys
import unittest

from rdkit import Chem, RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import peptide_sequence as S

RDLogger.DisableLog("rdApp.*")

# The hazard-7 target, built by the prompt generator from the monomer library: Gln-Trp-Arg-Cys-
# Ser-Gly-Ala.
QWRCSGA = ("N[C@@H](CCC(N)=O)C(=O)N[C@@H](Cc1c[nH]c2ccccc21)C(=O)N[C@@H](CCCNC(N)=N)C(=O)"
           "N[C@@H](CS)C(=O)N[C@@H](CO)C(=O)NCC(=O)N[C@@H](C)C(=O)O")
# chainS-4's target, from the ladder prompts: Gly-Ala-Ser-Val.
GASV = "NCC(=O)N[C@@H](C)C(=O)N[C@@H](CO)C(=O)N[C@@H](C(C)C)C(=O)O"
# The risk notes' worked example.
AAFFMNSGDTH = ("N[C@@H](C)C(=O)N[C@@H](C)C(=O)N[C@@H](Cc1ccccc1)C(=O)N[C@@H](Cc1ccccc1)C(=O)"
               "N[C@@H](CCSC)C(=O)N[C@@H](CC(N)=O)C(=O)N[C@@H](CO)C(=O)NCC(=O)"
               "N[C@@H](CC(=O)O)C(=O)N[C@@H]([C@@H](C)O)C(=O)N[C@@H](Cc1c[nH]cn1)C(=O)O")
# Every canonical residue once, including proline, whose side chain closes onto its own backbone
# nitrogen and so is the one the walk has to special-case.
ALL_TWENTY = ("N[C@@H](C)C(=O)N[C@@H](CCCNC(N)=N)C(=O)N[C@@H](CC(N)=O)C(=O)N[C@@H](CC(=O)O)C(=O)"
              "N[C@@H](CS)C(=O)N[C@@H](CCC(N)=O)C(=O)N[C@@H](CCC(=O)O)C(=O)NCC(=O)"
              "N[C@@H](Cc1c[nH]cn1)C(=O)N[C@@H]([C@@H](C)CC)C(=O)N[C@@H](CC(C)C)C(=O)"
              "N[C@@H](CCCCN)C(=O)N[C@@H](CCSC)C(=O)N[C@@H](Cc1ccccc1)C(=O)N1CCC[C@H]1C(=O)"
              "N[C@@H](CO)C(=O)N[C@@H]([C@@H](C)O)C(=O)N[C@@H](Cc1c[nH]c2ccccc21)C(=O)"
              "N[C@@H](Cc1ccc(O)cc1)C(=O)N[C@@H](C(C)C)C(=O)O")
RESIN_BOUND = "*OC(=O)[C@H](C)NC(=O)CNC(=O)[C@H](CO)N"   # H-Ser-Gly-Ala-resin
NOT_A_PEPTIDE = "CC(=O)Oc1ccccc1C(=O)O"                   # aspirin


class ItReadsTheSequence(unittest.TestCase):
    def test_side_chain_acids_never_choose_the_chain_direction(self):
        # Atom order is not chemistry: Asp/Glu side-chain acids may occur after the
        # C-terminal acid in an equivalent SMILES, including in internal residues.
        for sequence in ("GAD", "GAE", "DGA", "EGA", "ADG", "AEG"):
            mol = Chem.MolFromSequence(sequence)
            for order in (list(range(mol.GetNumAtoms())), list(reversed(range(mol.GetNumAtoms())))):
                smiles = Chem.MolToSmiles(Chem.RenumberAtoms(mol, order), canonical=False)
                with self.subTest(sequence=sequence, smiles=smiles):
                    read = S.read_sequence(smiles)
                    self.assertEqual(read.sequence, sequence, read.problem)
                    self.assertIsNone(read.problem)

    def test_the_hazard_route_target(self):
        read = S.read_sequence(QWRCSGA)
        self.assertEqual(read.sequence, "QWRCSGA", read.problem)
        self.assertIsNone(read.problem)

    def test_a_ladder_target(self):
        self.assertEqual(S.read_sequence(GASV).sequence, "GASV")

    def test_the_risk_notes_example(self):
        self.assertEqual(S.read_sequence(AAFFMNSGDTH).sequence, "AAFFMNSGDTH")

    def test_every_canonical_residue_including_proline(self):
        read = S.read_sequence(ALL_TWENTY)
        self.assertIsNone(read.problem, read.problem)
        self.assertEqual(read.sequence, "ARNDCQEGHILKMFPSTWYV")
        self.assertEqual(len(set(read.sequence)), 20, "each one exactly once")

    def test_it_reads_N_to_C_as_a_sequence_is_written(self):
        # GASV: glycine carries the free amine, valine the free acid. Reading it backwards would
        # give VSAG and put every window at the wrong end of the chain.
        self.assertEqual(S.read_sequence(GASV).sequence[0], "G")
        self.assertEqual(S.read_sequence(GASV).sequence[-1], "V")

    def test_a_resin_bound_chain_reads_too(self):
        # The support ester stands in for the C-terminal acid, so an on-resin chain is readable as
        # long as its side chains are free.
        self.assertEqual(S.read_sequence(RESIN_BOUND).sequence, "SGA")


class ItRefusesRatherThanGuessing(unittest.TestCase):
    def test_a_small_molecule_is_not_a_peptide(self):
        read = S.read_sequence(NOT_A_PEPTIDE)
        self.assertEqual(read.sequence, "")
        self.assertTrue(read.problem, "it must say why, not return empty silently")

    def test_a_single_amino_acid_is_not_a_chain(self):
        read = S.read_sequence("N[C@@H](C)C(=O)O")
        self.assertTrue(read.problem, read.problem)

    def test_an_unnamed_side_chain_is_reported_with_what_WAS_read(self):
        # A non-natural residue (here alpha-aminobutyric acid) in an otherwise ordinary chain. The
        # monomer recognition has known gaps, so the honest answer is "this much, and then I could
        # not name one" — silence would be indistinguishable from "nothing to worry about".
        abu = "N[C@@H](CC)C(=O)N[C@@H](C)C(=O)N[C@@H](CO)C(=O)O"
        read = S.read_sequence(abu)
        self.assertTrue(read.problem, "an unnamed residue must be reported")
        self.assertIn("?", read.sequence + (read.problem or ""),
                      f"and placed, not dropped: {read.sequence} / {read.problem}")

    def test_garbage_in_is_a_problem_not_an_exception(self):
        for smiles in ("", "not a smiles", None):
            read = S.read_sequence(smiles)
            self.assertEqual(read.sequence, "")
            self.assertTrue(read.problem)

    def test_a_branched_or_cyclic_peptide_is_declined(self):
        # A head-to-tail cyclic peptide has no free acid to start the walk from. Declining is right:
        # aggregation as modelled here is about a linear chain growing on a support.
        cyclic = "O=C1C[C@@H](C)NC(=O)[C@@H](C)NC(=O)[C@@H](C)N1"
        read = S.read_sequence(cyclic)
        self.assertTrue(read.problem, read.problem)


class ItFeedsTheAdvisory(unittest.TestCase):
    def test_the_two_fit_together(self):
        import peptide_aggregation as A
        read = S.read_sequence(QWRCSGA)
        advisory = A.aggregation_advisory(read.sequence)
        self.assertEqual(advisory["suspect"], [], "QWRCSGA is hydrophilic; nothing to report")

    def test_a_hydrophobic_target_reaches_the_advisory(self):
        import peptide_aggregation as A
        # Ala-Val-Ile-Leu-Phe-Val-Ile-Leu-Phe-Ser-Gly-Ala-Asp-Lys-Arg: an interior hydrophobic run.
        seq = ("N[C@@H](C)C(=O)N[C@@H](C(C)C)C(=O)N[C@@H]([C@@H](C)CC)C(=O)N[C@@H](CC(C)C)C(=O)"
               "N[C@@H](Cc1ccccc1)C(=O)N[C@@H](C(C)C)C(=O)N[C@@H]([C@@H](C)CC)C(=O)"
               "N[C@@H](CC(C)C)C(=O)N[C@@H](Cc1ccccc1)C(=O)N[C@@H](CO)C(=O)NCC(=O)"
               "N[C@@H](C)C(=O)N[C@@H](CC(=O)O)C(=O)N[C@@H](CCCCN)C(=O)"
               "N[C@@H](CCCNC(N)=N)C(=O)O")
        read = S.read_sequence(seq)
        self.assertIsNone(read.problem, read.problem)
        self.assertEqual(read.sequence, "AVILFVILFSGADKR")
        advisory = A.aggregation_advisory(read.sequence)
        self.assertTrue(advisory["suspect"], f"an interior hydrophobic run is suspect: {advisory}")


if __name__ == "__main__":
    unittest.main()
