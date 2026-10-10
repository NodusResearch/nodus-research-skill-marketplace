"""Tests for the route-program toolkit. Run with the plugin runtime's interpreter:

    <venv>/bin/python3 -I plugins/chemistry-studio/test/test_route_program.py

Every expectation below is a canonical SMILES RDKit actually produced, not one read off a template
by eye: a curated SMARTS that is quietly wrong is the worst outcome this module can have, so each
one is pinned to its product here.

The reversal of an index retro template is only exercised when ROUTE_PROGRAM_TEST_INDEX names a
directory holding one, because an index is local data that never ships with the repository.
"""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import reactions_worker
import route_program


def apply(**payload):
    return route_program.handle({"op": "apply", **payload})


def named(transform_id, molecule, reagents=(), **extra):
    return apply(molecule=molecule, operation={"kind": "named", "id": transform_id},
                 reagents=list(reagents), **extra)


# One substrate and the whole expected answer per curated transformation.
CURATED = {
    "ester-hydrolysis": ("CCOC(=O)c1ccccc1", [], "O=C(O)c1ccccc1", ["CCO"]),
    "ester-formation": ("OC(=O)c1ccccc1", ["CCO"], "CCOC(=O)c1ccccc1", ["O"]),
    "amide-formation": ("OC(=O)c1ccccc1", ["CNC"], "CN(C)C(=O)c1ccccc1", ["O"]),
    "amide-hydrolysis": ("CNC(=O)c1ccccc1", [], "O=C(O)c1ccccc1", ["CN"]),
    "n-acylation": ("Nc1ccccc1", ["CC(=O)Cl"], "CC(=O)Nc1ccccc1", ["Cl"]),
    "ketone-reduction": ("CC(=O)c1ccccc1", [], "CC(O)c1ccccc1", []),
    "aldehyde-reduction": ("O=Cc1ccccc1", [], "OCc1ccccc1", []),
    "secondary-alcohol-oxidation": ("CC(O)c1ccccc1", [], "CC(=O)c1ccccc1", []),
    "primary-alcohol-oxidation": ("OCc1ccccc1", [], "O=Cc1ccccc1", []),
    "aldehyde-oxidation": ("O=Cc1ccccc1", [], "O=C(O)c1ccccc1", []),
    "nitro-reduction": ("O=[N+]([O-])c1ccccc1", [], "Nc1ccccc1", []),
    "nitrile-hydrolysis": ("N#Cc1ccccc1", [], "O=C(O)c1ccccc1", ["N"]),
    "alkene-hydrogenation": ("C=Cc1ccccc1", [], "CCc1ccccc1", []),
    "halide-amination": ("BrCc1ccccc1", ["CNC"], "CN(C)Cc1ccccc1", ["Br"]),
    "phenol-alkylation": ("Oc1ccccc1", ["CI"], "COc1ccccc1", ["I"]),
    "acid-to-acyl-chloride": ("OC(=O)c1ccccc1", [], "O=C(Cl)c1ccccc1", []),
}

KETONE_REDUCTION_SMARTS = "[#6:1][C:2](=[O:3])[#6:4]>>[#6:1][CH1:2]([OH:3])[#6:4]"
HYDROGENATION_SMARTS = "[CX3:1]=[CX3:2]>>[C:1][C:2]"


class CuratedSet(unittest.TestCase):
    def test_every_curated_transformation_is_listed_with_a_site(self):
        listed = route_program.handle({"op": "transforms"})
        self.assertTrue(listed["ok"])
        ids = [t["id"] for t in listed["transforms"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), set(CURATED))
        for entry in listed["transforms"]:
            self.assertEqual(sorted(entry), ["id", "site", "summary"])
            self.assertTrue(entry["summary"].endswith("."), entry)
            self.assertIn(entry["site"], route_program._tables()["sites"])

    def test_every_curated_transformation_gives_the_product_it_claims(self):
        for transform_id, (molecule, reagents, product, co_products) in sorted(CURATED.items()):
            with self.subTest(transform_id):
                out = named(transform_id, molecule, reagents)
                self.assertTrue(out.get("ok"), out)
                self.assertEqual(out["product"], product)
                self.assertEqual(out["coProducts"], co_products)
                self.assertEqual(out["site"]["phrase"], route_program._tables()["byId"][transform_id]["site"])
                self.assertTrue(out["site"]["atoms"])

    def test_the_formula_is_the_main_product_s(self):
        self.assertEqual(named("nitro-reduction", "O=[N+]([O-])c1ccccc1")["formula"], "C6H7N")
        self.assertEqual(named("ester-hydrolysis", "CCOC(=O)c1ccccc1")["formula"], "C7H6O2")

    def test_a_co_product_is_returned_apart_from_the_carried_one(self):
        # The acyl part is the smaller fragment here, so a largest-fragment rule would hand back the
        # alcohol: what is carried is the fragment made of the atoms that came in.
        out = named("ester-hydrolysis", "CC(=O)OCCCCCCCCCCCC")
        self.assertEqual(out["product"], "CC(=O)O")
        self.assertEqual(out["coProducts"], ["CCCCCCCCCCCCO"])

    def test_a_routine_reagent_need_not_be_named_and_a_substantive_one_must_be(self):
        self.assertTrue(named("ester-hydrolysis", "CCOC(=O)c1ccccc1").get("ok"))
        self.assertTrue(named("ester-hydrolysis", "CCOC(=O)c1ccccc1", ["O"]).get("ok"))
        missing = named("ester-formation", "OC(=O)c1ccccc1")
        self.assertEqual(missing["error"], "no-match")
        self.assertIn("alcohol", missing["message"])


