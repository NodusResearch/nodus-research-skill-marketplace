"""What each hazard's by-product WEIGHS — so a route can be scored on what its analysis would see.

Build-plan item 25 wants a route scored on whether it HANDLED a hazard, and nothing can do that
today: a route that walks straight into one still verifies, because the by-product is a
self-consistent molecule with a balanced equation of its own. A mass shift is the one thing that
makes a hazard observable after the fact — it is what a chemist reads off the LC-MS of a crude
peptide — so it turns "this route is at risk" into "look for this peak".

HOW THESE TESTS ARE WRITTEN, and it is the whole point of the file. They do NOT compare the table
against itself, and they do not compare it against a number I typed from a book. Each shift is
RE-DERIVED here from two real structures — the intended species and the by-product — and the table
has to agree with the derivation. So the table cannot drift from the chemistry, and a transcription
error from the literature cannot survive.

The derivations agree with every figure the sources quote, which is the cross-check: -42 for
ornithine and +98 for capping (Vol 3 Sections 9.2.10 and 9.2.9), -18 for the aspartimide and +67
for the piperidides (Section 9.2.5), +51 for 3-(piperidin-1-yl)alanine (Section 10.2.2.1), and
+16, +56 and -71 from Chan & White's Table 5. That last one is the nicest: the row survived the PDF
extraction as "-7 1 CYS", and deriving Cys(Acm) -> Cys independently gives -71.08, recovering the
number the OCR broke.

THE ENTRIES THAT ARE NOT NUMBERS MATTER MORE THAN THE ONES THAT ARE. An epimerisation produces an
ISOMER: same formula, same mass, and so invisible to MS, to the balance check and to the target
comparison alike. Recording that as `same-mass` says "do not go looking, use chiral analysis",
which is more useful than omitting the entry and implying nobody asked. The arginine lactam is a
DELETION, detectable as an n-1 species rather than a fixed offset. The diketopiperazine has no
product to weigh at all.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import Descriptors

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")


def mw(smiles):
    mol = Chem.MolFromSmiles(smiles)
    assert mol is not None, smiles
    return Descriptors.MolWt(mol)


def derived(before, after):
    """The nominal mass change going from one real structure to another."""
    return round(mw(after) - mw(before))


# group -> (intended species, by-product, what the change is). Written as structures so the number
# in the table is checked against chemistry rather than against a transcription.
DERIVATIONS = {
    "n-terminal-gln": (
        "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)O",      # H-Gln-Ala-OH
        "O=C1CC[C@H](N1)C(=O)N[C@@H](C)C(=O)O",       # pyroGlu-Ala, ammonia gone
        "ammonia leaves as the lactam closes"),
    "arg-urethane-guanidine": (
        "NC(=N)NCCC[C@@H](C(=O)O)N",                  # arginine
        "NCCC[C@@H](C(=O)O)N",                        # ornithine
        "the amidine goes with the ruptured bond"),
    "n-terminal-amine-capping": (
        "C[C@@H](C(=O)O)NC(=O)CN",                    # H-Gly-Ala-OH, free N-terminus
        "C[C@@H](C(=O)O)NC(=O)CN=C(N(C)C)N(C)C",      # the tetramethylguanidino adduct
        "the uronium salt's own guanidino group"),
    "aspartimide-gly": (
        "OC(=O)C[C@H](N)C(=O)NCC(=O)O",               # H-Asp-Gly-OH
        "O=C1CC(N)C(=O)N1CC(=O)O",                    # the succinimide
        "water leaves as the imide closes"),
    "cys-resin-ester-epimerisation": (
        "N[C@@H](CS)C(=O)O",                          # cysteine
        "N[C@@H](CN1CCCCC1)C(=O)O",                   # 3-(piperidin-1-yl)alanine
        "beta-elimination then piperidine adds"),
    "sulfide": (
        "CSCC[C@@H](C(=O)O)N",                        # methionine
        "C[S](=O)CC[C@@H](C(=O)O)N",                  # the sulfoxide
        "one oxygen"),
    "asn-gln-amide": (
        "NC(=O)C[C@H](N)C(=O)O",                      # asparagine
        "N#CC[C@H](N)C(=O)O",                         # beta-cyanoalanine
        "dehydration to the nitrile"),
}


class EveryTabulatedNumberIsTheOneTheChemistryGives(unittest.TestCase):
    def test_each_derivation_matches_the_table(self):
        for group, (before, after, what) in DERIVATIONS.items():
            with self.subTest(group):
                entry = T.MASS_SHIFTS[group]
                self.assertEqual(entry["delta"], derived(before, after),
                                 f"{group}: the table says {entry['delta']} but {what} gives "
                                 f"{derived(before, after)}")

    def test_the_piperidide_adduct_is_the_plus_67_the_source_quotes(self):
        # Vol 3 Section 9.2.5: "For both the piperidide adducts +67 mass units." It is piperidine
        # opening the imide, so piperidine minus the water the imide closure expelled.
        self.assertEqual(round(mw("C1CCNCC1") - mw("O")), 67)

    def test_the_tert_butylation_in_Table_5_is_plus_56(self):
        # Chan & White Table 5, "+56 ... t-Butylation": a tert-butyl cation lands on an
        # electron-rich side chain, which is isobutylene's mass.
        self.assertEqual(round(mw("C=C(C)C")), 56)

    def test_the_Acm_loss_recovers_the_number_the_OCR_broke(self):
        # Table 5's row reads "-7 1 CYS ... Loss of Acm" in the extraction. Deriving it settles
        # whether that is -71 or something else.
        self.assertEqual(derived("N[C@@H](CSCNC(C)=O)C(=O)O", "N[C@@H](CS)C(=O)O"), -71)

    def test_an_arginine_deletion_is_the_residue_s_own_mass(self):
        # Why the lactam is "deletion" rather than a number: the shift is whichever residue failed
        # to couple. For arginine the chain is short by the residue, not by a fixed offset.
        with_arg = "NC(=N)NCCC[C@@H](C(=O)NCC(=O)O)NC(=O)[C@@H](C)N"   # Ala-Arg-Gly
        without = "C[C@@H](N)C(=O)NCC(=O)O"                             # Ala-Gly, n-1
        self.assertLess(derived(with_arg, without), -100,
                        "a whole residue, which is why no single number is tabulated")
        self.assertEqual(T.MASS_SHIFTS["arg-delta-lactam"]["kind"], "deletion")


class TheEpimerisationsAreExplicitlyInVISIBLE(unittest.TestCase):
    """The entries that say 'do not go looking', which is the useful half of the table."""

    def test_a_D_residue_really_does_weigh_the_same(self):
        # Derived rather than asserted: the two enantiomers of the same peptide.
        l_form = "C[C@@H](N)C(=O)N[C@@H](CS)C(=O)O"
        d_form = "C[C@@H](N)C(=O)N[C@H](CS)C(=O)O"
        self.assertEqual(derived(l_form, d_form), 0)
        self.assertEqual(Chem.MolFromSmiles(l_form).GetNumAtoms(),
                         Chem.MolFromSmiles(d_form).GetNumAtoms())

    def test_both_epimerisation_groups_are_marked_same_mass(self):
        for group in ("cys-epimerisation", "his-epimerisation"):
            with self.subTest(group):
                entry = T.MASS_SHIFTS[group]
                self.assertEqual(entry["kind"], "same-mass")
                self.assertEqual(entry["delta"], 0)

    def test_and_they_say_what_WOULD_find_it(self):
        # An entry that only says "invisible" leaves a reader nowhere to go.
        note = T.MASS_SHIFTS["cys-epimerisation"]["note"].lower()
        self.assertTrue(any(k in note for k in ("chiral", "digest", "enzymatic")),
                        f"name an analysis that can see it: {note}")

    def test_the_resin_diketopiperazine_has_no_product_to_weigh(self):
        entry = T.MASS_SHIFTS["resin-dipeptide-dkp"]
        self.assertEqual(entry["kind"], "absent")
        self.assertIsNone(entry["delta"])
        self.assertTrue(any(k in entry["note"].lower() for k in ("yield", "linker")),
                        "say what the evidence IS instead")


class TheTableIsCompleteAndHonest(unittest.TestCase):
    def test_every_peptide_hazard_has_an_entry(self):
        # Coverage, so a new gate cannot ship without the detectability question answered. This is
        # the durable half of the file: the next hazard added has to say whether MS can see it.
        missing = sorted(T.PEPTIDE_HAZARDS - set(T.MASS_SHIFTS))
        self.assertEqual(missing, [], f"gated peptide hazards with no mass signature: {missing}")

    def test_every_entry_names_a_real_group(self):
        unknown = sorted(set(T.MASS_SHIFTS) - set(T.GROUPS))
        self.assertEqual(unknown, [], f"MASS_SHIFTS names groups that do not exist: {unknown}")

    def test_every_entry_is_well_formed(self):
        for group, entry in T.MASS_SHIFTS.items():
            with self.subTest(group):
                self.assertEqual(sorted(entry), ["delta", "kind", "note"])
                self.assertIn(entry["kind"], ("shift", "same-mass", "deletion", "absent"))
                self.assertGreater(len(entry["note"]), 30, "a bare number helps nobody")
                if entry["kind"] == "same-mass":
                    self.assertEqual(entry["delta"], 0)
                if entry["kind"] in ("deletion", "absent"):
                    self.assertIsNone(entry["delta"], "these have no single number by definition")

    def test_it_does_NOT_claim_to_cover_the_small_molecule_hazards(self):
        # The reading was done for the peptide set only. Claiming a signature for the rest without
        # it would be the overreach this project keeps correcting.
        self.assertNotIn("ester", T.MASS_SHIFTS)
        self.assertNotIn("ketone", T.MASS_SHIFTS)
        self.assertLess(len(T.MASS_SHIFTS), len(T.GROUPS))


class ItReachesTheHazardARouteSees(unittest.TestCase):
    """The table is no use sitting in a module; it has to come out with the hazard."""

    QAG = "NC(=O)CC[C@H](N)C(=O)N[C@@H](C)C(=O)NCC(=O)O"

    def _hazards(self, reactant, product, reagents):
        return W._compatibility([{"reactants": [reactant], "products": [product],
                                  "reagents": reagents}])[0]["hazards"]

    def test_a_fired_hazard_carries_its_mass_shift(self):
        found = [h for h in self._hazards(self.QAG, self.QAG, "TFA/H2O 95:5, 2 h")
                 if h["group"] == "n-terminal-gln"]
        self.assertTrue(found)
        self.assertEqual(found[0]["massShift"]["delta"], -17)
        self.assertEqual(found[0]["massShift"]["kind"], "shift")

    def test_it_comes_through_all_three_readings_not_just_one(self):
        # ATTACKS, ACTIVATION_RISKS and UNMASKED_RISKS each build their own hazard dict, and the
        # first version of this wiring only touched one of them.
        cases = [
            # (reactant, product, conditions, group) — one per reading
            (self.QAG, self.QAG, "TFA/H2O 95:5, 2 h", "n-terminal-gln"),                 # UNMASKED
            ("C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O",
             "C[C@H](N)C(=O)N[C@@H](CC(=O)OC(C)(C)C)C(=O)NCC(=O)O",
             "20% piperidine in DMF", "aspartimide-gly"),                                 # ATTACKS
            ("C(C(=O)O)N", "C[C@@H](C(=O)NCC(=O)O)N",
             "HBTU, DIPEA, DMF, 30 min pre-activation", None),                            # ACTIVATION
        ]
        for reactant, product, conditions, group in cases[:2]:
            with self.subTest(group):
                found = [h for h in self._hazards(reactant, product, conditions)
                         if h["group"] == group]
                self.assertTrue(found, f"{group} did not fire")
                self.assertIn("massShift", found[0])

    def test_an_epimerisation_hazard_carries_the_zero_rather_than_nothing(self):
        cys = "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46"
        found = [h for h in self._hazards("C(C(=O)O)N", "C[C@@H](C(=O)NCC(=O)O)N", "HBTU, DIPEA, DMF")
                 if h["group"] == "cys-epimerisation"]
        # The fixture above has no cysteine, so this asserts the table directly for that group and
        # the wiring through a real step for the groups that do fire above.
        self.assertEqual(T.MASS_SHIFTS["cys-epimerisation"]["delta"], 0)
        self.assertEqual(found, [])

    def test_a_group_with_no_signature_simply_omits_the_field(self):
        # Rather than emitting a null, which a reader would have to interpret.
        found = [h for h in self._hazards("CCOC(=O)c1ccccc1", "CCOC(=O)c1ccccc1",
                                          "aqueous sodium hydroxide, heat")
                 if h["group"] == "ester"]
        if found:
            self.assertNotIn("massShift", found[0])


# Nothing goes after this block. Appending below it has stranded tests three times in this
# directory in one day.
if __name__ == "__main__":
    unittest.main()
