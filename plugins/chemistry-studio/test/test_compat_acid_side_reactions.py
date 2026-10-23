"""Acid-side reactions on Ser/Thr/Tyr, Trp with TES, and Cys(Acm) with a thiol.

Ser, Thr and Tyr look like one hazard but are TWO side reactions with two different sources. Both
are source-tested, on different sources: the acid for Ser/Thr, and the visible tBu group for Tyr on
the step that frees the phenol. The split and the reason for it are what this suite pins.

  * SER/THR — acid-induced O-ACYLATION, and 6.6 gives it TWO possible acyl sources. (1) The acid
    DONATES its own acyl group: "The major side reaction associated with peptides containing
    unprotected seryl and threonyl residues is acid-induced acylation of the hydroxyl groups.
    Hydroxyl groups of peptides undergo acylation when the latter are dissolved in strong
    carboxylic acids such as formic and trifluoroacetic acids"; acetic acid does it when "saturated
    with hydrogen bromide or chloride". (2) A strong MINERAL acid SHIFTS an acyl group off a
    peptide bond: "O-Acylation of peptides also occurs in strong mineral acids such as sulfuric and
    phosphoric acids, but in this case the acyl group originates by a shift of the acyl component
    of a peptide bond to the adjacent hydroxyl group." So `conc. H2SO4` fires on a peptide and not
    on a free serine, while `NaNO2/HCl` — the hydrazide activation of a real two-fragment NCL route
    — stays silent. HCl is not in 6.6's shift list: that is ABSENCE OF EVIDENCE, not a claim that
    it cannot shift. The reason the NCL cell is silent has to be the acid list, because the NCL
    fragment is a tetrapeptide hydrazide and DOES carry a peptide bond.

    A CATION test here would be wrong in the other direction: it would silence the major side
    reaction of every TFA cleavage, and a cation scavenger does not remove an acyl group. The
    remedy is 5% hydrazine/DMF on the FREE peptide after cleavage, never on the resin ester.

  * TYR — tert-BUTYLATION of the ring ("+56"), which genuinely IS cation-dependent. The SURVIVOR
    path keeps the unguarded reading: every acid-labile support is itself a cation precursor, and
    a linker test was written and withdrawn because the only text predicate available is
    `has_trityl_linker` — a trityl linker is not evidence of safety. Chan & White's
    cation-reactivity order reads "xanthenyl, methylbenzhydryl > acetamidomethyl, trityl,
    tert-butyl", so a 2-chlorotrityl release puts a cation in solution as reactive as the
    tert-butyl one, and `reactions_worker` already counts `trityl` among the cation sources for the
    indole gate. `TyrAlkylationKeepsTheUnguardedReading` pins that — including the case a trityl
    linker must NOT clear, so the withdrawn guard cannot come back unnoticed.

    The step that FREES the phenol is different, because there the source is visible in the
    structure: it is the molecule's own tert-butyl ether coming off. `TheTyrProductSideRowIsASourceTest`
    pins that row and its guard — a tert-butyl group (`boc`/`tbu-ester`/`tbu-ether`) in the
    reactants and no cation scavenger in the cocktail — which is a SOURCE test, the `free-indole`
    reading narrowed to the groups the `+56` signature is about, not a linker test.

The other gates are unchanged: a cation scavenger clears only `tyr` — it does NOT clear ser/thr —
TIS rather than TES for the indole, and no thiol for Cys(Acm).

`FormicAcidIsItsOwnDonorClass` pins the class added for the acid 6.6 names FIRST. It is a donor
class and not an acidolysis class: the Boc-Ser cell is the counterexample that keeps formic out of
`strong-acid`, and the generator's own n-formylation step is its negative control.

The on-route arms of the differential — the NCL `NaNO2/HCl` step going to zero and the
deprotection that frees the side chain still firing — live in `_local/test/test_hazard_coverage.py`,
because the generator (`peptide_route`, `peptide_convergent`) is not part of the shipped package.
"""

import os
import sys
import unittest

from rdkit import RDLogger

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

