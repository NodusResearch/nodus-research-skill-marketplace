"""The dipeptide building blocks: one coupling that adds two residues.

These blocks are not a convenience. Each one exists because the stepwise route through a particular
pair of residues has a named failure mode, and the block suppresses it by arriving with the
offending nitrogen already masked. What has to be true for that to be a route to the SAME peptide
rather than a different one is that the mask comes back off, and lands exactly where the plain
route would have. That is what these tests assert.

The blocks were derived from the single-residue blocks with the plugin's own transforms rather than
transcribed from a catalogue, so the test also pins the structures: a silent edit to either entry
changes a formula here.
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import rdMolDescriptors

import route_program

RDLogger.DisableLog("rdApp.*")

BLOCKS_TS = os.path.join(os.path.dirname(__file__), "..", "src", "engine", "peptideBuildingBlocks.ts")


def blocks():
    text = open(BLOCKS_TS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', text))


def canonical(smiles):
    return Chem.MolToSmiles(Chem.MolFromSmiles(smiles))


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


def apply_named(transform, molecule, reagents=()):
    answer = route_program.handle({"op": "apply", "molecule": molecule,
                                   "operation": {"kind": "named", "id": transform},
                                   "reagents": list(reagents)})
    assert answer.get("ok"), f"{transform}: {answer.get('error')} - {answer.get('message')}"
    return answer


def apply_named_sited(transform, molecule, reagents, site):
    answer = route_program.handle({"op": "apply", "molecule": molecule, "site": site,
                                   "operation": {"kind": "named", "id": transform},
                                   "reagents": list(reagents)})
    assert answer.get("ok"), f"{transform} at {site!r}: {answer.get('error')} - {answer.get('message')}"
    return answer


def count_atoms(smiles_list):
    """Element counts with hydrogens made explicit, over a list of SMILES."""
    import collections
    tally = collections.Counter()
    for smiles in smiles_list:
        for atom in Chem.AddHs(Chem.MolFromSmiles(smiles)).GetAtoms():
            tally[atom.GetSymbol()] += 1
    return dict(tally)


class DipeptideBlocks(unittest.TestCase):
    def setUp(self):
        self.blocks = blocks()

    def test_both_dipeptide_blocks_are_present_and_well_formed(self):
        for name, expected in (("Fmoc-Asp(OtBu)-(Dmb)Gly-OH", "C34H38N2O9"),
                               ("Fmoc-Gly-Pro-OH", "C22H22N2O5")):
            self.assertIn(name, self.blocks)
            smiles = self.blocks[name]
            self.assertIsNotNone(Chem.MolFromSmiles(smiles), name)
            self.assertEqual(formula(smiles), expected, name)

    def test_the_stereocentres_are_the_shipped_monomers_stereocentres(self):
        # A dipeptide block that quietly carried a D residue would still couple, still balance and
        # still look right in a program listing. The centre is the thing to pin.
        def centres(smiles):
            mol = Chem.MolFromSmiles(smiles)
            return [code for _, code in
                    Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)]
        self.assertEqual(centres(self.blocks["Fmoc-Asp(OtBu)-(Dmb)Gly-OH"]),
                         centres(self.blocks["Fmoc-Asp(OtBu)-OH"]))
        self.assertEqual(centres(self.blocks["Fmoc-Gly-Pro-OH"]),
                         centres(self.blocks["Fmoc-Pro-OH"]))

    def test_removing_the_dmb_lands_on_the_plain_dipeptide(self):
        # The point of the Dmb block is that it is TEMPORARY. Strip it and the result must be the
        # same molecule the ordinary two couplings would have given - built here independently, by
        # acylating glycine with Fmoc-Asp(OtBu)-OH, so the two routes are compared and not assumed.
        stripped = apply_named("dmb-removal", self.blocks["Fmoc-Asp(OtBu)-(Dmb)Gly-OH"], ["O"])
        plain = apply_named("n-peptide-coupling", self.blocks["glycine"],
                            [self.blocks["Fmoc-Asp(OtBu)-OH"]])
        self.assertEqual(canonical(stripped["product"]), canonical(plain["product"]))
        self.assertEqual(formula(stripped["product"]), "C25H28N2O7")
        # and the auxiliary leaves as the alcohol, not as something invented
        self.assertEqual([canonical(x) for x in stripped.get("coProducts") or []],
                         [canonical("COc1ccc(CO)c(OC)c1")])

    def test_the_glycine_fmoc_is_what_comes_off_the_proline_block(self):
        # Fmoc-Gly-Pro-OH exists to keep a C-terminal Xaa-Pro off the resin as a free dipeptide,
        # where it would cyclise to a diketopiperazine and cleave itself. Deprotection must free the
        # glycine nitrogen and leave the proline amide alone.
        freed = apply_named("fmoc-removal", self.blocks["Fmoc-Gly-Pro-OH"])
        self.assertEqual(canonical(freed["product"]), canonical("NCC(=O)N1CCC[C@H]1C(=O)O"))
        self.assertEqual(formula(freed["product"]), "C7H12N2O3")


class EveryDmbIsOneTreatment(unittest.TestCase):
    """Dmb removal is an acidolysis, and acid is not site-selective.

    A sequence with two Asp-Gly pairs carries two Dmb groups, and in the glassware one treatment
    takes both. Written as two un-sited statements it is not even expressible - the executor
    correctly refuses with `ambiguous-site`, because neither statement can say which group it means.
    Written as one `every dmb amide` it is both expressible and right.

    The accounting is the part worth pinning. `appliedTimes` is how a caller learns the reagent was
    consumed more than once; a caller that ignores it gets the correct product with a wrong mass
    balance, which is a quiet failure rather than a loud one.
    """

    TWO = ("COc1ccc(CN(CC(=O)NCC(=O)N(CC(=O)O)Cc2ccc(OC)cc2OC)C(C)=O)c(OC)c1")

    def test_two_dmb_groups_refuse_an_unsited_removal(self):
        answer = route_program.handle({"op": "apply", "molecule": self.TWO, "reagents": ["O"],
                                       "operation": {"kind": "named", "id": "dmb-removal"}})
        self.assertFalse(answer.get("ok"))
        self.assertEqual(answer.get("error"), "ambiguous-site")

    def test_every_takes_both_and_reports_the_count(self):
        answer = apply_named_sited("dmb-removal", self.TWO, ["O"], "every dmb amide")
        self.assertEqual(answer.get("appliedTimes"), 2)
        # both auxiliaries leave, and they leave as the alcohol
        self.assertEqual([canonical(x) for x in answer.get("coProducts") or []],
                         [canonical("COc1ccc(CO)c(OC)c1")] * 2)
        # the balance only closes if the water is counted twice, which is what appliedTimes is for
        consumed = count_atoms([self.TWO] + ["O"] * answer["appliedTimes"])
        released = count_atoms([answer["product"]] + list(answer.get("coProducts") or []))
        self.assertEqual(consumed, released)
        self.assertNotEqual(consumed, count_atoms([self.TWO, "O"]))


class ProlineDeprotection(unittest.TestCase):
    """Proline's ring nitrogen carries no hydrogen, which once stopped every carbamate removal.

    Guarded here because the fix (commits 4108c7d, 3386eef, widening `[NX3;H1:1]` to
    `[NX3;H1,H0:1]`) is a one-character kind of change that a later edit could undo without any
    other test noticing.
    """

    def test_proline_carbamates_come_off(self):
        for transform, block, expected in (("fmoc-removal", "Fmoc-Pro-OH", "C5H9NO2"),):
            answer = apply_named(transform, blocks()[block])
            self.assertEqual(canonical(answer["product"]), canonical("O=C(O)[C@@H]1CCCN1"))
            self.assertEqual(formula(answer["product"]), expected)


if __name__ == "__main__":
    unittest.main()
