"""A side-chain hydroxyl masked while that residue's alpha-carboxyl is still free.

Found 2026-10-14 by independent review of chainL-8, before AND after the contract fix. The model
protects a Ser/Thr side-chain OH with a reagent that preferentially hits the free alpha-carboxyl:
benzyl trichloroacetimidate/TfOH in one run, BnBr/Ag2O in the next. Two different reagents, the
same conceptual error, so prompt wording cannot reach it.

Why no existing check catches it: the wrong-selectivity product (benzyl ESTER, free side-chain OH)
has the SAME MOLECULAR FORMULA as the intended one (benzyl ETHER, free acid), so atom balance is
blind by construction, and the route verifies. Measured on the tables as they stood:

  'benzyl trichloroacetimidate, TfOH, DCM'  -> classify() == ['strong-acid']
  'BnBr, Ag2O, DMF'                         -> classify() == ['alkylating']

The first is the hole: the benzylating agent is not recognised AT ALL, and `strong-acid` attacks
none of boc/acetal/tbu-ester/silyl/trityl that would stand in for it, so the step raised ZERO
hazards. The second did raise one, but only the generic `acid` entry, "may be alkylated (as the
carboxylate)" at medium — true of any carboxylic acid and not the thing a chemist needs told.

So this pins three things: the reagent class must recognise an imidate benzylating agent; the
specific hazard must name the alpha-carboxyl and the remedy; and it must CLEAR when the carboxyl is
protected, so the flag is answerable rather than wallpaper (the standard this file's aspartimide
neighbour set).
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import RDLogger

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

FMOC = "NC(=O)OCC1c2ccccc2-c2ccccc21"
# Fmoc-Ser-OH: free side-chain OH, FREE alpha-carboxyl.
FMOC_SER = "OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"
# What the route DECLARED: the side chain benzylated, the acid left free. Intended product.
FMOC_SER_OBN = "C(c1ccccc1)OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"
# The remedy: the alpha-carboxyl carried as the tert-butyl ester, so nothing competes.
FMOC_SER_OTBU_ACID = "OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)OC(C)(C)C"
FMOC_SER_OBN_OTBU = "C(c1ccccc1)OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)OC(C)(C)C"
# A carboxylic acid that is NOT an alpha-amino acid: benzylating it is ordinary chemistry.
PHENYLACETIC = "OC(=O)Cc1ccccc1"
PHENYLACETIC_OBN = "O=C(OCc1ccccc1)Cc1ccccc1"
# 3-hydroxypropanoic acid: a free acid that SURVIVES while an alcohol is benzylated, but with no
# alpha-amino group. This is the control that separates the new reading from the generic one — the
# generic `acid` flag must still fire here, exactly as it did before.
HYDROXY_ACID = "OC(=O)CCO"
HYDROXY_ACID_OBN = "OC(=O)CCOCc1ccccc1"
# Ac2O acetylates the side chain; the alpha-carboxyl is the competing site.
FMOC_SER_OAC = "CC(=O)OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"

IMIDATE = "benzyl trichloroacetimidate, TfOH, DCM"
BNBR = "BnBr, Ag2O, DMF"
GROUP = "free-alpha-carboxyl"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1, "one step in, one step out"
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


class ImidateBenzylationIsRecognised(unittest.TestCase):
    """The reagent that raised NO flag at all. A trichloroacetimidate is a benzylating agent; the
    acid co-reagent is what the table saw, and an acid alone attacks none of these groups."""

    def test_the_imidate_classifies_as_alkylating(self):
        self.assertIn("alkylating", T.classify(IMIDATE),
                      f"benzyl trichloroacetimidate is a benzylating agent: {T.classify(IMIDATE)}")

    def test_the_acid_catalyst_is_still_seen(self):
        # TfOH really is a strong acid and other groups depend on that reading; recognising the
        # imidate must ADD a class, not replace one.
        self.assertIn("strong-acid", T.classify(IMIDATE))

    def test_the_plain_imidate_without_an_acid_also_classifies(self):
        self.assertIn("alkylating", T.classify("PMB trichloroacetimidate, CH2Cl2"))


class TheFreeAlphaCarboxylIsNamed(unittest.TestCase):
    """The hazard itself: it must name the alpha-carboxyl, rank it above the generic acid entry,
    and say what to do."""

    def test_benzyl_bromide_raises_it(self):
        found = hazards_for(FMOC_SER, FMOC_SER_OBN, BNBR)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_imidate_raises_it_too(self):
        found = hazards_for(FMOC_SER, FMOC_SER_OBN, IMIDATE)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_is_high_not_medium(self):
        # The measured failure verified twice. A medium flag beside a dozen others did not carry.
        hazard = next(h for h in hazards_for(FMOC_SER, FMOC_SER_OBN, BNBR) if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "high")

    def test_it_names_the_competing_product_and_a_remedy(self):
        hazard = next(h for h in hazards_for(FMOC_SER, FMOC_SER_OBN, BNBR) if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("ester", words, f"it must say WHAT forms instead: {words}")
        self.assertTrue(any(k in words for k in ("protect", "tert-butyl", "otbu")),
                        f"it must say what to do: {words}")

    def test_the_generic_acid_entry_does_not_double_fire(self):
        # The tables' own standard, set by ketone/enolizable-ketone: the specific reading replaces
        # the generic one rather than appearing beside it.
        found = hazards_for(FMOC_SER, FMOC_SER_OBN, BNBR)
        self.assertIn(GROUP, groups_in(found))
        self.assertNotIn("acid", groups_in(found), f"one flag per site: {groups_in(found)}")

    def test_an_acylating_agent_raises_it_as_well(self):
        # Item 27 is "alkylates or acylates": Ac2O reaches the alpha-carboxyl as the mixed anhydride.
        found = hazards_for(FMOC_SER, FMOC_SER_OAC, "Ac2O, pyridine")
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


class ItClearsAndStaysQuiet(unittest.TestCase):
    """A flag that cannot be answered is wallpaper, and one that fires on ordinary chemistry is
    worse. Both directions are pinned."""

    def test_protecting_the_carboxyl_clears_it(self):
        found = hazards_for(FMOC_SER_OTBU_ACID, FMOC_SER_OBN_OTBU, BNBR)
        self.assertNotIn(GROUP, groups_in(found),
                         f"the tert-butyl ester answers the flag: {groups_in(found)}")

    def test_an_ordinary_carboxylic_acid_is_not_this_hazard(self):
        found = hazards_for(PHENYLACETIC, PHENYLACETIC_OBN, BNBR)
        self.assertNotIn(GROUP, groups_in(found),
                         "phenylacetic acid has no alpha-amino group and no side chain")

    def test_an_ordinary_carboxylic_acid_keeps_the_GENERIC_flag(self):
        # Unchanged behaviour, and the control that proves the suppression is narrow: a free acid
        # surviving a benzylation, with no alpha-amino group, still raises the generic `acid` entry
        # and must NOT raise the new one.
        found = hazards_for(HYDROXY_ACID, HYDROXY_ACID_OBN, BNBR)
        self.assertIn("acid", groups_in(found), f"the generic reading is untouched: {groups_in(found)}")
        self.assertNotIn(GROUP, groups_in(found), "3-hydroxypropanoic acid is not an amino acid")

    def test_a_coupling_that_consumes_the_acid_does_not_flag_it(self):
        # In a peptide coupling the alpha-carboxyl is MEANT to react, so it never survives into the
        # product and must not be flagged as a bystander.
        dipeptide = "OC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](C)C(=O)O"
        found = hazards_for(FMOC_SER, dipeptide, "HBTU, DIPEA, DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


if __name__ == "__main__":
    unittest.main()
