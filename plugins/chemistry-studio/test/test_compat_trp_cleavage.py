"""Tryptophan alkylated during acid cleavage, when the cocktail carries no cation scavenger.

PEPTIDE-TODO Phase 2.5: "Trp alkylation on TFA cleavage (gate: Trp + a cleavage cocktail with no
scavenger)". The chemistry: as the acid-labile groups come off, they leave as CATIONS —
tert-butyl from a Boc or a tBu ester or ether, trityl from a Trt, the Pbf sulfonyl cation from an
Arg — and the indole of tryptophan is the most electron-rich ring in a peptide, so it takes them.
The peptide that comes off the resin is alkylated at the indole, and the loss is irreversible.

Three things have to be true together for this to be a real flag, and all three are gated here:

  1. a FREE indole. Fmoc-Trp(Boc)-OH ships, and the Boc on the indole nitrogen deactivates the
     ring, so the protected residue must stay silent — otherwise the flag could never be answered.
  2. a CATION SOURCE in the substrate. Strong acid on a peptide with nothing acid-labile on it
     releases no cation and threatens no indole; flagging that would be wallpaper.
  3. NO SCAVENGER named in the conditions. A cocktail with a thiol (EDT, DODT), thioanisole or
     phenol in it is the standard answer and the flag must clear.

Two judgments about what does NOT count, both now sourced rather than inferred. The source is
Chan & White, *Fmoc Solid Phase Peptide Synthesis: A Practical Approach*, Ch. 3 §10.2 (p. 65,
Table 4 "Cleavage cocktails" and the prose above it; Table 5 "Side reactions encountered during
cleavage reactions", pp. 66-67).

WATER DOES NOT COUNT. Nearly every cleavage cocktail is written with a few percent of water, and
water does not stop a tert-butyl or trityl cation reaching an indole — TFA/H2O 95:5 is exactly the
cocktail that alkylates Trp. Counting it would silence the flag on almost every real route. (The
book is softer than this: it calls water "moderately effective" against t-butyl cations and says
it offers "some protection to unprotected tryptophan against sulphonation". We keep the strict
reading, because "some protection" is not an answer a route can be scored against.)

WHICH TRIALKYLSILANE IT IS DECIDES THE ANSWER, and the two sources disagree about how far that
goes. This is the one place in the hazard set where a citation had to be weighed rather than read.

  * Chan & White argue against silanes generically. Both silane cocktails in Table 4 are
    prescribed for peptides "except ... unprotected Trp", only Reagent K is listed for "All
    peptides", the prose recommends silanes "particularly for peptides containing Arg(Pmc)/Arg(Pbf)
    and Trp(Boc)" — the PROTECTED residue — and Table 5 files "reduction of the indole ring of
    Trp" with the remedy "omit silane scavengers from the cleavage cocktail and substitute for
    EDT". It never distinguishes TIS from TES.
  * *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3 Ch. 10 (printed pp. 357-358)
    does distinguish them, and resolves it the other way for TIS: "TES has better scavenging
    properties then TIS. However, the latter (TIS) IS RECOMMENDED FOR Trp-CONTAINING SEQUENCES
    since the former (TES) has the ability to reduce the indole function of this residue." Its
    Table 10.1 annotates TFA/TES 95:5 as "no: Trp" and TFA/TIS 95:5 as "ACCEPTABLE: Trp". Both
    rest on the same primary source, Pearson, Blanchette, Baker & Guindon, Tetrahedron Lett 30,
    2739-2742 (1989).

Resolved in favour of Vol 3, because it is later, it is specifically about cleavage cocktails, and
it names the individual reagents where Chan & White says "silane scavengers" as a class. So TES
alone does NOT clear a free indole and TIS alone DOES. Recorded here because the first version of
this suite got it wrong in the other direction — it made every silane fail to clear, which flagged
TFA/TIS cocktails that the specialist source calls acceptable.

The substrates are DERIVED, not invented: Fmoc-Asp(OtBu)-OH acylating L-tryptophan through the
shipped n-peptide-coupling, which gives one species carrying both a free indole and a tBu ester
(C34H35N3O7), and the same peptide built from Fmoc-Trp(Boc)-OH for the protected arm (C39H43N3O9).
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem, RDLogger
from rdkit.Chem import rdMolDescriptors

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

# Fmoc-Asp(OtBu)-Trp-OH — free indole AND a tert-butyl ester on one molecule.
TRP_PEPTIDE = ("CC(C)(C)OC(=O)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H]"
               "(Cc1c[nH]c2ccccc12)C(=O)O")
# The same peptide with the indole Boc-protected: the shipped remedy.
TRP_PEPTIDE_BOC = ("CC(C)(C)OC(=O)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H]"
                   "(Cc1cn(C(=O)OC(C)(C)C)c2ccccc12)C(=O)O")
# A Trp peptide with NOTHING acid-labile on it: no cation is released, so no hazard.
TRP_NO_CATION = "C[C@H](NC(C)=O)C(=O)N[C@@H](Cc1c[nH]c2ccccc12)C(=O)O"
# What the cleaved peptide looks like after the acid takes the tBu off: the indole survives, which
# is what makes it a bystander the check can see.
CLEAVED = "OC(=O)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](Cc1c[nH]c2ccccc12)C(=O)O"

GROUP = "free-indole"
BARE_TFA = "TFA/H2O 95:5, 2 h"
# Vol 3 Table 10.1's two silane rows, which are annotated differently for tryptophan.
TES_ONLY = "TFA/triethylsilane/H2O 95:2.5:2.5, 2 h"   # "no: Trp" - reduces the indole
TIS_ONLY = "TFA/triisopropylsilane/H2O 95:2.5:2.5, 2 h"   # "acceptable: Trp"
# Chan & White Table 4's second row: a silane WITH EDT. Clears on either reading.
SCAVENGED = "TFA/TIS/H2O/EDT 94:1:2.5:2.5, 2 h"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1, "one step in, one step out"
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class TheSubstratesAreWhatTheyClaim(unittest.TestCase):
    """Pins the derived test material, so a silent edit to a SMILES here shows up as a formula."""

    def test_the_free_and_protected_peptides(self):
        self.assertEqual(formula(TRP_PEPTIDE), "C34H35N3O7")
        self.assertEqual(formula(TRP_PEPTIDE_BOC), "C39H43N3O9")

    def test_the_free_indole_pattern_tells_them_apart(self):
        query = Chem.MolFromSmarts(T.GROUPS[GROUP][1])
        self.assertIsNotNone(query, "the SMARTS compiles")
        self.assertTrue(Chem.MolFromSmiles(TRP_PEPTIDE).HasSubstructMatch(query))
        self.assertFalse(Chem.MolFromSmiles(TRP_PEPTIDE_BOC).HasSubstructMatch(query),
                         "the Boc on the indole nitrogen must silence it")

    def test_an_imidazole_or_a_plain_arene_is_not_an_indole(self):
        query = Chem.MolFromSmarts(T.GROUPS[GROUP][1])
        for smiles in ("C1=C(NC=N1)C[C@@H](C(=O)O)N",          # L-histidine
                       "C1=CC=C(C=C1)C[C@@H](C(=O)O)N"):       # L-phenylalanine
            self.assertFalse(Chem.MolFromSmiles(smiles).HasSubstructMatch(query), smiles)


class TheFlagFires(unittest.TestCase):
    def test_the_step_that_UNMASKS_the_indole(self):
        # The shape a real route has, from the measured route's step 16: the Boc comes off the
        # indole in the same acid that is shedding every other cation, so the bare indole exists
        # only on the PRODUCT side. Read from the reactants alone this fires a step late, or never.
        found = hazards_for(TRP_PEPTIDE_BOC, TRP_PEPTIDE, BARE_TFA)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_bare_tfa_on_a_trp_peptide_with_a_tbu_ester(self):
        found = hazards_for(TRP_PEPTIDE, CLEAVED, BARE_TFA)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_is_high(self):
        hazard = next(h for h in hazards_for(TRP_PEPTIDE, CLEAVED, BARE_TFA) if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "high")

    def test_it_says_what_happens_and_what_to_do(self):
        hazard = next(h for h in hazards_for(TRP_PEPTIDE, CLEAVED, BARE_TFA) if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("cation", words, f"it must name the mechanism: {words}")
        self.assertTrue(any(k in words for k in ("scaveng", "silane", "thiol", "trp(boc)")),
                        f"it must name a remedy: {words}")

    def test_a_trityl_is_a_cation_source_too(self):
        # Not just tert-butyl: a Trt on an Asn/Gln/Cys/His releases the trityl cation.
        trityl_trp = ("C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)NC(=O)C[C@@H](C(=O)O)"
                      "NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46")
        found = W._compatibility([{"reactants": [TRP_NO_CATION, trityl_trp],
                                   "products": [TRP_NO_CATION], "reagents": BARE_TFA}])[0]["hazards"]
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


class TheFlagClears(unittest.TestCase):
    """Each of the three gate conditions, switched off one at a time."""

    def test_a_silane_WITH_a_thiol_clears_it(self):
        # Table 4 row 2. The silane quenches the stabilised cations (trityl, Tmob, Rink); the EDT
        # is what covers the free indole. Together they are an answer.
        found = hazards_for(TRP_PEPTIDE, CLEAVED, SCAVENGED)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_thiol_or_thioanisole_cocktail_clears_it(self):
        for cocktail in ("TFA/EDT/thioanisole/H2O 94:2.5:2.5:1",
                         "Reagent K: TFA/phenol/water/thioanisole/EDT",
                         "TFA/DODT/H2O/TIS 94:2.5:2.5:1"):
            with self.subTest(cocktail):
                found = hazards_for(TRP_PEPTIDE, CLEAVED, cocktail)
                self.assertNotIn(GROUP, groups_in(found), f"{cocktail}: {groups_in(found)}")

    def test_TRIETHYLsilane_alone_does_NOT_clear_it(self):
        # Vol 3 Table 10.1 annotates TFA/TES 95:5 as "no: Trp", and the prose says TES "has the
        # ability to reduce the indole function of this residue". Chan & White's Table 5 agrees on
        # the chemistry, filing "reduction of the indole ring of Trp" with the remedy "omit silane
        # scavengers ... and substitute for EDT".
        for cocktail in (TES_ONLY, "TFA/TES/water, 3 h", "TFA/triethylsilane 95:5"):
            with self.subTest(cocktail):
                found = hazards_for(TRP_PEPTIDE, CLEAVED, cocktail)
                self.assertIn(GROUP, groups_in(found),
                              f"{cocktail}: TES reduces a free indole; hazards were {groups_in(found)}")

    def test_TRIISOPROPYLsilane_alone_DOES_clear_it(self):
        # The half of this that the first version of the suite got backwards. Vol 3: TIS "is
        # recommended for Trp-containing sequences", and Table 10.1 marks TFA/TIS 95:5
        # "acceptable: Trp". Flagging it would nag a route that used the cocktail the specialist
        # source recommends FOR tryptophan.
        for cocktail in (TIS_ONLY, "TFA/TIS/H2O 95:2.5:2.5"):
            with self.subTest(cocktail):
                found = hazards_for(TRP_PEPTIDE, CLEAVED, cocktail)
                self.assertNotIn(GROUP, groups_in(found), f"{cocktail}: {groups_in(found)}")

    def test_a_bare_unnamed_silane_is_treated_as_NOT_clearing(self):
        # "silane" without saying which one cannot be resolved, and the two differ in exactly the
        # property that matters here, so the conservative reading is the right one.
        found = hazards_for(TRP_PEPTIDE, CLEAVED, "TFA/silane/H2O 95:2.5:2.5")
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_water_alone_does_NOT_clear_it(self):
        # The judgment recorded in the module docstring. TFA/H2O 95:5 is the cocktail that
        # alkylates Trp, so water must not be read as an answer.
        found = hazards_for(TRP_PEPTIDE, CLEAVED, "TFA/H2O 95:5")
        self.assertIn(GROUP, groups_in(found), "water is not a cation scavenger for an indole")

    def test_the_boc_protected_indole_clears_it(self):
        found = hazards_for(TRP_PEPTIDE_BOC, TRP_PEPTIDE_BOC, BARE_TFA)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_no_cation_source_means_no_flag(self):
        found = hazards_for(TRP_NO_CATION, TRP_NO_CATION, BARE_TFA)
        self.assertNotIn(GROUP, groups_in(found),
                         "strong acid with nothing acid-labile releases no cation")

    def test_a_non_acidic_step_does_not_flag_it(self):
        found = hazards_for(TRP_PEPTIDE, TRP_PEPTIDE, "20% piperidine in DMF")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_indole_must_survive_to_be_flagged(self):
        # If the step's own product has no indole, the step consumed it and the check has nothing
        # to warn about — the same survives-into-the-product rule the rest of the table uses.
        found = hazards_for(TRP_PEPTIDE, "CC(C)(C)OC(=O)C[C@H](N)C(=O)O", BARE_TFA)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


if __name__ == "__main__":
    unittest.main()
