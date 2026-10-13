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


if __name__ == "__main__":
    unittest.main(verbosity=2)
