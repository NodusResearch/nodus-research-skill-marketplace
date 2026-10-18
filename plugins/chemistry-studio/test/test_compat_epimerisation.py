"""Histidine and cysteine losing their configuration during coupling.

PEPTIDE-TODO Phase 2.5: "His/Cys epimerisation on coupling (concrete gate, but severity is
condition-dependent: cap at medium)". Both residues acidify their own alpha-proton once the
carboxyl is activated — cysteine through the sulfur, histidine through its imidazole, which can
take the proton itself — so the activated residue racemises before it couples. The chain that comes
out contains a D residue at that position.

This is the class of error nothing downstream can see. A D residue has the same formula, the same
mass and the same connectivity as the L one, so balance, continuity and target-matching all pass;
only the stereocentre is wrong. It is the same failure the alpha-configuration line exists to catch
in a building block, one step earlier.

It rides on ACTIVATION_RISKS, added for the arginine lactam: the hazard belongs to the species
being activated, whose carboxyl is consumed either way, so ATTACKS cannot reach it.

Severity is MEDIUM for both, which the to-do asked for explicitly and the chemistry supports — how
much epimerisation happens depends on the base, the activator and the temperature, not on the
sequence. The flag CLEARS when the conditions name a recognised mitigation (collidine instead of
DIPEA, Oxyma or HOAt in place of HOBt), so a route that has taken care is not nagged. Temperature
is deliberately NOT parsed: "0 °C" and "10 °C" are a character apart and misreading one would
silence the flag on a route that deserves it.
"""

import os
import sys
import unittest

from rdkit import Chem, RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

FMOC_CYS_TRT = ("C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5"
                "C6=CC=CC=C46")
FMOC_HIS_TRT = ("C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)N4C=C(N=C4)C[C@@H](C(=O)O)NC(=O)OCC5C6="
                "CC=CC=C6C7=CC=CC=C57")
CYS_COUPLED = ("C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@@H](C(=O)NC)NC(=O)OCC4C5=CC=CC=C5"
               "C6=CC=CC=C46")
FMOC_ALA = "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
L_METHIONINE = "CSCC[C@@H](C(=O)O)N"
GLYCINE = "C(C(=O)O)N"
GLY_PRODUCT = "C[C@@H](C(=O)NCC(=O)O)N"

DIPEA = "HBTU, DIPEA, DMF"
COLLIDINE = "HBTU, 2,4,6-collidine, DMF"
OXYMA = "DIC, Oxyma, DMF"


def hazards_for(reactants, products, reagents):
    out = W._compatibility([{"reactants": reactants, "products": products, "reagents": reagents}])
    assert len(out) == 1
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


class ThePatternsPickTheTwoResidues(unittest.TestCase):
    def test_cysteine_free_and_protected(self):
        query = Chem.MolFromSmarts(T.GROUPS["cys-epimerisation"][1])
        self.assertIsNotNone(query)
        for smiles in (FMOC_CYS_TRT, "SC[C@@H](C(=O)O)N"):
            self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(query), smiles)

    def test_histidine_free_and_protected(self):
        query = Chem.MolFromSmarts(T.GROUPS["his-epimerisation"][1])
        self.assertIsNotNone(query)
        for smiles in (FMOC_HIS_TRT, "C1=C(NC=N1)C[C@@H](C(=O)O)N"):
            self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(query), smiles)

    def test_a_trityl_does_not_silence_either(self):
        # Unlike the Asn/Gln and Trp cases, the trityl here is NOT the remedy: it is on the sulfur
        # or the ring nitrogen and the alpha-proton is still acidified. If the pattern required a
        # free S-H or N-H the shipped blocks would both go quiet, which would be wrong.
        for group, smiles in (("cys-epimerisation", FMOC_CYS_TRT), ("his-epimerisation", FMOC_HIS_TRT)):
            query = Chem.MolFromSmarts(T.GROUPS[group][1])
            self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(query), group)

    def test_neither_matches_a_coupled_residue_or_an_innocent_one(self):
        for group in ("cys-epimerisation", "his-epimerisation"):
            query = Chem.MolFromSmarts(T.GROUPS[group][1])
            for smiles in (CYS_COUPLED, FMOC_ALA, L_METHIONINE):
                self.assertFalse(Chem.MolFromSmiles(smiles).HasSubstructMatch(query), f"{group} {smiles}")


