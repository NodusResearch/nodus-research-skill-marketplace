"""Tests for reading the templates file and surviving a stale screen cache.

Run with the plugin runtime's interpreter:

    <venv>/bin/python3 -I plugins/chemistry-studio/test/test_reactions_worker.py

Every test writes its own tiny index to a temporary directory: the real index is local data and
never ships here, and a fixture built in the test makes the expected answer the thing that went in.

Each test below is a defect that reached a build and was found by measurement, not by inspection:

  - the templates file gained a FOURTH column, a three-way split put that column at the front of
    every pattern, nothing parsed, and the store read as EMPTY rather than as unreadable. Measured
    2026-10-12: 106 of 106 evidence gathers across seven harness runs returned no disconnection,
    so the whole template library of index-v10 was never once consulted.

  - the screen cache beside the templates file is keyed on the file's bytes and the RDKit version
    but NOT on the code that wrote it, so a build whose loader parses all the templates hands its
    cache to a build whose loader cannot, which then defers parsing, re-parses with the broken
    split, gets None, and passes None to HasSubstructMatch. The silent drop above became a
    Boost.Python.ArgumentError that killed the search for every target.
"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import zstandard
from rdkit import Chem, RDLogger

import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

# Aspirin from salicylic acid: one acylation template, written retro (product >> precursors).
ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O"
SALICYLIC = "O=C(O)c1ccccc1O"
ACETYLATION = "[C:1](=[O:2])-[O;H0;D2:3]-[c:4]>>[C:1](=[O:2])-[OH;D1:3].[c:4]-[OH]"


def _write_zst(path, lines):
    with open(path, "wb") as fh:
        fh.write(zstandard.ZstdCompressor().compress(("\n".join(lines) + "\n").encode()))


def _index(tmp, template_lines):
    """A directory holding just enough of an index for _retro_templates and _disconnect."""
    _write_zst(os.path.join(tmp, "retro-templates.tsv.zst"), template_lines)
    _write_zst(os.path.join(tmp, "molecules.tsv.zst"), [f"{SALICYLIC}\t1"])
    W._retro_cache.clear()
    W._retro_screen.clear()
    return tmp


class TemplateRow(unittest.TestCase):
    def test_three_column_line(self):
        """The format as it was: count, rdchiral, pattern."""
        count, rdchiral, smarts = W._template_row(f"7\t3\t{ACETYLATION}\n")
        self.assertEqual((count, rdchiral), ("7", "3"))
        self.assertEqual(smarts, ACETYLATION)

    def test_four_column_line(self):
        """The format as index-v10 writes it: a column appears BEFORE the pattern.

        This is the bug: a three-way split returns "1\\t<pattern>" as the pattern, and
        MolFromSmarts on a string with a tab in it is None.
        """
        count, rdchiral, smarts = W._template_row(f"7\t3\t1\t{ACETYLATION}\n")
        self.assertEqual((count, rdchiral), ("7", "3"))
        self.assertEqual(smarts, ACETYLATION, "the pattern must be the LAST field, not the third")
        self.assertIsNotNone(
            Chem.MolFromSmarts(smarts.split(">>")[0]),
            "a pattern read from a four-column line must still parse",
        )

    def test_a_pattern_is_never_split(self):
        """However many columns are added, the pattern is whatever follows the last tab."""
        for extra in ([], ["1"], ["1", "radius=4"], ["1", "radius=4", "src=uspto"]):
            line = "\t".join(["7", "3", *extra, ACETYLATION])
            self.assertEqual(W._template_row(line)[2], ACETYLATION)


class LoadsFourColumnTemplates(unittest.TestCase):
    def test_templates_parse_and_disconnect(self):
        """End to end on a four-column file: the template loads and proposes the precursor."""
        with tempfile.TemporaryDirectory() as tmp:
            index = _index(tmp, [f"7\t3\t1\t{ACETYLATION}"])
            rows = W._retro_templates(index)
            self.assertEqual(len(rows), 1, "the four-column template was dropped")
            results = W._disconnect(index, [ASPIRIN], 4)
            precursors = {p["precursors"] for p in results[0]["proposals"]}
            self.assertTrue(
                any(SALICYLIC in side.split(".") for side in precursors),
                f"salicylic acid was not proposed; got {precursors}",
            )


class StaleScreenCache(unittest.TestCase):
    """A cache written by a loader that parsed MORE templates than this one can.

    Reproduces the shipped crash: `valid` names every line, so the rows are built with the query
    deferred (None); the lazy re-parse then fails on the unparseable line. The search must drop
    that template, not raise.
    """

    def test_unparseable_template_in_a_valid_cache_does_not_raise(self):
        import numpy as np

        with tempfile.TemporaryDirectory() as tmp:
            # The second line cannot be parsed as SMARTS by any version of the loader.
            index = _index(tmp, [f"7\t3\t1\t{ACETYLATION}", "7\t3\t1\t((((>>C"])
            path = os.path.join(index, "retro-templates.tsv.zst")
            screen = np.zeros((2, W.SCREEN_BITS // 64), dtype=np.uint64)
            np.savez(W._screen_cache_path(path), screen=screen, valid=np.asarray([0, 1], dtype=np.int64))
            W._retro_cache.clear()
            W._retro_screen.clear()

            rows = W._retro_templates(index)
            self.assertEqual(len(rows), 2, "the cached path should return the rows the cache names")
            self.assertTrue(all(row[3] is None for row in rows), "queries are parsed on first use")

            # The call that used to raise Boost.Python.ArgumentError: Mol.HasSubstructMatch(Mol, NoneType)
            results = W._disconnect(index, [ASPIRIN], 4)
            self.assertEqual(len(results), 1)
            precursors = {p["precursors"] for p in results[0]["proposals"]}
            self.assertTrue(
                any(SALICYLIC in side.split(".") for side in precursors),
                "the good template must still be applied after the bad one is skipped",
            )


class ScreenCacheKey(unittest.TestCase):
    def test_key_covers_the_loader_version(self):
        """Two builds that read the file differently must not share one cache.

        Without this the cache is interchangeable between a loader that parses every template and
        one that parses none, which is exactly how the crash above was delivered.
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "retro-templates.tsv.zst")
            _write_zst(path, [f"7\t3\t1\t{ACETYLATION}"])
            key = W._screen_cache_path(path)
            self.assertIn(f"screen-v{W.SCREEN_FORMAT}", key, "the cache name must carry the format version")


