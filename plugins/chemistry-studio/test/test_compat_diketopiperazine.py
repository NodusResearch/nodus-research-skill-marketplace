"""Diketopiperazine at the resin-bound dipeptide stage — the step that ends the synthesis.

PEPTIDE-TODO Phase 2.5: "Diketopiperazine at the dipeptide stage (gate: residue 2 is Pro/Gly +
acid-labile linker + an Fmoc removal). The one gate that needs the RESIN, which the compat layer
does not model yet." It also records that this item is now only the DETECTOR: the remedy already
ships, as Fmoc-Gly-Pro-OH loaded onto the support in place of the anchored monomer, which removes
the resin-bound-dipeptide stage the hazard needs.

The chemistry. With exactly two residues on the resin, deprotecting the second one frees an
alpha-amine six atoms from the ester holding the first residue to the support. It closes that ring
and the peptide leaves the resin as the diketopiperazine. Unlike an aspartimide, which erodes the
yield, this one ENDS the synthesis — what is left on the support is bare linker.

It is also a hazard the atom checks cannot reach. Nothing is unbalanced: the released peptide is a
clean cyclic product and the resin is a clean alcohol. The route simply stops being about the
peptide that was asked for.

Why residue 2 is the thing to gate on, and why Pro and Gly: proline's amide prefers the cis
conformation that puts the amine over the ester, and glycine has no side chain to get in the way.
Both make the closure fast enough to matter. A beta-branched or bulky residue there does not.

ONE LIMITATION, recorded rather than papered over: the gate the literature states includes an
ACID-LABILE LINKER, and this check cannot see the linker at all. The support is a single `*` in
this model and carries no identity, so a Wang ester and a sturdier anchor look identical here. The
flag is therefore slightly broader than the literature gate. It is raised at the resin-bound
dipeptide stage with Pro or Gly at residue 2, which is the part that IS visible.
"""

import os
import sys
import unittest

from rdkit import Chem, RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

# Resin-bound species, the support written as the single `*` the route rules require.
GLY_PRO_RESIN = "*OC(=O)[C@@H]1CCCN1C(=O)CN"          # Pro anchored, Gly at residue 2
PRO_GLY_RESIN = "*OC(=O)CNC(=O)[C@@H]1CCCN1"          # Gly anchored, Pro at residue 2
GLY_GLY_RESIN = "*OC(=O)CNC(=O)CN"
ALA_PRO_RESIN = "*OC(=O)[C@H](C)NC(=O)[C@@H]1CCCN1"
FMOC_GLY_PRO_RESIN = "*OC(=O)[C@@H]1CCCN1C(=O)CNC(=O)OCC1c2ccccc2-c2ccccc21"
ALA_ALA_RESIN = "*OC(=O)[C@H](C)NC(=O)[C@H](C)N"
TRIPEPTIDE_RESIN = "*OC(=O)CNC(=O)CNC(=O)CN"
SINGLE_RESIDUE_RESIN = "*OC(=O)CN"
PRO_ALA_RESIN = "*OC(=O)[C@@H]1CCCN1C(=O)[C@H](C)N"   # residue 2 is Ala
FREE_DIPEPTIDE = "OC(=O)[C@@H]1CCCN1C(=O)CN"          # no resin at all

GROUP = "resin-dipeptide-dkp"
DEPROTECTION = "20% piperidine in DMF, 2 x 5 min"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


