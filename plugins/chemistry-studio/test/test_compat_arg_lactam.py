"""Arginine losing itself to a delta-lactam while its own carboxyl is activated.

PEPTIDE-TODO Phase 2.5: "Arg(Pbf) delta-lactam during activation of its own carboxyl". Activate an
Fmoc-Arg(Pbf)-OH and the side-chain guanidine, three carbons away, reaches its own activated
carbonyl and closes a lactam. The residue is consumed without coupling, which shows up as a
DELETION in the sequence — the chain is one residue short and every mass after it is wrong.

This one needed a slot the compatibility tables did not have. ATTACKS answers the question "a
group SURVIVES into the product although a reagent attacks it", and it is evaluated only for
groups in `survives`. Here the hazard is the opposite shape: the species is MEANT to react, and
the worry is that it reacts with ITSELF instead. In a coupling step the arginine's acid is consumed
either way, so it is never in `survives` and the existing loop skipped it before reaching any
table entry.

So there is a second table, ACTIVATION_RISKS, read against the groups PRESENT IN THE REACTANTS
rather than the survivors. The shape is deliberately identical to ATTACKS so a chemist reads it the
same way, and `seen` is shared so one (group, reagent) pair cannot be reported twice.

Severity is MEDIUM, not high, and that is a judgment worth stating: lactam formation is real but it
is governed by how long the residue sits pre-activated, which the route's conditions text usually
does not say. The tables' own rule is "medium when it depends on conditions, amount or substrate".
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

FMOC_ARG_PBF = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4"
                "C5=CC=CC=C35)N)C")
# The same residue once it has coupled: no free acid, so nothing to activate.
ARG_COUPLED = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)NC)NC(=O)OCC3C4=CC=CC=C4"
               "C5=CC=CC=C35)N)C")
L_ARGININE = "NC(=N)NCCC[C@@H](C(=O)O)N"
FMOC_LYS_BOC = "CC(C)(C)OC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
GLYCINE = "C(C(=O)O)N"
# A dipeptide the coupling would give, used as the product side.
ARG_GLY = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)NCC(=O)O)NC(=O)OCC3C4=CC=CC=C4"
           "C5=CC=CC=C35)N)C")

GROUP = "arg-delta-lactam"
COUPLING = "HBTU, DIPEA, DMF, 30 min pre-activation"


def hazards_for(reactants, products, reagents):
    out = W._compatibility([{"reactants": reactants, "products": products, "reagents": reagents}])
    assert len(out) == 1, "one step in, one step out"
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


def formula(smiles):
    from rdkit.Chem import rdMolDescriptors
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class ThePatternPicksArginine(unittest.TestCase):
    def setUp(self):
        self.query = Chem.MolFromSmarts(T.GROUPS[GROUP][1])

    def test_the_smarts_compiles(self):
        self.assertIsNotNone(self.query)

    def test_it_matches_the_shipped_block_and_the_free_residue(self):
        # The guanidine is written as a C=N tautomer in the shipped SMILES, which is why the bonds
        # in the pattern are unspecified rather than single.
        for smiles in (FMOC_ARG_PBF, L_ARGININE):
            self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(self.query), smiles)

    def test_an_already_coupled_arginine_is_silent(self):
        self.assertFalse(Chem.MolFromSmiles(ARG_COUPLED).HasSubstructMatch(self.query),
                         "no free carboxyl, so there is nothing to activate")

    def test_lysine_is_not_arginine(self):
        self.assertFalse(Chem.MolFromSmiles(FMOC_LYS_BOC).HasSubstructMatch(self.query),
                         "an amine is not a guanidine and does not close this ring")


class TheFlagFiresOnActivation(unittest.TestCase):
    def test_coupling_the_arginine_raises_it(self):
        found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_fires_even_though_the_acid_is_consumed(self):
        # The point of the new table. The arginine is gone from the product side, so ATTACKS can
        # never see it; this assertion is what distinguishes the two mechanisms.
        out = W._compatibility([{"reactants": [GLYCINE, FMOC_ARG_PBF], "products": [ARG_GLY],
                                 "reagents": COUPLING}])[0]
        self.assertIn(GROUP, {h["group"] for h in out["hazards"]})
        self.assertNotIn(GROUP, {h["group"] for h in out["hazards"] if h["severity"] == "high"},
                         "condition-dependent, so medium")

    def test_it_is_medium(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
                      if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "medium")

    def test_it_names_the_consequence_and_a_remedy(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("lactam", words, f"name what forms: {words}")
        self.assertIn("deletion", words, f"name what it costs: {words}")
        self.assertTrue(any(k in words for k in ("pre-activation", "double", "in situ", "excess")),
                        f"name a remedy: {words}")


class TheFlagStaysQuietElsewhere(unittest.TestCase):
    def test_no_coupling_agent_means_no_flag(self):
        found = hazards_for([FMOC_ARG_PBF], [FMOC_ARG_PBF], "20% piperidine in DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_an_already_coupled_arginine_is_not_flagged(self):
        found = hazards_for([GLYCINE, ARG_COUPLED], [ARG_COUPLED], COUPLING)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_coupling_a_different_residue_is_not_flagged(self):
        found = hazards_for([GLYCINE, FMOC_LYS_BOC], [GLYCINE], COUPLING)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


class TheNewTableDoesNotDisturbTheOldOne(unittest.TestCase):
    """ACTIVATION_RISKS is read beside ATTACKS, not instead of it."""

    def test_the_asn_dehydration_flag_still_fires_on_an_acylating_step(self):
        # An unprotected asparagine side chain surviving a coupling: the pre-existing ATTACKS
        # entry, which must be unaffected by the new branch.
        asn = "NC(=O)C[C@H](N)C(=O)O"
        asn_coupled = "NC(=O)C[C@H](NC(C)=O)C(=O)O"
        found = hazards_for([asn], [asn_coupled], "DIC, HOBt, DMF")
        self.assertIn("asn-gln-amide", groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_hazard_is_not_reported_twice(self):
        found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
        pairs = [(h["group"], h["reagentClass"]) for h in found]
        self.assertEqual(len(pairs), len(set(pairs)), f"duplicate hazard: {pairs}")


class WhatBenoitonSaysActuallyClosesIt(unittest.TestCase):
    """The sourced rules, added 2026-10-17 after reading rather than inferring.

    Benoiton, *Chemistry of Peptide Synthesis* Section 6.11 (printed pp. 170-172) and the caption
    of its Figure 6.11. Three sentences decide this suite:

      * "When an arginyl residue is activated, there is a tendency for cyclization to the
        delta-lactam; the tendency is so great that protonation is insufficient to prevent the
        intramolecular reaction. So unprotected arginyl is rarely employed for coupling."
      * "Cyclization occurs even for residues that are protected on the side chain IF THE PROTECTOR
        IS NOT AT THE DELTA-ATOM." Pbf, Pmc, Mtr and tosyl are all N-omega arylsulfonyls, so
        Fmoc-Arg(Pbf)-OH does NOT close this, and a route using it must not be scored as safe. Of
        the terminal-substituent approach: "The protection provided is not always complete."
      * Figure 6.11: "N-delta,N-omega-bis-(Adoc = 1-adamantyloxycarbonyl)-substituted Boc- and
        Cbz-arginine are derivatives that can be coupled WITHOUT THIS SIDE-REACTION OCCURRING."

    And for the conditions half, *Peptide Synthesis: Methods and Protocols* (MiMB 2103) Ch. 6
    p. 95: HE-SPPS "decreased levels of side reactions such as gamma-lactam formation in arginine
    and aspartimide formation presumably due to optimized coupling and deprotection conditions",
    the coupling being "in situ carbodiimide-based activation using DIC/Oxyma for 2 min". Benoiton
    calls the ring the delta-lactam and M&P the gamma-lactam; same ring.
    """

    # Benoiton's Figure 6.11 derivative, with Boc standing in for Adoc: the same carbamate on the
    # same nitrogen, and the one the package could actually make with its own `boc-protection`.
    # C11H22N4O4 - pinned, so a silent edit here shows up as a formula.
    N_DELTA_BOC_ARG = "O=C(OC(C)(C)C)N(CCC[C@@H](N)C(=O)O)C(N)=N"

    def test_the_delta_protected_derivative_is_what_it_claims(self):
        self.assertEqual(formula(self.N_DELTA_BOC_ARG), "C11H22N4O4")

    def test_a_delta_protected_arginine_CLEARS_the_flag(self):
        # The structural remedy has to be expressible, or the flag is a warning nothing can answer.
        found = hazards_for([GLYCINE, self.N_DELTA_BOC_ARG], [ARG_GLY], COUPLING)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_Arg_Pbf_STILL_FLAGS_because_the_sulfonyl_is_not_at_the_delta_nitrogen(self):
        # The row of the rubric that matters most. If this ever goes silent, every route using the
        # standard arginine block is being scored as having handled a hazard it has not.
        found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
        self.assertIn(GROUP, groups_in(found),
                      "Pbf is an N-omega sulfonyl; Benoiton 6.11 says cyclization occurs anyway")

    def test_the_free_residue_still_flags(self):
        found = hazards_for([GLYCINE, L_ARGININE], [ARG_GLY], COUPLING)
        self.assertIn(GROUP, groups_in(found))

    def test_a_rapid_in_situ_carbodiimide_coupling_CLEARS_it(self):
        # Closes the gap the hazard panel pinned: before this, NO conditions cleared the flag, so
        # it fired on a route that had taken the very precaution its own remedy text recommends.
        for conditions in ("DIC (5 eq), Oxyma (5 eq), DMF, 2 min, in situ, no pre-activation",
                           "Fmoc-Arg(Pbf)-OH, DIC/Oxyma in situ, DMF, 90 C, 2 min",
                           "in-situ activation, DIC, Oxyma Pure, no premix"):
            with self.subTest(conditions):
                found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], conditions)
                self.assertNotIn(GROUP, groups_in(found), f"{conditions}: {groups_in(found)}")

    def test_a_LONG_PRE_ACTIVATION_with_an_onium_salt_still_flags(self):
        # The case the source warns about, and the one the default fixture uses: an onium salt with
        # a pre-activation step is where the lactam wins. Benoiton Section 4.21 item 8 names
        # pre-activation with exposure to tertiary amine as an origin of impurity in its own right.
        for conditions in (COUPLING, "HATU, DIPEA, 20 min pre-activation then add resin",
                           "PyBOP, NMM, DMF, pre-activate 15 min"):
            with self.subTest(conditions):
                found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], conditions)
                self.assertIn(GROUP, groups_in(found), f"{conditions}: {groups_in(found)}")

    def test_a_carbodiimide_WITHOUT_the_in_situ_or_additive_does_not_clear_it(self):
        # DIC alone is not what M&P credits. The claim is about the in-situ DIC/Oxyma pair, and
        # letting any carbodiimide silence the flag would overclaim the source.
        found = hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], "DIC, DMF, 60 min, pre-activated")
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_remedy_now_LEADS_with_the_building_block_not_the_conditions(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_ARG_PBF], [ARG_GLY], COUPLING)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("delta", words, f"name the nitrogen that has to be protected: {words}")
        self.assertIn("pbf", words, "say plainly that Pbf does not close it")
        self.assertTrue(any(k in words for k in ("in situ", "in-situ", "pre-activation")),
                        f"name the conditions mitigation too: {words}")


# Appended tests have twice been stranded by a `unittest.main()` sitting mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
