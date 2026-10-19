"""The structured protection table, and the shipped blocks it must cover.

These are package tests: the table is now the single source for the generator's side-chain
removals, so a shipped block whose group has no entry (or a table entry naming a transform/site
that does not exist) must fail here, not silently produce a route that leaves a group on.
"""

import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PKG, "python"))

import compat_tables as T
import protection_table as P

with open(os.path.join(PKG, "python", "route_transforms.json"), encoding="utf-8") as handle:
    TRANSFORMS = json.load(handle)
BY_ID = {entry["id"]: entry for entry in TRANSFORMS["transforms"]}


def shipped_groups():
    path = os.path.join(PKG, "src", "engine", "peptideBuildingBlocks.ts")
    body = open(path, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    names = re.findall(r'"([^"]+)":', body)
    groups = set()
    for name in names:
        for group in re.findall(r"\(([^)]+)\)", name):
            groups.add(group.split(",")[0])
    return groups


class EveryShippedGroupIsInTheTable(unittest.TestCase):
    def test_no_shipped_block_group_is_silently_unknown(self):
        for group in sorted(shipped_groups()):
            with self.subTest(group=group):
                self.assertIn(group, P.GROUPS)
                if P.removal(group) is None:
                    self.assertTrue(P.is_manual(group),
                                    f"{group} has no removal and is not marked manual")

    def test_every_table_entry_names_a_real_transform_and_site(self):
        for group, entry in P.GROUPS.items():
            for residue, (transform, site, _water) in entry["sites"].items():
                with self.subTest(group=group, residue=residue):
                    self.assertIn(transform, BY_ID, f"{group} names unknown transform {transform}")
                    self.assertIn(site, TRANSFORMS["sites"],
                                  f"{group} names unknown site phrase {site}")

    def test_every_tabulated_mass_shift_key_exists(self):
        for group in P.all_groups():
            key = P.mass_shift_key(group)
            if key is not None:
                with self.subTest(group=group):
                    self.assertIn(key, T.MASS_SHIFTS)

    def test_residue_specific_removals(self):
        self.assertEqual(P.removal("Boc", "Trp")[0], "ring-nitrogen-boc-removal")
        self.assertEqual(P.removal("Boc", "Lys")[0], "boc-removal")
        self.assertEqual(P.removal("Trt", "Cys")[0], "s-trityl-removal")
        self.assertEqual(P.removal("Trt", "His")[0], "imidazole-trityl-removal")
        self.assertEqual(P.removal("Trt", "Asn")[0], "n-trityl-removal")

    def test_auxiliaries_are_marked_as_auxiliaries(self):
        self.assertTrue(P.is_auxiliary("Dmb"))
        self.assertTrue(P.is_auxiliary("psiMe"))
        self.assertFalse(P.is_auxiliary("Boc"))

    def test_trp_tes_is_recorded_as_incompatible(self):
        trp = P.residue_scavengers("Trp")
        self.assertIsNotNone(trp)
        self.assertIn("TES", trp["incompatible"])
        self.assertIn("TIS", trp["compatible"])


if __name__ == "__main__":
    unittest.main()
