"""Tests for taking an assembled target apart.

Run with the plugin runtime's interpreter:

    <venv>/bin/python3 -I plugins/chemistry-studio/test/test_decompose.py

The library is local data and never ships here, so every test that needs one writes a tiny library
to a temporary directory. The chains are assembled from those same entries, which makes the expected
answer exactly the list of ids that went in — a chain read back wrongly cannot be blamed on the
fixture.

Three properties are worth more than the rest, because each one was a real defect caught by
measurement rather than by inspection:
  - the link must be the backbone bond, or a side-chain amide is cut and a unit is split in half;
  - chirality has to be asked for, or the two configurations of a unit are indistinguishable;
  - a unit is not joined at every attachment it declares, so one form per entry identifies neither
    the unit at the end of a chain nor a unit with an unused side-chain attachment.
"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

import decompose
import reactions_worker

RDLogger.DisableLog("rdApp.*")

# Three units, written as the library writes them: attachment points as atom map numbers.
UNITS = {
    # named for the configuration RDKit assigns, not for a trivial name: the point of the pair is
    # only that the two are told apart, and a trivial name here would assert more than is checked
    "unit-R": {"smiles": "C[C@@H]([NH2:1])[C:2](=O)O", "attach": {"R1": 1, "R2": 2}},
    "unit-S": {"smiles": "C[C@H]([NH2:1])[C:2](=O)O", "attach": {"R1": 1, "R2": 2}},
    "gly": {"smiles": "[NH2:1]C[C:2](=O)O", "attach": {"R1": 1, "R2": 2}},
    # a third attachment point that a linear chain never uses
    "asp": {"smiles": "[NH2:1][C@@H](C[C:3](=O)O)[C:2](=O)O",
            "attach": {"R1": 1, "R2": 2, "R3": 3}},
}

JOIN = AllChem.ReactionFromSmarts(
    # both ends pinned to the backbone, so a side chain is never joined by accident
    "[C;$(C[CX4][NX3]):1](=[O:2])[OX2H1]"
    ".[NX3;H1,H2;$(N[CX4][CX3](=[OX1])[OX2H1]):3]"
    ">>[C:1](=[O:2])[N:3]")


def forms_of(smiles, attach):
    """The entry's in-chain forms, derived the way tools/build-monomers.py derives them."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(HERE)))), "tools"))
    mol = Chem.MolFromSmiles(smiles)
    labels = sorted(attach)
    leaving = ("O", "N", "S", "F", "Cl", "Br", "I")
    bymap = {a.GetAtomMapNum(): a.GetIdx() for a in mol.GetAtoms() if a.GetAtomMapNum()}
    seen = {}
    for mask in range(1, 1 << len(labels)):
        chosen = [l for i, l in enumerate(labels) if mask & (1 << i)]
        drop = []
        for label in chosen:
            idx = bymap[attach[label]]
            atom = mol.GetAtomWithIdx(idx)
            if atom.GetTotalNumHs():
                continue
            for nb in atom.GetNeighbors():
                bond = mol.GetBondBetweenAtoms(idx, nb.GetIdx())
                if (nb.GetSymbol() in leaving and nb.GetTotalNumHs() > 0
                        and bond.GetBondType() == Chem.BondType.SINGLE and nb.GetDegree() == 1):
                    drop.append(nb.GetIdx())
                    break
        rw = Chem.RWMol(mol)
        for a in rw.GetAtoms():
            a.SetAtomMapNum(0)
        for i in sorted(set(drop), reverse=True):
            rw.RemoveAtom(i)
        out = rw.GetMol()
        Chem.SanitizeMol(out)
        smarts = Chem.MolToSmiles(out)
        if Chem.MolFromSmarts(smarts).GetNumAtoms() < 3:
            continue
        if smarts not in seen or len(chosen) > len(seen[smarts]):
            seen[smarts] = chosen
    return [{"condensed": c, "smarts": s} for s, c in seen.items()]


def write_library(path, ids):
    entries = []
    for mid in ids:
        u = UNITS[mid]
        entries.append({"id": mid, "smiles": u["smiles"], "attachments": u["attach"],
                        "inChainForms": forms_of(u["smiles"], u["attach"])})
    with open(os.path.join(path, "monomers.json"), "w") as fh:
        json.dump({"format": "nodus.monomer-library", "version": 1, "entries": entries}, fh)
    decompose._libraries.clear()
    return path


def chain(ids):
    mol = Chem.MolFromSmiles(UNITS[ids[0]]["smiles"])
    for a in mol.GetAtoms():
        a.SetAtomMapNum(0)
    for nxt in ids[1:]:
        m2 = Chem.MolFromSmiles(UNITS[nxt]["smiles"])
        for a in m2.GetAtoms():
            a.SetAtomMapNum(0)
        outs = JOIN.RunReactants((mol, m2))
        assert outs, f"could not join {nxt}"
        best = max((Chem.MolToSmiles(o[0]) for o in outs if _ok(o[0])), key=len)
        mol = Chem.MolFromSmiles(best)
    return Chem.MolToSmiles(mol)


