"""Residual protecting groups: a group removed later is not a hazard at an intermediate.

`_compatibility` reads each step in a route. A strong-acid deprotection sees every acid-labile
group still present in its own product; without the final product, it cannot tell a group that is
supposed to survive to the target from one the route removes in a later step. The filter here is
deliberately narrow: it suppresses only ATTACKS "survives" entries for a group with a RESIDUAL mass
signature that is absent from the final product. Premature loss (the group missing from the step
product) is a different branch and must stay visible.

These are package tests, not generator tests: the behavior lives in `reactions_worker._compatibility`
and must be covered in CI without the git-ignored `_local/` module.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "python")
sys.path.insert(0, PY)

from rdkit import RDLogger
RDLogger.DisableLog("rdApp.*")

import reactions_worker as W

# Boc-Ala-OtBu: one Boc carbamate and one tert-butyl ester, both acid-labile.
BOC_TBU = "CC(C)(C)OC(=O)N[C@@H](C)C(=O)OC(C)(C)C"
# The deprotected target: neither group remains.
FREE = "C[C@@H](N)C(=O)O"
TFA = "TFA/H2O 95:5, 2 h"


def groups(step):
    return {hazard["group"] for hazard in step["hazards"]}


class AGroupRemovedLaterIsAnIntermediateNotAResidualHazard(unittest.TestCase):
    def test_a_free_target_does_not_report_the_groups_its_later_step_removes(self):
        steps = [
            {"reactants": [BOC_TBU], "products": [BOC_TBU], "reagents": TFA},
            {"reactants": [BOC_TBU], "products": [FREE], "reagents": TFA},
        ]
        found = W._compatibility(steps)
        self.assertNotIn("boc", groups(found[0]))
        self.assertNotIn("tbu-ester", groups(found[0]))
        # The later step is the one that removes them, so it is not a "survives" hazard either.
        self.assertNotIn("boc", groups(found[1]))
        self.assertNotIn("tbu-ester", groups(found[1]))

    def test_a_group_still_in_the_final_product_is_still_reported(self):
        steps = [
            {"reactants": [BOC_TBU], "products": [BOC_TBU], "reagents": TFA},
            {"reactants": [BOC_TBU], "products": [BOC_TBU], "reagents": TFA},
        ]
        found = W._compatibility(steps)
        self.assertIn("boc", groups(found[0]))
        self.assertIn("tbu-ester", groups(found[0]))

    def test_the_filter_does_not_silence_a_non_residual_group(self):
        # `asn-gln-amide` is a shift, not a residual protecting group. It is present in the final
        # product here, but the point is that the residual filter must not be a general "absent
        # from the final product" suppression.
        asn = "NC(=O)C[C@H](N)C(=O)O"
        steps = [
            {"reactants": [asn], "products": [asn], "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF"},
            {"reactants": [asn], "products": [asn], "reagents": "Fmoc-amino acid, HBTU, DIPEA, DMF"},
        ]
        found = W._compatibility(steps)
        self.assertIn("asn-gln-amide", groups(found[0]))


if __name__ == "__main__":
    unittest.main()