class SiteResolution(unittest.TestCase):
    def test_exactly_one_match_is_applied_and_its_atoms_reported(self):
        out = named("ketone-reduction", "CCCC(=O)C")
        self.assertEqual(out["product"], "CCCC(C)O")
        self.assertEqual(out["site"], {"phrase": "ketone", "atoms": [2, 3, 4, 5]})

    def test_no_match_at_all_is_absent_site(self):
        out = named("ketone-reduction", "CCOC(=O)c1ccccc1")
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("no ketone", out["message"])

    def test_several_matches_are_ambiguous_and_never_guessed(self):
        out = named("ester-hydrolysis", "CCOC(=O)c1ccc(C(=O)OCC)cc1")
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("2 places", out["message"])

    def test_a_symmetric_group_is_one_place_not_several(self):
        out = named("ketone-reduction", "CC(C)=O")
        self.assertEqual(out["product"], "CC(C)O")

    def test_a_caller_s_phrase_overrides_the_transformation_s_own(self):
        # Two esters, so the declared phrase cannot discriminate; a narrower phrase can.
        both = named("ester-hydrolysis", "CCOC(=O)COC(C)=O")
        self.assertEqual(both["error"], "ambiguous-site")
        narrowed = named("ester-hydrolysis", "CCOC(=O)COC(C)=O", site="ether")
        self.assertEqual(narrowed["error"], "absent-site")

    def test_a_site_that_resolves_but_cannot_react_is_no_match_not_a_guess(self):
        # "alkyl halide" covers C-F; the displacement does not, so the site resolves and the
        # transformation then declines rather than inventing a product.
        out = named("halide-amination", "FCc1ccccc1", ["CNC"])
        self.assertEqual(out["error"], "no-match")
        self.assertIn("alkyl halide", out["message"])

    def test_a_phrase_outside_the_vocabulary_is_an_unresolved_name(self):
        out = named("ketone-reduction", "CC(=O)C", site="unicorn group")
        self.assertEqual(out["error"], "unresolved-name")
        self.assertIn("unicorn group", out["message"])

    def test_an_operation_with_no_site_and_several_places_is_ambiguous(self):
        # Not a symmetric diketone: reducing either carbonyl of one of those gives the same
        # molecule, which is one place, not two.
        out = apply(molecule="CC(=O)CCCC(=O)CC",
                    operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("no site was named", out["message"])

    def test_an_operation_with_no_site_and_one_place_is_fine(self):
        out = apply(molecule="CC(=O)c1ccccc1",
                    operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["product"], "CC(O)c1ccccc1")
        self.assertNotIn("site", out)


class Errors(unittest.TestCase):
    def test_an_unknown_curated_id_is_an_unresolved_name(self):
        out = named("no-such-transformation", "CC(=O)C")
        self.assertEqual(out["error"], "unresolved-name")

    def test_a_transformation_that_does_not_apply_is_no_match(self):
        out = apply(molecule="c1ccccc1", operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["error"], "no-match")

    def test_unreadable_input_is_unparsable(self):
        self.assertEqual(named("ketone-reduction", "not a smiles")["error"], "unparsable")
        self.assertEqual(apply(operation={"kind": "named", "id": "ketone-reduction"})["error"], "unparsable")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "smarts", "smarts": "nonsense"})["error"], "unparsable")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "wishful", "id": "x"})["error"], "unparsable")
        self.assertEqual(route_program.handle({"op": "levitate"})["error"], "unparsable")
        self.assertEqual(route_program.handle("not an object")["error"], "unparsable")
        self.assertEqual(named("ester-formation", "OC(=O)c1ccccc1", ["not a smiles"])["error"], "unparsable")

    def test_a_template_that_is_not_in_the_index_is_unknown(self):
        with tempfile.TemporaryDirectory() as empty:
            out = apply(molecule="CC(=O)C", operation={"kind": "template", "id": "whatever", "indexDir": empty})
            self.assertEqual(out["error"], "unknown-template")
        out = apply(molecule="CC(=O)C", operation={"kind": "template", "id": "whatever",
                                                   "indexDir": os.path.join(HERE, "no-such-index")})
        self.assertEqual(out["error"], "unknown-template")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "template"})["error"], "unknown-template")

    def test_a_budget_too_small_to_answer_in_is_reported_rather_than_overrun(self):
        polyene = "C=C" + "CC=C" * 40
        out = apply(molecule=polyene, operation={"kind": "smarts", "smarts": HYDROGENATION_SMARTS},
                    budgetSeconds=0.001)
        self.assertEqual(out["error"], "budget", out)

    def test_a_generous_budget_is_clamped_rather_than_honoured(self):
        out = apply(molecule="CC(=O)c1ccccc1", operation={"kind": "named", "id": "ketone-reduction"},
                    budgetSeconds=10_000)
        self.assertTrue(out.get("ok"), out)


