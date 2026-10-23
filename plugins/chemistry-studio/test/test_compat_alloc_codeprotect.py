"""One Alloc/OAll side-chain deprotection is one reagent treatment, not two findings.

The route model names exactly one operation per `apply`, so an Alloc/OAll lactam route writes its
single Pd(0) treatment as two statements: `allyl-ester-removal`, then `alloc-removal`, both under
`Pd(PPh3)4, morpholine, DMF, 2 h`. The first statement's product still carries the carbamate, so
`_compatibility` reported it as a group that "survives into the product" — at HIGH, with the remedy
"remove it deliberately with Pd(0)", which is literally the next statement of the same treatment.
One false positive (the second statement is silent, because by then the group is gone; this is not
a duplicate). Reproduced from the zilucoplan-style request the system prompt itself recommends:
`reviews/2026-10-23-alloc-codeprotect-treatment/`.

The gate is given no treatment field, and the step schema is closed, so it reads the convention it
IS given: a program-mode step's `reagents` is `conditions; <operation id>`, and on a generated
program the arrow is the id alone (the generator writes no `note` and names no species). Two
statements of one treatment therefore differ only in that tail. `_compatibility` groups consecutive
steps by the conditions head, and a group that the run's LAST product no longer carries did not
survive the treatment, so the survivor wording is false of it.

Deliberately NOT suppressed: a group that is still in the run's last product (it did survive), a
group removed and re-installed inside the run, a Pd step with no later removal in its run, and
anything whose reagents do not end in a curated id — which is the whole names-first path, and a
written program whose arrow carries names after the id. The tail test is what makes the last one
true by construction rather than by luck: two names-first steps with byte-identical reagent text are
NOT grouped, because the application attaches no `treatment` for them either.

The fixtures below are the generator's own payloads for `Ala-Lys(Glu)-Gly` cyclised through the
Alloc/OAll lactam (`sidechains {"2": "Alloc", "4": "OAll"}`, `cyclization [2, 4]`,
`n_terminal="acetyl"`, 14 statements), lifted from `peptide_route.program` on 2026-10-23 and sent in
the shape the app sends: `conditions + "; " + operation id`. The conditions-only string is NOT the
app's payload, and a test built from it would be green for the wrong reason.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import RDLogger

import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

ALLOC_CARBAMATE = "alloc-carbamate"
ALLYL_ESTER = "allyl-ester"
PD = "Pd(PPh3)4, morpholine, DMF, 2 h"

ROUTE = [
    # 0 M2 fmoc-removal
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)N"],
     "reagents": "20% piperidine in DMF, 2 x 5 min; fmoc-removal"},
    # 1 M3 n-peptide-coupling
    {"reactants": ["*OC(=O)[C@H](C)N", "C=CCOC(=O)CC[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF, 45 min; n-peptide-coupling"},
    # 2 M4 fmoc-removal
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@@H](N)CCC(=O)OCC=C"],
     "reagents": "20% piperidine in DMF, 2 x 5 min; fmoc-removal"},
    # 3 M5 n-peptide-coupling
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@@H](N)CCC(=O)OCC=C",
                   "O=C(O)CNC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)OCC1c2ccccc2-c2ccccc21"],
     "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF, 45 min; n-peptide-coupling"},
    # 4 M6 fmoc-removal
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CN"],
     "reagents": "20% piperidine in DMF, 2 x 5 min; fmoc-removal"},
    # 5 M7 n-peptide-coupling
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CN",
                   "C=CCOC(=O)NCCCC[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OCC=C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF, 45 min; n-peptide-coupling"},
    # 6 M8 fmoc-removal
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                   "[C@H](CCCCNC(=O)OCC=C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)[C@@H](N)CCCCNC(=O)OCC=C"],
     "reagents": "20% piperidine in DMF, 2 x 5 min; fmoc-removal"},
    # 7 M9 n-peptide-coupling
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)[C@@H](N)CCCCNC(=O)OCC=C",
                   "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF, 45 min; n-peptide-coupling"},
    # 8 M10 fmoc-removal
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                   "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(=O)OCC1c2ccccc2-c2ccccc21"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)N"],
     "reagents": "20% piperidine in DMF, 2 x 5 min; fmoc-removal"},
    # 9 M11 n-peptide-coupling (acetyl cap)
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                   "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)N", "CC(=O)O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(C)=O"],
     "reagents": "acetic acid, DIC/HOBt, DMF, 2 h; n-peptide-coupling"},
    # 10 M12 allyl-ester-removal — the false-positive statement
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)OCC=C)NC(=O)CNC(=O)"
                   "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(C)=O", "O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)O)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(C)=O"],
     "reagents": PD + "; allyl-ester-removal"},
    # 11 M13 alloc-removal — the same treatment's second statement
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)O)NC(=O)CNC(=O)"
                   "[C@H](CCCCNC(=O)OCC=C)NC(=O)[C@H](C)NC(C)=O", "O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)O)NC(=O)CNC(=O)"
                  "[C@H](CCCCN)NC(=O)[C@H](C)NC(C)=O"],
     "reagents": PD + "; alloc-removal"},
    # 12 M14 sidechain-macrolactamisation
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)O)NC(=O)CNC(=O)[C@H](CCCCN)NC(=O)[C@H](C)NC(C)=O"],
     "products": ["*OC(=O)[C@H](C)NC(=O)[C@@H]1CCC(=O)NCCCC[C@H](NC(=O)[C@H](C)NC(C)=O)C(=O)NCC(=O)N1"],
     "reagents": "TBTU, DIPEA, DMF, 2 h; sidechain-macrolactamisation"},
    # 13 M15 resin-cleavage
    {"reactants": ["*OC(=O)[C@H](C)NC(=O)[C@@H]1CCC(=O)NCCCC[C@H](NC(=O)[C@H](C)NC(C)=O)C(=O)NCC(=O)N1",
                   "O"],
     "products": ["CC(=O)N[C@@H](C)C(=O)N[C@H]1CCCCNC(=O)CC[C@@H](C(=O)N[C@@H](C)C(=O)O)NC(=O)CNC1=O"],
     "reagents": "TFA/H2O 95:5, 2 h; resin-cleavage"},
]

ALLYL_STEP, ALLOC_STEP = 10, 11

# The pre-change gate's output on this route, measured on a byte copy of HEAD (see
# `reviews/2026-10-23-alloc-codeprotect-treatment/tier1.txt`): one finding, at the allyl-ester
# step, and nothing anywhere else. It is recorded here so the differential is a statement about a
# measurement rather than about whatever the gate happens to return.
BEFORE = {ALLYL_STEP: [ALLOC_CARBAMATE]}

# The two Pd statements of that treatment, as the app sends them.
ALLYL = ROUTE[ALLYL_STEP]
ALLOC = ROUTE[ALLOC_STEP]
# The molecules the pair acts on, by role, so the controls below can reuse them without pretending
# to be a different route.
ALLOC_BEARING = ALLYL["reactants"][0]          # allyl ester + Alloc carbamate, before either removal
DEALLYLATED = ALLYL["products"][0]             # ester gone, carbamate still there
DEPROTECTED = ALLOC["products"][0]             # both gone


def step(reactants, products, reagents):
    return {"reactants": list(reactants), "products": list(products), "reagents": reagents}


def findings(steps):
    """The gate's findings for each step, in the app's one-call-per-route shape as groups only."""
    return [[hazard["group"] for hazard in block["hazards"]] for block in W._compatibility(steps)]


class TheReproducedRouteReportsThePairOnce(unittest.TestCase):
    """The differential: one high bullet disappears, every other step is untouched."""

    def test_the_allyl_ester_step_no_longer_calls_the_carbamate_a_survivor(self):
        # RED on the pre-change gate: ['alloc-carbamate'] at HIGH, with the remedy being the very
        # next statement ("remove it deliberately with Pd(0)").
        self.assertEqual(findings(ROUTE)[ALLYL_STEP], [])

    def test_the_alloc_removal_step_is_silent(self):
        # It was already silent — the carbamate is gone from its product, so `survives` never held.
        # This pair is a false positive, not a duplicate, and the fix must not make the second
        # statement speak either.
        self.assertEqual(findings(ROUTE)[ALLOC_STEP], [])

    def test_the_only_thing_that_moved_is_that_one_bullet(self):
        after = {index: found for index, found in enumerate(findings(ROUTE)) if found}
        expected = {index: found for index, found in BEFORE.items() if index != ALLYL_STEP}
        self.assertEqual(after, expected)


class AStatementWithoutItsPartnerStillFires(unittest.TestCase):
    """The positive control: the same step, the same molecules, no later removal in its run."""

    def test_the_alloc_carbamate_is_reported_when_nothing_removes_it(self):
        found = W._compatibility([ALLYL])[0]["hazards"]
        self.assertEqual([h["group"] for h in found], [ALLOC_CARBAMATE])
        self.assertEqual(found[0]["severity"], "high")
        self.assertEqual(found[0]["reagentClass"], "pd-coupling")
        self.assertIn("survives into the product", found[0]["why"])

    def test_the_group_the_step_is_meant_to_remove_is_still_reported(self):
        # The gate is not quiet on this step: a Pd treatment that leaves the allyl ester in place
        # still reports it. Without this, "no finding" could mean "the step was not examined".
        kept = W._compatibility([step([ALLOC_BEARING], [ALLOC_BEARING], PD + "; allyl-ester-removal")])
        self.assertEqual({h["group"] for h in kept[0]["hazards"]}, {ALLYL_ESTER, ALLOC_CARBAMATE})


class ADifferentRunIsNotOneTreatment(unittest.TestCase):
    """A coupling between the two Pd statements is not the same pot."""

    def test_the_coupling_between_keeps_the_two_pd_steps_in_separate_runs(self):
        found = findings([ALLYL, ROUTE[9], ALLOC])
        self.assertEqual(found[0], [ALLOC_CARBAMATE])
        self.assertEqual(found[2], [])


class AReinstalledGroupSurvivedTheTreatment(unittest.TestCase):
    """Read the run's LAST product, not merely a later step: a group put back is still there."""

    def test_a_group_removed_and_put_back_inside_the_run_is_kept(self):
        found = findings([
            ALLYL,
            ALLOC,
            step([DEPROTECTED], [DEALLYLATED], PD + "; alloc-removal"),   # re-installed
        ])
        self.assertEqual(found[0], [ALLOC_CARBAMATE])


