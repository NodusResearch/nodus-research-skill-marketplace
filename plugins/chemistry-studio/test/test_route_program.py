"""Tests for the route-program toolkit. Run with the plugin runtime's interpreter:

    <venv>/bin/python3 -I plugins/chemistry-studio/test/test_route_program.py

Every expectation below is a canonical SMILES RDKit actually produced, not one read off a template
by eye: a curated SMARTS that is quietly wrong is the worst outcome this module can have, so each
one is pinned to its product here.

The handle tests are the ones that matter most. A mark is only useful if it survives a long run of
operations that do not touch it, and that is the property most likely to drift quietly, so it is
tested at depth rather than over one step.

The reversal of an index retro template is only exercised when ROUTE_PROGRAM_TEST_INDEX names a
directory holding one, because an index is local data that never ships with the repository.
"""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

from rdkit import Chem

import reactions_worker
import route_program


def apply(**payload):
    return route_program.handle({"op": "apply", **payload})


def named(transform_id, molecule, reagents=(), **extra):
    return apply(molecule=molecule, operation={"kind": "named", "id": transform_id},
                 reagents=list(reagents), **extra)


# One substrate and the whole expected answer per curated transformation.
CURATED = {
    "ester-hydrolysis": ("CCOC(=O)c1ccccc1", [], "O=C(O)c1ccccc1", ["CCO"]),
    "ester-formation": ("OC(=O)c1ccccc1", ["CCO"], "CCOC(=O)c1ccccc1", ["O"]),
    "amide-formation": ("OC(=O)c1ccccc1", ["CNC"], "CN(C)C(=O)c1ccccc1", ["O"]),
    "amide-hydrolysis": ("CNC(=O)c1ccccc1", [], "O=C(O)c1ccccc1", ["CN"]),
    "n-acylation": ("Nc1ccccc1", ["CC(=O)Cl"], "CC(=O)Nc1ccccc1", ["Cl"]),
    "ketone-reduction": ("CC(=O)c1ccccc1", [], "CC(O)c1ccccc1", []),
    "aldehyde-reduction": ("O=Cc1ccccc1", [], "OCc1ccccc1", []),
    "secondary-alcohol-oxidation": ("CC(O)c1ccccc1", [], "CC(=O)c1ccccc1", []),
    "primary-alcohol-oxidation": ("OCc1ccccc1", [], "O=Cc1ccccc1", []),
    "aldehyde-oxidation": ("O=Cc1ccccc1", [], "O=C(O)c1ccccc1", []),
    # Two waters, because the oxygens have to go somewhere. Until 2026-10-14 this read `[]`
    # and the entry supplied no hydrogen, so the equation was short by 3 H2 and 2 O and could
    # never balance — every reduction in the curated set had the same fault, which meant a
    # route program using one always failed the audit.
    "nitro-reduction": ("O=[N+]([O-])c1ccccc1", [], "Nc1ccccc1", ["O", "O"]),
    "nitrile-hydrolysis": ("N#Cc1ccccc1", [], "O=C(O)c1ccccc1", ["N"]),
    "alkene-hydrogenation": ("C=Cc1ccccc1", [], "CCc1ccccc1", []),
    "halide-amination": ("BrCc1ccccc1", ["CNC"], "CN(C)Cc1ccccc1", ["Br"]),
    "phenol-alkylation": ("Oc1ccccc1", ["CI"], "COc1ccccc1", ["I"]),
    "acid-to-acyl-chloride": ("OC(=O)c1ccccc1", [], "O=C(Cl)c1ccccc1", []),
    # Protecting-group chemistry, added 2026-10-14. Until then the curated set held no
    # deprotection at all, so a peptide program had to reach for `amide-hydrolysis` with a
    # descriptive site phrase and died on the vocabulary: measured on chainP-2 and chainP-4,
    # both well-formed programs, both unbuildable. `n-carbamoylation` is here for the same
    # reason from the other side — `n-acylation` wants an acyl chloride and rejects benzyl
    # chloroformate, which is the standard way to put a Cbz on, so protection was unsayable too.
    #
    # Each of the five removals declares `carries: 1`, the map number that rides on the chain.
    # Size cannot stand in for it: Boc leaves isobutylene at 4 heavy atoms, which is smaller
    # than alanine's 6, while Fmoc leaves dibenzofulvene at 14 and Cbz leaves toluene at 7,
    # which are larger. A largest-fragment rule gets two of these three backwards, and the
    # default most-inherited-atoms rule returns the carbon dioxide.
    "fmoc-removal": ("C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O", [], "C[C@H](N)C(=O)O",
                     ["C=C1c2ccccc2-c2ccccc21", "O=C=O"]),
    "boc-removal": ("C[C@H](NC(=O)OC(C)(C)C)C(=O)O", [], "C[C@H](N)C(=O)O", ["C=C(C)C", "O=C=O"]),
    "cbz-removal": ("C[C@H](NC(=O)OCc1ccccc1)C(=O)O", [], "C[C@H](N)C(=O)O", ["Cc1ccccc1", "O=C=O"]),
    "benzyl-ester-hydrogenolysis": ("C[C@H](N)C(=O)OCc1ccccc1", [], "C[C@H](N)C(=O)O", ["Cc1ccccc1"]),
    "tert-butyl-ester-removal": ("C[C@H](N)C(=O)OC(C)(C)C", [], "C[C@H](N)C(=O)O", ["C=C(C)C"]),
    # The hindered twin of the above, added 2026-10-15 so the aspartimide advice in compat_tables
    # names a side-chain ester the toolkit can actually carry. Its own rule rather than a widened
    # tert-butyl one: the two site phrases must stay disjoint, or a program that asks for the
    # bulky ester would silently strip a tert-butyl one instead.
    "mpe-ester-removal": ("C[C@H](N)C(=O)OC(C)(CC)CC", [], "C[C@H](N)C(=O)O", ["C=C(CC)CC"]),
    "n-carbamoylation": ("C[C@H](N)C(=O)O", ["ClC(=O)OCc1ccccc1"],
                         "C[C@H](NC(=O)OCc1ccccc1)C(=O)O", ["Cl"]),
    # Peptide coupling in the C-to-N direction, added 2026-10-14. `amide-formation` carries the
    # ACID, and a curated verb can only occupy reactant slot 0 (see the `flexible` test below), so
    # a growing chain whose free end is the AMINE had no verb at all — which is the direction
    # solid-phase synthesis actually runs. Measured on chainP-6: a correct Fmoc hexapeptide died at
    # line 3 because the carried benzyl ester has no free carboxyl for `amide-formation` to use.
    "n-peptide-coupling": ("Nc1ccccc1", ["OC(=O)c1ccccc1"], "O=C(Nc1ccccc1)c1ccccc1", ["O"]),
    # The SPPS endgame, added 2026-10-15. Until these existed a program could assemble a fully
    # protected chain on the support and had no way to finish it: no side-chain removal for trityl,
    # tert-butyl ether or Pbf, and no cleavage from the support at all. Each releases what the acid
    # actually carries away, so the equation balances: triphenylmethanol from a trityl, isobutylene
    # from a tert-butyl ether, the sulfonic acid from Pbf.
    #
    # Trityl is three rules rather than one because the freed atom differs: a thiol and an
    # aliphatic nitrogen let the toolkit recount their hydrogens, but an imidazole ring nitrogen
    # must be written [nH:1] or the product cannot be kekulised. `trityl-removal` is the family
    # that picks between them, and it is in FAMILIES below.
    "s-trityl-removal": ("N[C@@H](CSC(c1ccccc1)(c1ccccc1)c1ccccc1)C(=O)O", ["O"], "N[C@@H](CS)C(=O)O",
                         ["OC(c1ccccc1)(c1ccccc1)c1ccccc1"]),
    "n-trityl-removal": ("O=C(NC(c1ccccc1)(c1ccccc1)c1ccccc1)C[C@H](N)C(=O)O", ["O"],
                         "NC(=O)C[C@H](N)C(=O)O", ["OC(c1ccccc1)(c1ccccc1)c1ccccc1"]),
    "imidazole-trityl-removal": ("N[C@@H](Cc1cn(C(c2ccccc2)(c2ccccc2)c2ccccc2)cn1)C(=O)O", ["O"],
                                 "N[C@@H](Cc1c[nH]cn1)C(=O)O", ["OC(c1ccccc1)(c1ccccc1)c1ccccc1"]),
    "tert-butyl-ether-removal": ("N[C@@H](COC(C)(C)C)C(=O)O", [], "N[C@@H](CO)C(=O)O", ["C=C(C)C"]),
    "pbf-removal": ("N[C@@H](CCCN=C(N)NS(=O)(=O)c1c(C)c(C)c2c(c1C)CC(C)(C)O2)C(=O)O", ["O"],
                    "NC(N)=NCCC[C@H](N)C(=O)O", ["Cc1c(C)c(S(=O)(=O)O)c(C)c2c1OC(C)(C)C2"]),
    # The chain is the PEPTIDE, not the support. This entry asserted the reverse until 2026-10-15,
    # and the suite passed the whole time: `carries` was 1, which is `[#0:1]`, the resin dummy atom,
    # so the last step of every solid-phase route handed back `*O` and returned the peptide as a
    # co-product. Caught by assembling a hexapeptide from non-natural blocks and reading what came
    # out of the cleavage. `carries` is now 2, the ester oxygen that stays with the acid.
    "resin-cleavage": ("*OC(=O)[C@@H](C)N", ["O"], "C[C@@H](N)C(=O)O", ["*O"]),
}

