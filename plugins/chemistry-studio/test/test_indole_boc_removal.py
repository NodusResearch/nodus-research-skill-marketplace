"""The indole Boc comes off again: `ring-nitrogen-boc-removal`.

This closes a gap where the package named a remedy a route could not actually take. The
`free-indole` hazard — tryptophan alkylated by the cations an acid cleavage sets loose — is
answered either by a scavenger in the cocktail or by carrying the residue as **Fmoc-Trp(Boc)-OH**,
which the package ships and the hazard's own message recommends. But nothing could remove that
Boc, so a generated route taking the building-block remedy had no way to finish.

The cause is one character of SMARTS. `boc-removal`'s site is `boc carbamate`,
`[NX3][CX3](=O)[OX2][CX4]([CH3])([CH3])[CH3]`, and the indole nitrogen of the shipped block is
AROMATIC — RDKit reads it as `n`, which `[NX3]` cannot match. Confirmed directly: the shipped
Fmoc-Trp(Boc)-OH answers False to the aliphatic pattern and True to the aromatic one.

WHY A SECOND RULE RATHER THAN A WIDER ONE, which was the open design question. Widening the first
atom to `[#7;X3]` does not work: the product template has to put the hydrogen back, and `[#7:1]`
leaves the freed aromatic nitrogen without it, so the molecule will not kekulise — measured, it
raises `KekulizeException: Can't kekulize mol`. The product must be written `[nH:1]`, and a single
rule cannot write both that and the aliphatic `[N:1]`.

The package had already met this exact asymmetry and resolved it the same way. Trityl removal is
THREE rules — `s-trityl-removal`, `n-trityl-removal`, `imidazole-trityl-removal` — and the comment
on the last one says why: "The freed ring nitrogen keeps its hydrogen, which a rule written for an
aliphatic nitrogen cannot express." So a separate transform is this package's established pattern,
not a departure from it.

The rule is written for an aromatic ring nitrogen generally, not for indole alone, so it also
covers an N-im-Boc histidine. Fmoc-His(Boc)-OH does not currently ship; the rule costs nothing if
it ever does.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "python")
sys.path.insert(0, PY)

from rdkit import Chem, RDLogger
from rdkit.Chem import rdChemReactions, rdMolDescriptors

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

TABLES = json.load(open(os.path.join(PY, "route_transforms.json"), encoding="utf-8"))
BY_ID = {t["id"]: t for t in TABLES["transforms"]}
TRANSFORM = "ring-nitrogen-boc-removal"

BLOCKS_TS = os.path.join(os.path.dirname(HERE), "src", "engine", "peptideBuildingBlocks.ts")


def shipped(name):
    import re
    text = open(BLOCKS_TS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', text))[name]


def run(transform, smiles, *reagents):
    """The carried product of a transform, or None if it does not apply."""
    rxn = rdChemReactions.ReactionFromSmarts(BY_ID[transform]["smarts"])
    mols = tuple(Chem.MolFromSmiles(s) for s in (smiles,) + reagents)
    for outcome in rxn.RunReactants(mols):
        try:
            mol = outcome[0]
            Chem.SanitizeMol(mol)
            return Chem.MolToSmiles(mol)
        except Exception:
            continue
    return None


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class TheGapItCloses(unittest.TestCase):
    """Pins the defect, so that the reason this transform exists cannot be lost."""

    def test_the_shipped_Trp_block_has_an_AROMATIC_nitrogen(self):
        mol = Chem.MolFromSmiles(shipped("Fmoc-Trp(Boc)-OH"))
        aromatic = [a.GetIsAromatic() for a in mol.GetAtoms() if a.GetAtomicNum() == 7]
        self.assertIn(True, aromatic, "the indole nitrogen should be aromatic after sanitization")

    def test_the_ALIPHATIC_boc_rule_cannot_reach_it(self):
        site = Chem.MolFromSmarts(TABLES["sites"]["boc carbamate"])
        self.assertFalse(Chem.MolFromSmiles(shipped("Fmoc-Trp(Boc)-OH")).HasSubstructMatch(site),
                         "if this ever passes, the second rule is redundant and should go")

    def test_boc_removal_itself_does_not_apply_to_it(self):
        self.assertIsNone(run("boc-removal", shipped("Fmoc-Trp(Boc)-OH")),
                          "the gap, stated as behaviour rather than as a pattern")

    def test_a_WIDENED_rule_would_not_sanitize_which_is_why_this_is_separate(self):
        # The measurement that decided the design. Widening the first atom to [#7;X3] and leaving
        # the product as [#7:1] loses the hydrogen the freed ring nitrogen needs.
        widened = ("[#7;X3:1][CX3:2](=[OX1:3])[OX2:4][CX4:5]([CH3:6])([CH3:7])[CH3:8]"
                   ">>[#7:1].[OX1:3]=[CX3:2]=[OX2:4].[CH2:6]=[CX3:5]([CH3:7])[CH3:8]")
        rxn = rdChemReactions.ReactionFromSmarts(widened)
        outcomes = rxn.RunReactants((Chem.MolFromSmiles(shipped("Fmoc-Trp(Boc)-OH")),))
        self.assertTrue(outcomes, "it does MATCH — the problem is the product, not the site")
        with self.assertRaises(Exception):
            Chem.SanitizeMol(outcomes[0][0])


class TheRuleWorks(unittest.TestCase):
    def test_it_is_declared_with_a_site_and_a_summary(self):
        entry = BY_ID[TRANSFORM]
        self.assertEqual(entry["site"], "ring nitrogen boc")
        self.assertIn(entry["site"], TABLES["sites"])
        self.assertTrue(entry["summary"].endswith("."), entry["summary"])
        self.assertEqual(entry["carries"], 1)
        self.assertEqual(entry["reagents"], [])

    def test_it_takes_the_Boc_off_the_shipped_Trp_block(self):
        got = run(TRANSFORM, shipped("Fmoc-Trp(Boc)-OH"))
        self.assertIsNotNone(got)
        # Fmoc-Trp-OH: the block less Boc, which is C5H8O2 (isobutylene + CO2).
        self.assertEqual(formula(got), "C26H22N2O4", got)

    def test_the_freed_indole_KEEPS_ITS_HYDROGEN(self):
        got = run(TRANSFORM, shipped("Fmoc-Trp(Boc)-OH"))
        self.assertTrue(Chem.MolFromSmiles(got).HasSubstructMatch(Chem.MolFromSmarts("[nH]")),
                        f"the whole reason for a separate rule: {got}")

    def test_it_works_on_a_bare_Boc_indole_too(self):
        self.assertEqual(run(TRANSFORM, "CC(C)(C)OC(=O)n1ccc2ccccc21"),
                         Chem.MolToSmiles(Chem.MolFromSmiles("c1ccc2[nH]ccc2c1")))

    def test_it_covers_an_imidazole_ring_nitrogen_as_well(self):
        # Written for an aromatic ring nitrogen generally, so an N-im-Boc histidine is covered if
        # such a block is ever added.
        got = run(TRANSFORM, "CC(C)(C)OC(=O)n1cnc(C[C@@H](N)C(=O)O)c1")
        self.assertIsNotNone(got)
        self.assertTrue(Chem.MolFromSmiles(got).HasSubstructMatch(Chem.MolFromSmarts("[nH]")), got)

    def test_it_leaves_an_ALIPHATIC_Boc_alone(self):
        # Fmoc-Lys(Boc)-OH is `boc-removal`'s job. If this rule took it too, the two would compete
        # and a route could not say which nitrogen it meant.
        self.assertIsNone(run(TRANSFORM, shipped("Fmoc-Lys(Boc)-OH")))

    def test_it_leaves_a_tert_butyl_ESTER_alone(self):
        self.assertIsNone(run(TRANSFORM, shipped("Fmoc-Asp(OtBu)-OH")))


class TheRemedyIsNowExpressibleEndToEnd(unittest.TestCase):
    """The point of the whole change: take the remedy, and the route can still finish.

    `free-indole` tells a route to carry the tryptophan as Fmoc-Trp(Boc)-OH. That is only advice a
    route can act on if the Boc can come off, and if the hazard then behaves correctly on the step
    that removes it.
    """

    def test_the_hazard_recommends_the_block(self):
        text, _forms = T.suggestion("free-indole", "strong-acid")
        self.assertIn("trp(boc)", (text or "").lower())

    def test_the_protected_block_does_NOT_raise_the_hazard(self):
        step = {"reactants": [shipped("Fmoc-Trp(Boc)-OH")],
                "products": [shipped("Fmoc-Trp(Boc)-OH")],
                "reagents": "TFA/H2O 95:5, 2 h"}
        groups = {h["group"] for h in W._compatibility([step])[0]["hazards"]}
        self.assertNotIn("free-indole", groups, f"hazards were {groups}")

    def test_and_the_step_that_removes_the_Boc_DOES_expose_a_matchable_indole(self):
        before = shipped("Fmoc-Trp(Boc)-OH")
        after = run(TRANSFORM, before)
        pattern = Chem.MolFromSmarts(T.GROUPS["free-indole"][1])
        self.assertFalse(Chem.MolFromSmiles(before).HasSubstructMatch(pattern))
        self.assertTrue(Chem.MolFromSmiles(after).HasSubstructMatch(pattern),
                        "the product-side gate has something to read")


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