SER = "N[C@@H](CO)C(=O)NCC(=O)O"
THR = "N[C@@H]([C@@H](C)O)C(=O)NCC(=O)O"
TYR = "N[C@@H](Cc1ccc(O)cc1)C(=O)NCC(=O)O"
TRP = "N[C@@H](Cc1c[nH]c2ccccc12)C(=O)NCC(=O)O"
CYS_ACM = "CC(=O)NCS[C@H](N)C(=O)NCC(=O)O"

# The shipped tBu-protected blocks' side chains, on a free acid: the reactant of the deprotection
# that FREES the group, which is the step where the acid and the bare hydroxyl are both present.
# Reading only survivors misses it, which is why these are in UNMASKED_RISKS too.
SER_TBU = "CC(C)(C)OC[C@H](N)C(=O)NCC(=O)O"
THR_TBU = "CC(C)(C)O[C@@H](C)[C@H](N)C(=O)NCC(=O)O"
# The Tyr half of the same row: Fmoc-Tyr(tBu)-OH's side chain on a free dipeptide.
TYR_TBU = "CC(C)(C)Oc1ccc(C[C@H](N)C(=O)NCC(=O)O)cc1"
# The generator's own last two molecules on a head-to-tail cyclic Gly-Ser-Tyr-Thr-Ala route: step
# 11, `tert-butyl-ether-removal` under TFA/H2O 95:5. Verbatim from `peptide_route.program` +
# `route_program.handle`, so the cyclic shape is tested on the molecules the route really carries
# rather than on a hand-drawn one. This is the shape whose LAST statement frees the three
# hydroxyls, so the survivor path can never see them and the product-side rows are the only voice.
CYCLIC_TBU = ("C[C@@H]1NC(=O)[C@H]([C@@H](C)OC(C)(C)C)NC(=O)[C@H](Cc2ccc(OC(C)(C)C)cc2)"
              "NC(=O)[C@H](COC(C)(C)C)NC(=O)CNC1=O")
CYCLIC_FREE = ("C[C@@H]1NC(=O)[C@H]([C@@H](C)O)NC(=O)[C@H](Cc2ccc(O)cc2)"
               "NC(=O)[C@H](CO)NC(=O)CNC1=O")
# The ester and hydrazide endgames end on this same on-resin statement: the tBu removal, with no
# later strong-acid step to report the free phenol as a survivor. `*` is the support.
ENDGAME_TBU = "*OC(=O)[C@H](C)NC(=O)[C@H](Cc1ccc(OC(C)(C)C)cc1)NC(=O)CN"
ENDGAME_FREE = "*OC(=O)[C@H](C)NC(=O)[C@H](Cc1ccc(O)cc1)NC(=O)CN"
# A Boc co-reactant, present only to make the new source test pass on a SURVIVOR step.
BOC_ALA = "CC(C)(C)OC(=O)N[C@@H](C)C(=O)O"
# A Boc on the serine nitrogen: the counterexample that keeps `formic-acid` out of `strong-acid`.
# `ATTACKS["strong-acid"]` says a Boc "is cleaved by acid" and reads no acid identity, so a
# formylation or a formic wash filed under that class would claim an acidolysis nobody performed.
BOC_SER = "CC(C)(C)OC(=O)N[C@@H](CO)C(=O)NCC(=O)O"
# A peptide with NO serine: used to prove the shift is read per molecule. A step that lists this
# beside a free serine must not fire on the serine because the *peptide* has a bond.
ALA_GLY = "N[C@@H](C)C(=O)NCC(=O)O"
FREE_SER = "N[C@@H](CO)C(=O)O"
SER_AMIDE = "N[C@@H](CO)C(=O)N"


def hazards(reactants, products, reagents):
    out = W._compatibility([{"reactants": reactants, "products": products, "reagents": reagents}])
    return out[0]["hazards"]


def groups_for(smiles, reagents):
    return {h["group"] for h in hazards([smiles], [smiles], reagents)}