# One substrate and the whole expected answer per curated closure: two sites on one molecule.
CLOSURES = ("disulfide-closure", "bis-halomethyl-bridge", "head-to-tail-macrolactamisation")

# A family verb names the intent and dispatches to the member that fits the molecule, so it has no
# SMARTS, no single site, and no one product to claim -- the member it picks has all three. Listed
# apart from CURATED for exactly that reason; FamilyVerbs below covers what it does instead.
FAMILIES = ("n-deprotect", "trityl-removal")

KETONE_REDUCTION_SMARTS = "[#6:1][C:2](=[O:3])[#6:4]>>[#6:1][CH1:2]([OH:3])[#6:4]"
HYDROGENATION_SMARTS = "[CX3:1]=[CX3:2]>>[C:1][C:2]"


class CuratedSet(unittest.TestCase):
    def test_every_curated_transformation_is_listed_with_a_site(self):
        listed = route_program.handle({"op": "transforms"})
        self.assertTrue(listed["ok"])
        ids = [t["id"] for t in listed["transforms"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), set(CURATED) | set(CLOSURES) | set(FAMILIES))
        for entry in listed["transforms"]:
            self.assertEqual(sorted(entry), ["id", "site", "siteSlots", "summary"])
            self.assertTrue(entry["summary"].endswith("."), entry)
            if entry["id"] in FAMILIES:
                # It declares no site: which group it acts on depends on the molecule in hand.
                self.assertIsNone(entry["site"])
                self.assertEqual(entry["siteSlots"], [])
                self.assertTrue(route_program._tables()["byId"][entry["id"]]["family"])
            elif entry["id"] in CLOSURES:
                # A closure declares the two sites it joins and no single site of its own.
                self.assertIsNone(entry["site"])
                self.assertEqual(len(entry["siteSlots"]), 2)
                for phrase in entry["siteSlots"]:
                    self.assertIn(phrase, route_program._tables()["sites"])
            else:
                self.assertEqual(entry["siteSlots"], [])
                self.assertIn(entry["site"], route_program._tables()["sites"])

    def test_every_curated_transformation_gives_the_product_it_claims(self):
        for transform_id, (molecule, reagents, product, co_products) in sorted(CURATED.items()):
            with self.subTest(transform_id):
                out = named(transform_id, molecule, reagents)
                self.assertTrue(out.get("ok"), out)
                self.assertEqual(out["product"], product)
                self.assertEqual(out["coProducts"], co_products)
                self.assertEqual(out["site"]["phrase"], route_program._tables()["byId"][transform_id]["site"])
                self.assertTrue(out["site"]["atoms"])

    def test_the_formula_is_the_main_product_s(self):
        self.assertEqual(named("nitro-reduction", "O=[N+]([O-])c1ccccc1")["formula"], "C6H7N")
        self.assertEqual(named("ester-hydrolysis", "CCOC(=O)c1ccccc1")["formula"], "C7H6O2")

    def test_a_co_product_is_returned_apart_from_the_carried_one(self):
        # The acyl part is the smaller fragment here, so a largest-fragment rule would hand back the
        # alcohol: what is carried is the fragment made of the atoms that came in.
        out = named("ester-hydrolysis", "CC(=O)OCCCCCCCCCCCC")
        self.assertEqual(out["product"], "CC(=O)O")
        self.assertEqual(out["coProducts"], ["CCCCCCCCCCCCO"])

    def test_a_routine_reagent_need_not_be_named_and_a_substantive_one_must_be(self):
        self.assertTrue(named("ester-hydrolysis", "CCOC(=O)c1ccccc1").get("ok"))
        self.assertTrue(named("ester-hydrolysis", "CCOC(=O)c1ccccc1", ["O"]).get("ok"))
        missing = named("ester-formation", "OC(=O)c1ccccc1")
        self.assertEqual(missing["error"], "no-match")
        self.assertIn("alcohol", missing["message"])


class ProtectingGroups(unittest.TestCase):
    """Which fragment continues the route when a step cuts the molecule in two.

    The toolkit cannot read this off the chemistry: both sides of an ester hydrolysis are made of
    the atoms that went in, and the route is the only thing that knows which one it is following.
    So a curated transformation that cleaves declares the map number riding on the chain
    (`carries`), and a caller may override with `carry`. Everything here is a case where getting it
    wrong is silent — the step succeeds, the wrong molecule goes forward, and the route fails
    several lines later on something that is not the mistake."""

    FMOC_LYS_BOC = "O=C(O)[C@H](CCCCNC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21"

    def test_a_deprotection_carries_the_chain_and_not_the_protecting_group(self):
        # The point of `carries`. Without it the default rule hands back carbon dioxide, which has
        # the most template-named atoms of any fragment here.
        for transform_id, substrate in (
            ("fmoc-removal", "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"),
            ("boc-removal", "C[C@H](NC(=O)OC(C)(C)C)C(=O)O"),
            ("cbz-removal", "C[C@H](NC(=O)OCc1ccccc1)C(=O)O"),
        ):
            with self.subTest(transform_id):
                out = named(transform_id, substrate)
                self.assertTrue(out.get("ok"), out)
                self.assertEqual(out["product"], "C[C@H](N)C(=O)O")
                self.assertIn("O=C=O", out["coProducts"])

    def test_size_would_get_fmoc_and_cbz_backwards(self):
        # Why `carries` is a declaration and not a heuristic. Dibenzofulvene (14 heavy atoms) and
        # toluene (7) are both bigger than alanine (6); isobutylene (4) is smaller. Any rule that
        # reads size alone is wrong for two of these three.
        for transform_id, substrate, byproduct in (
            ("fmoc-removal", "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O", "C=C1c2ccccc2-c2ccccc21"),
            ("cbz-removal", "C[C@H](NC(=O)OCc1ccccc1)C(=O)O", "Cc1ccccc1"),
        ):
            with self.subTest(transform_id):
                out = named(transform_id, substrate)
                self.assertIn(byproduct, out["coProducts"])
                biggest = named(transform_id, substrate, carry="largest")
                self.assertEqual(biggest["product"], byproduct)

    def test_each_protecting_group_is_removed_without_touching_the_other(self):
        # Fmoc-Lys(Boc)-OH holds two carbamates. This is the selectivity a peptide route needs and
        # the reason the site vocabulary gained the precise phrases: `carbamate` cannot choose.
        fmoc_off = named("fmoc-removal", self.FMOC_LYS_BOC)
        self.assertEqual(fmoc_off["product"], "CC(C)(C)OC(=O)NCCCC[C@H](N)C(=O)O")
        boc_off = named("boc-removal", self.FMOC_LYS_BOC)
        self.assertEqual(boc_off["product"], "NCCCC[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O")
        loose = named("fmoc-removal", self.FMOC_LYS_BOC, site="carbamate")
        self.assertEqual(loose["error"], "ambiguous-site")

    def test_the_stereocentre_survives_a_deprotection(self):
        # The alpha carbon is untouched by every one of these, so an inverted product would mean
        # the SMARTS is reordering branches around it.
        for transform_id, substrate in (
            ("fmoc-removal", "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O"),
            ("boc-removal", "C[C@H](NC(=O)OC(C)(C)C)C(=O)O"),
            ("tert-butyl-ester-removal", "C[C@H](N)C(=O)OC(C)(C)C"),
        ):
            with self.subTest(transform_id):
                self.assertEqual(named(transform_id, substrate)["product"], "C[C@H](N)C(=O)O")

    def test_carry_names_a_fragment_outright(self):
        # TFA-Gly-OMe, one amide, so the site is unambiguous and only the fragment choice is in
        # question. `amide-hydrolysis` declares no `carries`: either side of an amide can be the
        # chain, which is exactly when the caller has to say.
        tfa_gly_ome, peptide, tfa = "COC(=O)CNC(=O)C(F)(F)F", "COC(=O)CN", "O=C(O)C(F)(F)F"
        default = named("amide-hydrolysis", tfa_gly_ome, site="amide")
        self.assertEqual(default["product"], tfa)
        # And `largest` is no help here either: trifluoroacetic acid has 7 heavy atoms against the
        # glycine ester's 6. Naming the fragment is the only reliable way to say it.
        self.assertEqual(named("amide-hydrolysis", tfa_gly_ome, site="amide",
                               carry="largest")["product"], tfa)
        out = named("amide-hydrolysis", tfa_gly_ome, site="amide", carry=peptide)
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"], peptide)
        self.assertEqual(out["coProducts"], [tfa])

    def test_a_carry_the_step_cannot_form_is_an_error_and_lists_what_it_does_form(self):
        # The value of saying it outright: a line that misunderstands its own reaction is caught
        # here rather than three steps downstream.
        out = named("boc-removal", "C[C@H](NC(=O)OC(C)(C)C)C(=O)O", carry="c1ccccc1")
        self.assertEqual(out["error"], "no-match")
        self.assertIn("C[C@H](N)C(=O)O", out["message"])
        self.assertEqual(named("boc-removal", "C[C@H](NC(=O)OC(C)(C)C)C(=O)O",
                               carry={"kind": "banana"})["error"], "unparsable")

    def test_protection_accepts_a_chloroformate(self):
        # The chainP-4 block: Cbz-Cl is a chloroformate, so `n-acylation` rejects it.
        self.assertEqual(named("n-acylation", "C[C@H](N)C(=O)O", ["ClC(=O)OCc1ccccc1"])["error"],
                         "no-match")
        out = named("n-carbamoylation", "C[C@H](N)C(=O)O", ["ClC(=O)OCc1ccccc1"])
        self.assertEqual(out["product"], "C[C@H](NC(=O)OCc1ccccc1)C(=O)O")

    def test_a_dipeptide_route_runs_end_to_end(self):
        # chainP-2's target, which program mode could not build at all before this.
        coupled = named("amide-formation", "CC(C)(C)OC(=O)NCC(=O)O", ["COC(=O)[C@H](C)N"])
        self.assertEqual(coupled["product"], "COC(=O)[C@H](C)NC(=O)CNC(=O)OC(C)(C)C")
        freed = named("boc-removal", coupled["product"])
        self.assertEqual(freed["product"], "COC(=O)[C@H](C)NC(=O)CN")