class Describe(unittest.TestCase):
    def test_describe_reports_the_formula_and_only_the_sites_that_are_present(self):
        out = route_program.handle({"op": "describe", "molecule": "CCOC(=O)c1ccc(O)cc1"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["formula"], "C9H10O3")
        self.assertIn("ester", out["sites"])
        self.assertIn("phenol", out["sites"])
        self.assertNotIn("ketone", out["sites"])
        self.assertNotIn("nitro group", out["sites"])
        self.assertTrue(out["summary"].startswith("C9H10O3, 12 heavy atoms;"), out["summary"])

    def test_describe_says_when_a_phrase_cannot_discriminate(self):
        out = route_program.handle({"op": "describe", "molecule": "CCOC(=O)c1ccc(C(=O)OCC)cc1"})
        self.assertIn("ester (2)", out["summary"])

    def test_describe_of_a_molecule_with_nothing_named_says_so(self):
        out = route_program.handle({"op": "describe", "molecule": "C1CCCCC1"})
        self.assertEqual(out["sites"], [])
        self.assertIn("no named site present", out["summary"])

    def test_describe_needs_a_readable_molecule(self):
        self.assertEqual(route_program.handle({"op": "describe", "molecule": "???"})["error"], "unparsable")


class Dispatch(unittest.TestCase):
    def test_the_worker_dispatches_the_request_key_and_wraps_the_answer(self):
        out = reactions_worker.handle({"routeProgram": {"op": "apply", "molecule": "CC(=O)c1ccccc1",
                                                        "operation": {"kind": "named", "id": "ketone-reduction"}}})
        self.assertEqual(list(out), ["routeProgram"])
        self.assertEqual(out["routeProgram"]["product"], "CC(O)c1ccccc1")

    def test_the_worker_needs_no_index_for_a_route_program_request(self):
        out = reactions_worker.handle({"routeProgram": {"op": "transforms"}})
        self.assertTrue(out["routeProgram"]["ok"])


@unittest.skipUnless(os.environ.get("ROUTE_PROGRAM_TEST_INDEX"),
                     "set ROUTE_PROGRAM_TEST_INDEX to an index directory holding retro-templates.tsv.zst")
class ReversedIndexTemplate(unittest.TestCase):
    """The second-class path: our templates are retro, so forward use means swapping the sides."""

    index = os.environ.get("ROUTE_PROGRAM_TEST_INDEX", "")
    NITRO = "[NH2;D1;+0:1]-[c:2]>>O=[N+;H0;D3:1](-[O-])-[c:2]"

    def test_a_retro_template_reversed_makes_the_product_it_was_derived_from(self):
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": self.NITRO, "indexDir": self.index})
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"], "Nc1ccccc1")

    def test_a_template_can_be_asked_for_by_digest(self):
        import hashlib

        digest = hashlib.sha1(self.NITRO.encode()).hexdigest()[:16]
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": digest, "indexDir": self.index})
        self.assertEqual(out.get("product"), "Nc1ccccc1")

    def test_a_template_the_index_does_not_hold_is_unknown(self):
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": "[C:1]>>[C:1]", "indexDir": self.index})
        self.assertEqual(out["error"], "unknown-template")


if __name__ == "__main__":
    unittest.main(verbosity=2)