class BoundedAndDamagedInputs(unittest.TestCase):
    def test_a_site_past_the_match_cap_does_not_drop_a_template(self):
        mol = Chem.MolFromSmiles(".".join(["C"] * (W.SITE_MAX_MATCHES + 5)))
        query = Chem.MolFromSmarts("[C]")
        self.assertTrue(W._at_site(mol, query, {mol.GetNumAtoms() - 1}))
        self.assertFalse(W._at_site(mol, Chem.MolFromSmarts("[N]"), {mol.GetNumAtoms() - 1}))

    def test_malformed_rows_do_not_hide_the_valid_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = _index(tmp, ["", "bad", "x\t3\tbad", "-1\t3\tbad", f"7\t3\t{ACETYLATION}"])
            self.assertEqual(len(W._retro_templates(index)), 1)
            self.assertTrue(W._disconnect(index, [ASPIRIN], 4)[0]["proposals"])

    def test_invalid_cache_indices_or_shape_are_rebuilt(self):
        import numpy as np
        for valid, screen in ((np.array([-1]), np.zeros((1, 32), dtype=np.uint64)),
                              (np.array([0]), np.zeros((1, 1), dtype=np.uint64)),
                              (np.array([0.0]), np.zeros((1, 32), dtype=np.uint64))):
            with self.subTest(valid=valid, shape=screen.shape), tempfile.TemporaryDirectory() as tmp:
                index = _index(tmp, [f"7\t3\t{ACETYLATION}"])
                cache = W._screen_cache_path(os.path.join(tmp, "retro-templates.tsv.zst"))
                np.savez(cache, valid=valid, screen=screen)
                rows = W._retro_templates(index)
                self.assertEqual(len(rows), 1)
                self.assertIsNotNone(rows[0][3], "an invalid cache must be rebuilt")