class WhichVerbsApply(unittest.TestCase):
    """Step two of the three-part recipe: name the class, CHECK IT AGAINST THE LIBRARY, implement.

    Steps one and three were already here — `named=` is the class and the engine derives the
    product, so a mass-balance error is impossible by construction — and nothing checked the
    middle. A verb that cannot act on the carried molecule was discovered only by failing, and the
    refusal named what was missing rather than what would have worked.

    Measured 2026-10-14 on chainP-6: a correct Fmoc solution-phase hexapeptide, five `fmoc-removal`
    steps and a final hydrogenolysis, died at line 3 on `amide-formation` applied to a benzyl ester.
    The message said "The carried molecule has no carboxylic acid", which is true and useless: the
    chain was the amine, and the verb for that direction is `n-peptide-coupling`."""

    PHE_OBN = "O=C(OCc1ccccc1)[C@H](Cc1ccccc1)N"   # H-Phe-OBn: free amine, carboxyl esterified
    FMOC_LEU = "O=C(OCC1c2ccccc2-c2ccccc21)N[C@@H](CC(C)C)C(=O)O"

    def test_a_wrong_verb_is_told_which_verb_does_apply(self):
        out = named("amide-formation", self.PHE_OBN, [self.FMOC_LEU])
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("no carboxylic acid", out["message"])
        self.assertIn("n-peptide-coupling", out["message"])

    def test_the_verb_it_names_actually_works(self):
        # The point of naming it: following the advice has to succeed, or the advice is the
        # chainL-3 pattern — correct, and pointing at something the reader cannot do.
        out = named("n-peptide-coupling", self.PHE_OBN, [self.FMOC_LEU])
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"],
                         "CC(C)C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N[C@@H](Cc1ccccc1)C(=O)OCc1ccccc1")
        self.assertEqual(out["coProducts"], ["O"])
        # Both centres stay L, and the product writes them with OPPOSITE tags — `[C@H]` for the
        # leucine, `[C@@H]` for the phenylalanine — because the atom order differs. That is why the
        # configuration is asserted with a CIP labeller and never by comparing the @/@@ tag.
        from rdkit import Chem
        from rdkit.Chem import rdCIPLabeler
        mol = Chem.MolFromSmiles(out["product"])
        rdCIPLabeler.AssignCIPLabels(mol)
        labels = sorted(a.GetPropsAsDict()["_CIPCode"] for a in mol.GetAtoms() if a.HasProp("_CIPCode"))
        self.assertEqual(labels, ["S", "S"], "both amino acids must remain L through the coupling")

    def test_the_two_coupling_directions_are_separate_verbs(self):
        # A curated verb only ever occupies reactant slot 0, so the carried molecule decides which
        # verb applies. Carrying the acid is amide-formation; carrying the amine is the new one.
        acid, amine = "CC(C)(C)OC(=O)NCC(=O)O", "COC(=O)[C@H](C)N"
        self.assertTrue(named("amide-formation", acid, [amine]).get("ok"))
        self.assertEqual(named("n-peptide-coupling", acid, [amine])["error"], "absent-site")
        self.assertTrue(named("n-peptide-coupling", amine, [acid]).get("ok"))
        self.assertEqual(named("amide-formation", amine, [acid])["error"], "absent-site")

    def test_nothing_is_offered_when_nothing_applies(self):
        # Methane with no reagents: the clause is absent rather than empty, so a failure stays one
        # sentence when there is no help to give.
        out = named("amide-formation", "C")
        self.assertNotIn("DO apply", out["message"])

    def test_the_advice_respects_the_reagents_actually_given(self):
        # A verb is only offered when it fires with what the line has. Without the acid partner,
        # n-peptide-coupling cannot run, so it must not be suggested.
        out = named("amide-formation", self.PHE_OBN)
        self.assertNotIn("n-peptide-coupling", out.get("message", ""))


class SiteResolution(unittest.TestCase):
    def test_exactly_one_match_is_applied_and_its_atoms_reported(self):
        out = named("ketone-reduction", "CCCC(=O)C")
        self.assertEqual(out["product"], "CCCC(C)O")
        self.assertEqual(out["site"], {"phrase": "ketone", "atoms": [2, 3, 4, 5]})

    def test_no_match_at_all_is_absent_site(self):
        out = named("ketone-reduction", "CCOC(=O)c1ccccc1")
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("no ketone", out["message"])

    def test_several_matches_are_ambiguous_and_never_guessed(self):
        out = named("ester-hydrolysis", "CCOC(=O)c1ccc(C(=O)OCC)cc1")
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("2 places", out["message"])

    def test_a_symmetric_group_is_one_place_not_several(self):
        out = named("ketone-reduction", "CC(C)=O")
        self.assertEqual(out["product"], "CC(C)O")

    def test_a_caller_s_phrase_overrides_the_transformation_s_own(self):
        # Two esters, so the declared phrase cannot discriminate; a narrower phrase can.
        both = named("ester-hydrolysis", "CCOC(=O)COC(C)=O")
        self.assertEqual(both["error"], "ambiguous-site")
        narrowed = named("ester-hydrolysis", "CCOC(=O)COC(C)=O", site={"kind": "phrase", "phrase": "ether"})
        self.assertEqual(narrowed["error"], "absent-site")

    def test_a_bare_string_site_is_still_read_as_a_phrase(self):
        # The shape the first adapter sent, kept working so the two sides can land independently.
        out = named("ester-hydrolysis", "CCOC(=O)COC(C)=O", site="ether")
        self.assertEqual(out["error"], "absent-site")

    def test_a_site_that_resolves_but_cannot_react_is_no_match_not_a_guess(self):
        # "alkyl halide" covers C-F; the displacement does not, so the site resolves and the
        # transformation then declines rather than inventing a product.
        out = named("halide-amination", "FCc1ccccc1", ["CNC"])
        self.assertEqual(out["error"], "no-match")
        self.assertIn("alkyl halide", out["message"])

    def test_a_phrase_outside_the_vocabulary_is_an_unresolved_name(self):
        out = named("ketone-reduction", "CC(=O)C", site={"kind": "phrase", "phrase": "unicorn group"})
        self.assertEqual(out["error"], "unresolved-name")
        self.assertIn("unicorn group", out["message"])

    def test_an_operation_with_no_site_and_several_places_is_ambiguous(self):
        # Not a symmetric diketone: reducing either carbonyl of one of those gives the same
        # molecule, which is one place, not two.
        out = apply(molecule="CC(=O)CCCC(=O)CC",
                    operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("no site was named", out["message"])

    def test_an_operation_with_no_site_and_one_place_is_fine(self):
        out = apply(molecule="CC(=O)c1ccccc1",
                    operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["product"], "CC(O)c1ccccc1")
        self.assertNotIn("site", out)


class Errors(unittest.TestCase):
    def test_an_unknown_curated_id_is_an_unresolved_name(self):
        out = named("no-such-transformation", "CC(=O)C")
        self.assertEqual(out["error"], "unresolved-name")

    def test_a_transformation_that_does_not_apply_is_no_match(self):
        out = apply(molecule="c1ccccc1", operation={"kind": "smarts", "smarts": KETONE_REDUCTION_SMARTS})
        self.assertEqual(out["error"], "no-match")

    def test_unreadable_input_is_unparsable(self):
        self.assertEqual(named("ketone-reduction", "not a smiles")["error"], "unparsable")
        self.assertEqual(apply(operation={"kind": "named", "id": "ketone-reduction"})["error"], "unparsable")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "smarts", "smarts": "nonsense"})["error"], "unparsable")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "wishful", "id": "x"})["error"], "unparsable")
        self.assertEqual(route_program.handle({"op": "levitate"})["error"], "unparsable")
        self.assertEqual(route_program.handle("not an object")["error"], "unparsable")
        self.assertEqual(named("ester-formation", "OC(=O)c1ccccc1", ["not a smiles"])["error"], "unparsable")

    def test_a_template_that_is_not_in_the_index_is_unknown(self):
        with tempfile.TemporaryDirectory() as empty:
            out = apply(molecule="CC(=O)C", operation={"kind": "template", "id": "whatever", "indexDir": empty})
            self.assertEqual(out["error"], "unknown-template")
        out = apply(molecule="CC(=O)C", operation={"kind": "template", "id": "whatever",
                                                   "indexDir": os.path.join(HERE, "no-such-index")})
        self.assertEqual(out["error"], "unknown-template")
        self.assertEqual(apply(molecule="CC(=O)C", operation={"kind": "template"})["error"], "unknown-template")

    def test_a_budget_too_small_to_answer_in_is_reported_rather_than_overrun(self):
        polyene = "C=C" + "CC=C" * 40
        out = apply(molecule=polyene, operation={"kind": "smarts", "smarts": HYDROGENATION_SMARTS},
                    budgetSeconds=0.001)
        self.assertEqual(out["error"], "budget", out)

    def test_a_generous_budget_is_clamped_rather_than_honoured(self):
        out = apply(molecule="CC(=O)c1ccccc1", operation={"kind": "named", "id": "ketone-reduction"},
                    budgetSeconds=10_000)
        self.assertTrue(out.get("ok"), out)


