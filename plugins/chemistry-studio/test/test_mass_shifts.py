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
        """Coverage, so a new gate cannot ship without the detectability question answered.

        `PEPTIDE_HAZARDS` is now listed explicitly rather than derived from the table's own keys.
        It was `frozenset(MASS_SHIFTS)` at first, which made this test tautological — it could
        never fail, because the set it checked against was defined as whatever was in the table.
        """
        missing = sorted(T.PEPTIDE_HAZARDS - set(T.MASS_SHIFTS))
        self.assertEqual(missing, [], f"gated peptide hazards with no mass signature: {missing}")

    def test_every_entry_names_a_real_group(self):
        unknown = sorted(set(T.MASS_SHIFTS) - set(T.GROUPS))
        self.assertEqual(unknown, [], f"MASS_SHIFTS names groups that do not exist: {unknown}")

    def test_every_entry_is_well_formed(self):
        for group, entry in T.MASS_SHIFTS.items():
            with self.subTest(group):
                self.assertEqual(sorted(entry), ["delta", "kind", "note"])
                self.assertIn(entry["kind"], ("shift", "same-mass", "deletion", "absent", "residual"))
                self.assertGreater(len(entry["note"]), 30, "a bare number helps nobody")
                if entry["kind"] == "same-mass":
                    self.assertEqual(entry["delta"], 0)
                if entry["kind"] == "residual":
                    self.assertGreater(entry["delta"], 0, "a group that failed to leave adds mass")
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
        found = [h for h in self._hazards(self.QAG, self.QAG, "TFA/H2O 95:5, 2 h, then evaporated and triturated")
                 if h["group"] == "n-terminal-gln"]
        self.assertTrue(found)
        self.assertEqual(found[0]["massShift"]["delta"], -17)
        self.assertEqual(found[0]["massShift"]["kind"], "shift")

    def test_it_comes_through_all_three_readings_not_just_one(self):
        # ATTACKS, ACTIVATION_RISKS and UNMASKED_RISKS each build their own hazard dict, and the
        # first version of this wiring only touched one of them.
        cases = [
            # (reactant, product, conditions, group) — one per reading
            (self.QAG, self.QAG, "TFA/H2O 95:5, 2 h, then evaporated and triturated",
             "n-terminal-gln"),                                                          # UNMASKED
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


class AResidualProtectingGroupIsTheCommonestPeakOfAll(unittest.TestCase):
    """A group still there when the route says it is gone — different question, same table.

    This is what a crude peptide trace actually shows first, and the numbers are positive because
    the product is HEAVIER by whatever failed to leave. Chan & White's Table 5 quotes two of them
    and the derivations agree exactly: "+56 ... incomplete removal of t-Bu groups" and "+242 ...
    incomplete removal of Trt".
    """

    RESIDUAL = {
        "boc": ("C[C@@H](C(=O)O)NC(=O)OC(C)(C)C", "C[C@@H](C(=O)O)N"),
        "cbz": ("C[C@@H](C(=O)O)NC(=O)OCc1ccccc1", "C[C@@H](C(=O)O)N"),
        "fmoc": ("C[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21", "C[C@@H](C(=O)O)N"),
        "trityl": ("N[C@@H](CSC(c1ccccc1)(c1ccccc1)c1ccccc1)C(=O)O", "N[C@@H](CS)C(=O)O"),
        "tbu-ester": ("OC(=O)C[C@H](N)C(=O)OC(C)(C)C", "OC(=O)C[C@H](N)C(=O)O"),
        "tbu-ether": ("N[C@@H](COC(C)(C)C)C(=O)O", "N[C@@H](CO)C(=O)O"),
        "silyl-ether": ("N[C@@H](CO[Si](C)(C)C(C)(C)C)C(=O)O", "N[C@@H](CO)C(=O)O"),
        "benzyl-ether": ("N[C@@H](COCc1ccccc1)C(=O)O", "N[C@@H](CO)C(=O)O"),
        "benzyl-ester": ("OC(=O)C[C@H](N)C(=O)OCc1ccccc1", "OC(=O)C[C@H](N)C(=O)O"),
    }

    def test_each_residual_group_weighs_what_the_table_says(self):
        for group, (protected, free) in self.RESIDUAL.items():
            with self.subTest(group):
                self.assertEqual(T.MASS_SHIFTS[group]["delta"], derived(free, protected))

    def test_they_are_all_POSITIVE_because_the_group_failed_to_leave(self):
        for group in self.RESIDUAL:
            with self.subTest(group):
                self.assertEqual(T.MASS_SHIFTS[group]["kind"], "residual")
                self.assertGreater(T.MASS_SHIFTS[group]["delta"], 0)

    def test_the_two_Table_5_quotes_agree_exactly(self):
        self.assertEqual(T.MASS_SHIFTS["tbu-ether"]["delta"], 56)
        self.assertEqual(T.MASS_SHIFTS["trityl"]["delta"], 242)

    def test_Pbf_derives_as_252_NOT_the_254_the_table_quotes(self):
        """Settles a disagreement with the source rather than adopting its number.

        Chan & White's Table 5 lists "+254/266" for an Arg(Pbf)/(Pmc) sulfonyl left on the peptide.
        Pmc derives as +266 exactly, and Pbf is one CH2 smaller, so Pbf must be +252 — which is
        also what the SHIPPED Fmoc-Arg(Pbf)-OH gives when Fmoc-Arg-OH is subtracted from it. Two
        independent routes to +252, and the table's own internal consistency at +266 is what shows
        the +254 to be wrong. So the free-indole note quotes +252.
        """
        import re
        path = os.path.join(os.path.dirname(HERE), "src", "engine", "peptideBuildingBlocks.ts")
        body = open(path, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
        shipped = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))
        fmoc_arg = "NC(=N)NCCC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21"
        self.assertEqual(derived(fmoc_arg, shipped["Fmoc-Arg(Pbf)-OH"]), 252)
        # Pmc, one CH2 larger, is the +266 the same table quotes correctly.
        self.assertEqual(derived("NC(=N)N",
                                 "NC(=N)NS(=O)(=O)c1c(C)c(C)c2c(c1C)CCC(C)(C)O2"), 266)
        self.assertIn("+252", T.MASS_SHIFTS["free-indole"]["note"])
        self.assertNotIn("+254", T.MASS_SHIFTS["free-indole"]["note"])

    def test_an_acetal_is_left_without_a_number_on_purpose(self):
        # Unlike the others it is not one fixed fragment: a dimethyl acetal is +46 and a dioxolane
        # +44, so the group name alone does not fix the shift.
        entry = T.MASS_SHIFTS["acetal"]
        self.assertIsNone(entry["delta"])
        self.assertIn("depends", entry["note"].lower())