class ReactionClasses(unittest.TestCase):
    """_reaction_classes is heuristic and feeds literature SEARCH TERMS, not a verdict -- but a
    wrong term costs a wasted search and a misleading precedent, so the obvious guards are kept."""

    def test_an_acylation_with_an_acylating_agent_is_named(self):
        # benzene + acetyl chloride -> acetophenone
        self.assertIn("Friedel-Crafts acylation",
                      W._reaction_classes("c1ccccc1.CC(=O)Cl", "CC(=O)c1ccccc1"))

    def test_an_aryl_ketone_merely_unmasked_is_not_an_acylation(self):
        # Found 2026-10-13. The pre-existing guard already covered the oxidation route (an alcohol
        # is consumed there). The gap was an aryl ketone UNMASKED: nothing is acylated and no
        # alcohol is consumed -- one is released -- so the old test passed either way and proved
        # nothing. A ketal hydrolysis is the case that actually exercises it.
        self.assertNotIn("Friedel-Crafts acylation",
                         W._reaction_classes("CC1(OCCO1)c1ccccc1.O", "CC(=O)c1ccccc1.OCCO"))

    def test_an_anhydride_also_counts_as_the_acylating_agent(self):
        self.assertIn("Friedel-Crafts acylation",
                      W._reaction_classes("c1ccccc1.CC(=O)OC(C)=O", "CC(=O)c1ccccc1.CC(=O)O"))


def _forward_index(tmp, template_lines):
    """A directory holding just enough of an index for _forward_steps."""
    _write_zst(os.path.join(tmp, "forward-templates.tsv.zst"), template_lines)
    W._forward_cache.clear()
    W._forward_screen.clear()
    return tmp


