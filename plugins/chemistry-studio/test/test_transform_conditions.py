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
    "n-formylation": "acylating",
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
        # A protection install (block manufacture, not on-resin assembly) is deliberately unmapped;
        # it must read as a gap, never as some default class.
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


# Nothing goes after this block.
if __name__ == "__main__":
    unittest.main()
