"""A D-alpha-amino-acid block: the one error no other check in this engine can see.

The group and attack machinery is SMARTS-based and achiral, the mass shifts are identical for an
isomer, and the target comparison is constitution-level. So a route that couples the wrong
enantiomer passes balance, mass and target alike. That is not hypothetical: in the chainC-4 run a
correct all-L route was rejected against a prompt whose target SMILES accidentally specified D-Ala;
the model then substituted a D-Ala block to match the target and the route verified.

The fix reads RDKit's CIP label on the alpha-carbon of a FREE ACID in the step's reactants, and only
when that molecule has exactly one alpha centre: the incoming building block. A growing resin-bound
chain has its carboxyl esterified to the support, and a free peptide — the head-to-tail route's
linear precursor, or a side-chain acid exposed by a later deprotection — has more than one stereogenic
residue. So a D residue is flagged once, on the step that introduces it.

Natural configuration is not one letter everywhere: L-cysteine is (R) because sulfur outranks the
carboxyl oxygen, and every other proteinogenic L residue is (S). The sweep over the shipped table
below is what keeps that exception honest.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PKG, "python"))

from rdkit import Chem, RDLogger

import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

BLOCKS_TS = os.path.join(PKG, "src", "engine", "peptideBuildingBlocks.ts")
_ALPHA = Chem.MolFromSmarts("[NX3][CX4;H1]([CX3]=[OX1])")
_CYSTEINE = Chem.MolFromSmarts("[NX3][CX4;H1]([CX3]=[OX1])[CH2][S]")


def blocks():
    body = open(BLOCKS_TS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))


def alpha_labels(smiles):
    mol = Chem.MolFromSmiles(smiles)
    assert mol is not None, smiles
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return sorted(mol.GetAtomWithIdx(match[1]).GetPropsAsDict().get("_CIPCode")
                  for match in mol.GetSubstructMatches(_ALPHA))


def d_centres(smiles):
    """CIP labels the gate calls D, using its own Cys exception (L-Cys is R)."""
    mol = Chem.MolFromSmiles(smiles)
    assert mol is not None, smiles
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    cysteines = {match[1] for match in mol.GetSubstructMatches(_CYSTEINE)}
    out = []
    for match in mol.GetSubstructMatches(_ALPHA):
        label = mol.GetAtomWithIdx(match[1]).GetPropsAsDict().get("_CIPCode")
        expected = "R" if match[1] in cysteines else "S"
        if label in ("R", "S") and label != expected:
            out.append(label)
    return out


def hazards(reactants, products=None, reagents="HATU, DIPEA, DMF"):
    out = W._compatibility([{"reactants": reactants, "products": products or reactants,
                             "reagents": reagents}])[0]
    return [h for h in out["hazards"] if h["group"] == "d-amino-acid"]


# The shipped Fmoc-L-Ala and its enantiomer, both as the free acid a coupling consumes.
L_ALA = "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
D_ALA = "C[C@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
# A D-alanine already ON THE RESIN: its carboxyl is an ester to the support, not a free acid.
D_ALA_ON_RESIN = "*OC(=O)[C@H](C)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"

# The generator's own M7 and M10 molecules on a head-to-tail `dA-Lys-Gly-Glu` route, replayed from
# `peptide_route.program` on 2026-10-23 (`reviews/2026-10-23-app-hazard-filters/probe2_filters.py`).
# M7 couples the Fmoc-dA block; M10 closes the ring on the finished linear peptide, whose C-terminal
# acid is free in solution. These are the real objects the report sends, not hand-built analogues.
COUPLING_REACTANTS = [
    "*OC(=O)[C@H](CCC(=O)OC(C)(C)C)NC(=O)CNC(=O)[C@@H](N)CCCCNC(=O)OC(C)(C)C",  # resin chain, N-term free
    "C[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O",                             # Fmoc-dA-OH
]
COUPLING_PRODUCT = ("*OC(=O)[C@H](CCC(=O)OC(C)(C)C)NC(=O)CNC(=O)[C@H](CCCCNC(=O)OC(C)(C)C)"
                    "NC(=O)[C@@H](C)NC(=O)OCC1c2ccccc2-c2ccccc21")
LINEAR_PRECURSOR = ("C[C@@H](N)C(=O)N[C@@H](CCCCNC(=O)OC(C)(C)C)C(=O)NCC(=O)"
                    "N[C@@H](CCC(=O)OC(C)(C)C)C(=O)O")
CYCLIC_PRODUCT = ("C[C@H]1NC(=O)[C@H](CCC(=O)OC(C)(C)C)NC(=O)CNC(=O)"
                  "[C@H](CCCCNC(=O)OC(C)(C)C)NC1=O")


class ADBlockIsFlagged(unittest.TestCase):
    def test_the_inverted_alanine_is_flagged(self):
        found = hazards([D_ALA, "NCC(=O)OC"])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["severity"], "medium")
        self.assertIn("(R)", found[0]["why"])
        self.assertIn("D configuration", found[0]["why"])

    def test_the_natural_alanine_is_silent(self):
        self.assertEqual(hazards([L_ALA, "NCC(=O)OC"]), [])

    def test_it_is_medium_so_it_does_not_by_itself_fail_a_route(self):
        # Deliberate: this makes the substitution VISIBLE. It is not the severity that drives a
        # correction round, and a target that genuinely asks for a D residue must still be reachable.
        self.assertEqual({h["severity"] for h in hazards([D_ALA])}, {"medium"})

    def test_the_mass_signature_says_an_isomer_is_invisible(self):
        found = hazards([D_ALA])
        self.assertEqual(found[0]["massShift"]["kind"], "same-mass")
        self.assertEqual(found[0]["massShift"]["delta"], 0)

    def test_it_names_the_remedy(self):
        found = hazards([D_ALA])
        self.assertIn("L block", found[0]["suggestion"])


class EveryShippedNaturalBlockIsSilent(unittest.TestCase):
    """The sweep that catches a hard-coded CIP letter, and the Cys exception specifically."""

    def test_no_shipped_block_is_flagged(self):
        flagged = {name for name, smiles in blocks().items() if hazards([smiles])}
        self.assertEqual(flagged, set())

    def test_the_shipped_table_really_contains_an_R_centre(self):
        # Without this, the sweep could pass by matching nothing at all.
        self.assertEqual(alpha_labels(blocks()["Fmoc-Cys(Trt)-OH"]), ["R"])

    def test_cysteine_is_the_one_R_residue_and_its_enantiomer_is_flagged(self):
        # L-Cys is (R); a check that hard-coded (S) for every residue would flag the correct block.
        self.assertEqual(alpha_labels(blocks()["Fmoc-Cys(Trt)-OH"]), ["R"])
        self.assertEqual(hazards([blocks()["Fmoc-Cys(Trt)-OH"]]), [])
        d_cys = "N[C@@H](C(=O)O)CS"  # the enantiomer of L-Cys (R), so this one is (S)
        self.assertEqual(alpha_labels(d_cys), ["S"])
        self.assertEqual(len(hazards([d_cys])), 1)

    def test_no_shipped_multi_residue_block_carries_a_d_centre(self):
        # The monomer scope skips a molecule with more than one alpha centre. That is the documented
        # cost: a D-containing dipeptide block would be skipped, and its D centre would go unflagged.
        # The package ships three dipeptides — Fmoc-Asp(OtBu)-(Dmb)Gly-OH, Fmoc-Ala-Ser(psiMe,Mepro)-OH
        # and Fmoc-Gly-Pro-OH — and none is D. If one is added, this fails and the scope (or the
        # block) must be revisited rather than silently losing the finding.
        multi = {name: d_centres(smiles) for name, smiles in blocks().items()
                 if len(Chem.MolFromSmiles(smiles).GetSubstructMatches(_ALPHA)) > 1}
        self.assertEqual({name: labels for name, labels in multi.items() if labels}, {})


class TheFlagBelongsToTheBlockNotTheChain(unittest.TestCase):
    def test_a_d_residue_already_on_the_resin_is_not_reflagged(self):
        # The chain's carboxyl is an ester to the support, so it is not a free acid and the check
        # never reads it. Only the step that COUPLES the wrong block is flagged.
        self.assertFalse(Chem.MolFromSmiles(D_ALA_ON_RESIN).HasSubstructMatch(
            Chem.MolFromSmarts("[CX3](=O)[OX2H1]")))  # the ester, not the free acid
        self.assertEqual(hazards([D_ALA_ON_RESIN, "NCC(=O)OC"]), [])

    def test_a_free_peptide_carrying_a_d_residue_is_not_read(self):
        # Measured truth, replacing the old claim that this project never puts a free peptide acid in
        # solution: a head-to-tail route does exactly that at the closure. The linear precursor below
        # really is a peptide (three alpha centres) and carries the same D residue as the block that
        # introduced it, so it is not a building block and the gate does not read it. The single
        # block still is, which is the positive control under it.
        precursor = Chem.MolFromSmiles(LINEAR_PRECURSOR)
        self.assertEqual(len(precursor.GetSubstructMatches(_ALPHA)), 3)
        self.assertEqual(hazards([LINEAR_PRECURSOR]), [])
        self.assertEqual(len(hazards([D_ALA])), 1)


class AHeadToTailRouteFlagsTheBlockOnce(unittest.TestCase):
    """The linear precursor at the closure is not a second finding; the coupling still is one.

    Both steps go through the real `_compatibility`, in one call as the app sends them, with the
    molecules the generator itself emitted. This is the counter-example the old test denied.
    """

    def test_the_closure_does_not_repeat_the_coupling_finding(self):
        found = W._compatibility([
            {"reactants": COUPLING_REACTANTS, "products": [COUPLING_PRODUCT],
             "reagents": "HBTU, DIPEA, DMF"},
            {"reactants": [LINEAR_PRECURSOR], "products": [CYCLIC_PRODUCT],
             "reagents": "HATU, DIPEA, DMF, high dilution (about 1 mM), 2 h"},
        ])
        per_step = [[h for h in block["hazards"] if h["group"] == "d-amino-acid"]
                    for block in found]
        self.assertEqual([len(step) for step in per_step], [1, 0])
        self.assertEqual(sum(len(step) for step in per_step), 1)
        self.assertIn("(R)", per_step[0][0]["why"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
