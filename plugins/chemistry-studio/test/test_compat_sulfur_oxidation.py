"""Methionine and cysteine oxidation — and the survey that decided what this fix should be.

PEPTIDE-TODO Phase 2.5 asked for this one conditionally: "Met/Cys oxidation — check what existing
oxidant classes already cover before adding". The survey (2026-10-17) says the hazard RULES are
already there and the REAGENTS are not:

    chromium-oxidant  thiol high, sulfide medium      L-methionine   -> matches `sulfide`
    peracid           thiol high, sulfide high        L-cysteine     -> matches `thiol`
    alcohol-oxidant   thiol medium                    Fmoc-Cys(Trt)  -> matches `sulfide`
    alkene-cleavage   sulfide medium

    classify('30% H2O2, AcOH')   -> []        classify('air')  -> []
    classify('hydrogen peroxide')-> []        classify('O2')   -> []
    classify('DMSO')             -> []

So the most ordinary oxidant a peptide chemist would write raised nothing — not because the table
lacked a rule for it, but because nothing recognised the reagent. Adding another hazard would have
been the wrong fix; what was missing is one class and one pattern.

Two deliberate restrictions, both of them judgments about wallpaper rather than chemistry:

  - BARE DMSO IS NOT AN OXIDANT HERE. DMSO is the solvent half the steps in a peptide route are run
    in, and at room temperature it does not oxidise a methionine appreciably. Flagging every DMSO
    step would bury the real ones. DMSO/TFA, which IS used to oxidise Met and to close disulfides,
    is recognised through its acid.
  - AIR ATTACKS THE FREE THIOL AND THE METHIONINE SULFIDE, but not an S-tritylated cysteine. A free
    cysteine air-oxidises to the disulfide; methionine gives the +16 sulfoxide that Chan & White
    Table 5 lists, so the `met-sulfide` group is its own pattern (the two-CH2 Met chain) and the
    shipped Fmoc-Cys(Trt)-OH stays silent under air. The old thioether exemption was too broad.

And the disulfide case carries a caveat the others do not: forming one is often the POINT (the
cyclisation work in Phase 2), so the message has to say "if that is what this step is for, declare
it" rather than treat it as damage.
"""

import os
import sys
import unittest

from rdkit import RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

MET_PEPTIDE = "CSCC[C@H](NC(C)=O)C(=O)N[C@@H](C)C(=O)O"
CYS_PEPTIDE = "SC[C@H](NC(C)=O)C(=O)N[C@@H](C)C(=O)O"
CYS_TRT_PEPTIDE = ("C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@H](NC(C)=O)C(=O)N[C@@H](C)"
                   "C(=O)O")
ALA_PEPTIDE = "C[C@H](NC(C)=O)C(=O)N[C@@H](C)C(=O)O"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


class ThePeroxideIsRecognisedNow(unittest.TestCase):
    """The gap the survey found: the rule existed, the reagent did not."""

    def test_hydrogen_peroxide_classifies_as_a_peroxide_oxidant(self):
        for text in ("30% H2O2, AcOH", "hydrogen peroxide, water", "H2O2 (aq)"):
            with self.subTest(text):
                self.assertIn("peracid", T.classify(text), f"{text} -> {T.classify(text)}")

    def test_it_does_not_match_inside_another_formula(self):
        # The formula-token lookarounds matter: a step naming water or a hydroxide is not a peroxide.
        for text in ("H2O only", "NaOH, H2O", "TFA/H2O 95:5"):
            with self.subTest(text):
                self.assertNotIn("peracid", T.classify(text), f"{text} -> {T.classify(text)}")

    def test_methionine_is_flagged_under_peroxide(self):
        found = hazards_for(MET_PEPTIDE, MET_PEPTIDE, "30% H2O2, AcOH")
        self.assertIn("sulfide", groups_in(found), f"hazards were {groups_in(found)}")

    def test_cysteine_is_flagged_under_peroxide(self):
        found = hazards_for(CYS_PEPTIDE, CYS_PEPTIDE, "30% H2O2, AcOH")
        self.assertIn("thiol", groups_in(found), f"hazards were {groups_in(found)}")