def _ok(mol):
    try:
        Chem.SanitizeMol(mol)
        return True
    except Exception:
        return False


class Cutting(unittest.TestCase):
    """The cut, which needs no library at all."""

    def test_a_single_unit_has_no_link_bonds(self):
        mol = Chem.MolFromSmiles("C[C@@H](N)C(=O)O")
        self.assertEqual(decompose.link_bonds(mol), [])

    def test_two_units_joined_have_one_link_bond(self):
        mol = Chem.MolFromSmiles(chain(["unit-R", "gly"]))
        self.assertEqual(len(decompose.link_bonds(mol)), 1)

    def test_n_units_have_n_minus_one_link_bonds(self):
        for n in (2, 3, 4, 5):
            ids = (["unit-R", "gly"] * 3)[:n]
            mol = Chem.MolFromSmiles(chain(ids))
            self.assertEqual(len(decompose.link_bonds(mol)), n - 1, ids)

    def test_a_side_chain_amide_is_not_a_link(self):
        # the amide here hangs off a side chain, not the backbone: cutting it would split a unit
        mol = Chem.MolFromSmiles("NC(=O)C[C@@H](N)C(=O)O")
        self.assertEqual(decompose.link_bonds(mol), [])

    def test_a_carbamate_is_not_a_link(self):
        mol = Chem.MolFromSmiles("CC(C)(C)OC(=O)N[C@@H](C)C(=O)O")
        self.assertEqual(decompose.link_bonds(mol), [])

    def test_cutting_nothing_returns_the_molecule_whole(self):
        mol = Chem.MolFromSmiles("C[C@@H](N)C(=O)O")
        pieces = decompose.cut(mol, [])
        self.assertEqual(len(pieces), 1)
        self.assertEqual(len(pieces[0][1]), mol.GetNumAtoms())

    def test_every_atom_lands_in_exactly_one_fragment(self):
        mol = Chem.MolFromSmiles(chain(["unit-R", "gly", "asp"]))
        pieces = decompose.cut(mol, decompose.link_bonds(mol))
        seen = [i for _, original in pieces for i in original]
        self.assertEqual(sorted(seen), list(range(mol.GetNumAtoms())))


class Deprotecting(unittest.TestCase):
    @staticmethod
    def cip(mol):
        m = Chem.Mol(mol)
        Chem.AssignStereochemistry(m, cleanIt=True, force=True)
        return [a.GetPropsAsDict().get("_CIPCode") for a in m.GetAtoms() if a.HasProp("_CIPCode")]

    def test_a_tert_butyl_ester_comes_off(self):
        mol = Chem.MolFromSmiles("CC(C)(C)OC(=O)C[C@@H](N)C(=O)O")
        out, gone = decompose.deprotect(mol)
        self.assertIn("tBu-on-O", gone)
        # the expectation is RDKit's own canonical output, not a string read off by eye: a chiral
        # tag means different things at different atom orderings, and comparing them by hand is how
        # a correct deprotection first looked like a stereo inversion
        self.assertEqual(Chem.MolToSmiles(out), "N[C@H](CC(=O)O)C(=O)O")

    def test_a_carbamate_group_comes_off_in_two_steps_and_restores_the_hydrogen(self):
        mol = Chem.MolFromSmiles("CC(C)(C)OC(=O)N[C@@H](C)C(=O)O")
        out, gone = decompose.deprotect(mol)
        self.assertEqual(gone, ["tBu-on-O", "carbamate"])
        self.assertEqual(Chem.MolToSmiles(out), "C[C@H](N)C(=O)O")

    def test_deprotection_never_changes_a_configuration(self):
        """The property the two strings above are only evidence for."""
        for smiles in ("CC(C)(C)OC(=O)N[C@@H](C)C(=O)O",
                       "CC(C)(C)OC(=O)C[C@@H](N)C(=O)O",
                       "CC(C)(C)OC(=O)N[C@H](C)C(=O)O"):
            mol = Chem.MolFromSmiles(smiles)
            before = self.cip(mol)
            out, gone = decompose.deprotect(mol)
            self.assertTrue(gone, smiles)
            self.assertEqual(self.cip(out), before, smiles)

    def test_an_unprotected_fragment_is_returned_unchanged(self):
        mol = Chem.MolFromSmiles("C[C@@H](N)C(=O)O")
        out, gone = decompose.deprotect(mol)
        self.assertEqual(gone, [])
        self.assertEqual(Chem.MolToSmiles(out), "C[C@@H](N)C(=O)O")

    def test_a_ring_bond_is_never_cut(self):
        # the pattern can match inside a ring; cutting there would open it
        mol = Chem.MolFromSmiles("C1CCCCO1")
        out, gone = decompose.deprotect(mol)
        self.assertEqual(gone, [])
        self.assertEqual(out.GetNumAtoms(), mol.GetNumAtoms())


