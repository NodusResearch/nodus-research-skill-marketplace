"""The shipped orthogonal Cys blocks: structure, configuration and protecting-group identity."""

import os
import re
import sys
import unittest

from rdkit import Chem

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
BLOCKS = os.path.join(PKG, "src", "engine", "peptideBuildingBlocks.ts")


def blocks():
    body = open(BLOCKS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))


class TheOrthogonalCysBlocksAreShipped(unittest.TestCase):
    def test_acm_and_stbu_are_present_and_parse(self):
        table = blocks()
        for name in ("Fmoc-Cys(Acm)-OH", "Fmoc-Cys(StBu)-OH"):
            with self.subTest(name=name):
                self.assertIn(name, table)
                self.assertIsNotNone(Chem.MolFromSmiles(table[name]))

    def test_both_are_l_cysteine(self):
        table = blocks()
        query = Chem.MolFromSmarts("[NX3][CX4;H1]([CX3]=[OX1])")
        for name in ("Fmoc-Cys(Acm)-OH", "Fmoc-Cys(StBu)-OH"):
            with self.subTest(name=name):
                mol = Chem.MolFromSmiles(table[name])
                Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
                labels = [mol.GetAtomWithIdx(match[1]).GetPropsAsDict().get("_CIPCode")
                          for match in mol.GetSubstructMatches(query)]
                self.assertEqual([label for label in labels if label], ["R"])

    def test_the_side_chains_are_acm_and_stbu(self):
        table = blocks()
        self.assertTrue(Chem.MolFromSmiles(table["Fmoc-Cys(Acm)-OH"])
                        .HasSubstructMatch(Chem.MolFromSmarts("[SX2][CH2][NX3][CX3](=O)[CH3]")))
        self.assertTrue(Chem.MolFromSmiles(table["Fmoc-Cys(StBu)-OH"])
                        .HasSubstructMatch(Chem.MolFromSmarts("[SX2][SX2][CX4]([CH3])([CH3])[CH3]")))


class TheOrthogonalSideChainBlocksAreShipped(unittest.TestCase):
    def test_the_lys_and_allyl_blocks_are_present_parse_and_are_l(self):
        table = blocks()
        query = Chem.MolFromSmarts("[NX3][CX4;H1]([CX3]=[OX1])")
        for name in ("Fmoc-Lys(Dde)-OH", "Fmoc-Lys(Ddiv)-OH", "Fmoc-Lys(Alloc)-OH",
                     "Fmoc-Glu(OAll)-OH", "Fmoc-Asp(OAll)-OH"):
            with self.subTest(name=name):
                self.assertIn(name, table)
                mol = Chem.MolFromSmiles(table[name])
                self.assertIsNotNone(mol)
                Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
                labels = [mol.GetAtomWithIdx(match[1]).GetPropsAsDict().get("_CIPCode")
                          for match in mol.GetSubstructMatches(query)]
                self.assertEqual([label for label in labels if label], ["S"])

    def test_the_groups_are_dde_ddiv_alloc_and_allyl(self):
        table = blocks()
        cases = {
            "Fmoc-Lys(Dde)-OH": "[NX3][CX3]([CH3])=[CX3]",
            "Fmoc-Lys(Ddiv)-OH": "[NX3][CX3]([CH2][CH]([CH3])[CH3])=[CX3]",
            "Fmoc-Lys(Alloc)-OH": "[NX3][CX3](=O)[OX2][CH2][CH]=[CH2]",
            "Fmoc-Glu(OAll)-OH": "[#6][CX3](=O)[OX2][CH2][CH]=[CH2]",
            "Fmoc-Asp(OAll)-OH": "[#6][CX3](=O)[OX2][CH2][CH]=[CH2]",
        }
        for name, smarts in cases.items():
            with self.subTest(name=name):
                self.assertTrue(Chem.MolFromSmiles(table[name])
                                .HasSubstructMatch(Chem.MolFromSmarts(smarts)))


if __name__ == "__main__":
    unittest.main()