class TheFlagsFire(unittest.TestCase):
    def test_coupling_cysteine_with_dipea(self):
        found = hazards_for([GLYCINE, FMOC_CYS_TRT], [GLY_PRODUCT], DIPEA)
        self.assertIn("cys-epimerisation", groups_in(found), f"hazards were {groups_in(found)}")

    def test_coupling_histidine_with_dipea(self):
        found = hazards_for([GLYCINE, FMOC_HIS_TRT], [GLY_PRODUCT], DIPEA)
        self.assertIn("his-epimerisation", groups_in(found), f"hazards were {groups_in(found)}")

    def test_both_are_medium(self):
        for group, block in (("cys-epimerisation", FMOC_CYS_TRT), ("his-epimerisation", FMOC_HIS_TRT)):
            hazard = next(h for h in hazards_for([GLYCINE, block], [GLY_PRODUCT], DIPEA)
                          if h["group"] == group)
            self.assertEqual(hazard["severity"], "medium", group)

    def test_the_message_says_what_is_lost_and_that_nothing_downstream_sees_it(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_CYS_TRT], [GLY_PRODUCT], DIPEA)
                      if h["group"] == "cys-epimerisation")
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("epimeris", "racemis", " d ", "d-")), words)
        self.assertTrue(any(k in words for k in ("collidine", "oxyma", "hoat")),
                        f"it must name a remedy: {words}")
        self.assertTrue(any(k in words for k in ("mass", "formula", "balance")),
                        f"it must say why nothing else catches it: {words}")


class TheFlagsClearOnCare(unittest.TestCase):
    def test_collidine_clears_them(self):
        for group, block in (("cys-epimerisation", FMOC_CYS_TRT), ("his-epimerisation", FMOC_HIS_TRT)):
            found = hazards_for([GLYCINE, block], [GLY_PRODUCT], COLLIDINE)
            self.assertNotIn(group, groups_in(found), f"{group}: {groups_in(found)}")

    def test_oxyma_clears_them(self):
        for group, block in (("cys-epimerisation", FMOC_CYS_TRT), ("his-epimerisation", FMOC_HIS_TRT)):
            found = hazards_for([GLYCINE, block], [GLY_PRODUCT], OXYMA)
            self.assertNotIn(group, groups_in(found), f"{group}: {groups_in(found)}")

    def test_a_non_coupling_step_does_not_raise_them(self):
        found = hazards_for([FMOC_CYS_TRT], [FMOC_CYS_TRT], "20% piperidine in DMF")
        self.assertNotIn("cys-epimerisation", groups_in(found), f"hazards were {groups_in(found)}")

    def test_an_already_coupled_residue_does_not_raise_them(self):
        found = hazards_for([GLYCINE, CYS_COUPLED], [CYS_COUPLED], DIPEA)
        self.assertNotIn("cys-epimerisation", groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_arginine_flag_still_behaves(self):
        # The neighbour in the same table, to show the clearing rule is scoped to these two and did
        # not silence everything on ACTIVATION_RISKS: collidine is not an answer to a lactam.
        arg = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4"
               "C5=CC=CC=C35)N)C")
        found = hazards_for([GLYCINE, arg], [GLY_PRODUCT], COLLIDINE)
        self.assertIn("arg-delta-lactam", groups_in(found), f"hazards were {groups_in(found)}")