class Identifying(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        write_library(self.dir, ["unit-R", "unit-S", "gly", "asp"])

    def test_a_chain_reads_back_as_the_units_that_built_it(self):
        for ids in (["unit-R", "gly"], ["unit-R", "gly", "asp"],
                    ["gly", "unit-R", "gly", "asp"], ["asp", "gly", "unit-R"]):
            out = decompose.decompose([chain(ids)], self.dir)[0]
            got = sorted(u["ids"][0] for u in out["units"])
            self.assertEqual(got, sorted(ids), f"{ids} -> {out}")
            self.assertEqual(out["unidentified"], [], ids)
            self.assertEqual(out["covered"], 1.0, ids)

    def test_the_two_configurations_of_a_unit_are_told_apart(self):
        left = decompose.decompose([chain(["unit-R", "gly"])], self.dir)[0]
        right = decompose.decompose([chain(["unit-S", "gly"])], self.dir)[0]
        self.assertEqual(sorted(u["ids"][0] for u in left["units"]), sorted(["gly", "unit-R"]))
        self.assertEqual(sorted(u["ids"][0] for u in right["units"]), sorted(["gly", "unit-S"]))

    def test_the_unit_at_the_end_keeps_its_free_acid_and_is_still_identified(self):
        out = decompose.decompose([chain(["unit-R", "gly"])], self.dir)[0]
        joined = {u["ids"][0]: u["joinedAt"] for u in out["units"]}
        # one unit is joined at both of its points, the other only at one
        self.assertEqual(sorted(len(v) for v in joined.values()), [1, 2])

    def test_a_unit_whose_side_chain_attachment_is_unused_is_still_identified(self):
        out = decompose.decompose([chain(["gly", "asp"])], self.dir)[0]
        ids = sorted(u["ids"][0] for u in out["units"])
        self.assertEqual(ids, ["asp", "gly"])

    def test_a_unit_the_library_does_not_hold_is_unidentified_not_guessed(self):
        write_library(self.dir, ["gly"])
        out = decompose.decompose([chain(["unit-R", "gly"])], self.dir)[0]
        self.assertEqual([u["ids"][0] for u in out["units"]], ["gly"])
        self.assertEqual(len(out["unidentified"]), 1)
        self.assertLess(out["covered"], 1.0)

    def test_two_entries_with_the_same_form_are_reported_as_ambiguous(self):
        # the same structure under two ids: both must come back, not one picked
        with open(os.path.join(self.dir, "monomers.json")) as fh:
            data = json.load(fh)
        twin = dict(next(e for e in data["entries"] if e["id"] == "gly"), id="gly-twin")
        data["entries"].append(twin)
        with open(os.path.join(self.dir, "monomers.json"), "w") as fh:
            json.dump(data, fh)
        decompose._libraries.clear()
        out = decompose.decompose([chain(["gly", "unit-R"])], self.dir)[0]
        amb = [u for u in out["units"] if u.get("ambiguous")]
        self.assertEqual(len(amb), 1, out)
        self.assertEqual(sorted(amb[0]["ids"]), ["gly", "gly-twin"])


class WithoutALibrary(unittest.TestCase):
    """The cut is useful on its own: the fragments are what a retro pass can afford to ask about."""

    def test_the_fragments_still_come_back(self):
        out = decompose.decompose([chain(["unit-R", "gly", "asp"])], None)[0]
        self.assertFalse(out["hasLibrary"])
        self.assertEqual(out["units"], [])
        self.assertEqual(len(out["unidentified"]), 3)
        self.assertEqual(out["covered"], 0.0)

    def test_a_missing_library_directory_is_not_an_error(self):
        out = decompose.decompose(["C[C@@H](N)C(=O)O"], "/nonexistent/path")[0]
        self.assertFalse(out["hasLibrary"])
        self.assertEqual(len(out["unidentified"]), 1)

    def test_an_unparsable_target_says_so(self):
        out = decompose.decompose(["not a molecule"], None)[0]
        self.assertEqual(out["error"], "unparsable")


class Dispatch(unittest.TestCase):
    def test_the_op_is_reachable_through_handle(self):
        out = reactions_worker.handle({"decompose": [chain(["unit-R", "gly"])]})
        self.assertIn("decompositions", out)
        self.assertEqual(out["decompositions"][0]["linkBonds"], 1)

    def test_only_strings_are_taken(self):
        out = reactions_worker.handle({"decompose": [None, 42, "", "C[C@@H](N)C(=O)O"]})
        self.assertEqual(len(out["decompositions"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