class AirOxidisesTheThiolOnly(unittest.TestCase):
    def test_air_oxidation_classifies(self):
        for text in ("air oxidation, pH 8, 24 h", "aerobic oxidation", "open to the air, 48 h",
                     "O2, pH 7.5"):
            with self.subTest(text):
                self.assertIn("air-oxidation", T.classify(text), f"{text} -> {T.classify(text)}")

    def test_a_free_cysteine_is_flagged(self):
        found = hazards_for(CYS_PEPTIDE, CYS_PEPTIDE, "air oxidation, pH 8, 24 h")
        self.assertIn("thiol", groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_message_allows_for_a_DELIBERATE_disulfide(self):
        hazard = next(h for h in hazards_for(CYS_PEPTIDE, CYS_PEPTIDE, "air oxidation, pH 8, 24 h")
                      if h["group"] == "thiol")
        words = hazard["why"].lower()
        self.assertIn("disulfide", words, words)
        self.assertTrue(any(k in words for k in ("intend", "deliberate", "on purpose", "declare")),
                        f"forming one is often the point: {words}")

    def test_a_tritylated_cysteine_is_silent_under_air(self):
        found = hazards_for(CYS_TRT_PEPTIDE, CYS_TRT_PEPTIDE, "air oxidation, pH 8, 24 h")
        self.assertNotIn("thiol", groups_in(found), "the S-trityl is the remedy and must clear it")

    def test_methionine_is_flagged_under_air_as_the_sulfoxide(self):
        # Chan & White Table 5: +16 on Met is the sulfoxide. The pattern is the Met side chain, so
        # an S-trityl cysteine is not caught by it.
        found = hazards_for(MET_PEPTIDE, MET_PEPTIDE, "air oxidation, pH 8, 24 h")
        self.assertIn("met-sulfide", groups_in(found), f"hazards were {groups_in(found)}")
        hazard = next(h for h in found if h["group"] == "met-sulfide")
        self.assertEqual(hazard["severity"], "medium")
        self.assertIn("sulfoxide", hazard["why"].lower())

    def test_a_tritylated_cysteine_is_silent_for_the_met_pattern_too(self):
        found = hazards_for(CYS_TRT_PEPTIDE, CYS_TRT_PEPTIDE, "air oxidation, pH 8, 24 h")
        self.assertNotIn("met-sulfide", groups_in(found))


class WhatMustNotBeFlagged(unittest.TestCase):
    def test_bare_DMSO_is_not_an_oxidant(self):
        # The judgment in the docstring: DMSO is the solvent, and flagging every step run in it
        # would bury the real oxidations.
        self.assertEqual(T.classify("DMSO"), [])
        self.assertNotIn("air-oxidation", T.classify("HBTU, DIPEA, DMSO"))
        found = hazards_for(MET_PEPTIDE, MET_PEPTIDE, "HBTU, DIPEA, DMSO")
        self.assertNotIn("sulfide", groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_routine_mention_of_air_is_not_an_oxidation(self):
        for text in ("air-dried overnight", "under an air-tight seal", "dried in a stream of air"):
            with self.subTest(text):
                self.assertNotIn("air-oxidation", T.classify(text), f"{text} -> {T.classify(text)}")

    def test_a_peptide_without_sulfur_is_never_flagged(self):
        for conditions in ("30% H2O2, AcOH", "air oxidation, pH 8, 24 h"):
            with self.subTest(conditions):
                found = hazards_for(ALA_PEPTIDE, ALA_PEPTIDE, conditions)
                self.assertEqual(groups_in(found) & {"thiol", "sulfide"}, set())


if __name__ == "__main__":
    unittest.main()
