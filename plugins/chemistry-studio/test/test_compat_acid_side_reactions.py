"""Acid-side reactions on Ser/Thr/Tyr, Trp with TES, and Cys(Acm) with a thiol.

These are the remaining per-step gates from the Chan & White read. Each has a real remedy:
a cation scavenger for O-acylation/Tyr alkylation, TIS instead of TES for the indole, and omitting
the thiol for Cys(Acm). The gates would be wallpaper if a route could not clear them, so every
positive case has a negative control that names the remedy.
"""

import os
import sys
import unittest

from rdkit import RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

SER = "N[C@@H](CO)C(=O)NCC(=O)O"
THR = "N[C@@H]([C@@H](C)O)C(=O)NCC(=O)O"
TYR = "N[C@@H](Cc1ccc(O)cc1)C(=O)NCC(=O)O"
TRP = "N[C@@H](Cc1c[nH]c2ccccc12)C(=O)NCC(=O)O"
CYS_ACM = "CC(=O)NCS[C@H](N)C(=O)NCC(=O)O"


def groups_for(smiles, reagents):
    out = W._compatibility([{"reactants": [smiles], "products": [smiles], "reagents": reagents}])
    return {h["group"] for h in out[0]["hazards"]}


class SerThrOacylationAndTyrAlkylation(unittest.TestCase):
    def test_the_three_side_chains_fire_without_a_cation_scavenger(self):
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl"), (TYR, "tyr")):
            with self.subTest(group=group):
                self.assertIn(group, groups_for(smiles, "TFA/H2O 95:5, 2 h"))

    def test_a_cation_scavenger_clears_them(self):
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl"), (TYR, "tyr")):
            with self.subTest(group=group):
                found = groups_for(smiles, "TFA/TIS/H2O 95:2.5:2.5, 2 h")
                self.assertNotIn(group, found)

    def test_the_mass_signature_is_the_tbu_adduct(self):
        for group in ("ser-hydroxyl", "thr-hydroxyl", "tyr"):
            with self.subTest(group=group):
                self.assertEqual(T.MASS_SHIFTS[group]["delta"], 56)


class TrpSilaneReduction(unittest.TestCase):
    def test_tes_reduces_the_indole_and_is_not_reported_as_alkylation(self):
        found = groups_for(TRP, "TFA/TES/H2O 95:2.5:2.5, 2 h")
        self.assertIn("trp-indole-reduction", found)
        self.assertNotIn("free-indole", found)

    def test_tis_is_the_trp_safe_silane(self):
        found = groups_for(TRP, "TFA/TIS/H2O 95:2.5:2.5, 2 h")
        self.assertNotIn("trp-indole-reduction", found)
        self.assertNotIn("free-indole", found)

    def test_the_signature_is_minus_71(self):
        self.assertEqual(T.MASS_SHIFTS["trp-indole-reduction"]["delta"], -71)


class CysAcmThiolInterchange(unittest.TestCase):
    def test_edt_flags_the_acm_side_chain(self):
        self.assertIn("cys-acm", groups_for(CYS_ACM, "TFA/H2O/EDT 95:2.5:2.5, 2 h"))

    def test_plain_tfa_does_not(self):
        self.assertNotIn("cys-acm", groups_for(CYS_ACM, "TFA/H2O 95:5, 2 h"))

    def test_the_signature_is_acm_loss_minus_71(self):
        self.assertEqual(T.MASS_SHIFTS["cys-acm"]["delta"], -71)


if __name__ == "__main__":
    unittest.main()
