"""The bridge from a program-mode step's transform id to the hazard checker.

A free-text route step reads "...treated with 20% piperidine..." and `classify` turns that into a
reagent class. A PROGRAM-MODE step has no such prose: it names its operation by transform `id`
(`fmoc-removal`, `n-peptide-coupling`, `dmb-removal`) and lists reagent SMILES. So `classify` of a
program step is empty and every hazard gate stays silent on a generated route — verified 2026-10-17
by executing the generator's own routes and finding zero hazards fired, not because the molecules
were clean but because nothing told the checker what each step used.

`conditions_for_transform` is the missing piece: the conditions an operation runs under, keyed by
id, so a program step can go through the same `classify` -> `_compatibility` path as a free-text
one. These tests check the map three ways — it classifies correctly, it agrees with each
transform's own `summary`, and it actually makes the gates fire on a program-style step.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "python")
sys.path.insert(0, PY)

from rdkit import RDLogger
RDLogger.DisableLog("rdApp.*")

import compat_tables as T
import reactions_worker as W

TRANSFORMS = {t["id"]: t for t in
              json.load(open(os.path.join(PY, "route_transforms.json"), encoding="utf-8"))["transforms"]}

# What each mapped transform must classify to. The peptide program set: assembly, endgame, cleavage.
EXPECTED_CLASS = {
    "fmoc-removal": "amine-base",
    "n-peptide-coupling": "acylating",
    "n-acylation": "acylating",
    "amide-formation": "acylating",
    "boc-removal": "strong-acid",
    "ring-nitrogen-boc-removal": "strong-acid",
    "tert-butyl-ester-removal": "strong-acid",
    "tert-butyl-ether-removal": "strong-acid",
    "mpe-ester-removal": "strong-acid",
    "trityl-removal": "strong-acid",
    "s-trityl-removal": "strong-acid",
    "n-trityl-removal": "strong-acid",
    "imidazole-trityl-removal": "strong-acid",
    "pbf-removal": "strong-acid",
    "dmb-removal": "strong-acid",
    "pseudoproline-opening": "strong-acid",
    "resin-cleavage": "strong-acid",
    "resin-cleavage-amide": "strong-acid",
    "dde-removal": "hydrazine",
    "alloc-removal": "pd-coupling",
    "allyl-ester-removal": "pd-coupling",
    "otmse-removal": "fluoride",
    "odmab-removal": "hydrazine",
    "n-formylation": "acylating",
    # catalytic hydrogenolysis: H2/Pd-C is the one regime each summary names
    "cbz-removal": "hydrogenation",
    "benzyl-ester-hydrogenolysis": "hydrogenation",
}


class TheBridgeClassifiesEachTransform(unittest.TestCase):
    def test_every_mapped_id_gives_the_expected_reagent_class(self):
        for tid, want in EXPECTED_CLASS.items():
            with self.subTest(tid):
                cond = T.conditions_for_transform(tid)
                self.assertIsNotNone(cond, f"{tid} has no conditions")
                self.assertIn(want, T.classify(cond), f"{tid}: classify({cond!r})={T.classify(cond)}")

    def test_the_map_and_the_expectations_cover_the_same_ids(self):
        # So a new mapping cannot be added without an assertion about what it means.
        self.assertEqual(set(T.TRANSFORM_CONDITIONS), set(EXPECTED_CLASS))

    def test_an_unmapped_transform_returns_None_not_a_wrong_class(self):
        # An absent id must read as a gap, never as some default class. The rule for absence is
        # not "protection installs are unmapped" — `n-formylation` is an install and IS mapped, for
        # the formic-acid Ser/Thr gate — it is that no single string the transform's summary
        # supports classifies to a class the operation's own hazards need.
        for tid in ("pbf-sulfonylation", "imidazole-tritylation", "o-tert-butylation", "not-a-transform"):
            with self.subTest(tid):
                self.assertIsNone(T.conditions_for_transform(tid))

    def test_every_mapped_id_is_a_real_transform(self):
        strays = sorted(set(T.TRANSFORM_CONDITIONS) - set(TRANSFORMS))
        self.assertEqual(strays, [], f"mapped ids that are not transforms: {strays}")


class ItAgreesWithEachTransformsOwnSummary(unittest.TestCase):
    """The cross-check that keeps the map honest: where a transform's summary names its reagent,
    the class that summary classifies to must be the class the mapped conditions give. The executor
    describes `fmoc-removal` as using piperidine and `boc-removal` as using TFA; the bridge must not
    disagree with that."""

    def test_no_summary_contradicts_the_mapped_class(self):
        for tid, want in EXPECTED_CLASS.items():
            summary_classes = T.classify(TRANSFORMS[tid]["summary"])
            if not summary_classes:
                continue  # family verbs and a few summaries do not name the reagent; nothing to check
            with self.subTest(tid):
                self.assertIn(want, summary_classes,
                              f"{tid}: summary classifies to {summary_classes}, map says {want}")


class ItMakesTheGatesFireOnAProgramStep(unittest.TestCase):
    """The point of the whole thing: a program-style step (reactant/product + transform id, no
    conditions prose) must reach the gates once the bridge supplies the conditions."""

    # Cbz-Gly-OBzl carries both reducible groups, so whichever one the step removes the other is
    # collateral. One molecule, two steps, mirrored answers — which is what pins each hydrogenolysis
    # id to its own direction rather than to "hydrogenation flags something".
    CBZ_GLY_OBZL = "O=C(NCC(=O)OCc1ccccc1)OCc1ccccc1"
    CBZ_REMOVED_OBZL_KEPT = "NCC(=O)OCc1ccccc1"         # the Cbz is the intended victim
    OBZL_REMOVED_CBZ_KEPT = "O=C(NCC(=O)O)OCc1ccccc1"   # the benzyl ester is

    def _check(self, reactants, products, transform_id):
        cond = T.conditions_for_transform(transform_id)
        out = W._compatibility([{"reactants": reactants, "products": products, "reagents": cond}])
        return {h["group"] for h in out[0]["hazards"]}

    def test_fmoc_removal_on_an_Asp_Gly_dipeptide_raises_the_aspartimide(self):
        # Exactly the step a generated chainDG-6 route produces, minus the conditions string. With
        # the bridge it classifies as amine-base and the gate fires; without it, classify is [].
        fmoc_on = "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
        freed = "C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
        self.assertIn("aspartimide-gly", self._check([fmoc_on], [freed], "fmoc-removal"))

    def test_the_SAME_step_with_no_bridge_is_silent(self):
        # The defect, stated: the transform id alone classifies as nothing.
        fmoc_on = "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
        freed = "C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
        out = W._compatibility([{"reactants": [fmoc_on], "products": [freed], "reagents": "fmoc-removal"}])
        self.assertNotIn("aspartimide-gly", {h["group"] for h in out[0]["hazards"]})

    def test_a_coupling_that_adds_an_arginine_raises_the_lactam(self):
        chain_amine = "C[C@@H](C(=O)NCC(=O)O)N"
        arg = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4"
               "C5=CC=CC=C35)N)C")
        product = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)NC(C)C(=O)NCC(=O)O)"
                   "NC(=O)OCC3C4=CC=CC=C4C5=CC=CC=C35)N)C")
        fired = self._check([chain_amine, arg], [product], "n-peptide-coupling")
        self.assertIn("arg-delta-lactam", fired)

    def test_hydrazine_flags_a_dde_group_that_must_survive(self):
        molecule = "CC(=C1C(=O)CC(C)(C)CC1=O)NC"
        self.assertIn("dde-enamine", self._check([molecule], [molecule], "dde-removal"))

    def test_hydrazine_flags_a_support_ester(self):
        molecule = "*OC(=O)[C@@H](C)N"
        self.assertIn("support ester", self._check([molecule], [molecule], "dde-removal"))

    def test_pd_flags_alloc_and_allyl_groups_that_must_survive(self):
        alloc = "C=CCOC(=O)NCC"
        allyl = "C=CCOC(=O)C"
        self.assertIn("alloc-carbamate", self._check([alloc], [alloc], "alloc-removal"))
        self.assertIn("allyl-ester", self._check([allyl], [allyl], "allyl-ester-removal"))

    def test_fluoride_flags_an_otmse_group_that_must_survive(self):
        otmse = "C[Si](C)(C)CCOC(=O)C"
        self.assertIn("otmse-ester", self._check([otmse], [otmse], "otmse-removal"))

    def test_hydrazine_flags_allyl_groups_that_must_survive(self):
        alloc = "C=CCOC(=O)NCC"
        allyl = "C=CCOC(=O)C"
        self.assertIn("alloc-carbamate", self._check([alloc], [alloc], "dde-removal"))
        self.assertIn("allyl-ester", self._check([allyl], [allyl], "dde-removal"))

    def test_fluoride_flags_an_fmoc_group_that_must_survive(self):
        fmoc = "O=C(O)CNC(=O)OCC1c2ccccc2-c2ccccc21"
        self.assertIn("fmoc", self._check([fmoc], [fmoc], "otmse-removal"))

    def test_hydrazine_flags_odmab_and_fmoc_that_must_survive(self):
        odmab = "CC(=O)OCC1=CC=C(NC(=C2C(=O)CC(C)(C)CC2=O)CC(C)C)C=C1"
        fmoc = "O=C(O)CNC(=O)OCC1c2ccccc2-c2ccccc21"
        self.assertIn("odmab-ester", self._check([odmab], [odmab], "odmab-removal"))
        self.assertIn("fmoc", self._check([fmoc], [fmoc], "odmab-removal"))

    def test_cbz_removal_flags_the_benzyl_ester_it_would_also_cleave(self):
        fired = self._check([self.CBZ_GLY_OBZL], [self.CBZ_REMOVED_OBZL_KEPT], "cbz-removal")
        self.assertIn("benzyl-ester", fired)

    def test_benzyl_ester_hydrogenolysis_flags_the_cbz_it_would_also_cleave(self):
        fired = self._check([self.CBZ_GLY_OBZL], [self.OBZL_REMOVED_CBZ_KEPT],
                            "benzyl-ester-hydrogenolysis")
        self.assertIn("cbz", fired)

    def test_control_plain_cbz_removal_is_examined_and_clean(self):
        """CONTROL — silence where silence is the right answer, on a Cbz route with nothing else
        reducible. Read as a control, not as a second positive test: the `hazards == []` half is
        true in both states. The half that makes it mean something is that the record now names
        its class and drops `unmodelled`, so "no hazards" is examined-and-clean rather than
        "nothing was looked at" — that half is red before the map entry and green after it."""
        l_ala_gly = "C[C@H](NC(=O)OCc1ccccc1)C(=O)NCC(=O)O"   # L-Ala (CIP S); the D form would
        freed = "C[C@H](N)C(=O)NCC(=O)O"                      # fire the D-block reading instead
        record = W._compatibility([{"reactants": [l_ala_gly], "products": [freed],
                                    "transform": "cbz-removal"}])[0]
        self.assertEqual({h["group"] for h in record["hazards"]}, set())
        self.assertEqual([c["id"] for c in record["reagentClasses"]], ["hydrogenation"])
        self.assertNotIn("unmodelled", record)

    def test_control_a_mapped_id_step_is_byte_identical_to_its_string_as_free_text(self):
        """CONTROL — green in both states, and it says so. `boc-removal` was mapped before this
        unit; its record must not move. The map's contract is that it supplies a STRING to
        `classify`, not a second code path, so the same step written as free text must produce
        the identical record, field for field."""
        boc_ser_obzl = "CC(C)(C)OC(=O)N[C@@H](CO)C(=O)OCc1ccccc1"
        boc_ser_oh = "CC(C)(C)OC(=O)N[C@@H](CO)C(=O)O"
        by_id = W._compatibility([{"reactants": [boc_ser_obzl], "products": [boc_ser_oh],
                                   "transform": "boc-removal"}])[0]
        by_text = W._compatibility([{"reactants": [boc_ser_obzl], "products": [boc_ser_oh],
                                     "reagents": "TFA/H2O 95:5, 2 h"}])[0]
        self.assertIn("boc", {h["group"] for h in by_text["hazards"]})  # not a trivial empty ==
        self.assertEqual(by_id, by_text)


class TheStepCarriesItsOwnTransformId(unittest.TestCase):
    """The shipped wiring. The tests above resolve the map themselves and hand `_compatibility` a
    conditions string, which is what the LOCAL generator does. The app-facing path cannot: the map
    lives here and the caller is TypeScript. So a step may carry `transform` and `_compatibility`
    resolves it, which is the only new surface on the wire.

    A step's own text still travels, and the mapped conditions LEAD it. On this path that text is
    the arrow text, which is the model's free-form note when it wrote one — prose, not a conditions
    line. Preferring the note (as the local generator prefers its `care` plan, which IS a
    conditions line) would let an annotated step silence the gates an unannotated one trips."""

    # The Asp(OtBu)-Gly step a generated chainDG-6 route produces, as above.
    FMOC_ON = "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"
    FREED = "C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O"

    def _groups(self, **extra):
        step = {"reactants": [self.FMOC_ON], "products": [self.FREED], **extra}
        return {h["group"] for h in W._compatibility([step])[0]["hazards"]}

    def _record(self, **extra):
        step = {"reactants": [self.FMOC_ON], "products": [self.FREED], **extra}
        return W._compatibility([step])[0]

    def test_a_transform_id_alone_makes_the_gate_fire(self):
        # No conditions string anywhere: this is exactly the step shape the app sends.
        self.assertIn("aspartimide-gly", self._groups(transform="fmoc-removal"))

    def test_a_prose_note_does_not_silence_the_gate(self):
        # The trap: the arrow text prefers the note, so a model that documents its steps would
        # otherwise turn every gate off. The note is kept, and the conditions still lead.
        fired = self._groups(reagents="remove the Fmoc and carry on", transform="fmoc-removal")
        self.assertIn("aspartimide-gly", fired)

    def test_a_note_that_names_a_real_reagent_is_still_read(self):
        # The note is appended, not discarded, so a reagent the model names in prose still counts.
        fired = self._groups(reagents="HATU, DIPEA, DMF", transform="fmoc-removal")
        self.assertIn("aspartimide-gly", fired)

    def test_an_unmapped_transform_is_marked_as_not_examined(self):
        # What this field exists to stop. `conditions_for_transform` returns None outside the map,
        # and with no note the text is the empty string, so `classify` reads nothing and every gate
        # below is skipped. `hazards == []` then means "nothing was looked at", not "nothing found",
        # and the record has to say so: 210 of 213 captured program steps were in this state and
        # every one of them rendered as a clean step.
        record = self._record(transform="azide-alkyne-click")
        self.assertIsNone(T.conditions_for_transform("azide-alkyne-click"))
        self.assertEqual(record["hazards"], [])
        self.assertEqual(record["reagentClasses"], [])
        self.assertEqual(record["unmodelled"], "azide-alkyne-click")

    def test_a_note_that_classifies_leaves_no_marker(self):
        # The negative control against over-flagging. The step WAS examined — for the reagent the
        # note names — so calling it unexamined would understate the check.
        record = self._record(transform="ester-formation", reagents="NaOH, H2O")
        self.assertEqual([c["id"] for c in record["reagentClasses"]], ["hydroxide"])
        self.assertNotIn("unmodelled", record)

    def test_a_mapped_transform_is_not_marked(self):
        # The negative control against the marker swallowing the ordinary path.
        record = self._record(transform="fmoc-removal")
        self.assertIn("aspartimide-gly", {h["group"] for h in record["hazards"]})
        self.assertNotIn("unmodelled", record)

    def test_a_free_smarts_step_is_not_marked(self):
        # `smarts` is the app's word for a line that supplied its own pattern, not a curated id, so
        # no map entry could ever cover it. Claiming a transform called `smarts` is unmodelled
        # would be a different and false statement.
        record = self._record(transform="smarts")
        self.assertNotIn("unmodelled", record)

    def test_a_step_can_be_both_unexamined_and_flagged(self):
        # A gate that needs no reagent class (the D-block reading) fires on a step whose reagents
        # are unexamined. The marker is additive: it must never replace a hazard, and a hazard must
        # never hide the gap.
        d_ala = "C[C@@H](N)C(=O)O"
        record = W._compatibility([{"reactants": [d_ala], "products": [d_ala],
                                    "transform": "azide-alkyne-click"}])[0]
        self.assertIn("d-amino-acid", {h["group"] for h in record["hazards"]})
        self.assertEqual(record["unmodelled"], "azide-alkyne-click")

    def test_a_free_text_step_is_untouched(self):
        # The names-first path sends no `transform`. Its behaviour must not move.
        self.assertIn("aspartimide-gly", self._groups(reagents="20% piperidine in DMF, 2 x 5 min"))

    def test_the_bare_id_as_text_is_still_silent(self):
        # The defect restated against the new field: an id in the TEXT slot classifies as nothing.
        # Only the `transform` slot is resolved, so the gap closes in one place, not two.
        self.assertNotIn("aspartimide-gly", self._groups(reagents="fmoc-removal"))


# Nothing goes after this block.
if __name__ == "__main__":
    unittest.main()
