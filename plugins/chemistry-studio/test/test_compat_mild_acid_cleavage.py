"""Mild-acid cleavage from a super-acid-labile resin, and the pyroglutamate risk that lives there.

Rubric item 4. This one began as "the strong-acid pyroglutamate path is a false positive, remove
it" and ended somewhere else, so the reasoning is recorded rather than just the outcome.

WHAT THE SOURCES ACTUALLY SAY. Vol 3 Section 9.2.4 is blunt that the final cleavage is not the
problem: the cyclisation "is catalyzed by weak acids, but NOT by strong acids such as the ones
required for final cleavage and deprotection. However, weak acids ARE used in the Fmoc/tBu strategy
in the case of super acid-labile group deprotection or for peptide cleavage from highly
acid-sensitive resins, such as 2-Cl-Trt and SASRIN." Benoiton Section 6.16 lists "acetic acid,
trifluoroacetic acid, and Boc-amino acids" together as the catalysing weak carboxylic acids, and
adds "left at pH 2-3".

The mechanism reconciles them, and it is a pH WINDOW rather than a monotonic acid dependence: the
alpha-amine has to be UNPROTONATED to be the nucleophile, while the side-chain carbonyl has to be
protonated to be electrophilic. In 95% TFA the amine is fully protonated and cannot attack. So Vol
3 is right about the concentrated step.

THE FLAG NOW NEEDS THE WORK-UP NAMED, and that is a reversal of the paragraph that used to sit here.
A TFA cleavage does not end at 95% TFA: the acid is evaporated and the peptide triturated, which
takes the mixture through the dilute and residual regime where the window is open. That part is
right. What was wrong was firing on the step as WRITTEN, because a route's conditions line almost
never mentions the work-up — so every concentrated final cleavage was flagged. The strong-acid path
now requires the step to name the regime (`has_dilute_workup`: evaporate, triturate, dilute,
aqueous, work-up, pH N); a step that names it still fires. The mild-acid path needs no such token,
because there the acid IS the step.

WHAT WAS MISSING is the case both sources point at directly: cleavage from 2-chlorotrityl or SASRIN
with a mild acid, where the window is open for the whole step. Those cocktails — AcOH/TFE/DCM,
HFIP/DCM, TFE/DCM — classified as NO reagent class at all, so a route cleaving from 2-CTC reached
none of the gates. That is the third classifier gap of this kind found today, after HCTU and the
milder Fmoc-removal bases.

The new `mild-acid` class carries ONE hazard deliberately. It exists to close the classification
hole and to hang this hazard off; filling it in is a separate job with its own reading.
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

# Gln-Ala-Gly on a 2-chlorotrityl resin, N-terminus already free, side-chain amide unprotected,
# and the same chain released by the mild acid.
QAG_RESIN = "*OC(=O)CNC(=O)[C@@H](C)NC(=O)[C@H](CCC(N)=O)N"
QAG_FREE = "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)NCC(=O)O"
# The same chain with the glutamine side chain tritylated — the remedy, which must clear it.
QAG_TRT_RESIN = ("*OC(=O)CNC(=O)[C@@H](C)NC(=O)[C@H](CCC(=O)NC(c1ccccc1)(c1ccccc1)c1ccccc1)N")
# Ala-Ala-Gly, no glutamine at all.
AAG_RESIN = "*OC(=O)CNC(=O)[C@@H](C)NC(=O)[C@H](C)N"
AAG_FREE = "C[C@H](N)C(=O)N[C@@H](C)C(=O)NCC(=O)O"

MILD = {
    "AcOH/TFE/DCM": "AcOH/TFE/DCM 1:2:7, 1 h, rt",
    "HFIP/DCM": "20% HFIP in DCM, 2 x 15 min",
    "TFE/DCM": "TFE/DCM 2:8, 1 h, 2-chlorotrityl resin",
    "dilute TFA": "1% TFA in DCM, 5 x 2 min, SASRIN resin",
}
CONCENTRATED = "TFA/H2O 95:5, 2 h"
CONCENTRATED_WORKUP = CONCENTRATED + ", then evaporated and triturated with ether"
GROUP = "n-terminal-gln"


def groups(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1
    return {h["group"] for h in out[0]["hazards"]}


def hazard(reactant, product, reagents, group):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    return next(h for h in out[0]["hazards"] if h["group"] == group)


class TheClassifierGapItCloses(unittest.TestCase):
    """Pins the gap, so that removing the class would fail loudly rather than silently."""

    def test_every_mild_cleavage_cocktail_now_classifies(self):
        for name, conditions in MILD.items():
            with self.subTest(name):
                self.assertIn("mild-acid", T.classify(conditions),
                              f"{conditions!r} reached no gate at all before this class existed")

    def test_a_concentrated_TFA_cleavage_is_NOT_read_as_mild(self):
        self.assertNotIn("mild-acid", T.classify(CONCENTRATED))
        self.assertIn("strong-acid", T.classify(CONCENTRATED))

    def test_an_ordinary_solvent_line_is_not_read_as_an_acid(self):
        for conditions in ("DCM, rt, 1 h", "DMF, 45 min", "20% piperidine in DMF"):
            with self.subTest(conditions):
                self.assertNotIn("mild-acid", T.classify(conditions))


class TheHazardFiresOnAMildCleavage(unittest.TestCase):
    def test_each_mild_cocktail_raises_pyroglutamate_on_a_free_Gln_N_terminus(self):
        for name, conditions in MILD.items():
            with self.subTest(name):
                found = groups(QAG_RESIN, QAG_FREE, conditions)
                self.assertIn(GROUP, found, f"{conditions}: {found}")

    def test_no_catalyst_needs_to_be_named_because_the_acid_IS_the_catalyst(self):
        # Unlike the coupling and deprotection paths, which need HOBt or acetic acid named in the
        # conditions, a mild-acid cleavage is itself the weak-acid regime the sources describe.
        found = groups(QAG_RESIN, QAG_FREE, "20% HFIP in DCM, 2 x 15 min")
        self.assertIn(GROUP, found, f"hazards were {found}")

    def test_a_chain_with_no_glutamine_N_terminus_is_silent(self):
        for name, conditions in MILD.items():
            with self.subTest(name):
                self.assertNotIn(GROUP, groups(AAG_RESIN, AAG_FREE, conditions))

    def test_the_tritylated_glutamine_clears_it(self):
        # Benoiton: "Pyroglutamyl is not formed when the carboxamide groups are protected." The
        # structural remedy has to clear this path as well as the other two.
        found = groups(QAG_TRT_RESIN, QAG_TRT_RESIN, MILD["AcOH/TFE/DCM"])
        self.assertNotIn(GROUP, found, f"hazards were {found}")

    def test_the_message_names_the_resin_context_and_the_block(self):
        got = hazard(QAG_RESIN, QAG_FREE, MILD["AcOH/TFE/DCM"], GROUP)
        words = f"{got['why']} {got.get('suggestion') or ''}".lower()
        self.assertIn("gln(trt)", words, f"name the block: {words}")
        self.assertTrue(any(k in words for k in ("2-chlorotrityl", "chlorotrityl", "sasrin",
                                                 "acid-labile", "acid-sensitive")),
                        f"name where this happens: {words}")


class TheConcentratedCleavagePathNeedsTheWorkUpNamed(unittest.TestCase):
    """The part I first got wrong, kept as tests so the reasoning is not lost again.

    My first reading of Vol 3 was that the `strong-acid` path is a false positive and should go. It
    should not: a TFA cleavage is evaporated and triturated, which carries the mixture through the
    dilute and residual regime where the pH window is open. But the step TEXT usually does not say
    that, so firing on a bare "95% TFA" flagged every concentrated final cleavage. The gate now
    requires the regime to be named.
    """

    def test_it_fires_when_the_work_up_is_named(self):
        self.assertIn(GROUP, groups(QAG_RESIN, QAG_FREE, CONCENTRATED_WORKUP))

    def test_a_bare_concentrated_cleavage_is_silent(self):
        self.assertNotIn(GROUP, groups(QAG_RESIN, QAG_FREE, CONCENTRATED))

    def test_the_message_no_longer_blames_the_concentrated_acid_itself(self):
        got = hazard(QAG_RESIN, QAG_FREE, CONCENTRATED_WORKUP, GROUP)
        words = f"{got['why']} {got.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("evapora", "work-up", "workup", "residual",
                                                 "trituart", "triturat", "dilute")),
                        f"say WHERE in the step the window opens: {words}")
        self.assertTrue(any(k in words for k in ("quickly", "promptly", "as soon")),
                        f"Benoiton's remedy is to remove the acid fast: {words}")

    def test_a_capping_step_that_is_BOTH_acylating_and_a_weak_acid_reports_once(self):
        # `Ac2O/AcOH capping` matches the acylating class and the mild-acid class at once, and
        # before the suppression it printed the hazard twice — one nitrogen, two messages. The
        # mild-acid reading is the specific one and wins. Found by checking the new class against
        # the paths that already existed, not by a failing test, so it is pinned here.
        found = W._compatibility([{"reactants": [QAG_FREE], "products": [QAG_FREE],
                                   "reagents": "Ac2O/AcOH capping, DMF, 20 min"}])[0]["hazards"]
        paths = [h["reagentClass"] for h in found if h["group"] == GROUP]
        self.assertEqual(paths, ["mild-acid"], f"expected one mild-acid flag, got {paths}")

    def test_both_acid_paths_do_not_double_report(self):
        found = W._compatibility([{"reactants": [QAG_RESIN], "products": [QAG_FREE],
                                   "reagents": "1% TFA in DCM then TFA/H2O 95:5"}])[0]["hazards"]
        pairs = [(h["group"], h["reagentClass"]) for h in found if h["group"] == GROUP]
        self.assertEqual(len(pairs), len(set(pairs)), f"duplicate hazard: {pairs}")


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
