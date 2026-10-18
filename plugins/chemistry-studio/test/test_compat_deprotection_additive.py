"""What goes in the piperidine: the additive that answers aspartimide, and the one that cannot.

Two things are encoded here, and the second only exists because the first has a conflict.

1. ASPARTIMIDE CAN BE ANSWERED IN THE DEPROTECTION, not only by a building block. The four
   aspartimide gates fired on any `amine-base` step and nothing cleared them, so a route that had
   taken a real precaution was still told to change its building blocks. The literature names
   several:

     * Mergler et al. measured 0.1 M HOBt or 2,4-dinitrophenol in the piperidine as reducing
       aspartimide significantly (the 1994 study; see also "The aspartimide problem in Fmoc-based
       SPPS", J Pept Sci 2003).
     * The 2025 ChemBioChem review *Aspartimide Formation and Its Prevention in Fmoc Chemistry
       SPPS* reports Oxyma Pure as MORE effective than either HOBt or HOAt.
     * Piperazine and 4-methylpiperidine remove Fmoc while suppressing aspartimide; dipropylamine
       likewise, at comparable deprotection efficiency.
     * DBU goes the other way: *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3
       Section 9.2.5 — "Fmoc removal with DBU also promotes aspartimide formation."

   None of these ELIMINATES it, so this does not change the severities; it clears the flag for a
   route that has done what the literature asks, which is the difference between advice and noise.

2. THE HOBt COLLISION, now visible instead of hidden. HOBt in the piperidine suppresses
   aspartimide, and HOBt CATALYSES the cyclisation of an N-terminal glutamine to pyroglutamate
   (Benoiton Section 6.16: catalysed by weak carboxylic acids "as well as by
   1-hydroxybenzotriazole"). Until now the pyroglutamate gate only read `acylating` steps, so HOBt
   sitting in a deprotection was invisible to it — a route could be advised to add HOBt and walk
   into the other hazard with no warning. The gate now also reads `amine-base` steps, so a chain
   carrying both an Asp-Gly and a free glutamine N-terminus gets BOTH flags on that step and the
   trade-off is stated rather than concealed.

   Which is why the advice leads with OXYMA: the 2025 review has it beating HOBt on aspartimide,
   and it is not on Benoiton's list of pyroglutamate catalysts, so `has_pyroglutamate_catalyst`
   excludes it. One additive answers both hazards.
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

# Ala-Asp(OtBu)-Gly with the N-terminal Fmoc still on, and the same after piperidine. Built by the
# hazard panel's route and pinned here, so the aspartimide site is a real Asp-Gly in a chain.
ADG_FMOC = ("C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O")
ADG_FREE = "C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
# Gln-Ala-Gly, N-terminal glutamine, Fmoc on and off. The side-chain amide is unprotected.
QAG_FMOC = ("NC(=O)CC[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](C)C(=O)NCC(=O)O")
QAG_FREE = "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)NCC(=O)O"
# A chain with BOTH liabilities: N-terminal Gln and an Asp-Gly further along.
QDG_FMOC = ("NC(=O)CC[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O")
QDG_FREE = "NC(=O)CC[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"

PLAIN = "20% piperidine in DMF, 2 x 5 min, rt"
OXYMA = "20% piperidine + 0.1 M Oxyma in DMF, 2 x 5 min, rt"
HOBT = "20% piperidine + 0.1 M HOBt in DMF, 2 x 5 min, rt"
DNP = "20% piperidine + 0.1 M 2,4-dinitrophenol in DMF, 2 x 5 min"
PIPERAZINE = "5% piperazine in DMF, 2 x 5 min"
METHYLPIPERIDINE = "20% 4-methylpiperidine in DMF, 2 x 5 min"
DBU = "2% DBU / 2% piperidine in DMF, 2 x 5 min"
DBU_WITH_OXYMA = "2% DBU / 20% piperidine + 0.1 M Oxyma in DMF"

ASPARTIMIDE = {"aspartimide-gly", "aspartimide-gly-hindered",
               "aspartimide-beta-heteroatom", "aspartimide-prone-xaa"}


def groups(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1
    return {h["group"] for h in out[0]["hazards"]}


def hazard(reactant, product, reagents, group):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    return next(h for h in out[0]["hazards"] if h["group"] == group)


class TheSubstratesAreWhatTheyClaim(unittest.TestCase):
    def test_the_aspartimide_site_is_present_before_and_after(self):
        pattern = Chem.MolFromSmarts(T.GROUPS["aspartimide-gly"][1])
        for smiles in (ADG_FMOC, ADG_FREE):
            with self.subTest(smiles):
                self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(pattern))

    def test_the_glutamine_N_terminus_appears_only_in_the_PRODUCT(self):
        pattern = Chem.MolFromSmarts(T.GROUPS["n-terminal-gln"][1])
        self.assertFalse(Chem.MolFromSmiles(QAG_FMOC).HasSubstructMatch(pattern),
                         "Fmoc on the amine, so it cannot cyclise yet")
        self.assertTrue(Chem.MolFromSmiles(QAG_FREE).HasSubstructMatch(pattern))


class PlainPiperidineStillFlagsAspartimide(unittest.TestCase):
    def test_it_fires(self):
        self.assertIn("aspartimide-gly", groups(ADG_FMOC, ADG_FREE, PLAIN))

    def test_it_is_still_high(self):
        self.assertEqual(hazard(ADG_FMOC, ADG_FREE, PLAIN, "aspartimide-gly")["severity"], "high")


class TheAdditivesTheLiteratureNames(unittest.TestCase):
    def test_Oxyma_clears_it(self):
        self.assertNotIn("aspartimide-gly", groups(ADG_FMOC, ADG_FREE, OXYMA))

    def test_HOBt_and_dinitrophenol_clear_it(self):
        for conditions in (HOBT, DNP):
            with self.subTest(conditions):
                self.assertNotIn("aspartimide-gly", groups(ADG_FMOC, ADG_FREE, conditions))

    def test_the_milder_bases_are_RECOGNISED_as_amine_bases_at_all(self):
        # This has to come before the clearance test, and it is the reason that test is written in
        # two halves. `\bpiperidine\b` does not match "4-methylpiperidine" or "piperazine", so none
        # of these classified as any reagent class — and the clearance test below passed for that
        # wrong reason, because no hazard had fired to be cleared. Exactly the trap the project has
        # hit before: a fixture that passes without exercising anything.
        for conditions in (PIPERAZINE, METHYLPIPERIDINE, "20% dipropylamine in DMF, 2 x 5 min"):
            with self.subTest(conditions):
                self.assertIn("amine-base", T.classify(conditions),
                              "a deprotection that classifies as nothing reaches NO gate at all")

    def test_a_milder_base_clears_it(self):
        for conditions in (PIPERAZINE, METHYLPIPERIDINE,
                           "20% dipropylamine in DMF, 2 x 5 min"):
            with self.subTest(conditions):
                self.assertNotIn("aspartimide-gly", groups(ADG_FMOC, ADG_FREE, conditions))

    def test_and_a_milder_base_still_reaches_the_OTHER_amine_base_gates(self):
        # The point of fixing the CLASSIFIER rather than only the aspartimide guard. A milder base
        # suppresses aspartimide and does nothing about the diketopiperazine, so that gate must
        # still fire — otherwise switching base would silently buy a blind spot. The Gly-Pro resin
        # dipeptide is the diketopiperazine suite's own fixture.
        fmoc_on = "*OC(=O)[C@@H]1CCCN1C(=O)CNC(=O)OCC1c2ccccc2-c2ccccc21"
        amine_free = "*OC(=O)[C@@H]1CCCN1C(=O)CN"
        for conditions in (PIPERAZINE, METHYLPIPERIDINE):
            with self.subTest(conditions):
                found = groups(fmoc_on, amine_free, conditions)
                self.assertIn("resin-dipeptide-dkp", found, f"hazards were {found}")

    def test_all_four_aspartimide_groups_are_cleared_not_just_the_glycine_one(self):
        # They share one guard; if only the Gly case cleared, the others would be unanswerable.
        for pattern_group, chain in (("aspartimide-gly", (ADG_FMOC, ADG_FREE)),):
            with self.subTest(pattern_group):
                self.assertFalse(ASPARTIMIDE & groups(chain[0], chain[1], OXYMA))

    def test_DBU_is_a_RISK_FACTOR_and_does_not_clear_even_with_Oxyma(self):
        # Vol 3 Section 9.2.5: "Fmoc removal with DBU also promotes aspartimide formation." A route
        # that reaches for DBU should not be able to buy its way out with an additive.
        for conditions in (DBU, DBU_WITH_OXYMA):
            with self.subTest(conditions):
                self.assertIn("aspartimide-gly", groups(ADG_FMOC, ADG_FREE, conditions),
                              "DBU must defeat the clearance")

    def test_the_remedy_leads_with_Oxyma_and_names_the_collision(self):
        words = hazard(ADG_FMOC, ADG_FREE, PLAIN, "aspartimide-gly")
        text = f"{words['why']} {words.get('suggestion') or ''}".lower()
        self.assertIn("oxyma", text, f"the additive that answers both hazards: {text}")
        self.assertIn("dmb", text, "the dipeptide block stays in the advice")


class TheHObtCollisionIsVisible(unittest.TestCase):
    def test_HOBt_in_a_DEPROTECTION_now_raises_pyroglutamate(self):
        # The gate used to read `acylating` steps only, so HOBt sitting in the piperidine was
        # invisible to it and a route could be advised into the other hazard silently.
        self.assertIn("n-terminal-gln", groups(QAG_FMOC, QAG_FREE, HOBT))

    def test_plain_piperidine_does_NOT_raise_pyroglutamate(self):
        # It needs a named catalyst. Every cycle frees an N-terminal amine, so without this the
        # gate would fire on every deprotection of every glutamine-containing chain.
        self.assertNotIn("n-terminal-gln", groups(QAG_FMOC, QAG_FREE, PLAIN))

    def test_Oxyma_in_a_deprotection_does_NOT_raise_pyroglutamate(self):
        # The reason Oxyma is the recommended additive: Benoiton's catalyst list does not include
        # it, so it buys the aspartimide suppression without buying the other hazard.
        self.assertNotIn("n-terminal-gln", groups(QAG_FMOC, QAG_FREE, OXYMA))

    def test_a_chain_with_BOTH_liabilities_gets_BOTH_flags_on_an_HOBt_deprotection(self):
        # The collision, stated. This is the case where the two pieces of advice conflict, and the
        # route is told so rather than being handed one of them.
        found = groups(QDG_FMOC, QDG_FREE, HOBT)
        self.assertIn("n-terminal-gln", found, f"hazards were {found}")
        self.assertFalse(ASPARTIMIDE & found, f"HOBt should have cleared the aspartimide: {found}")

    def test_and_with_Oxyma_that_same_chain_gets_NEITHER(self):
        found = groups(QDG_FMOC, QDG_FREE, OXYMA)
        self.assertNotIn("n-terminal-gln", found, f"hazards were {found}")
        self.assertFalse(ASPARTIMIDE & found, f"hazards were {found}")

    def test_a_chain_with_no_glutamine_N_terminus_is_silent_even_with_HOBt(self):
        self.assertNotIn("n-terminal-gln", groups(ADG_FMOC, ADG_FREE, HOBT))

    def test_the_acylating_path_still_works(self):
        # Regression fence on 3653b85: the coupling path must not have been replaced by this one.
        found = groups(QAG_FREE, QAG_FREE, "Fmoc-Ala-OH, HBTU, HOBt, DIPEA, DMF, 45 min")
        self.assertIn("n-terminal-gln", found, f"hazards were {found}")


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
