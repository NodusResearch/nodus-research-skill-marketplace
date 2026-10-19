"""Asn deamidation under piperidine: the Asn-Gly and Asn-Ser motifs.

The side-chain amide closes on the next backbone nitrogen to form a succinimide, which hydrolyses
to Asp or iso-Asp. The pattern is a sequence motif, so the gate distinguishes the literature's
neighbouring residues (Gly, Ser) from an Asn-Ala control and from a protected Asn(Trt) whose amide
is secondary.
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

ASN_GLY = "NC(=O)C[C@H](N)C(=O)NCC(=O)O"
ASN_SER = "NC(=O)C[C@H](N)C(=O)N[C@@H](CO)C(=O)O"
ASN_ALA = "NC(=O)C[C@H](N)C(=O)N[C@@H](C)C(=O)O"


def groups_for(reactant, reagents):
    out = W._compatibility([{"reactants": [reactant], "products": [reactant], "reagents": reagents}])
    return {h["group"] for h in out[0]["hazards"]}


class TheTwoDeamidationMotifsAreGated(unittest.TestCase):
    def test_asn_gly_and_asn_ser_fire_under_piperidine(self):
        self.assertIn("asn-deamidation-gly", groups_for(ASN_GLY, "20% piperidine in DMF"))
        self.assertIn("asn-deamidation-ser", groups_for(ASN_SER, "20% piperidine in DMF"))

    def test_asn_ala_is_silent(self):
        self.assertNotIn("asn-deamidation-gly", groups_for(ASN_ALA, "20% piperidine in DMF"))
        self.assertNotIn("asn-deamidation-ser", groups_for(ASN_ALA, "20% piperidine in DMF"))

    def test_coupling_activators_do_not_raise_the_base_gate(self):
        # The acylating path has its own `asn-gln-amide` dehydration gate; deamidation is the
        # piperidine case and must not also fire on a coupling.
        found = groups_for(ASN_GLY, "HBTU, DIPEA, DMF")
        self.assertNotIn("asn-deamidation-gly", found)

    def test_the_mass_signature_is_the_asn_to_asp_hydrolysis(self):
        for group in ("asn-deamidation-gly", "asn-deamidation-ser"):
            with self.subTest(group=group):
                self.assertEqual(T.MASS_SHIFTS[group]["delta"], 1)
                self.assertIn("iso-Asp", T.MASS_SHIFTS[group]["note"])


if __name__ == "__main__":
    unittest.main()
