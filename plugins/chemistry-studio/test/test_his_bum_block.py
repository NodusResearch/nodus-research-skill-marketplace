"""Fmoc-His(Bum)-OH: the pi-protected histidine, so the remedy can actually be taken.

The defect this closes. Histidine racemises because the imidazole's PI nitrogen — the one adjacent
to the carbon bearing the side chain — takes the alpha-proton of the activated residue. Benoiton
Section 6.10: "Substitution at the pi-nitrogen PREVENTS isomerization", while substitution at the
tau nitrogen only "MAY DIMINISH its ability to abstract the alpha-proton". The only histidine the
package shipped was Fmoc-His(Trt)-OH, which is TAU-substituted, so the `his-epimerisation` hazard
had to tell a reader that the thing which would actually prevent it does not ship. A remedy nobody
can take is the defect this project keeps meeting under different names.

Why Bum and not Bom, which is what Benoiton names. They are different groups and only one belongs
in Fmoc chemistry:

    Bum   tert-butoxymethyl,  TFA-labile,  CAS 90653-46-6, C26H29N3O5, MW 463.53
    Bom   benzyloxymethyl,    HF-labile,   CAS 84891-19-0, C29H27N3O5, MW 497.54

Benoiton names "N-pi-benzyloxymethyl (Bom) for Boc chemistry and N-pi-1-adamantyloxymethyl (1-Adom)
for Fmoc chemistry". Bom is HF-labile, so in an Fmoc route it would never come off; Bum is the
TFA-labile analogue developed for Fmoc SPPS and published as Fmoc-His(3-Bum)-OH. So quoting Bom
here would have been chemically wrong even though it is what the cited page says.

THE STRUCTURE IS ASSERTED, NOT TRUSTED. A hand-written SMILES can put the substituent on the wrong
ring nitrogen and still give the right formula — the two tautomeric positions are isomers. So the
tests below check the TOPOLOGY: the substituted nitrogen must be the one bonded to the carbon that
carries the side-chain CH2, and the shipped Trt block must be the other way round.

The caution travels with it: deprotecting any N-pi-oxymethyl group releases FORMALDEHYDE, which
needs a scavenger or it modifies the peptide. Benoiton says so of Bom ("Formaldehyde that is
liberated must be trapped by scavengers") and the Bum reevaluation says the same.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import Descriptors, rdMolDescriptors

import compat_tables as T

RDLogger.DisableLog("rdApp.*")

BLOCKS_TS = os.path.join(os.path.dirname(HERE), "src", "engine", "peptideBuildingBlocks.ts")
BUM = "Fmoc-His(Bum)-OH"
TRT = "Fmoc-His(Trt)-OH"
# Cgamma inside the imidazole, reached through the side-chain CH2.
_SIDE_CHAIN = Chem.MolFromSmarts("[CH2][c]1[c,n][c,n][c,n][c,n]1")


def blocks():
    body = open(BLOCKS_TS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))


def pi_nitrogen_degree(smiles):
    """The heavy-atom degree of the ring nitrogen ADJACENT to C-gamma, which is N-pi.

    Degree 2 means it is bare (two ring bonds); degree 3 means it carries a substituent.
    """
    mol = Chem.MolFromSmiles(smiles)
    assert mol is not None, smiles
    hit = mol.GetSubstructMatch(_SIDE_CHAIN)
    assert hit, f"no imidazole side chain found in {smiles}"
    gamma = mol.GetAtomWithIdx(hit[1])
    nitrogens = [nb for nb in gamma.GetNeighbors() if nb.GetAtomicNum() == 7]
    assert len(nitrogens) == 1, f"expected exactly one nitrogen beside C-gamma, got {len(nitrogens)}"
    return nitrogens[0].GetDegree()


class TheBlockIsTheRealCompound(unittest.TestCase):
    def test_it_ships(self):
        self.assertIn(BUM, blocks())

    def test_the_smiles_parses(self):
        self.assertIsNotNone(Chem.MolFromSmiles(blocks()[BUM]))

    def test_the_formula_and_mass_match_the_catalogue_entry(self):
        mol = Chem.MolFromSmiles(blocks()[BUM])
        self.assertEqual(rdMolDescriptors.CalcMolFormula(mol), "C26H29N3O5")
        self.assertAlmostEqual(Descriptors.MolWt(mol), 463.53, places=1)

    def test_it_is_NOT_the_Bom_compound(self):
        # The confusable one: benzyloxymethyl, C29H27N3O5, 497.54, and HF-labile so useless in an
        # Fmoc route. If the SMILES were ever edited into Bom this catches it by formula.
        mol = Chem.MolFromSmiles(blocks()[BUM])
        self.assertNotEqual(rdMolDescriptors.CalcMolFormula(mol), "C29H27N3O5")

    def test_it_carries_a_tert_butyl_ETHER_not_an_ester_or_a_carbamate(self):
        # tert-butoxymethyl: the tBu sits on an oxygen that sits on a CH2 on the ring nitrogen.
        mol = Chem.MolFromSmiles(blocks()[BUM])
        bum = Chem.MolFromSmarts("[n][CH2][OX2][CX4]([CH3])([CH3])[CH3]")
        self.assertTrue(mol.HasSubstructMatch(bum), blocks()[BUM])

    def test_the_alpha_centre_is_the_same_L_configuration_as_the_other_blocks(self):
        # Pinned against the shipped Trt block rather than asserted as a letter, so the two cannot
        # disagree about which enantiomer the package supplies.
        def alpha_tag(smiles):
            mol = Chem.MolFromSmiles(smiles)
            Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
            patt = Chem.MolFromSmarts("[CX4;H1]([NX3][CX3]=[OX1])[CX3](=[OX1])[OX2H1]")
            idx = mol.GetSubstructMatch(patt)[0]
            return mol.GetAtomWithIdx(idx).GetPropsAsDict().get("_CIPCode")
        self.assertEqual(alpha_tag(blocks()[BUM]), alpha_tag(blocks()[TRT]))


class TheSubstituentIsOnTheRightNitrogen(unittest.TestCase):
    """The assertion a formula check cannot make: the two positions are isomers."""

    def test_the_new_block_is_PI_substituted(self):
        self.assertEqual(pi_nitrogen_degree(blocks()[BUM]), 3,
                         "the Bum must sit on the nitrogen ADJACENT to C-gamma, which is N-pi; "
                         "that is the only position that prevents racemisation")

    def test_the_shipped_trityl_block_is_TAU_substituted(self):
        self.assertEqual(pi_nitrogen_degree(blocks()[TRT]), 2,
                         "Fmoc-His(Trt)-OH's pi nitrogen is bare — the trityl is on tau, which is "
                         "why it only reduces racemisation rather than preventing it")

    def test_so_the_two_blocks_are_substituted_at_DIFFERENT_nitrogens(self):
        self.assertNotEqual(pi_nitrogen_degree(blocks()[BUM]),
                            pi_nitrogen_degree(blocks()[TRT]))

    def test_both_still_have_one_free_ring_nitrogen_and_one_substituted(self):
        for name in (BUM, TRT):
            with self.subTest(name):
                mol = Chem.MolFromSmiles(blocks()[name])
                ring_n = [a for a in mol.GetAtoms()
                          if a.GetAtomicNum() == 7 and a.GetIsAromatic()]
                self.assertEqual(len(ring_n), 2, "an imidazole has two nitrogens")
                self.assertEqual(sorted(a.GetDegree() for a in ring_n), [2, 3])


class TheHazardCanNowNameIt(unittest.TestCase):
    def test_the_pi_protected_block_clears_the_epimerisation_gate(self):
        query = Chem.MolFromSmarts(T.GROUPS["his-epimerisation"][1])
        self.assertFalse(Chem.MolFromSmiles(blocks()[BUM]).HasSubstructMatch(query))
        self.assertTrue(Chem.MolFromSmiles(blocks()[TRT]).HasSubstructMatch(query))

    def test_the_histidine_message_names_the_block_that_now_ships(self):
        for group, rows in (("acylating", T.ACTIVATION_RISKS["acylating"]),):
            text = next(why for g, _s, why in rows if g == "his-epimerisation")
            self.assertIn("His(Bum)", text, f"the remedy is takeable now, so it should say so: {text}")

    def test_it_no_longer_says_nothing_pi_protected_ships(self):
        text = next(why for g, _s, why in T.ACTIVATION_RISKS["acylating"]
                    if g == "his-epimerisation")
        self.assertNotIn("do not ship", text.lower())
        self.assertNotIn("does not ship", text.lower())

    def test_and_it_still_carries_the_formaldehyde_caution(self):
        # The reason not to recommend it blindly: an N-pi-oxymethyl group releases formaldehyde on
        # deprotection, which needs its own scavenger.
        text = next(why for g, _s, why in T.ACTIVATION_RISKS["acylating"]
                    if g == "his-epimerisation")
        self.assertIn("formaldehyde", text.lower(), text)

    def test_the_DEFAULT_histidine_block_is_unchanged(self):
        """Adding Bum must not change what a route gets when it just asks for a histidine.

        The preference order is reproduced here rather than imported from the generator, for the
        same reason the hazard panel had to stop importing it: `peptide_route` is not part of the
        package, so a test that imports it passes on our tree and dies on the shipped one — and
        the runner aborts its loop on the first failure, taking every later suite with it.
        """
        preference = ("Fmoc-His(Boc)-OH", "Fmoc-His(Pbf)-OH", "Fmoc-His(Trt)-OH",
                      "Fmoc-His(OtBu)-OH", "Fmoc-His(tBu)-OH", "Fmoc-His-OH")
        shipped = blocks()
        chosen = next(name for name in preference if name in shipped)
        self.assertEqual(chosen, TRT, "Trt is still what a plain histidine resolves to")
        self.assertNotIn(BUM, preference,
                         "Bum is a deliberate choice a route makes, not the default")


# Nothing goes after this block. Appending below it has stranded tests three times in this
# directory in one day.
if __name__ == "__main__":
    unittest.main()