class ForwardSteps(unittest.TestCase):
    """What the index can actually DO to a molecule, as the author is offered it.

    The point of the search is that a candidate has precedent: a transformation that cannot be
    applied is never offered, so an empty list is an answer rather than a failure.
    """

    # acid + amine >> amide, the forward direction, written as the builder writes it
    COUPLE = ("[C:1]-[C;H0;D3;+0:2](=[O;D1;H0:3])-[O;H1;D1;+0].[C:5]-[NH2;D1;+0:4]"
              ">>[C:1]-[C;H0;D3;+0:2](=[O;D1;H0:3])-[NH;D2;+0:4]-[C:5]")
    # ester >> acid: applies to the product of the coupling, not to the acid itself
    HYDROLYSE = "[C:1]-[C;H0;D3;+0:2](=[O;D1;H0:3])-[O;H0;D2;+0]-[CH3;D1;+0]>>[C:1]-[C:2](=[O:3])-[OH]"

    def test_a_transformation_that_applies_is_offered_with_its_product(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = _forward_index(tmp, [f"500\t500\t2\t{self.COUPLE}"])
            out = W._forward_steps(index, "CC(=O)O", ["CCN"], limit=5)
            self.assertEqual(len(out), 1, out)
            self.assertEqual(out[0]["product"], "CCNC(C)=O")
            self.assertEqual(out[0]["count"], 500)
            self.assertEqual(out[0]["smarts"], self.COUPLE)

    def test_a_transformation_that_does_not_apply_is_not_offered(self):
        with tempfile.TemporaryDirectory() as tmp:
            # The hydrolysis needs a methyl ester; the molecule is an acid, so nothing applies.
            index = _forward_index(tmp, [f"500\t500\t2\t{self.HYDROLYSE}"])
            self.assertEqual(W._forward_steps(index, "CC(=O)O", [], limit=5), [])

    def test_a_two_component_transformation_needs_its_partner(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = _forward_index(tmp, [f"500\t500\t2\t{self.COUPLE}"])
            # Without the amine there is no second component, so the coupling cannot be offered.
            self.assertEqual(W._forward_steps(index, "CC(=O)O", [], limit=5), [])

    def test_outcomes_are_deduplicated_by_product_keeping_the_best_attested(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Two templates that reach the SAME product: one entry, carrying the higher count, so
            # the number reads as the precedent for the OUTCOME rather than for one writing of it.
            index = _forward_index(tmp, [f"120\t120\t2\t{self.COUPLE}", f"900\t900\t3\t{self.COUPLE}"])
            out = W._forward_steps(index, "CC(=O)O", ["CCN"], limit=5)
            self.assertEqual(len(out), 1, out)
            self.assertEqual(out[0]["count"], 900)

    def test_an_unreadable_molecule_and_an_absent_file_both_give_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = _forward_index(tmp, [f"500\t500\t2\t{self.COUPLE}"])
            self.assertEqual(W._forward_steps(index, "not a molecule", ["CCN"]), [])
            self.assertEqual(W._forward_steps(index, None, ["CCN"]), [])
        with tempfile.TemporaryDirectory() as bare:
            W._forward_cache.clear(); W._forward_screen.clear()
            self.assertEqual(W._forward_steps(bare, "CC(=O)O", ["CCN"]), [])

    def test_an_author_written_request_reuses_the_path_the_application_last_gave(self):
        """The author cannot name the index: they do not know it and it is not theirs to know.

        Found 2026-10-14: the first model-written request failed outright with "needs the index
        directory", because a fence carries only what the author wrote. The application supplies
        the path on every call it makes itself, so the worker reuses the last one it was given.
        """
        with tempfile.TemporaryDirectory() as tmp:
            index = _forward_index(tmp, [f"500\t500\t2\t{self.COUPLE}"])
            W._last_index_dir = None
            # Nothing has been told to the worker yet, so it says so rather than guessing.
            with self.assertRaises(SystemExit):
                W.handle({"forwardSteps": {"molecule": "CC(=O)O", "reagents": ["CCN"]}})
            # The application makes a call of its own, carrying the path...
            W.handle({"indexDir": index, "forwardSteps": {"molecule": "CC(=O)O", "reagents": ["CCN"]}})
            # ...and an author-written request afterwards needs no path.
            out = W.handle({"forwardSteps": {"molecule": "CC(=O)O", "reagents": ["CCN"]}})
            self.assertEqual(len(out["forwardSteps"]), 1, out)
            self.assertEqual(out["forwardSteps"][0]["product"], "CCNC(C)=O")

    def test_the_request_names_what_the_index_lacks_rather_than_failing(self):
        with tempfile.TemporaryDirectory() as bare:
            W._forward_cache.clear(); W._forward_screen.clear()
            out = W.handle({"indexDir": bare, "forwardSteps": {"molecule": "CC(=O)O"}})
            self.assertEqual(out["forwardSteps"], [])
            self.assertIn("forward-templates.tsv.zst", out.get("indexLacks", []))


class AspartimideContext(unittest.TestCase):
    """The four aspartimide groups fire on the right sequence context and stay silent elsewhere.

    These are not lone functional groups: an aspartate side-chain ESTER closes onto the backbone
    N-H of the NEXT residue under repeated base. So the hazard depends on a neighbour, which is why
    it lives in the compatibility tables rather than the context-free transform set.

    The four groups are split by which REMEDY applies, not by how bad the case is, so each one's
    advice names only a fix its own pattern has already shown to be available. The cases below pin
    that split down, including the part that makes the flag useful: moving the ester from tert-butyl
    to the hindered OMpe clears the milder cases outright and drops Asp-Gly from high to medium,
    rather than leaving a warning nothing can answer.

    Every substrate is a real Fmoc-removal step on a side-chain-protected dipeptide methyl ester.
    """

    DEPROTECTION = "20% piperidine in DMF, 2 x 15 min"

    # (label, reactant, product, expected group or None, expected severity or None)
    CASES = (
        ("Asp(OtBu)-Gly, the classic worst case",
         "COC(=O)CNC(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21",
         "COC(=O)CNC(=O)[C@@H](N)CC(=O)OC(C)(C)C",
         "aspartimide-gly", "high"),
        ("Asp(OMpe)-Gly, same pair behind a hindered ester",
         "CCC(C)(CC)OC(=O)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)NCC(=O)OC",
         "CCC(C)(CC)OC(=O)C[C@H](N)C(=O)NCC(=O)OC",
         "aspartimide-gly-hindered", "medium"),
        ("Asp(OtBu)-Ser(tBu), where a pseudoproline could go",
         "COC(=O)[C@H](COC(C)(C)C)NC(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21",
         "COC(=O)[C@H](COC(C)(C)C)NC(=O)[C@@H](N)CC(=O)OC(C)(C)C",
         "aspartimide-beta-heteroatom", "medium"),
        ("Asp(OtBu)-Ala, prone but with no special dipeptide sold for it",
         "COC(=O)[C@H](C)NC(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21",
         "COC(=O)[C@H](C)NC(=O)[C@@H](N)CC(=O)OC(C)(C)C",
         "aspartimide-prone-xaa", "medium"),
        # Silent on purpose. A beta-branched neighbour hinders the closure enough that flagging it
        # would be wallpaper, and proline has no backbone N-H to close with at all.
        ("Asp(OtBu)-Val, beta-branched neighbour",
         "COC(=O)[C@@H](NC(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21)C(C)C",
         "COC(=O)[C@@H](NC(=O)[C@@H](N)CC(=O)OC(C)(C)C)C(C)C",
         None, None),
        ("Asp(OtBu)-Pro, no backbone N-H",
         "COC(=O)[C@@H]1CCCN1C(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21",
         "COC(=O)[C@@H]1CCCN1C(=O)[C@@H](N)CC(=O)OC(C)(C)C",
         None, None),
    )

    def _aspartimide_hazards(self, reactant, product):
        out = W._compatibility([{"reactants": [reactant], "products": [product],
                                 "reagents": self.DEPROTECTION}])
        self.assertEqual(len(out), 1, "one step in, one step out")
        return [h for h in out[0]["hazards"] if h["group"].startswith("aspartimide")]

    def test_the_named_context_raises_exactly_its_own_group(self):
        for label, reactant, product, group, severity in self.CASES:
            with self.subTest(label):
                found = self._aspartimide_hazards(reactant, product)
                if group is None:
                    self.assertEqual(found, [], "this context must stay silent")
                    continue
                # Exactly one: the four patterns are disjoint by construction (CH2 against a
                # substituted CH, beta heteroatom against beta carbon, hindered ester against
                # labile), so a site that raised two would mean that disjointness had broken.
                self.assertEqual([h["group"] for h in found], [group])
                self.assertEqual(found[0]["severity"], severity)

    def test_the_hindered_ester_is_what_clears_the_milder_cases(self):
        # The remedy the Asp-Gly advice names must actually change the answer, or the flag is one
        # a caller can never discharge. Asp(OMpe)-Ala is the OtBu-Ala case with the bulky ester.
        ompe_ala = ("CCC(C)(CC)OC(=O)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](C)C(=O)OC",
                    "CCC(C)(CC)OC(=O)C[C@H](N)C(=O)N[C@@H](C)C(=O)OC")
        self.assertEqual(self._aspartimide_hazards(*ompe_ala), [],
                         "a hindered ester clears the Ala case outright")
        # ...while Asp-Gly is prone enough that it is downgraded, not silenced.
        gly = self.CASES[1]
        self.assertEqual(self._aspartimide_hazards(gly[1], gly[2])[0]["severity"], "medium")

    def test_a_free_aspartate_has_no_ester_to_attack(self):
        # The closure consumes an ester. With the side chain unprotected there is nothing to close
        # onto, so the worst neighbour in the set must still be silent.
        self.assertEqual(self._aspartimide_hazards(
            "COC(=O)CNC(=O)[C@H](CC(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
            "COC(=O)CNC(=O)[C@@H](N)CC(=O)O"), [])

class SideChainAmideDehydration(unittest.TestCase):
    """An unprotected Asn/Gln side chain is dehydrated to the nitrile by a coupling activator.

    Two things make this worth a test rather than a comment. The first is the false positive it
    must avoid: a C-terminal peptide amide is also a primary carboxamide, and flagging it would
    fire on most Rink-resin syntheses ever written. The pattern separates them on the CH2 linker —
    a side-chain amide reaches its carbonyl through at least one CH2, a C-terminal one sits
    directly on the alpha carbon.

    The second is that the hazard must DISCHARGE. Unusually for this table the remedy needs nothing
    new: Fmoc-Asn(Trt)-OH and Fmoc-Gln(Trt)-OH are already in the building-block set, and a Trt
    makes the side chain a secondary amide, so the same step goes silent once the remedy is used.
    """

    TRT = "C(c1ccccc1)(c2ccccc2)c3ccccc3"

    def _hazards(self, reactants, products, reagents):
        out = W._compatibility([{"reactants": reactants, "products": products, "reagents": reagents}])
        return [h for h in out[0]["hazards"] if h["group"] == "asn-gln-amide"]

    def test_a_free_side_chain_amide_under_an_activator_is_flagged(self):
        for label, acid, product, reagents in (
            ("Asn with a carbodiimide", "N[C@@H](CC(=O)N)C(=O)O",
             "COC(=O)CNC(=O)[C@@H](N)CC(=O)N", "DIC/Oxyma in DMF, 2 h"),
            ("Gln with a uronium salt", "N[C@@H](CCC(=O)N)C(=O)O",
             "COC(=O)CNC(=O)[C@@H](N)CCC(=O)N", "HATU, DIPEA, DMF, 30 min"),
        ):
            with self.subTest(label):
                found = self._hazards([acid, "NCC(=O)OC"], [product], reagents)
                self.assertEqual([h["group"] for h in found], ["asn-gln-amide"])
                self.assertEqual(found[0]["severity"], "medium")
                # The advice must point at a form that exists, not just describe one.
                self.assertIn("N-trityl amide", found[0]["protectedForms"])

    def test_the_trityl_protected_side_chain_discharges_it(self):
        self.assertEqual(self._hazards(
            [f"N[C@@H](CC(=O)N{self.TRT})C(=O)O", "NCC(=O)OC"],
            [f"COC(=O)CNC(=O)[C@@H](N)CC(=O)N{self.TRT}"],
            "DIC/Oxyma in DMF, 2 h"), [])

    def test_it_needs_the_activator_as_well_as_the_side_chain(self):
        # Base alone does not dehydrate an amide, so an Fmoc removal on the same residue is silent.
        self.assertEqual(self._hazards(
            ["N[C@@H](CC(=O)N)C(=O)O"], ["N[C@@H](CC(=O)N)C(=O)O"],
            "20% piperidine in DMF"), [])

    def test_a_c_terminal_peptide_amide_is_not_a_side_chain_amide(self):
        # The false positive this pattern exists to avoid: Rink-type C-terminal amides are primary
        # carboxamides too, and every one of them would otherwise flag under a coupling agent.
        self.assertEqual(self._hazards(
            ["C[C@@H](N)C(=O)N", "OC(=O)C"], ["CC(=O)N[C@@H](C)C(=O)N"],
            "HATU, DIPEA, DMF, 30 min"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