class AGroupThatStaysInTheTreatmentIsKept(unittest.TestCase):
    """The same treatment, a group nothing in it removes: the warning is still true."""

    def test_the_carbamate_is_reported_across_both_statements(self):
        found = findings([
            step([ALLOC_BEARING], [ALLOC_BEARING], PD + "; allyl-ester-removal"),
            step([ALLOC_BEARING], [ALLOC_BEARING], PD + "; alloc-removal"),
        ])
        self.assertIn(ALLOC_CARBAMATE, found[0])
        self.assertIn(ALLOC_CARBAMATE, found[1])


class TheNamesFirstShapeIsNeverGrouped(unittest.TestCase):
    """No curated-id tail, no run — even when two steps carry byte-identical text.

    The application attaches `treatment` from the generator's per-statement conditions, and the
    names-first path passes none, so the app does not treat these two as one pot either. Grouping
    them here would be the gate inventing a treatment the report does not show.
    """

    NAMES_FIRST = [
        step([ALLOC_BEARING], [DEALLYLATED], PD),
        step([DEALLYLATED], [DEPROTECTED], PD),
    ]

    def test_the_two_steps_really_do_carry_identical_reagent_text(self):
        # The detector is the tail, not a difference in the string: if these diverged, the test
        # below would pass for the wrong reason.
        self.assertEqual(self.NAMES_FIRST[0]["reagents"], self.NAMES_FIRST[1]["reagents"])

    def test_the_names_first_pair_keeps_both_findings_it_has(self):
        found = findings(self.NAMES_FIRST)
        self.assertEqual(found[0], [ALLOC_CARBAMATE])
        self.assertEqual(found[1], [])

    def test_a_step_whose_arrow_is_a_name_is_not_grouped_either(self):
        # A written program's arrow can carry names after the id; the tail is then not a curated id
        # and nothing is stripped. The failure direction is no suppression.
        named = [step([ALLOC_BEARING], [DEALLYLATED], PD + "; tetrakis(triphenylphosphine)palladium(0)"),
                 step([DEALLYLATED], [DEPROTECTED], PD + "; tetrakis(triphenylphosphine)palladium(0)")]
        self.assertEqual(findings(named)[0], [ALLOC_CARBAMATE])

    def test_an_id_the_condition_map_does_not_cover_is_not_a_tail(self):
        # 13 of the generator's ids have no entry in TRANSFORM_CONDITIONS. A step naming one is
        # still a program step, but the gate cannot tell it from prose — so it groups nothing.
        import compat_tables as T
        self.assertIsNone(T.conditions_for_transform("sidechain-macrolactamisation"))
        ungrouped = [step([ALLOC_BEARING], [DEALLYLATED], PD + "; sidechain-macrolactamisation"),
                     step([DEALLYLATED], [DEPROTECTED], PD + "; sidechain-macrolactamisation")]
        self.assertEqual(findings(ungrouped)[0], [ALLOC_CARBAMATE])


class AnUnreadableLastProductDoesNotSilenceTheRun(unittest.TestCase):
    """Absence from a product that was never read is not evidence the group left."""

    def test_a_missing_last_product_keeps_the_finding(self):
        found = findings([ALLYL, step([DEALLYLATED], [], PD + "; alloc-removal")])
        self.assertEqual(found[0], [ALLOC_CARBAMATE])


if __name__ == "__main__":
    unittest.main(verbosity=2)
