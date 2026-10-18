"""Guanidino capping: a uronium coupling reagent caps the chain's own N-terminus.

The hazard. HBTU, TBTU, HATU and HCTU are uronium/guanidinium salts, and they will react with a
free amine directly if they meet one before they meet the carboxylic acid they were added to
activate. The adduct is a tetramethylguanidino group on the chain's N-terminus, it is stable to
everything that follows, and *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3
Section 9.2.9 (printed p. 339) is explicit that it "survives the final cleavage as well". So the
result is a CAPPED chain: truncated at that residue, +98 mass units, and no further coupling can
touch it.

What makes it gateable rather than wallpaper is that the source names the protocol detail, not just
the reagent:

    "The reaction occurs if the coupling agent is added in solution to the resin BEFORE the
     incoming amino acid or if the coupling agent is used IN EXCESS with respect to the amino
     acid."

Every coupling in every synthesis has a free amine being acylated — that is what a coupling is —
so a gate on "uronium salt plus free amine" would fire on all of them and say nothing. This one
therefore needs BOTH a uronium/guanidinium reagent AND an explicit pre-activation or pre-mix in the
conditions. A route that activates in situ does not raise it.

Two deliberate limits, so the gate does not overclaim:

  * EQUIVALENTS ARE NOT READ. "HBTU (3 eq), amino acid (2 eq)" is the source's other trigger, and
    parsing it reliably is the same trap as temperature and time, which this package already
    refuses to read: "3 eq" and "2 eq" differ by one character, and misparsing one would silence a
    flag on a route that deserves it. Recorded as a gap rather than guessed at.
  * PHOSPHONIUM SALTS ARE EXCLUDED. PyBOP and PyAOP have no electrophilic carbon of this kind and
    the source contrasts them with the uronium salts, so they must stay silent — and switching to
    one is part of the remedy, which only works if it clears the flag.
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

GROUP = "n-terminal-amine-capping"

# A resin-bound dipeptide with its N-terminus free: H-Ala-Gly-O-resin. The free alpha-amine sits on
# a residue whose carbonyl is an AMIDE, which is what distinguishes a chain from a loose monomer.
CHAIN_FREE_N = "*OC(=O)CNC(=O)[C@H](C)N"
# The same chain after the coupling, N-terminus acylated by the incoming residue.
CHAIN_COUPLED = "*OC(=O)CNC(=O)[C@H](C)NC(=O)[C@H](C)NC(=O)OCC1c2ccccc2-c2ccccc21"
# The incoming monomer: Fmoc on the nitrogen, so it carries NO free alpha-amine of its own.
FMOC_ALA = "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13"
# A loose amino acid, free amine AND free acid, no amide. Must not read as a chain N-terminus.
L_ALANINE = "C[C@@H](C(=O)O)N"

PREACTIVATED_URONIUM = "Fmoc-Ala-OH, HBTU, DIPEA, DMF, pre-activate 5 min then add to the resin"
IN_SITU_URONIUM = "Fmoc-Ala-OH, HBTU, DIPEA, DMF, added in situ, 45 min"
PREACTIVATED_PHOSPHONIUM = "Fmoc-Ala-OH, PyBOP, DIPEA, DMF, pre-activate 5 min then add to the resin"
PREACTIVATED_CARBODIIMIDE = "Fmoc-Ala-OH, DIC, Oxyma, DMF, pre-activate 5 min then add to the resin"


def hazards_for(reactants, products, reagents):
    out = W._compatibility([{"reactants": reactants, "products": products, "reagents": reagents}])
    assert len(out) == 1, "one step in, one step out"
    return out[0]["hazards"]


def groups_in(hazards):
    return {h["group"] for h in hazards}


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


class TheSubstratesAreWhatTheyClaim(unittest.TestCase):
    def test_the_formulas_are_pinned(self):
        # The resin is the dummy atom the package's own `resin-cleavage` transform uses, so the
        # formula carries a `*`.
        self.assertEqual(formula(CHAIN_FREE_N), "C5H9*N2O3")
        self.assertEqual(formula(FMOC_ALA), "C18H17NO4")
        self.assertEqual(formula(L_ALANINE), "C3H7NO2")

    def test_the_pattern_compiles(self):
        self.assertIsNotNone(Chem.MolFromSmarts(T.GROUPS[GROUP][1]))


class ThePatternIsAChainNTerminus(unittest.TestCase):
    def setUp(self):
        self.pattern = Chem.MolFromSmarts(T.GROUPS[GROUP][1])

    def _match(self, smiles):
        return Chem.MolFromSmiles(smiles).HasSubstructMatch(self.pattern)

    def test_a_chain_with_a_free_N_terminus_matches(self):
        self.assertTrue(self._match(CHAIN_FREE_N))

    def test_a_LOOSE_AMINO_ACID_does_not_match(self):
        # The distinction the pattern turns on: a monomer's carbonyl is an acid, a chain's is an
        # amide. Without this the gate would fire on the incoming residue of every coupling.
        self.assertFalse(self._match(L_ALANINE), "a free amino acid is not a chain N-terminus")

    def test_an_Fmoc_protected_monomer_does_not_match(self):
        self.assertFalse(self._match(FMOC_ALA))

    def test_an_ALREADY_COUPLED_chain_does_not_match(self):
        self.assertFalse(self._match(CHAIN_COUPLED), "there is no free amine left to cap")

    def test_a_side_chain_amine_alone_does_not_match(self):
        # Fmoc-Lys-OH with a free side-chain amine: a real free amine, but four carbons from the
        # carbonyl rather than on the alpha carbon, so it is not an N-terminus.
        lysine = "NCCCC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21"
        self.assertFalse(self._match(lysine))


class TheFlagFires(unittest.TestCase):
    def test_a_PREACTIVATED_uronium_coupling_raises_it(self):
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_URONIUM)
        self.assertIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_every_uronium_and_guanidinium_salt_the_source_names(self):
        for reagent in ("HBTU", "TBTU", "HATU", "HCTU"):
            with self.subTest(reagent):
                conditions = f"Fmoc-Ala-OH, {reagent}, DIPEA, DMF, pre-activate 5 min then add resin"
                found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], conditions)
                self.assertIn(GROUP, groups_in(found), f"{reagent}: {groups_in(found)}")

    def test_it_is_medium(self):
        hazard = next(h for h in hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED],
                                             PREACTIVATED_URONIUM) if h["group"] == GROUP)
        self.assertEqual(hazard["severity"], "medium", hazard)

    def test_it_says_the_chain_is_CAPPED_and_names_the_mass(self):
        hazard = next(h for h in hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED],
                                             PREACTIVATED_URONIUM) if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("cap", "truncat")), f"say what happens: {words}")
        self.assertIn("98", words, f"the mass shift is the diagnostic: {words}")

    def test_the_remedy_names_all_three_ways_out(self):
        hazard = next(h for h in hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED],
                                             PREACTIVATED_URONIUM) if h["group"] == GROUP)
        words = f"{hazard['why']} {hazard.get('suggestion') or ''}".lower()
        self.assertTrue(any(k in words for k in ("in situ", "in-situ", "pre-mix", "premix")),
                        f"name the protocol fix: {words}")
        self.assertTrue(any(k in words for k in ("pybop", "phosphonium")),
                        f"name the reagent class that cannot do this: {words}")
        self.assertTrue(any(k in words for k in ("equivalent", " eq", "excess")),
                        f"name the stoichiometry fix: {words}")


class TheFlagStaysQuietElsewhere(unittest.TestCase):
    def test_explicitly_omitting_preactivation_does_not_trigger_the_flag(self):
        for protocol in ("no pre-activation", "in situ, without premixing", "no pre-mixing"):
            with self.subTest(protocol=protocol):
                found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED],
                                    f"HBTU, DIPEA, DMF, {protocol}")
                self.assertNotIn(GROUP, groups_in(found), found)

    def test_an_IN_SITU_uronium_coupling_is_silent(self):
        # The whole point of the guard. This is the standard protocol and it must not be nagged.
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], IN_SITU_URONIUM)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_plain_uronium_coupling_with_no_protocol_detail_is_silent(self):
        # Conservative on purpose: most routes say neither "in situ" nor "pre-activate", and
        # flagging all of them would be wallpaper on every coupling in every synthesis.
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], "HBTU, DIPEA, DMF, 45 min")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_PHOSPHONIUM_salt_is_silent_even_pre_activated(self):
        # Vol 3 contrasts the phosphonium salts with the uronium ones, and switching to one is part
        # of the remedy — so it has to clear the flag or the advice cannot be taken.
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_PHOSPHONIUM)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_CARBODIIMIDE_coupling_is_silent_even_pre_activated(self):
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_CARBODIIMIDE)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_non_coupling_step_is_silent(self):
        found = hazards_for([CHAIN_FREE_N], [CHAIN_FREE_N], "20% piperidine in DMF, 2 x 5 min")
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")

    def test_a_chain_with_no_free_N_terminus_is_silent(self):
        found = hazards_for([CHAIN_COUPLED, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_URONIUM)
        self.assertNotIn(GROUP, groups_in(found), f"hazards were {groups_in(found)}")


class ItDoesNotDisturbWhatWasAlreadyThere(unittest.TestCase):
    def test_the_generic_amine_flag_is_not_printed_beside_it(self):
        # One flag per site, the same rule `free-alpha-carboxyl` applies to the generic `acid`
        # entry: both match the same nitrogen, and the generic wording says nothing about capping.
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_URONIUM)
        pairs = [(h["group"], h["reagentClass"]) for h in found]
        self.assertIn(GROUP, groups_in(found))
        self.assertNotIn("amine", groups_in(found), f"generic amine printed too: {pairs}")

    def test_a_hazard_is_not_reported_twice(self):
        found = hazards_for([CHAIN_FREE_N, FMOC_ALA], [CHAIN_COUPLED], PREACTIVATED_URONIUM)
        pairs = [(h["group"], h["reagentClass"]) for h in found]
        self.assertEqual(len(pairs), len(set(pairs)), f"duplicate hazard: {pairs}")

    def test_HCTU_is_recognised_as_a_coupling_reagent_at_all(self):
        # Found while writing this suite: `classify` did not know HCTU, so a step whose only
        # activator was HCTU classified as NO reagent class and reached none of the gates.
        self.assertIn("acylating", T.classify("Fmoc-Ala-OH (3 eq), HCTU (3 eq), NMM, DMF"))


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
