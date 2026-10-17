"""An N-terminal glutamine cyclising to pyroglutamate.

PEPTIDE-TODO Phase 2.5: "N-terminal Gln -> pyroglutamate (gate: Gln at position 1 after
deprotection)". The free alpha-amine attacks its own side-chain amide five atoms away, closes the
five-membered lactam and expels ammonia. The peptide loses its N-terminal amine — it can no longer
be extended, and it is a different molecule from the one asked for.

The gate that matters is WHERE this is a real hazard rather than a step in every cycle. A free
N-terminal glutamine exists for a moment in EVERY round of a synthesis: deprotect, then couple. If
the flag fired at each Fmoc removal it would fire on every Gln-containing route many times over and
mean nothing. What makes it real is acid with nowhere further to go — the final cleavage, where the
N-terminal amine is free and stays free. So this is gated on `strong-acid` only, and the tests pin
the fact that an ordinary piperidine deprotection does NOT raise it.

The rest of the conjunction is carried by the SMARTS, so each half is a separate control:
  - the alpha-amine must be FREE (a mid-chain glutamine has an amide there and is silent),
  - the side chain must be a PRIMARY amide two carbons out (asparagine, one carbon, cannot reach),
  - and Fmoc-Gln(Trt)-OH ships, so the trityl-protected side chain must clear the flag.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import rdMolDescriptors

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

TRT = "C(c1ccccc1)(c1ccccc1)c1ccccc1"
# H-Gln-Ala-OH: the N-terminal glutamine, free amine.
GLN_ALA = "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)O"
# The same with the side-chain amide tritylated — the shipped remedy, Fmoc-Gln(Trt)-OH's side chain.
GLN_TRT_ALA = "O=C(CC[C@H](N)C(=O)N[C@@H](C)C(=O)O)N" + TRT
# Mid-chain glutamine: the alpha-nitrogen is an amide, so nothing can close.
AC_GLN_ALA = "CC(=O)N[C@H](CCC(N)=O)C(=O)N[C@@H](C)C(=O)O"
# Asparagine: one CH2 short, so the ring it would have to close is four-membered.
ASN_ALA = "NC(=O)C[C@H](N)C(=O)N[C@@H](C)C(=O)O"
# What the hazard produces, if the route declared it: the lactam, ammonia expelled.
PYROGLU_ALA = "O=C1CC[C@H](N1)C(=O)N[C@@H](C)C(=O)O"
# A cleavage substrate needs something acid-labile for the step to make sense.
TBU_GLN_ALA = "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)OC(C)(C)C"

GROUP = "n-terminal-gln"
CLEAVAGE = "TFA/H2O 95:5, 2 h"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1, "one step in, one step out"
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class ThePatternPicksTheRightResidue(unittest.TestCase):
    def setUp(self):
        self.query = Chem.MolFromSmarts(T.GROUPS[GROUP][1])

    def test_the_smarts_compiles(self):
        self.assertIsNotNone(self.query)

    def test_it_matches_a_free_n_terminal_glutamine(self):
        self.assertTrue(Chem.MolFromSmiles(GLN_ALA).HasSubstructMatch(self.query))

    def test_a_mid_chain_glutamine_is_silent(self):
        self.assertFalse(Chem.MolFromSmiles(AC_GLN_ALA).HasSubstructMatch(self.query),
                         "an acylated alpha-nitrogen cannot attack anything")

    def test_asparagine_is_silent(self):
        self.assertFalse(Chem.MolFromSmiles(ASN_ALA).HasSubstructMatch(self.query),
                         "one CH2 short: the ring would be four-membered")

    def test_the_tritylated_side_chain_is_silent(self):
        self.assertFalse(Chem.MolFromSmiles(GLN_TRT_ALA).HasSubstructMatch(self.query),
                         "Fmoc-Gln(Trt)-OH is the remedy, so it must clear the flag")

    def test_the_product_of_the_hazard_is_silent(self):
        self.assertFalse(Chem.MolFromSmiles(PYROGLU_ALA).HasSubstructMatch(self.query),
                         "once cyclised there is nothing left to warn about")

    def test_the_substrates_are_what_they_claim(self):
        self.assertEqual(formula(GLN_ALA), "C8H15N3O4")
        self.assertEqual(formula(PYROGLU_ALA), "C8H12N2O4")
        # the difference between them is exactly the ammonia expelled
        self.assertEqual(formula(ASN_ALA), "C7H13N3O4")


class TheFlagFiresOnCleavage(unittest.TestCase):
    def test_the_step_that_UNMASKS_the_side_chain_amide(self):
        # harness-runs/hazard-7 step 19: the trityl comes off the glutamine side chain in acid, so
        # the primary amide the alpha-amine closes onto exists only on the PRODUCT side. The
        # tritylated reactant deliberately matches nothing, which is what made the reactant-side
        # reading miss this step entirely.
        found = hazards_for(GLN_TRT_ALA, GLN_ALA, CLEAVAGE)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_acid_cleavage_raises_it(self):
        found = hazards_for(TBU_GLN_ALA, GLN_ALA, CLEAVAGE)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_names_the_product_and_the_remedy(self):
        hazard = next(h for h in hazards_for(TBU_GLN_ALA, GLN_ALA, CLEAVAGE) if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("pyroglutamate", words, f"name what forms: {words}")
        self.assertIn("ammonia", words, f"name what leaves: {words}")
        self.assertTrue(any(k in words for k in ("trt", "trityl")), f"name the remedy: {words}")


class TheFlagStaysQuietElsewhere(unittest.TestCase):
    def test_an_ordinary_fmoc_removal_does_not_raise_it(self):
        # The wallpaper case this gate exists to avoid: every cycle frees an N-terminal amine for a
        # moment, and the next coupling consumes it.
        found = hazards_for(GLN_ALA, GLN_ALA, "20% piperidine in DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_coupling_does_not_raise_it(self):
        found = hazards_for(GLN_ALA, AC_GLN_ALA, "HBTU, DIPEA, DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_declared_cyclisation_is_not_flagged(self):
        # If the route SAYS the pyroglutamate forms, the group reacted and there is no bystander.
        found = hazards_for(GLN_ALA, PYROGLU_ALA, CLEAVAGE)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_tritylated_peptide_is_not_flagged_in_acid(self):
        found = hazards_for(GLN_TRT_ALA, GLN_TRT_ALA, CLEAVAGE)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_asparagine_in_acid_is_not_flagged(self):
        found = hazards_for(ASN_ALA, ASN_ALA, CLEAVAGE)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


if __name__ == "__main__":
    unittest.main()