class TheGateIsResidueTwo(unittest.TestCase):
    def setUp(self):
        self.query = Chem.MolFromSmarts(T.GROUPS[GROUP][1])

    def test_the_smarts_compiles(self):
        self.assertIsNotNone(self.query)

    def test_glycine_or_proline_at_residue_two_matches(self):
        for smiles in (GLY_PRO_RESIN, PRO_GLY_RESIN, GLY_GLY_RESIN, ALA_PRO_RESIN):
            self.assertTrue(Chem.MolFromSmiles(smiles).HasSubstructMatch(self.query), smiles)

    def test_a_bulkier_residue_two_does_not(self):
        # H-Pro-Ala-resin has a proline, but it is ANCHORED; residue 2 is alanine, which does not
        # close fast enough to be worth a flag. The position is the gate, not the presence.
        self.assertFalse(Chem.MolFromSmiles(PRO_ALA_RESIN).HasSubstructMatch(self.query))
        self.assertFalse(Chem.MolFromSmiles(ALA_ALA_RESIN).HasSubstructMatch(self.query))

    def test_a_protected_amine_does_not_match(self):
        # The hazard needs the amine FREE, which is what makes the Fmoc removal the trigger. The
        # carbamate nitrogen is H1 like proline's ring N-H, so the pattern has to exclude acylated
        # nitrogens explicitly — it did not in the first draft, and this case caught it.
        self.assertFalse(Chem.MolFromSmiles(FMOC_GLY_PRO_RESIN).HasSubstructMatch(self.query))

    def test_the_dipeptide_STAGE_is_the_gate(self):
        # One residue cannot cyclise; three means residue 2's nitrogen is an amide, so the ring
        # cannot close there either. Both fall out of the same pattern rather than needing a count.
        self.assertFalse(Chem.MolFromSmiles(SINGLE_RESIDUE_RESIN).HasSubstructMatch(self.query))
        self.assertFalse(Chem.MolFromSmiles(TRIPEPTIDE_RESIN).HasSubstructMatch(self.query))

    def test_it_needs_the_resin(self):
        self.assertFalse(Chem.MolFromSmiles(FREE_DIPEPTIDE).HasSubstructMatch(self.query),
                         "in solution there is no ester to the support to close onto")


class TheFlagFires(unittest.TestCase):
    def test_the_deprotection_that_CREATES_the_free_amine(self):
        # THE CASE THAT MATTERS, and the one the first version of this file got wrong. Taken from
        # harness-runs/hazard-7 step 4 verbatim: the reactant still carries the Fmoc, so the group
        # exists ONLY in the product. An earlier draft passed the same already-deprotected molecule
        # as both sides, which cannot happen in a real route, and the gate was inert in production
        # while this file was green.
        found = hazards_for(FMOC_GLY_PRO_RESIN, GLY_PRO_RESIN, DEPROTECTION)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_also_fires_when_the_amine_is_already_free(self):
        found = hazards_for(GLY_PRO_RESIN, GLY_PRO_RESIN, DEPROTECTION)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_is_high(self):
        hazard = next(h for h in hazards_for(FMOC_GLY_PRO_RESIN, GLY_PRO_RESIN, DEPROTECTION)
                      if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "high", "it ends the synthesis rather than eroding it")

    def test_it_names_the_block_that_answers_it(self):
        # The to-do's own requirement: "this item is now only the DETECTOR, not the fix, and it
        # should name the block".
        hazard = next(h for h in hazards_for(FMOC_GLY_PRO_RESIN, GLY_PRO_RESIN, DEPROTECTION)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}"
        self.assertIn("Fmoc-Gly-Pro-OH", words, f"name the shipped block: {words}")
        self.assertIn("diketopiperazine", words.lower(), f"name what forms: {words}")

    def test_it_says_the_atom_checks_cannot_see_it(self):
        hazard = next(h for h in hazards_for(FMOC_GLY_PRO_RESIN, GLY_PRO_RESIN, DEPROTECTION)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("balance", "cleav", "off the resin", "support")),
                        f"say what it costs: {words}")


class TheFlagStaysQuiet(unittest.TestCase):
    def test_a_coupling_does_not_raise_it(self):
        # The next coupling is the thing that REMOVES the hazard, so it must not be flagged.
        found = hazards_for(GLY_PRO_RESIN, TRIPEPTIDE_RESIN, "Fmoc-Gly-OH, HBTU, DIPEA, DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_an_alanine_dipeptide_is_not_flagged(self):
        found = hazards_for(ALA_ALA_RESIN, ALA_ALA_RESIN, DEPROTECTION)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_tripeptide_stage_is_not_flagged(self):
        found = hazards_for(TRIPEPTIDE_RESIN, TRIPEPTIDE_RESIN, DEPROTECTION)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_an_acid_step_does_not_raise_it(self):
        # It is the base that frees the amine; acid is a different hazard set entirely.
        found = hazards_for(GLY_PRO_RESIN, GLY_PRO_RESIN, "TFA/H2O 95:5")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


if __name__ == "__main__":
    unittest.main()