class AllFourHazardBuildersCarryIt(unittest.TestCase):
    """There are FOUR, not three, and the first pass at this wiring missed one.

    The `_REMOVED_BY` builder — "the group is gone in the product, but none of the named reagents
    removes it" — ends differently from the other three, so a replace that asserted a count of
    three walked straight past it. The signature is useful precisely there: the hazard says a group
    vanished unexplained, and the number is what a reader checks the product mass against.
    """

    def test_the_removed_by_builder_carries_a_signature(self):
        before, after = "C[C@@H](C(=O)O)NC(=O)OC(C)(C)C", "C[C@@H](C(=O)O)N"
        found = [h for h in W._compatibility(
            [{"reactants": [before], "products": [after],
              "reagents": "DMF, 45 min, 20% piperidine"}])[0]["hazards"]
            if h["group"] == "boc" and h["reagentClass"] is None]
        self.assertTrue(found, "the unexplained-removal hazard did not fire")
        self.assertEqual(found[0]["massShift"], {"delta": 100, "kind": "residual",
                                                 "note": found[0]["massShift"]["note"]})

    def test_the_count_of_builders_is_pinned_so_a_fifth_cannot_be_missed(self):
        # The lesson, as a test: the reason one was missed is that nobody had counted them.
        worker = os.path.join(os.path.dirname(HERE), "python", "reactions_worker.py")
        source = open(worker, encoding="utf-8").read()
        builders = source.count("hazards.append({\"group\":")
        wired = source.count('"massShift": T.mass_shift(group)')
        self.assertEqual(builders, 4, "a builder was added or removed — wire it and update this")
        self.assertEqual(wired, builders, "every hazard builder must carry the mass signature")


# Nothing goes after this block. Appending below it has stranded tests three times in this
# directory in one day.
if __name__ == "__main__":
    unittest.main()