class SerThrOacylationIsAnAcylSourceTest(unittest.TestCase):
    """The step must name a real acyl source: the acid itself, or a peptide bond to shift.

    Two sources, two tests, one negative control each. `TFA/H2O` proves the carboxylic arm still
    fires; `conc. H2SO4` proves the mineral-shift arm does; `NaNO2/HCl` and `TsOH/AcOH` prove the
    acid list is positive rather than "any mineral acid"; free serine under `H2SO4` proves the bond
    test is per molecule; and `TFA/TIS/H2O` proves a scavenger does not clear it.
    """

    def test_the_two_groups_fire_on_a_carboxylic_acid_with_no_scavenger(self):
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                self.assertIn(group, groups_for(smiles, "TFA/H2O 95:5, 2 h"))

    def test_a_mineral_acid_does_NOT_fire_the_NCL_defect(self):
        # The real fixture's conditions, verbatim: peptide-hydrazide activation for native chemical
        # ligation. NO2/HCl cannot O-acylate a serine, so the gate reported a hazard that no
        # reagent in the step can cause, and its remedy (add TIS) was advice for a reaction that is
        # not happening.
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                found = groups_for(smiles, "NaNO2/HCl, then MPAA or ethanethiol")
                self.assertNotIn(group, found)
                self.assertEqual(found, set(), f"the NCL activation raised {found}")

    def test_a_carboxylic_acid_beside_the_mineral_one_still_fires(self):
        # The suppression has to be about the ACID, not about the word "HCl": a step that goes on
        # to TFA is still an acylating step, and silencing it would be the failure this test exists
        # to prevent.
        self.assertIn("ser-hydroxyl", groups_for(SER, "NaNO2/HCl, then TFA/H2O 95:5"))

    def test_the_deprotection_that_frees_the_group_carries_the_statement(self):
        # Ser(tBu) -> Ser happens in the very TFA that then acylates the hydroxyl. That is a
        # product-side reading, so without the UNMASKED_RISKS entry the only statement is the later
        # resin-cleavage one — and on a route whose LAST step is this deprotection (a head-to-tail
        # cyclic peptide) there is no later step, so nothing is said at all.
        for reactant, product, group in ((SER_TBU, SER, "ser-hydroxyl"),
                                         (THR_TBU, THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                found = {h["group"] for h in hazards([reactant], [product], "TFA/H2O 95:5, 2 h")}
                self.assertIn(group, found)

    def test_a_trityl_linker_does_NOT_clear_a_carboxylic_acid(self):
        # Whatever a named linker says about cations, it says nothing about TFA's ability to
        # acylate a hydroxyl, and using it as if it did would silence every 2-chlorotrityl
        # cleavage of a Ser/Thr peptide.
        self.assertIn("ser-hydroxyl", groups_for(SER, "TFA/H2O 95:5, 2 h, 2-chlorotrityl resin"))

    def test_a_sulfuric_acid_shifts_a_peptide_bond_onto_the_hydroxyl(self):
        # One of 6.6's three mineral shift acids, and the cell the old blanket suppressor lost.
        # `conc.` and the bare token are the same conditions; both must fire.
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            for conditions in ("conc. H2SO4", "H2SO4"):
                with self.subTest(group=group, conditions=conditions):
                    self.assertIn(group, groups_for(smiles, conditions))

    def test_the_shift_needs_a_peptide_bond_on_the_SAME_molecule(self):
        # Positive first: the same conditions on Ser-Gly fire. Then the three negatives — a free
        # serine has no acyl component to shift, a C-terminal amide is not a peptide bond, and an
        # Ala-Gly peptide beside a free serine must NOT fire on the serine just because the
        # peptide has a bond.
        self.assertIn("ser-hydroxyl",
                      {h["group"] for h in hazards([SER], [SER], "conc. H2SO4")})
        for label, reactants, group in (
                ("free Ser", [FREE_SER], "ser-hydroxyl"),
                ("Ser-NH2", [SER_AMIDE], "ser-hydroxyl"),
                ("peptide + free Ser", [ALA_GLY, FREE_SER], "ser-hydroxyl")):
            with self.subTest(case=label):
                found = {h["group"] for h in hazards(reactants, reactants, "conc. H2SO4")}
                self.assertNotIn(group, found)

    def test_the_shift_list_is_positive_not_every_mineral_acid(self):
        # 6.6 names sulfuric, phosphoric and hydrogen fluoride. HCl is silent for ABSENCE OF
        # EVIDENCE, not because a mineral acid is harmless; the NCL hydrazide activation is the
        # cell this unit exists to keep silent, and TsOH/AcOH is 6.6's own negative case.
        for conditions in ("NaNO2/HCl, then MPAA or ethanethiol",
                           "HCl/dioxane",
                           "4 M HCl in dioxane",
                           "TsOH/AcOH",
                           "p-toluenesulfonic acid in acetic acid"):
            with self.subTest(conditions=conditions):
                self.assertEqual(groups_for(SER, conditions), set())

    def test_the_shift_arm_stays_unreachable_where_the_class_is_missing(self):
        # Out of scope by ruling: H3PO4 has no reagent class and HF is `fluoride`, so neither can
        # reach a strong-acid gate. The shift predicate still knows them, so the next unit inherits
        # a correct rule; this test pins that nothing fires today and says why.
        self.assertNotIn("strong-acid", T.classify("H3PO4"))
        self.assertIn("fluoride", T.classify("HF"))
        self.assertNotIn("ser-hydroxyl", groups_for(SER, "H3PO4"))
        self.assertNotIn("ser-hydroxyl", groups_for(SER, "HF"))

    def test_hbr_in_acetic_acid_is_an_acyl_donor(self):
        # 6.6: "In the weaker acetic acid, acylation occurs if the acid is saturated with hydrogen
        # bromide or chloride." The donor is the saturated AcOH, not AcOH alone, and the sentence
        # names chloride too, so HCl/AcOH is the same cell.
        for conditions in ("HBr/AcOH", "HCl/AcOH"):
            with self.subTest(conditions=conditions):
                self.assertIn("ser-hydroxyl", groups_for(SER, conditions))
        self.assertNotIn("ser-hydroxyl", groups_for(SER, "AcOH"))
        self.assertNotIn("ser-hydroxyl", groups_for(SER, "HBr"))
        self.assertIn("ser-hydroxyl", groups_for(SER, "TFA/AcOH"))
        # The donor arm isolated on a molecule with NO peptide bond: the old code fired because
        # AcOH matched the donor, the new code must not. On Ser-Gly the H2SO4 shift arm fires
        # legitimately, so that cell is not a test of acetic acid.
        self.assertNotIn("ser-hydroxyl", groups_for(FREE_SER, "AcOH, conc. H2SO4"))

    def test_a_cation_scavenger_does_NOT_clear_them(self):
        # The negative control for the Tyr cell below. TIS/phenol take a cation; an O-acyl is not a
        # cation, and the remedy is hydrazine on the free peptide. This test used to assert the
        # opposite — the clearance was the October defect.
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                found = groups_for(smiles, "TFA/TIS/H2O 95:2.5:2.5, 2 h")
                self.assertIn(group, found)

    def test_the_remedy_is_hydrazine_on_the_free_peptide(self):
        found = [h for h in hazards([SER], [SER], "TFA/H2O 95:5, 2 h")
                 if h["group"] == "ser-hydroxyl"]
        self.assertTrue(found)
        suggestion = found[0]["suggestion"]
        self.assertIn("hydrazine", suggestion)
        self.assertIn("FREE peptide", suggestion)
        self.assertIn("never on the resin", suggestion)
        self.assertNotIn("cation scavenger", suggestion)
        # And the message names the source a chemist can reason about, not just the group.
        shifted = [h for h in hazards([SER], [SER], "conc. H2SO4")
                   if h["group"] == "ser-hydroxyl"][0]
        self.assertIn("peptide bond", shifted["why"])

    def test_the_english_word_hi_is_not_hydroiodic_acid(self):
        # `_F + "HI" + _E` under re.I matched the word "hi", classified ordinary prose as a strong
        # acid, and reached every strong-acid row. The formula token is case-sensitive now.
        self.assertNotIn("strong-acid", T.classify("the mixture was stirred hi and then filtered"))
        self.assertIn("strong-acid", T.classify("57% HI"))
        self.assertIn("strong-acid", T.classify("HI (aq)"))

    def test_the_mass_signature_is_the_tyr_tbu_adduct(self):
        self.assertEqual(T.MASS_SHIFTS["tyr"]["delta"], 56)

    def test_ser_and_thr_carry_no_mass_shift(self):
        # Two acyl sources, so no single delta: trifluoroacetyl is +96, formyl +28, acetyl +42, and
        # 0 for the mineral-acid arm, which shifts an acyl group off a peptide bond onto the
        # hydroxyl — an N-to-O shift of the same group, so the product is isobaric rather than a
        # different adduct. The figures are arithmetic from the structures the sources name; none
        # is quoted by a source, so none is printed in the table. The hazard still says why and how
        # to strip it; a number here would be false precision, and the old +56 named a tBu cation
        # that is not involved.
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                self.assertIsNone(T.mass_shift(group))
                found = [h for h in hazards([smiles], [smiles], "TFA/H2O 95:5, 2 h")
                         if h["group"] == group]
                self.assertTrue(found)
                self.assertNotIn("massShift", found[0])


FORMIC_MEDIUM = "95% formic acid, 2 h"
FORMIC_FORMYLATION = "formic acid, DIC/HOBt, DMF, 2 h"


class FormicAcidIsItsOwnDonorClass(unittest.TestCase):
    """The acid 6.6 names first, and why it gets a class of its own.

    6.6: "Hydroxyl groups of peptides undergo acylation when the latter are dissolved in strong
    carboxylic acids such as formic and trifluoroacetic acids". `classify('95% formic acid, 2 h')`
    returned `[]`, so that sentence reached no gate. Formic is NOT added to `strong-acid`, because
    that class also carries what an acidolysis does — `boc`, `tbu-ester`, `trityl`, `asp-pro` — and
    none of those rows reads which acid it is. The Boc-Ser cell below is that counterexample, and
    it is the mutation any "just add formic to strong-acid" fix fails.
    """

    def test_a_formic_medium_fires_on_ser_and_thr(self):
        for smiles, group in ((SER, "ser-hydroxyl"), (THR, "thr-hydroxyl")):
            with self.subTest(group=group):
                pairs = {(h["group"], h["reagentClass"])
                         for h in hazards([smiles], [smiles], FORMIC_MEDIUM)}
                self.assertIn((group, "formic-acid"), pairs)

    def test_the_class_is_visible_to_the_reader_and_is_not_strong_acid(self):
        # The artifact shows `reagentClasses`, and a class is the only place a reagent's identity
        # is visible; a bare predicate outside the class loop would leave the reader no reason.
        self.assertIn("formic-acid", T.classify(FORMIC_MEDIUM))
        self.assertNotIn("strong-acid", T.classify(FORMIC_MEDIUM))
        self.assertIn("formic acid", T.label_of("formic-acid"))
        # `formate` is a different species and an acyl donor in nothing this table models; the
        # patterns are the word "formic" and the formula, with the elsewhere-used token boundaries.
        # (`ammonium formate` is a transfer-hydrogenation reagent and already classifies as
        # `hydrogenation`; that is pre-existing and not this class's business.)
        self.assertNotIn("formic-acid", T.classify("ammonium formate, 2 h"))
        self.assertNotIn("formic-acid", T.classify("performic acid, 2 h"))

    def test_a_boc_serine_under_formic_acid_does_not_report_the_carbamate(self):
        # The measured counterexample. `concentrated H2SO4` on the same molecule reports both
        # `boc` and `ser-hydroxyl`; 95% formic is not an acidolysis and must report only the
        # hydroxyl it actually acylates.
        found = {h["group"] for h in hazards([BOC_SER], [BOC_SER], FORMIC_MEDIUM)}
        self.assertIn("ser-hydroxyl", found)
        self.assertNotIn("boc", found)
        self.assertNotIn("tbu-ester", found)

    def test_the_class_carries_the_two_rows_and_no_acidolysis_row(self):
        self.assertEqual({row[0] for row in T.ATTACKS["formic-acid"]},
                         {"ser-hydroxyl", "thr-hydroxyl"})
        self.assertEqual({row[0] for row in T.UNMASKED_RISKS["formic-acid"]},
                         {"ser-hydroxyl", "thr-hydroxyl"})

    def test_the_shared_rows_are_derived_not_retyped(self):
        # The rows' own text already names both acyl sources, so a second copy would be one more
        # string to drift out of step with 6.6. Equality of severity AND why-text is what keeps
        # them one statement.
        for table in ("ATTACKS", "UNMASKED_RISKS"):
            with self.subTest(table=table):
                strong = {g: (s, w) for g, s, w in getattr(T, table)["strong-acid"]
                          if g in ("ser-hydroxyl", "thr-hydroxyl")}
                formic = {g: (s, w) for g, s, w in getattr(T, table)["formic-acid"]}
                self.assertEqual(formic, strong)

    def test_the_generator_formylation_step_does_not_double_report(self):
        # `n-formylation`'s own conditions, reached the way the generator reaches it: a transform
        # id and no conditions prose. The step is BOTH classes, and `acylating` already says the
        # hydroxyl may be acylated with the remedy for that reaction; the acidolysis row would
        # repeat it and attach "keep the acid treatment short" to a DIC/HOBt coupling in DMF.
        out = W._compatibility([{"reactants": [SER], "products": [SER],
                                 "transform": "n-formylation"}])[0]
        pairs = {(h["group"], h["reagentClass"]) for h in out["hazards"]}
        self.assertIn(("alcohol", "acylating"), pairs)
        self.assertNotIn("ser-hydroxyl", {group for group, _cls in pairs})
        # ...and it is the skip that keeps it single, not the class being absent: both classes fire.
        self.assertEqual(set(T.classify(T.conditions_for_transform("n-formylation"))),
                         {"formic-acid", "acylating"})

    def test_the_formylation_skip_is_scoped_to_formic(self):
        # TFA/HOBt is a coupling that happens to be run in TFA — the acid is the medium, not the
        # acyl partner — and the `strong-acid` reading there is unchanged by this unit.
        pairs = {(h["group"], h["reagentClass"]) for h in hazards([SER], [SER], "TFA/HOBt")}
        self.assertIn(("ser-hydroxyl", "strong-acid"), pairs)

    def test_the_donor_arm_needs_no_peptide_bond_and_TFA_already_agrees(self):
        # This unit's brief asked for `free Ser | 95% formic acid` to stay silent "same molecule".
        # It cannot, and the shipped reading is why. The BOND test belongs to the shift arm — 6.6:
        # "the acyl group originates by a shift of the acyl component of a peptide bond to the
        # adjacent hydroxyl group" — while the DONOR arm is the acid dissolving the peptide. The
        # anchor is measured at HEAD: `free Ser | TFA/H2O 95:5` already fires `ser-hydroxyl`.
        # Making formic silent here would be one condition answering differently by spelling.
        self.assertIn("ser-hydroxyl", groups_for(FREE_SER, "TFA/H2O 95:5, 2 h"))
        self.assertIn("ser-hydroxyl", groups_for(FREE_SER, FORMIC_MEDIUM))
        # And the shift arm keeps its bond test, so the two arms are still told apart.
        self.assertNotIn("ser-hydroxyl", groups_for(FREE_SER, "conc. H2SO4"))


class TheSpelledBromideIsTheSameCell(unittest.TestCase):
    """`HBr in AcOH` fired while `hydrogen bromide in acetic acid` did not, one spelling apart.

    The donor predicate and `_MINERAL_ACID` both already read the spelled form; only the
    `strong-acid` pattern list did not, so the cell never reached the gate. 6.6 uses the spelled
    form itself ("removal of benzyl-based protectors by hydrogen bromide in acetic acid").
    """

    def test_hydrogen_bromide_in_acetic_acid_reaches_the_same_finding_as_the_formula(self):
        spelled = hazards([SER], [SER], "hydrogen bromide in acetic acid")
        formula = hazards([SER], [SER], "HBr in AcOH")
        self.assertTrue(spelled)
        self.assertEqual(spelled, formula)

    def test_the_spelled_form_is_read_as_a_strong_acid(self):
        self.assertIn("strong-acid", T.classify("hydrogen bromide in acetic acid"))
        self.assertIn("strong-acid", T.classify("hydrobromic acid in acetic acid"))

    def test_a_bare_spelled_bromide_is_not_a_donor_either(self):
        # 6.6's donor is a strong carboxylic acid, or acetic acid saturated with HBr. Bare HBr gas
        # is neither, and the formula spelling is already silent (`has_acyl_donor_acid("HBr")` is
        # False because HBr is a mineral acid in `_MINERAL_ACID`). The spelled form must agree, or
        # adding it to the class manufactures a flag on a silyl-ether cleavage.
        for conditions in ("HBr", "hydrogen bromide", "hydrobromic acid"):
            with self.subTest(conditions=conditions):
                self.assertIn("strong-acid", T.classify(conditions))
                self.assertNotIn("ser-hydroxyl", groups_for(SER, conditions))


class TyrAlkylationKeepsTheUnguardedReading(unittest.TestCase):
    """The SURVIVOR path still has no source test, and the one that was tried is refuted here.

    These are the statements the acyl split must not disturb: a strong acid with no scavenger
    fires, and a named cation scavenger is what clears it. The third is the refutation — a named
    trityl linker must NOT clear the flag, because a 2-chlorotrityl release puts a trityl cation in
    solution and Chan & White's reactivity order places trityl alongside tert-butyl. If a future
    linker predicate is added, it has to leave this case firing. The PRODUCT-side row added below
    does not touch any of this: it only ever fires on a step that frees the phenol.
    """

    def test_a_strong_acid_with_no_scavenger_fires(self):
        self.assertIn("tyr", groups_for(TYR, "TFA/H2O 95:5, 2 h"))

    def test_a_named_trityl_linker_does_NOT_clear_it(self):
        for conditions in ("TFA/H2O 95:5, 2 h, 2-CTC resin",
                           "1% TFA in DCM, 2-chlorotrityl resin",
                           "TFA/DCM, Barlos resin, 2 x 10 min"):
            with self.subTest(conditions=conditions):
                self.assertIn("tyr", groups_for(TYR, conditions))

    def test_a_cation_scavenger_clears_it(self):
        self.assertNotIn("tyr", groups_for(TYR, "TFA/TIS/H2O 95:2.5:2.5, 2 h"))


class TheTyrProductSideRowIsASourceTest(unittest.TestCase):
    """The step that FREES the phenol speaks; the step that merely meets a free one is unchanged.

    Tyr ring t-butylation is cation-dependent, and the cation is the tert-butyl group this very
    step is removing from the molecule. That is visible in the structure, unlike the linker, so the
    row is guarded on the reactants (`boc`/`tbu-ester`/`tbu-ether`) and on the absence of a cation
    scavenger — the `free-indole` source test narrowed to the groups the `+56` signature names. It
    is still not a linker predicate: every pinned linker string must keep firing, and does.
    """

    def test_the_deprotection_that_frees_tyrosine_carries_the_statement(self):
        found = hazards([TYR_TBU], [TYR], "TFA/H2O 95:5, 2 h")
        tyr = [h for h in found if h["group"] == "tyr"]
        self.assertEqual(len(tyr), 1, f"expected one tyr statement, got {found}")
        self.assertEqual(tyr[0]["reagentClass"], "strong-acid")
        # The message must say what the reaction is, where the cation comes from, and that the
        # damage is not repairable — the three things a chemist needs to act on it.
        self.assertIn("tert-butyl", tyr[0]["why"])
        self.assertIn("cannot be repaired", tyr[0]["why"])
        self.assertIn("scavenger", tyr[0]["suggestion"])

    def test_the_cyclic_last_step_now_speaks_for_all_three_hydroxyls(self):
        # Head-to-tail cyclic Gly-Ser-Tyr-Thr-Ala, step 11: the tBu removal is the LAST statement,
        # so no later step can report these as survivors. Before the row this route said nothing.
        found = {h["group"] for h in hazards([CYCLIC_TBU], [CYCLIC_FREE], "TFA/H2O 95:5, 2 h")}
        self.assertEqual(found & {"ser-hydroxyl", "thr-hydroxyl", "tyr"},
                         {"ser-hydroxyl", "thr-hydroxyl", "tyr"})

    def test_the_ester_and_hydrazide_endgame_last_step_speaks(self):
        # Both endgames reach this same on-resin statement and stop there, so the free phenol has
        # no later strong-acid step to appear in as a survivor.
        found = {h["group"] for h in hazards([ENDGAME_TBU], [ENDGAME_FREE], "TFA/H2O 95:5, 2 h")}
        self.assertIn("tyr", found)

    def test_a_cation_scavenger_clears_the_freeing_step_too(self):
        found = {h["group"] for h in hazards([TYR_TBU], [TYR], "TFA/TIS/H2O 95:2.5:2.5, 2 h")}
        self.assertNotIn("tyr", found)

    def test_a_named_linker_does_NOT_clear_the_freeing_step_either(self):
        # The pin, restated on the product-side row: the guard is a source test, not a linker test.
        for conditions in ("TFA/H2O 95:5, 2 h, 2-CTC resin",
                           "1% TFA in DCM, 2-chlorotrityl resin",
                           "TFA/DCM, Barlos resin, 2 x 10 min"):
            with self.subTest(conditions=conditions):
                found = {h["group"] for h in hazards([TYR_TBU], [TYR], conditions)}
                self.assertIn("tyr", found)

    def test_a_surviving_phenol_is_reported_once_even_with_a_tBu_source_present(self):
        # `seen` must suppress the product-side row when the ATTACKS row already fired this step.
        # The Boc co-reactant makes the new source test pass, so only the shared `seen` set keeps
        # this to one statement.
        tyr = [h for h in hazards([TYR, BOC_ALA], [TYR], "TFA/H2O 95:5, 2 h")
               if h["group"] == "tyr"]
        self.assertEqual(len(tyr), 1, f"expected one tyr statement, got {tyr}")
        self.assertIn("survives into the product", tyr[0]["why"])

    def test_a_tBu_tyrosine_that_this_step_does_NOT_free_is_silent(self):
        # The row is about the phenol being laid BARE. A Tyr(tBu) carried through unchanged has no
        # free phenol in the product and no statement to raise.
        found = {h["group"] for h in hazards([TYR_TBU], [TYR_TBU], "TFA/H2O 95:5, 2 h")}
        self.assertNotIn("tyr", found)


class TrpSilaneReduction(unittest.TestCase):
    def test_tes_reduces_the_indole_and_is_not_reported_as_alkylation(self):
        found = groups_for(TRP, "TFA/TES/H2O 95:2.5:2.5, 2 h")
        self.assertIn("trp-indole-reduction", found)
        self.assertNotIn("free-indole", found)

    def test_tis_is_the_trp_safe_silane(self):
        found = groups_for(TRP, "TFA/TIS/H2O 95:2.5:2.5, 2 h")
        self.assertNotIn("trp-indole-reduction", found)
        self.assertNotIn("free-indole", found)

    def test_the_signature_is_minus_71(self):
        self.assertEqual(T.MASS_SHIFTS["trp-indole-reduction"]["delta"], -71)


class CysAcmThiolInterchange(unittest.TestCase):
    def test_edt_flags_the_acm_side_chain(self):
        self.assertIn("cys-acm", groups_for(CYS_ACM, "TFA/H2O/EDT 95:2.5:2.5, 2 h"))

    def test_plain_tfa_does_not(self):
        self.assertNotIn("cys-acm", groups_for(CYS_ACM, "TFA/H2O 95:5, 2 h"))

    def test_the_signature_is_acm_loss_minus_71(self):
        self.assertEqual(T.MASS_SHIFTS["cys-acm"]["delta"], -71)


if __name__ == "__main__":
    unittest.main()
