"""Arginine quietly becoming ornithine, when its guanidine is protected as a urethane.

*Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3 Section 9.2.10 (printed p. 341):
"when Arg residues are protected with urethane-type groups, such as Boc and Alloc, they suffer
partial conversion into the corresponding Orn residues, especially in the Boc/Bzl strategy but also
in the Fmoc/tBu technique. This undesired conversion is caused by guanidino acylation during the
coupling step followed by ... decomposition under the strong basic conditions required for Fmoc
removal. The overall process generates a product with a difference of -42 mass units."

Benoiton Section 6.11 describes the same bond breaking, from the other direction: "Any N-g-acylated
product that might be formed is sensitive to base; piperidine ruptures the delta-N-epsilon-C bond
of the adduct, generating an ORNITHINE residue."

So the hazard is a PROTECTING-GROUP CHOICE, and that is what makes it worth gating: the remedy is a
building block the package already ships. Fmoc-Arg(Pbf)-OH carries an ARYLSULFONYL on the guanidine,
not a urethane, and is not subject to this. A route that reaches for a Boc or Alloc on a guanidine
instead — which it can, the package ships `boc-protection` — is choosing the liability.

Why it is read as a survivor rather than as a product. In the route as WRITTEN the protected
guanidine comes through the piperidine step intact; what the literature says is that it partly does
not. That is exactly the `ATTACKS` reading — a group the step attacks, which the route claims
survives — and not `UNMASKED_RISKS`, which is for what a step creates.

Severity is medium because the conversion is PARTIAL ("suffer partial conversion"), and because
nothing downstream can see it: an ornithine peptide is a different molecule with its own consistent
formula, so a balance check and a target comparison both pass on the route as written.
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

GROUP = "arg-urethane-guanidine"

# An arginine whose guanidine carries a Boc — the urethane case. Derived by putting a Boc on the
# delta nitrogen of Fmoc-arginine, which is what the package's own `boc-protection` would do.
FMOC_ARG_BOC = ("O=C(OC(C)(C)C)N(CCC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O)C(N)=N")
# The Alloc variant, the other group Vol 3 names.
FMOC_ARG_ALLOC = ("O=C(OCC=C)N(CCC[C@@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O)C(N)=N")
# The shipped block: an ARYLSULFONYL on the guanidine, not a urethane. Must stay silent.
FMOC_ARG_PBF = ("CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4"
                "C5=CC=CC=C35)N)C")
# A Boc on an ordinary side-chain amine, not on a guanidine: Fmoc-Lys(Boc)-OH. Must stay silent.
FMOC_LYS_BOC = "CC(C)(C)OC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
# Free arginine: a guanidine with no protector at all.
L_ARGININE = "NC(=N)NCCC[C@@H](C(=O)O)N"

PIPERIDINE = "20% piperidine in DMF, 2 x 5 min, rt"
COUPLING = "Fmoc-Ala-OH, HBTU, DIPEA, DMF, 45 min"


def hazards_for(reactant, product, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [product], "reagents": reagents}])
    assert len(out) == 1
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class TheSubstratesAreWhatTheyClaim(unittest.TestCase):
    def test_the_formulas_are_pinned(self):
        self.assertEqual(formula(FMOC_ARG_BOC), "C26H32N4O6")
        self.assertEqual(formula(FMOC_ARG_ALLOC), "C25H28N4O6")
        self.assertEqual(formula(FMOC_ARG_PBF), "C34H40N4O7S")

    def test_the_pattern_compiles(self):
        self.assertIsNotNone(Chem.MolFromSmarts(T.GROUPS[GROUP][1]))


class ThePatternIsAUrethaneOnAGuanidine(unittest.TestCase):
    def setUp(self):
        self.pattern = Chem.MolFromSmarts(T.GROUPS[GROUP][1])

    def _match(self, smiles):
        return Chem.MolFromSmiles(smiles).HasSubstructMatch(self.pattern)

    def test_a_Boc_on_the_guanidine_matches(self):
        self.assertTrue(self._match(FMOC_ARG_BOC))

    def test_an_Alloc_on_the_guanidine_matches(self):
        self.assertTrue(self._match(FMOC_ARG_ALLOC))

    def test_the_SHIPPED_Pbf_block_does_NOT_match(self):
        # The remedy has to be silent, or the advice could not be taken. Pbf is an arylsulfonyl.
        self.assertFalse(self._match(FMOC_ARG_PBF),
                         "if this ever matches, every standard arginine synthesis gets flagged")

    def test_a_FREE_guanidine_does_not_match(self):
        self.assertFalse(self._match(L_ARGININE))

    def test_a_Boc_on_an_ORDINARY_amine_does_not_match(self):
        # Fmoc-Lys(Boc)-OH is a carbamate on a plain side-chain amine, with no guanidine in sight.
        self.assertFalse(self._match(FMOC_LYS_BOC), "a Boc-lysine is not a Boc-arginine")

    def test_an_Fmoc_carbamate_on_the_ALPHA_nitrogen_does_not_match_on_its_own(self):
        # Every residue in Fmoc chemistry carries an alpha carbamate; matching that would fire on
        # the whole synthesis. The pattern requires the carbamate to be ON a guanidine nitrogen.
        fmoc_ala = "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
        self.assertFalse(self._match(fmoc_ala))


class TheFlagFires(unittest.TestCase):
    def test_a_piperidine_step_raises_it(self):
        found = hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, PIPERIDINE)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_the_Alloc_variant_raises_it_too(self):
        found = hazards_for(FMOC_ARG_ALLOC, FMOC_ARG_ALLOC, PIPERIDINE)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_milder_Fmoc_removal_base_still_raises_it(self):
        # The conversion is driven by base generally, not by piperidine specifically, and nothing
        # in the sources says a milder base avoids it — so it must not clear the way aspartimide
        # does. Guards against the aspartimide clearance leaking across groups.
        found = hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, "5% piperazine in DMF, 2 x 5 min")
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_is_medium(self):
        hazard = next(h for h in hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, PIPERIDINE)
                      if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "medium", hazard)

    def test_it_names_ornithine_the_mass_and_the_shipped_remedy(self):
        hazard = next(h for h in hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, PIPERIDINE)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertIn("ornithine", words, f"name what it becomes: {words}")
        self.assertIn("42", words, f"the mass shift is the diagnostic: {words}")
        self.assertIn("pbf", words, f"name the block that ships: {words}")

    def test_it_says_nothing_downstream_can_see_it(self):
        hazard = next(h for h in hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, PIPERIDINE)
                      if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("balance", "cannot see", "invisible", "passes")),
                        f"the checks pass on the route as written: {words}")


class TheFlagStaysQuietElsewhere(unittest.TestCase):
    def test_the_shipped_Pbf_block_is_never_flagged(self):
        for conditions in (PIPERIDINE, COUPLING, "TFA/H2O 95:5, 2 h"):
            with self.subTest(conditions):
                found = hazards_for(FMOC_ARG_PBF, FMOC_ARG_PBF, conditions)
                self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_Boc_lysine_under_piperidine_is_not_flagged(self):
        found = hazards_for(FMOC_LYS_BOC, FMOC_LYS_BOC, PIPERIDINE)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_non_basic_step_does_not_raise_it(self):
        # The decomposition needs the base. An acid cleavage removes the Boc instead.
        found = hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, "TFA/H2O 95:5, 2 h")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_it_does_not_double_report_with_the_delta_lactam_flag(self):
        # Both are arginine hazards and both can be live on one residue, but they are different
        # steps: the lactam is on the activation, this is on the base. A coupling must not raise
        # this one.
        found = hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, COUPLING)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_hazard_is_not_reported_twice(self):
        found = hazards_for(FMOC_ARG_BOC, FMOC_ARG_BOC, PIPERIDINE)
        pairs = [(h["group"], h["reagentClass"]) for h in found]
        self.assertEqual(len(pairs), len(set(pairs)), f"duplicate hazard: {pairs}")


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
