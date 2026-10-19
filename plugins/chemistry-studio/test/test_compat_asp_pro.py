"""The Asp-Pro acid-cleavage motif.

Chan & White Ch 2 Table 6 / Ch 4: the Asp-Pro bond is unusually acid-labile because the Asp
side-chain carboxyl participates in the cleavage. A strong-acid step that still carries the motif
is a real chain-cut hazard, not just a deprotection. The gate is a sequence motif, so it is checked
once per route rather than once per strong-acid step.
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

ASP_PRO_FREE = "N[C@@H](CC(=O)O)C(=O)N1CCCC1"
ASP_PRO_OTBU = "N[C@@H](CC(=O)OC(C)(C)C)C(=O)N1CCCC1"
ASP_ALA = "N[C@@H](CC(=O)O)C(=O)N[C@@H](C)C(=O)O"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    return out[0]["hazards"]


class TheAspProMotifIsGatedUnderStrongAcid(unittest.TestCase):
    def test_the_pattern_matches_free_and_protected_aspartate(self):
        for smiles in (ASP_PRO_FREE, ASP_PRO_OTBU):
            with self.subTest(smiles=smiles):
                self.assertEqual(len(hazards_for(smiles, smiles, "TFA/H2O 95:5, 2 h")), 1
                                 if smiles == ASP_PRO_FREE else 2)
                found = hazards_for(smiles, smiles, "TFA/H2O 95:5, 2 h")
                self.assertIn("asp-pro", {h["group"] for h in found})

    def test_it_is_high_and_names_the_bond(self):
        found = next(h for h in hazards_for(ASP_PRO_FREE, ASP_PRO_FREE, "TFA/H2O 95:5, 2 h")
                     if h["group"] == "asp-pro")
        self.assertEqual(found["severity"], "high")
        self.assertIn("Asp-Pro", found["why"])
        self.assertIn("cleaved", found["why"].lower())

    def test_an_asp_ala_control_is_silent(self):
        found = hazards_for(ASP_ALA, ASP_ALA, "TFA/H2O 95:5, 2 h")
        self.assertNotIn("asp-pro", {h["group"] for h in found})

    def test_piperidine_does_not_raise_the_acid_cleavage(self):
        found = hazards_for(ASP_PRO_FREE, ASP_PRO_FREE, "20% piperidine in DMF")
        self.assertNotIn("asp-pro", {h["group"] for h in found})


if __name__ == "__main__":
    unittest.main()
