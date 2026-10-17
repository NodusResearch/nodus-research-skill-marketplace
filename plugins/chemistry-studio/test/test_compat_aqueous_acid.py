"""Peptide additions must preserve the existing aqueous-acid compatibility rules."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python"))

import reactions_worker as W


class AqueousAcidCompatibility(unittest.TestCase):
    def test_surviving_acid_sensitive_groups_are_still_reported(self):
        for group, smiles in (
            ("acetal", "CC1OCCO1"),
            ("trityl", "COC(c1ccccc1)(c1ccccc1)c1ccccc1"),
            ("silyl-ether", "CO[Si](C)(C)C"),
        ):
            with self.subTest(group=group):
                result = W._compatibility([{
                    "reactants": [smiles], "products": [smiles], "reagents": "aqueous acid",
                }])
                self.assertTrue(any(h["group"] == group and h["reagentClass"] == "aqueous-acid"
                                    for h in result[0]["hazards"]), result)


if __name__ == "__main__":
    unittest.main()