class Describe(unittest.TestCase):
    def test_describe_reports_the_formula_and_only_the_sites_that_are_present(self):
        out = route_program.handle({"op": "describe", "molecule": "CCOC(=O)c1ccc(O)cc1"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["formula"], "C9H10O3")
        self.assertIn("ester", out["sites"])
        self.assertIn("phenol", out["sites"])
        self.assertNotIn("ketone", out["sites"])
        self.assertNotIn("nitro group", out["sites"])
        self.assertTrue(out["summary"].startswith("C9H10O3, 12 heavy atoms;"), out["summary"])

    def test_describe_says_when_a_phrase_cannot_discriminate(self):
        out = route_program.handle({"op": "describe", "molecule": "CCOC(=O)c1ccc(C(=O)OCC)cc1"})
        self.assertIn("ester (2)", out["summary"])

    def test_describe_of_a_molecule_with_nothing_named_says_so(self):
        out = route_program.handle({"op": "describe", "molecule": "C1CCCCC1"})
        self.assertEqual(out["sites"], [])
        self.assertIn("no named site present", out["summary"])

    def test_describe_needs_a_readable_molecule(self):
        self.assertEqual(route_program.handle({"op": "describe", "molecule": "???"})["error"], "unparsable")


class Dispatch(unittest.TestCase):
    def test_the_worker_dispatches_the_request_key_and_wraps_the_answer(self):
        out = reactions_worker.handle({"routeProgram": {"op": "apply", "molecule": "CC(=O)c1ccccc1",
                                                        "operation": {"kind": "named", "id": "ketone-reduction"}}})
        self.assertEqual(list(out), ["routeProgram"])
        self.assertEqual(out["routeProgram"]["product"], "CC(O)c1ccccc1")

    def test_the_worker_needs_no_index_for_a_route_program_request(self):
        out = reactions_worker.handle({"routeProgram": {"op": "transforms"}})
        self.assertTrue(out["routeProgram"]["ok"])


class Closures(unittest.TestCase):
    """Two-site transformations: joining two places on ONE carried molecule.

    The substrates are plain small molecules carrying two or three thiols. Ring sizes are asserted
    because a small closure and a large macrocycle are different propositions and the number is the
    only thing that tells them apart; nothing in the toolkit gates on it."""

    # Three arms of different length off one carbon, so each pair closes a different ring.
    TRI = "SCCCC(CCS)CCCCS"
    ARM_1_2 = "[SH:901]CCCC(CC[SH:902])CCCCS"
    ARM_1_3 = "[SH:901]CCCC(CCS)CCCC[SH:902]"
    ARM_2_3 = "SCCCC(CC[SH:901])CCCC[SH:902]"
    PAIR = [{"kind": "handle", "mark": 901}, {"kind": "handle", "mark": 902}]

    def test_the_disulfide_closure_shuts_a_ring_on_a_molecule_with_two_thiols(self):
        out = named("disulfide-closure", "SCCCCCCS")
        self.assertEqual(out["product"], "C1CCCSSCC1")
        # Iodine is the oxidant the entry names, so the byproduct is two of hydrogen iodide and the
        # equation balances as written.
        self.assertEqual(out["coProducts"], ["I", "I"])
        self.assertEqual(out["ring"], {"size": 8, "bridgeAtoms": 0})
        self.assertEqual(out["formula"], "C6H12S2")

    def test_the_bridge_ring_size_follows_the_isomer_of_the_reagent(self):
        spans = {
            "BrCc1ccccc1CBr": ("c1ccc2c(c1)CSCCCCCCSC2", 12, 4),
            "BrCc1cccc(CBr)c1": ("c1cc2cc(c1)CSCCCCCCSC2", 13, 5),
            "BrCc1ccc(CBr)cc1": ("c1cc2ccc1CSCCCCCCSC2", 14, 6),
        }
        for reagent, (product, size, bridge) in spans.items():
            with self.subTest(reagent):
                out = named("bis-halomethyl-bridge", "SCCCCCCS", [reagent])
                self.assertEqual(out["product"], product)
                self.assertEqual(out["coProducts"], ["Br", "Br"])
                self.assertEqual(out["ring"], {"size": size, "bridgeAtoms": bridge})
        # The three spans really are three different rings, not one answer three times.
        self.assertEqual(len({p for p, _size, _bridge in spans.values()}), 3)

    def test_three_thiols_need_two_marks_and_the_marks_pick_which_two_are_joined(self):
        closures = {self.ARM_1_2: ("SCCCCC1CCCSSCC1", 8),
                    self.ARM_1_3: ("SCCC1CCCCSSCCC1", 10),
                    self.ARM_2_3: ("SCCCC1CCCCSSCC1", 9)}
        self.assertEqual(len({product for product, _size in closures.values()}), 3)
        for handle, (product, size) in closures.items():
            with self.subTest(handle):
                out = apply(moleculeHandle=handle, operation={"kind": "named", "id": "disulfide-closure"},
                            sites=self.PAIR)
                self.assertEqual(out["product"], product)
                self.assertEqual(out["ring"]["size"], size)
                # Not either of the other two closures the same molecule could have made.
                for other, _other_size in closures.values():
                    if other != product:
                        self.assertNotEqual(out["product"], other)

    def test_the_bridge_too_joins_only_the_two_marked_thiols(self):
        closures = {self.ARM_1_2: ("SCCCCC1CCCSCc2ccc(cc2)CSCC1", 14),
                    self.ARM_1_3: ("SCCC1CCCCSCc2ccc(cc2)CSCCC1", 16),
                    self.ARM_2_3: ("SCCCC1CCCCSCc2ccc(cc2)CSCC1", 15)}
        self.assertEqual(len({product for product, _size in closures.values()}), 3)
        for handle, (product, size) in closures.items():
            with self.subTest(handle):
                out = apply(moleculeHandle=handle, operation={"kind": "named", "id": "bis-halomethyl-bridge"},
                            reagents=["BrCc1ccc(CBr)cc1"], sites=self.PAIR)
                self.assertEqual(out["product"], product)
                self.assertEqual(out["ring"], {"size": size, "bridgeAtoms": 6})
                self.assertEqual(out["coProducts"], ["Br", "Br"])

    def test_a_closure_with_no_sites_named_is_ambiguous_when_several_pairs_could_shut(self):
        out = named("disulfide-closure", self.TRI)
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("3 places", out["message"])

    def test_naming_one_of_two_sites_is_refused(self):
        out = apply(moleculeHandle=self.ARM_1_2, operation={"kind": "named", "id": "disulfide-closure"},
                    sites=[{"kind": "handle", "mark": 901}])
        self.assertEqual(out["error"], "unparsable")
        self.assertIn("joins 2 sites and 1 was named", out["message"])

    def test_a_one_site_transformation_still_refuses_two_sites(self):
        out = named("ketone-reduction", "CC(=O)c1ccccc1",
                    site=[{"kind": "phrase", "phrase": "ketone"}, {"kind": "handle", "mark": 901}])
        self.assertEqual(out["error"], "unparsable")
        self.assertIn("one site per operation", out["message"])

    def test_a_mark_that_no_longer_exists_is_an_absent_site(self):
        out = apply(moleculeHandle=self.ARM_1_2, operation={"kind": "named", "id": "disulfide-closure"},
                    sites=[{"kind": "handle", "mark": 901}, {"kind": "handle", "mark": 907}])
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("907", out["message"])

    def test_a_mark_on_the_wrong_group_is_refused_before_anything_runs(self):
        out = apply(moleculeHandle="[CH3:901]C(=O)CCCS",
                    operation={"kind": "named", "id": "disulfide-closure"},
                    sites=[{"kind": "handle", "mark": 901}, {"kind": "phrase", "phrase": "thiol"}])
        self.assertEqual(out["error"], "no-match")
        self.assertIn("two thiol sites", out["message"])

    def test_a_closure_needs_its_reagent(self):
        out = named("bis-halomethyl-bridge", "SCCCCCCS")
        self.assertEqual(out["error"], "no-match")
        self.assertIn("bis(halomethyl)arene", out["message"])

    def test_the_closure_marks_the_new_bond_and_the_bridge_and_takes_the_site_marks(self):
        out = apply(moleculeHandle=self.ARM_1_2, operation={"kind": "named", "id": "bis-halomethyl-bridge"},
                    reagents=["BrCc1ccc(CBr)cc1"], sites=self.PAIR, markAs=903)
        self.assertEqual(out["product"], "SCCCCC1CCCSCc2ccc(cc2)CSCC1")
        # 903 covers the two new bonds and the arene it bridged with, so it takes the two site
        # marks with it: they marked exactly the atoms the closure acted on.
        self.assertEqual(out["marks"], [903])
        # The two new bonds and the bridge: both sulfurs, both new CH2 and the four arene carbons
        # the ring runs through. NOT the carried molecule's own stretch of the ring — marking that
        # would put the mark over half the molecule and take every other mark with it.
        self.assertEqual(out["productHandle"].count(":903]"), 8)
        self.assertLess(8, out["ring"]["size"])
        self.assertNotIn(":", out["product"])
        self.assertNotIn(":", "".join(out["coProducts"]))
        self.assertEqual(out["sites"], [{"phrase": None, "atoms": [0], "mark": 901},
                                        {"phrase": None, "atoms": [7], "mark": 902}])

    def test_the_named_pair_is_reached_however_many_copies_the_molecule_carries(self):
        """The cost bound and its correctness in one: the competing copies are protected before
        anything runs, so the work does not grow with the molecule and the outcome cap can never
        cut off the pair the program named."""
        from rdkit import Chem

        plain = "C" + "".join("CC(S)" for _ in range(8)) + "CC"
        mol = Chem.MolFromSmiles(plain)
        thiols = mol.GetSubstructMatches(Chem.MolFromSmarts("[SX2H1]"))
        self.assertEqual(len(thiols), 8)
        marked = Chem.Mol(mol)
        marked.GetAtomWithIdx(thiols[0][0]).SetAtomMapNum(901)
        marked.GetAtomWithIdx(thiols[-1][0]).SetAtomMapNum(902)

        out = apply(moleculeHandle=Chem.MolToSmiles(marked),
                    operation={"kind": "named", "id": "disulfide-closure"}, sites=self.PAIR)
        self.assertEqual(out["product"], "CCC1CC(S)CC(S)CC(S)CC(S)CC(S)CC(S)CC(CC)SS1")
        self.assertEqual(out["ring"], {"size": 17, "bridgeAtoms": 0})
        # Unaimed, the same molecule offers 16 closures and the toolkit refuses to choose.
        loose = apply(molecule=plain, operation={"kind": "named", "id": "disulfide-closure"})
        self.assertEqual(loose["error"], "ambiguous-site")
        self.assertIn("16 places", loose["message"])


class Handles(unittest.TestCase):
    """Provenance marks: acting at the place an earlier operation acted."""

    def test_three_of_the_same_group_need_a_mark_and_the_mark_picks_the_right_one(self):
        seeded = named("ester-formation", "COC(=O)c1ccc(C(=O)O)c(C(=O)OCCC)c1", ["CCO"], markAs=901)
        self.assertEqual(seeded["product"], "CCCOC(=O)c1cc(C(=O)OC)ccc1C(=O)OCC")
        self.assertEqual(seeded["marks"], [901])

        by_phrase = apply(moleculeHandle=seeded["productHandle"],
                          operation={"kind": "named", "id": "ester-hydrolysis"},
                          site={"kind": "phrase", "phrase": "ester"})
        self.assertEqual(by_phrase["error"], "ambiguous-site")
        self.assertIn("3 places", by_phrase["message"])

        by_mark = apply(moleculeHandle=seeded["productHandle"],
                        operation={"kind": "named", "id": "ester-hydrolysis"},
                        site={"kind": "handle", "mark": 901})
        # The ethyl ester the mark sits on, not the methyl or the propyl one beside it.
        self.assertEqual(by_mark["product"], "CCCOC(=O)c1cc(C(=O)OC)ccc1C(=O)O")
        self.assertNotEqual(by_mark["product"], "CCCOC(=O)c1cc(C(=O)O)ccc1C(=O)OCC")
        self.assertNotEqual(by_mark["product"], "CCOC(=O)c1ccc(C(=O)OC)cc1C(=O)O")
        self.assertEqual(by_mark["coProducts"], ["CCO"])

    def test_four_operations_each_at_the_site_the_previous_one_made(self):
        step = named("primary-alcohol-oxidation", "COC(=O)c1ccc(CO)cc1", markAs=901)
        self.assertEqual(step["product"], "COC(=O)c1ccc(C=O)cc1")
        self.assertEqual(step["marks"], [901])

        step = apply(moleculeHandle=step["productHandle"],
                     operation={"kind": "named", "id": "aldehyde-oxidation"},
                     site={"kind": "handle", "mark": 901}, markAs=902)
        self.assertEqual(step["product"], "COC(=O)c1ccc(C(=O)O)cc1")
        self.assertEqual(step["marks"], [901, 902])

        step = apply(moleculeHandle=step["productHandle"],
                     operation={"kind": "named", "id": "ester-formation"}, reagents=["CCO"],
                     site={"kind": "handle", "mark": 902}, markAs=903)
        self.assertEqual(step["product"], "CCOC(=O)c1ccc(C(=O)OC)cc1")
        # 903 took 902's atoms, because this operation acted on exactly what 902 marked. An atom
        # holds one mark, so the response says which marks are left rather than keeping both.
        self.assertEqual(step["marks"], [901, 903])

        # Two esters now, so nothing but a mark can say which one.
        self.assertEqual(apply(moleculeHandle=step["productHandle"],
                               operation={"kind": "named", "id": "ester-hydrolysis"},
                               site={"kind": "phrase", "phrase": "ester"})["error"], "ambiguous-site")
        last = apply(moleculeHandle=step["productHandle"],
                     operation={"kind": "named", "id": "ester-hydrolysis"},
                     site={"kind": "handle", "mark": 903})
        self.assertEqual(last["product"], "COC(=O)c1ccc(C(=O)O)cc1")
        self.assertEqual(last["coProducts"], ["CCO"])
        self.assertEqual(last["marks"], [901, 903])

    def test_two_marks_on_two_arms_each_address_their_own_arm(self):
        first = named("aldehyde-oxidation", "O=Cc1ccc(C(=O)OC)cc1C", markAs=901)
        self.assertEqual(first["product"], "COC(=O)c1ccc(C(=O)O)c(C)c1")
        second = apply(moleculeHandle=first["productHandle"],
                       operation={"kind": "named", "id": "ester-hydrolysis"},
                       site={"kind": "phrase", "phrase": "ester"}, markAs=902)
        self.assertEqual(second["product"], "Cc1cc(C(=O)O)ccc1C(=O)O")
        # Disjoint arms, so neither mark took anything from the other.
        self.assertEqual(second["marks"], [901, 902])

        self.assertEqual(apply(moleculeHandle=second["productHandle"],
                               operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                               site={"kind": "phrase", "phrase": "carboxylic acid"})["error"], "ambiguous-site")
        at_901 = apply(moleculeHandle=second["productHandle"],
                       operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                       site={"kind": "handle", "mark": 901})
        at_902 = apply(moleculeHandle=second["productHandle"],
                       operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                       site={"kind": "handle", "mark": 902})
        self.assertEqual(at_901["product"], "Cc1cc(C(=O)O)ccc1C(=O)Cl")
        self.assertEqual(at_902["product"], "Cc1cc(C(=O)Cl)ccc1C(=O)O")
        self.assertNotEqual(at_901["product"], at_902["product"])

    def test_a_mark_survives_six_operations_elsewhere_and_still_addresses_its_own_site(self):
        """The mid-chain case: the mark is set first, the molecule then goes through six operations
        on another arm, and the seventh acts at the original mark."""
        step = named("aldehyde-oxidation", "O=Cc1ccc(C(=O)O)cc1CO", markAs=901)
        self.assertEqual(step["product"], "O=C(O)c1ccc(C(=O)O)c(CO)c1")
        self.assertEqual(step["marks"], [901])
        elsewhere = [("primary-alcohol-oxidation", "primary alcohol"), ("aldehyde-reduction", "aldehyde")] * 3
        for transform_id, phrase in elsewhere:
            step = apply(moleculeHandle=step["productHandle"],
                         operation={"kind": "named", "id": transform_id},
                         site={"kind": "phrase", "phrase": phrase})
            self.assertTrue(step.get("ok"), step)
            self.assertEqual(step["marks"], [901], step)
        self.assertEqual(step["product"], "O=C(O)c1ccc(C(=O)O)c(CO)c1")

        # Two carboxylic acids by now, and only the mark knows which one came from the aldehyde.
        self.assertEqual(apply(moleculeHandle=step["productHandle"],
                               operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                               site={"kind": "phrase", "phrase": "carboxylic acid"})["error"], "ambiguous-site")
        out = apply(moleculeHandle=step["productHandle"],
                    operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                    site={"kind": "handle", "mark": 901})
        self.assertEqual(out["product"], "O=C(O)c1ccc(C(=O)Cl)c(CO)c1")
        # The other acid, marked by hand for contrast, gives a different molecule.
        other = apply(moleculeHandle="O=[C:901]([OH:901])c1ccc(C(=O)O)c(CO)c1",
                      operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                      site={"kind": "handle", "mark": 901})
        self.assertEqual(other["product"], "O=C(Cl)c1ccc(C(=O)O)c(CO)c1")
        self.assertNotEqual(out["product"], other["product"])

    def test_two_marks_do_not_drift_over_eighteen_operations_elsewhere(self):
        """The property most likely to fail quietly, so it is tested at the depth a real route has.

        Three arms on one ring. Two of them are marked, the third is then oxidised and reduced
        eight times over, and at the end each mark still addresses its own arm and nothing else."""
        step = named("aldehyde-oxidation", "O=Cc1cc(CO)c(C(=O)OC)cc1C", markAs=901)
        self.assertEqual(step["product"], "COC(=O)c1cc(C)c(C(=O)O)cc1CO")
        step = apply(moleculeHandle=step["productHandle"],
                     operation={"kind": "named", "id": "ester-hydrolysis"},
                     site={"kind": "phrase", "phrase": "ester"}, markAs=902)
        settled = step["product"]
        self.assertEqual(settled, "Cc1cc(C(=O)O)c(CO)cc1C(=O)O")
        self.assertEqual(step["marks"], [901, 902])

        elsewhere = [("primary-alcohol-oxidation", "primary alcohol"), ("aldehyde-reduction", "aldehyde")] * 8
        for at, (transform_id, phrase) in enumerate(elsewhere):
            step = apply(moleculeHandle=step["productHandle"],
                         operation={"kind": "named", "id": transform_id},
                         site={"kind": "phrase", "phrase": phrase})
            self.assertTrue(step.get("ok"), (at, step))
            self.assertEqual(step["marks"], [901, 902], at)
        self.assertEqual(step["product"], settled)

        self.assertEqual(apply(moleculeHandle=step["productHandle"],
                               operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                               site={"kind": "phrase", "phrase": "carboxylic acid"})["error"], "ambiguous-site")
        at_901 = apply(moleculeHandle=step["productHandle"],
                       operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                       site={"kind": "handle", "mark": 901})
        at_902 = apply(moleculeHandle=step["productHandle"],
                       operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                       site={"kind": "handle", "mark": 902})
        self.assertEqual(at_901["product"], "Cc1cc(C(=O)O)c(CO)cc1C(=O)Cl")
        self.assertEqual(at_902["product"], "Cc1cc(C(=O)Cl)c(CO)cc1C(=O)O")

    def test_a_mark_that_is_not_there_is_an_absent_site(self):
        out = named("ketone-reduction", "CC(=O)C", site={"kind": "handle", "mark": 999})
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("999", out["message"])

    def test_a_mark_in_two_separate_places_is_ambiguous(self):
        out = apply(moleculeHandle="[CH3:901]OC(=O)c1ccc(C(=O)O[CH3:901])cc1",
                    operation={"kind": "named", "id": "ester-hydrolysis"},
                    site={"kind": "handle", "mark": 901})
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("2 separate places", out["message"])

    def test_no_mark_ever_reaches_the_molecule_or_the_product(self):
        out = named("aldehyde-oxidation", "O=Cc1ccc(C(=O)OC)cc1C", markAs=901)
        self.assertNotIn(":", out["product"])
        self.assertNotIn("901", out["product"])
        for co_product in out["coProducts"]:
            self.assertNotIn(":", co_product)
        # The handle is where the mark lives, and it is a different string from the product.
        self.assertIn(":901]", out["productHandle"])
        self.assertNotEqual(out["productHandle"], out["product"])
        onward = apply(moleculeHandle=out["productHandle"],
                       operation={"kind": "named", "id": "ester-hydrolysis"},
                       site={"kind": "phrase", "phrase": "ester"})
        self.assertNotIn(":", onward["product"])
        self.assertNotIn(":", "".join(onward["coProducts"]))

    def test_an_unmarked_product_has_a_handle_equal_to_itself(self):
        out = named("ketone-reduction", "CC(=O)c1ccccc1")
        self.assertEqual(out["marks"], [])
        self.assertEqual(out["productHandle"], out["product"])

    def test_a_map_number_in_a_plain_molecule_is_not_provenance(self):
        # `molecule` is contracted to be clean, so a stray number in one is cleared rather than
        # read as a mark the caller never claimed.
        out = apply(molecule="[CH3:901]OC(=O)c1ccccc1",
                    operation={"kind": "named", "id": "ester-hydrolysis"},
                    site={"kind": "handle", "mark": 901})
        self.assertEqual(out["error"], "absent-site")

    def test_the_handle_is_preferred_over_the_plain_molecule(self):
        out = apply(molecule="CC(=O)c1ccccc1", moleculeHandle="[CH3:901]C(=O)CCCC(C)=O",
                    operation={"kind": "named", "id": "ketone-reduction"},
                    site={"kind": "handle", "mark": 901})
        self.assertEqual(out["product"], "CC(=O)CCCC(C)O")

    def test_a_site_list_holds_one_today_and_says_so_when_given_two(self):
        one = named("ketone-reduction", "CC(=O)c1ccccc1", site=[{"kind": "phrase", "phrase": "ketone"}])
        self.assertEqual(one["product"], "CC(O)c1ccccc1")
        two = named("ketone-reduction", "CC(=O)c1ccccc1",
                    site=[{"kind": "phrase", "phrase": "ketone"}, {"kind": "handle", "mark": 901}])
        self.assertEqual(two["error"], "unparsable")
        self.assertIn("one site", two["message"])

    def test_the_plural_key_the_adapter_sends_is_read_too(self):
        # The adapter sends `sites`; ignoring it would drop the handle and fall back to the
        # transformation's own phrase, which is the one way a site can go silently unhonoured.
        marked = named("aldehyde-oxidation", "O=Cc1ccc(C(=O)OC)cc1C", markAs=901)
        out = route_program.handle({"op": "apply", "moleculeHandle": marked["productHandle"],
                                    "operation": {"kind": "named", "id": "acid-to-acyl-chloride"},
                                    "sites": [{"kind": "handle", "mark": 901}]})
        self.assertEqual(out["site"]["mark"], 901)
        self.assertEqual(out["product"], "COC(=O)c1ccc(C(=O)Cl)c(C)c1")
        missing = route_program.handle({"op": "apply", "molecule": "CC(=O)C",
                                        "operation": {"kind": "named", "id": "ketone-reduction"},
                                        "sites": [{"kind": "handle", "mark": 999}]})
        self.assertEqual(missing["error"], "absent-site")

    def test_a_mark_must_be_a_whole_number_in_range(self):
        for bad in ("nine", 0, -3, 10 ** 9, 1.5):
            with self.subTest(bad):
                self.assertEqual(named("ketone-reduction", "CC(=O)c1ccccc1", markAs=bad)["error"], "unparsable")
        self.assertEqual(named("ketone-reduction", "CC(=O)c1ccccc1",
                               site={"kind": "handle", "mark": "nine"})["error"], "unparsable")

    def test_a_handle_site_is_reported_back_with_its_mark(self):
        marked = named("aldehyde-oxidation", "O=Cc1ccc(C(=O)OC)cc1C", markAs=901)
        out = apply(moleculeHandle=marked["productHandle"],
                    operation={"kind": "named", "id": "acid-to-acyl-chloride"},
                    site={"kind": "handle", "mark": 901})
        self.assertEqual(out["site"]["mark"], 901)
        self.assertIsNone(out["site"]["phrase"])
        self.assertTrue(out["site"]["atoms"])

    def test_describe_reports_the_marks_a_handle_still_holds(self):
        out = route_program.handle({"op": "describe",
                                    "moleculeHandle": "O=C(O)c1ccc([C:901](=O)[OH:901])c(CO)c1"})
        self.assertEqual(out["marks"], [901])
        self.assertIn("marks held: 901", out["summary"])
        self.assertIn("carboxylic acid (2)", out["summary"])
        self.assertEqual(route_program.handle({"op": "describe", "molecule": "CC(=O)C"})["marks"], [])


@unittest.skipUnless(os.environ.get("ROUTE_PROGRAM_TEST_INDEX"),
                     "set ROUTE_PROGRAM_TEST_INDEX to an index directory holding retro-templates.tsv.zst")
class ReversedIndexTemplate(unittest.TestCase):
    """The second-class path: our templates are retro, so forward use means swapping the sides."""

    index = os.environ.get("ROUTE_PROGRAM_TEST_INDEX", "")
    NITRO = "[NH2;D1;+0:1]-[c:2]>>O=[N+;H0;D3:1](-[O-])-[c:2]"

    def test_a_retro_template_reversed_makes_the_product_it_was_derived_from(self):
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": self.NITRO, "indexDir": self.index})
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"], "Nc1ccccc1")

    def test_a_template_can_be_asked_for_by_digest(self):
        import hashlib

        digest = hashlib.sha1(self.NITRO.encode()).hexdigest()[:16]
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": digest, "indexDir": self.index})
        self.assertEqual(out.get("product"), "Nc1ccccc1")

    def test_a_template_the_index_does_not_hold_is_unknown(self):
        out = apply(molecule="O=[N+]([O-])c1ccccc1",
                    operation={"kind": "template", "id": "[C:1]>>[C:1]", "indexDir": self.index})
        self.assertEqual(out["error"], "unknown-template")


class TemplateRows(unittest.TestCase):
    """The templates file has gained a column before and will again.

    Splitting into exactly three columns put a newer file's fourth column at the front of every
    SMARTS, so every pattern failed to parse and the entire library was dropped — a store that read
    as EMPTY rather than as unreadable, which is the worst way for this to fail. The pattern cannot
    contain a tab, so the last field is the pattern whatever else is there."""

    SMARTS = "[NH2;D1;+0:1]-[c:2]>>O=[N+;H0;D3:1](-[O-])-[c:2]"

    def test_three_columns(self):
        self.assertEqual(reactions_worker._template_row(f"12\t1\t{self.SMARTS}"),
                         ("12", "1", self.SMARTS))

    def test_four_columns_with_a_radius_between(self):
        self.assertEqual(reactions_worker._template_row(f"12\t1\t2\t{self.SMARTS}"),
                         ("12", "1", self.SMARTS))

    def test_a_column_added_in_future_does_not_break_it(self):
        self.assertEqual(reactions_worker._template_row(f"12\t1\t2\tsomething\t{self.SMARTS}"),
                         ("12", "1", self.SMARTS))

    def test_the_trailing_newline_is_not_part_of_the_pattern(self):
        self.assertEqual(reactions_worker._template_row(f"12\t1\t2\t{self.SMARTS}\n")[2],
                         self.SMARTS)

    def test_the_pattern_from_either_shape_parses(self):
        for line in (f"12\t1\t{self.SMARTS}", f"12\t1\t2\t{self.SMARTS}"):
            smarts = reactions_worker._template_row(line)[2]
            self.assertIsNotNone(Chem.MolFromSmarts(smarts.split(">>")[0]), line)


class SiteEnvironment(unittest.TestCase):
    """Telling a proposal that acted AT the named place from one that merely matched there.

    The template filter decides which templates run, not where they are applied, so most surviving
    proposals are disconnections elsewhere and they bury the one asked for. A disconnection at the
    site destroys the site's own surroundings, so those surroundings cannot occur in the precursors.

    The radius matters more than it looks: at one that is too small the environment recurs, survives
    the disconnection intact, and every proposal reads as having acted elsewhere. Measured, that
    threw away all 4,020 proposals on one target."""

    CHAIN = "CCCCCCCCNC(=O)CCCCCCCC"

    def test_the_environment_is_smaller_than_the_molecule_and_reparses(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        smiles = reactions_worker._environment(mol, {8}, 2)
        self.assertIsNotNone(smiles)
        env = Chem.MolFromSmiles(smiles)
        self.assertIsNotNone(env, smiles)
        self.assertLess(env.GetNumAtoms(), mol.GetNumAtoms())

    def test_a_cut_neighbour_becomes_a_dummy_so_the_kept_atom_keeps_its_degree(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        env = Chem.MolFromSmiles(reactions_worker._environment(mol, {8}, 1))
        self.assertTrue(any(a.GetAtomicNum() == 0 for a in env.GetAtoms()), Chem.MolToSmiles(env))

    def test_an_empty_site_has_no_environment(self):
        self.assertIsNone(reactions_worker._environment(Chem.MolFromSmiles(self.CHAIN), set(), 2))

    def test_a_bigger_radius_keeps_more(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        sizes = [Chem.MolFromSmiles(reactions_worker._environment(mol, {8}, r)).GetNumAtoms()
                 for r in (1, 2, 3)]
        self.assertEqual(sizes, sorted(sizes))
        self.assertLess(sizes[0], sizes[-1])

    def test_the_query_occurs_exactly_once_in_the_molecule_it_came_from(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        query = reactions_worker._site_environment(mol, {8})
        self.assertIsNotNone(query)
        self.assertEqual(len(mol.GetSubstructMatches(query, uniquify=True, maxMatches=8)), 1)

    def test_a_repetitive_environment_is_grown_until_it_is_unique(self):
        # a symmetric chain: a small window around one methylene matches in many places, so the
        # radius has to grow before the query says anything about WHICH one
        mol = Chem.MolFromSmiles("OCCCCCCCCCCCCO")
        small = Chem.MolFromSmarts(
            reactions_worker._environment(mol, {6}, 1).replace("[*]", "[*,#1]"))
        self.assertGreater(len(mol.GetSubstructMatches(small, uniquify=True, maxMatches=20)), 1)
        grown = reactions_worker._site_environment(mol, {6})
        if grown is not None:
            self.assertEqual(len(mol.GetSubstructMatches(grown, uniquify=True, maxMatches=8)), 1)

    def test_a_precursor_that_still_holds_the_environment_did_not_act_there(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        query = reactions_worker._site_environment(mol, {8})
        # the molecule itself obviously still holds it
        self.assertFalse(reactions_worker._acted_at_site(self.CHAIN, query))

    def test_a_precursor_without_the_environment_did_act_there(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        query = reactions_worker._site_environment(mol, {8})
        # the amide cut back to the amine and the acid: the environment is gone from both
        self.assertTrue(reactions_worker._acted_at_site("CCCCCCCCN.OC(=O)CCCCCCCC", query))

    def test_one_precursor_holding_it_is_enough_to_reject_the_whole_set(self):
        mol = Chem.MolFromSmiles(self.CHAIN)
        query = reactions_worker._site_environment(mol, {8})
        self.assertFalse(reactions_worker._acted_at_site(f"CO.{self.CHAIN}", query))


class DisconnectionSite(unittest.TestCase):
    """Marking a target says WHERE a disconnection is wanted, which lets the retro pass skip the
    templates that are found only somewhere else.

    Tested on the two pure functions rather than through a whole pass, because a template library is
    local data that never ships with the repository. The properties the saving rests on are here:
    the marks are not carried into the molecule that gets searched, the site is the atoms they sat
    on, and a template found only away from the site is rejected while the same template on an
    unmarked target is kept."""

    def test_an_unmarked_target_has_no_site_and_keeps_its_atoms(self):
        mol, site, canonical = reactions_worker._site_of("CC(=O)OCC")
        self.assertEqual(site, frozenset())
        self.assertEqual(canonical[0], "CCOC(C)=O")
        self.assertEqual(canonical[1], [])

    def test_marks_give_the_site_and_are_stripped_from_the_molecule(self):
        mol, site, canonical = reactions_worker._site_of("CC(=O)O[CH2:901]C")
        self.assertEqual(len(site), 1)
        # the molecule that is searched and reported carries no map numbers
        self.assertEqual(canonical[0], "CCOC(C)=O")
        self.assertEqual(mol.GetAtomWithIdx(next(iter(site))).GetSymbol(), "C")

    def test_the_reported_site_indexes_the_canonical_target_not_the_input(self):
        """The caller holds `target`, so the indices have to be its own."""
        mol, site, (smiles, reported) = reactions_worker._site_of("CC(=O)O[CH2:901]C")
        marked_atom = Chem.MolFromSmiles(smiles).GetAtomWithIdx(reported[0])
        self.assertEqual(marked_atom.GetSymbol(), "C")
        # the methylene of the ethyl: two heavy neighbours, two hydrogens
        self.assertEqual(marked_atom.GetTotalNumHs(), 2)
        self.assertEqual(sorted(n.GetSymbol() for n in marked_atom.GetNeighbors()), ["C", "O"])

    def test_the_reported_site_is_every_marked_atom_and_no_other(self):
        _, site, (smiles, reported) = reactions_worker._site_of("[CH3:901]C(=O)O[CH2:902]C")
        self.assertEqual(len(site), 2)
        self.assertEqual(len(reported), 2)
        canonical = Chem.MolFromSmiles(smiles)
        self.assertTrue(all(0 <= i < canonical.GetNumAtoms() for i in reported))

    def test_without_a_site_any_place_counts(self):
        mol, site, _ = reactions_worker._site_of("OCCCCCCO")
        alcohol = Chem.MolFromSmarts("[OX2H1]")
        self.assertTrue(reactions_worker._at_site(mol, alcohol, site))

    def test_a_pattern_found_only_away_from_the_site_is_rejected(self):
        # one end marked; the query is pinned to the OTHER kind of group, which is at neither end
        mol, site, _ = reactions_worker._site_of("[OH:901]CCCCCCO")
        self.assertEqual(len(site), 1)
        self.assertTrue(reactions_worker._at_site(mol, Chem.MolFromSmarts("[OX2H1]"), site))
        self.assertFalse(reactions_worker._at_site(mol, Chem.MolFromSmarts("[NX3]"), site))

    def test_a_pattern_found_at_the_site_among_several_places_is_kept(self):
        # a symmetric diol: the alcohol query matches twice, and only one match is at the mark
        mol, site, _ = reactions_worker._site_of("[OH:901]CCCCCCO")
        alcohol = Chem.MolFromSmarts("[OX2H1]")
        self.assertEqual(len(mol.GetSubstructMatches(alcohol, uniquify=True)), 2)
        self.assertTrue(reactions_worker._at_site(mol, alcohol, site))

    def test_a_pattern_that_spans_the_site_counts_even_when_the_mark_is_not_its_anchor(self):
        # the mark is on the carbon; the query starts at the oxygen and reaches it
        mol, site, _ = reactions_worker._site_of("CC(=O)O[CH2:901]C")
        ester = Chem.MolFromSmarts("[CX3](=O)[OX2][CX4]")
        self.assertTrue(reactions_worker._at_site(mol, ester, site))

    def test_a_target_that_does_not_parse_gives_no_molecule(self):
        mol, site, canonical = reactions_worker._site_of("not a molecule")
        self.assertIsNone(mol)
        self.assertEqual(site, frozenset())
        self.assertEqual(canonical, ())


if __name__ == "__main__":
    unittest.main(verbosity=2)


class SuppliedConditions(unittest.TestCase):
    """A transformation may declare the conditions it implies, and they must not enter the balance.

    Why, from the independent chemistry review on 2026-10-14 (claude-opus-5, blind to the app's
    verdict): it raised against BOTH reviewed routes that every acidic deprotection delivers the
    amine as its ammonium salt and the following coupling "as written contains no base, so the
    amine is non-nucleophilic". The route was unrunnable while the engine called it correct.

    The fix has to land in the AGENT slot, not a reaction slot. A reaction slot is balance-bearing
    -- `cbz-removal` says so in its own summary, "the hydrogen is written as a reactant so the
    equation balances" -- so a base put there would unbalance every coupling unless the protonated
    base were also written as a product, which is a far larger change. The balancer's own error
    text names the right place: "If they are catalysts and not consumed, list them under Agents
    instead."
    """

    CHAIN = "COC(=O)CN"                                    # a growing chain, free amine
    BOC_ALA = "CC(C)(C)OC(=O)N[C@@H](C)C(=O)O"             # the incoming residue

    def test_the_coupling_supplies_a_base_as_an_agent(self):
        out = apply(molecule=self.CHAIN, operation={"kind": "named", "id": "n-peptide-coupling"},
                    reagents=[self.BOC_ALA])
        self.assertTrue(out["ok"], out)
        # The acid fills the declared slot, so it is a co-REACTANT and balance-bearing.
        self.assertEqual(len(out["coReactants"]), 1, out["coReactants"])
        # The base is a condition: present, and in the slot the balance ignores.
        self.assertEqual(out["agents"], ["CCN(C(C)C)C(C)C"], out["agents"])
        self.assertNotIn("CCN(C(C)C)C(C)C", out["coReactants"])

    def test_a_caller_reagent_beyond_the_slots_still_becomes_an_agent(self):
        """The supplied conditions are appended to the caller's surplus, not substituted for it."""
        out = apply(molecule=self.CHAIN, operation={"kind": "named", "id": "n-peptide-coupling"},
                    reagents=[self.BOC_ALA, "CO"])
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["agents"], ["CO", "CCN(C(C)C)C(C)C"], out["agents"])

    def test_a_transformation_without_conditions_declares_no_agents(self):
        out = apply(molecule="CC(C)(C)OC(=O)NCC(=O)OC", operation={"kind": "named", "id": "boc-removal"})
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["agents"], [], out["agents"])


class FamilyVerbs(unittest.TestCase):
    """A family verb names the intent and the toolkit picks the member the molecule fits.

    Why, measured 2026-10-14: this is the ONE error that survived turning thinking off. A route
    installed Cbz on line 3 and asked for `boc-removal` on line 4; the verb matched nothing, and
    because a statement that produces nothing leaves every later statement without an input, that
    single line left 15 of 17 steps unbuilt. The model was being asked to remember which group it
    had installed three lines earlier, which is bookkeeping -- the work this toolkit exists to take
    over, and the work the reasoning tokens were being spent on.

    Dispatch adds no chemistry: each member is a curated verb with its own tests above.
    """

    GLY_OME = "COC(=O)CN"

    def deprotect(self, molecule):
        return apply(molecule=molecule, operation={"kind": "named", "id": "n-deprotect"})

    def test_it_picks_the_group_the_molecule_actually_carries(self):
        for label, molecule, phrase in (
            ("cbz", "O=C(OCc1ccccc1)NCC(=O)OC", "cbz carbamate"),
            ("boc", "CC(C)(C)OC(=O)NCC(=O)OC", "boc carbamate"),
            ("fmoc", "O=C(OCC1c2ccccc2-c2ccccc21)NCC(=O)OC", "fmoc carbamate"),
        ):
            with self.subTest(label):
                out = self.deprotect(molecule)
                self.assertTrue(out.get("ok"), out)
                # The member's own site, not the family's: the family declares none.
                self.assertEqual(out["site"]["phrase"], phrase)
                self.assertEqual(out["product"], self.GLY_OME)

    def test_two_different_groups_are_refused_rather_than_guessed(self):
        # Fmoc-Lys(Boc)-OH, from the user's own prompts. Which group the route means is intent, and
        # inferring it would be wrong silently -- the rule the site resolver already follows.
        out = self.deprotect("O=C(OCC1c2ccccc2-c2ccccc21)N[C@@H](CCCCNC(=O)OC(C)(C)C)C(=O)O")
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("fmoc carbamate", out["message"])
        self.assertIn("boc carbamate", out["message"])
        # It must name the verbs that WOULD settle it, or the author has nowhere to go.
        self.assertIn("fmoc-removal", out["message"])
        self.assertIn("boc-removal", out["message"])

    def test_no_protecting_group_says_so(self):
        out = self.deprotect(self.GLY_OME)
        self.assertEqual(out["error"], "absent-site")
        self.assertIn("none of the groups", out["message"])

    def test_the_specific_removals_still_work_on_their_own(self):
        """The family is an addition, not a replacement: naming the member must keep working."""
        out = apply(molecule="CC(C)(C)OC(=O)NCC(=O)OC",
                    operation={"kind": "named", "id": "boc-removal"})
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"], self.GLY_OME)

    def test_a_wrong_specific_removal_still_fails_loudly(self):
        """Dispatch must not make a mis-named member silently succeed -- that would hide the bug
        this verb exists to prevent, rather than fix it."""
        out = apply(molecule="O=C(OCc1ccccc1)NCC(=O)OC",
                    operation={"kind": "named", "id": "boc-removal"})
        self.assertEqual(out["error"], "absent-site")


class EveryMatchingSite(unittest.TestCase):
    """`site="every ester"` is one transformation at every place that phrase matches.

    Why, measured 2026-10-14 on chainP-8: a route masked two side-chain hydroxyls and wrote ONE
    `ester-hydrolysis` to free both. That is correct chemistry -- one saponification takes both --
    against a grammar of one site per line, so the toolkit refused a route that was right and the
    run ended with the refusal unread.

    Implemented as consecutive single applications, so each pass contributes its own co-reactants
    and co-products and the equation balances over all of them without anything here knowing that
    two esters consume two waters. Verified against the real balancer: balanced, charge-balanced,
    no differences.
    """

    DIACETATE = "CC(=O)OCC(COC(C)=O)NC(=O)OC(C)(C)C"   # two acetates on one Boc-protected backbone

    def test_one_line_takes_both_esters(self):
        out = apply(molecule=self.DIACETATE, operation={"kind": "named", "id": "ester-hydrolysis"},
                    site="every ester", carry="largest")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["appliedTimes"], 2)
        # The backbone continues and the Boc is untouched; both acetates leave.
        self.assertEqual(out["product"], "CC(C)(C)OC(=O)NC(CO)CO")
        self.assertEqual(out["coProducts"], ["CC(=O)O", "CC(=O)O"])
        # Two hydrolyses consume two waters. This is what makes the derived equation balance.
        self.assertEqual(out["coReactants"], ["O", "O"])

    def test_without_every_the_refusal_stands(self):
        """The ambiguity refusal must NOT be weakened: it is the guard against a silent guess, and
        `every` is an opt-in that says all of them, never a way to pick one."""
        out = apply(molecule=self.DIACETATE, operation={"kind": "named", "id": "ester-hydrolysis"},
                    site="ester", carry="largest")
        self.assertEqual(out["error"], "ambiguous-site")
        self.assertIn("2 places matching", out["message"])

    def test_a_single_place_is_unchanged_by_every(self):
        out = apply(molecule="CCOC(=O)c1ccccc1", operation={"kind": "named", "id": "ester-hydrolysis"},
                    site="every ester")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["product"], "O=C(O)c1ccccc1")
        self.assertEqual(out["coProducts"], ["CCO"])
        self.assertNotIn("appliedTimes", out)

    def test_a_phrase_that_matches_nothing_says_so(self):
        out = apply(molecule="CCO", operation={"kind": "named", "id": "ester-hydrolysis"},
                    site="every ester")
        self.assertIn(out["error"], ("absent-site", "no-match"))

    def test_it_fires_through_the_key_the_adapter_actually_sends(self):
        """The adapter sends `sites`, plural, as a list of objects. Reading only the singular `site`
        is why this feature never fired in the application while every test here passed: the tests
        called the engine with the shape the adapter does not use. Measured on chainP-24,
        2026-10-14 -- three of its four turns died on
        "'every tert-butyl ester' is not a site phrase this toolkit knows"."""
        out = route_program.handle({"op": "apply", "molecule": self.DIACETATE,
                                    "operation": {"kind": "named", "id": "ester-hydrolysis"},
                                    "sites": [{"kind": "phrase", "phrase": "every ester"}],
                                    "carry": "largest"})
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out["appliedTimes"], 2)
        self.assertEqual(out["coProducts"], ["CC(=O)O", "CC(=O)O"])

    def test_the_plural_key_still_refuses_an_ambiguous_phrase(self):
        """And the opt-in stays an opt-in on that key too."""
        out = route_program.handle({"op": "apply", "molecule": self.DIACETATE,
                                    "operation": {"kind": "named", "id": "ester-hydrolysis"},
                                    "sites": [{"kind": "phrase", "phrase": "ester"}],
                                    "carry": "largest"})
        self.assertEqual(out["error"], "ambiguous-site")

    def test_each_and_all_are_the_same_request(self):
        for word in ("all esters", "each ester"):
            with self.subTest(word):
                out = apply(molecule=self.DIACETATE, operation={"kind": "named", "id": "ester-hydrolysis"},
                            site=word, carry="largest")
                self.assertTrue(out.get("ok"), out)
                self.assertEqual(out["appliedTimes"], 2)