class WhatTheSourcesSayAboutTheseTwo(unittest.TestCase):
    """Rubric items 4 and 5: the remedies, re-grounded after reading.

    HISTIDINE — Benoiton Section 6.10, printed pp. 169-170. The mechanism is not the base in the
    pot: "Isomerization results from abstraction of the alpha-proton by the basic PI-NITROGEN of
    the ring", so the residue carries its own route to its own alpha-proton. Two consequences that
    change what the remedy should say:

      * "Substitution at the PI-nitrogen PREVENTS isomerization." The efficient protectors are
        N-pi-benzyloxymethyl (Bom) for Boc chemistry and N-pi-1-adamantyloxymethyl (1-Adom) for
        Fmoc chemistry. Neither ships.
      * The shipped block is already the literature's standard answer, and it works the other way:
        "the most popular derivative for synthesis using Fmoc chemistry is
        N-alpha-Fmoc-N-tau-trityl-L-histidine ... the electron-withdrawing effect of the substituent
        reduces the basicity of the pi-nitrogen so that activation and coupling occur with MINIMAL
        enantiomerization." Reduced, not eliminated — "substitution at the tau-nitrogen ... MAY
        DIMINISH its ability to abstract the alpha-proton."

    So the corpus audit's recommendation — switch the remedy to the building block
    Fmoc-His(Boc)-OH — would have been wrong twice over: the popular derivative is the Trt, which
    the package already ships, and Boc on the tau-nitrogen is merely "analogous" to it, not a cure.
    Conditions remain a real lever precisely BECAUSE tau-protection only reduces.

    CYSTEINE — the citable framing is NO base rather than a weaker one. Peptide Synthesis: Methods
    and Protocols Ch. 6 p. 95: "The LACK OF BASE present during the coupling allowed
    Fmoc-Cys(Trt)-OH to be coupled at 90 C without an increase in epimerization compared to room
    temperature methods." Benoiton Section 4.21 item 9 agrees from the other side: "Onium
    salt-mediated couplings of N-alkoxycarbonylcysteines and serines. Activated forms of these
    compounds are particularly sensitive to the TERTIARY AMINES required to effect the couplings."
    Item 8 of the same list names a pre-activation that exposes the activated intermediate to
    tertiary amine as an origin of impurity in its own right, which is the citation for "keep the
    pre-activation short".

    Collidine stays accepted, because the gate must not punish a route that took a real precaution,
    but it is no longer what the message leads with: it could not be sourced in Benoiton, in Chan &
    White, or in M&P, and the thing those DO name is the carbodiimide route with no base at all.
    """

    def test_the_shipped_histidine_block_is_the_one_Benoiton_calls_standard(self):
        # The remedy text names it, so it has to actually ship. Read from the package's own table
        # rather than asserted against a literal, which would be a second source of truth.
        blocks = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "engine",
                              "peptideBuildingBlocks.ts")
        self.assertIn("Fmoc-His(Trt)-OH", open(blocks, encoding="utf-8").read())

    def test_the_histidine_message_names_the_block_AND_the_conditions(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_HIS_TRT], [GLY_PRODUCT], DIPEA)
                      if h["group"] == "his-epimerisation")
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("his(trt)", words, f"name the shipped block: {words}")
        self.assertTrue(any(k in words for k in ("reduce", "minimal", "not eliminat", "only")),
                        f"say that the block reduces rather than cures: {words}")
        self.assertIn("pi", words, f"name the nitrogen that would actually prevent it: {words}")

    def test_the_histidine_message_does_NOT_recommend_His_Boc(self):
        # The audit's recommendation, declined on the source. Asserting its ABSENCE because a later
        # reader looking at Benoiton's list of tau-substituted derivatives could easily re-add it.
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_HIS_TRT], [GLY_PRODUCT], DIPEA)
                      if h["group"] == "his-epimerisation")
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertNotIn("his(boc)", words,
                         "Boc on the tau-nitrogen is analogous to the Trt, not better than it")

    def test_the_cysteine_message_leads_with_NO_base_not_a_weaker_one(self):
        hazard = next(h for h in hazards_for([GLYCINE, FMOC_CYS_TRT], [GLY_PRODUCT], DIPEA)
                      if h["group"] == "cys-epimerisation")
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("oxyma", words, f"name the sourced route: {words}")
        self.assertTrue(any(k in words for k in ("no base", "without base", "base-free",
                                                 "absence of base")),
                        f"say that the absence of base is the point: {words}")

    def test_collidine_is_still_accepted_even_though_it_is_unsourced(self):
        # A route that used a weaker base took a real precaution; the gate should not nag it just
        # because the citation is missing. Pinned so that tightening this becomes a deliberate act.
        for substrate, group in ((FMOC_CYS_TRT, "cys-epimerisation"),
                                 (FMOC_HIS_TRT, "his-epimerisation")):
            with self.subTest(group):
                found = hazards_for([GLYCINE, substrate], [GLY_PRODUCT], COLLIDINE)
                self.assertNotIn(group, groups_in(found), f"hazards were {groups_in(found)}")

    def test_WHY_the_pi_versus_tau_distinction_is_not_in_the_pattern(self):
        """Records a rejected approach, with the measurement that rejected it.

        The obvious move is to require the pi-nitrogen to still bear a hydrogen, so that a
        genuinely pi-protected histidine would clear the flag while the tau-protected Trt block
        kept raising it. It does not work, and the reason is tautomers: imidazole's N-H sits on
        either nitrogen depending on how the SMILES was written, so `c1cnc[nH]1` answers True for
        free histidine written one way and False written the other. Worse, the SHIPPED
        Fmoc-His(Trt)-OH and a hand-built N-pi-trityl histidine both answer False, so the rule
        cannot tell the standard block from the thing it is supposed to distinguish it from.

        Measured before this test was written; kept as a test so that the pattern staying
        tautomer-insensitive is a property someone has to break on purpose.
        """
        both_ways = ["N[C@@H](Cc1c[nH]cn1)C(=O)O", "N[C@@H](Cc1cnc[nH]1)C(=O)O"]
        pattern = Chem.MolFromSmarts(T.GROUPS["his-epimerisation"][1])
        for smiles in both_ways:
            with self.subTest(smiles):
                self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(pattern),
                                "the gate must not depend on which tautomer was written")


# Appended tests have twice been stranded by a `unittest.main()` sitting mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
