"""Coverage over the reagents real routes actually write, so the next gap fails loudly.

WHY THIS EXISTS. Three times in one day a hazard gate turned out to be unreachable for the same
reason, and never because the gate was wrong:

  * TBTU, HCTU, COMU and PyAOP were in no pattern, so a step whose only activator was one of them
    reached no coupling gate.
  * `\\bpiperidine\\b` matches neither "4-methylpiperidine" nor "piperazine", so a route using the
    milder Fmoc-removal bases the aspartimide literature RECOMMENDS reached no amine-base gate at
    all — not aspartimide, not the diketopiperazine, not the C-terminal cysteine racemisation.
  * AcOH/TFE/DCM and HFIP/DCM, the standard mild cleavage cocktails, had no class, so a route
    cleaving from 2-chlorotrityl reached nothing.

The shape is always the same and it is the dangerous kind: **a reagent nobody wrote a pattern for
does not fail loudly. `classify` returns [] and the step quietly reaches no gate.** Nothing in the
suite was red, because a hazard that cannot fire cannot fail a test that only checks firing.

HOW THE LIST WAS BUILT, which matters more than its length. It is not from memory. Every step of
every route in `harness-runs/` was mined — 1215 steps across 77 runs — `classify` was run over each
one's prose and Agents line, and the 296 that returned [] were tokenised to see WHAT was in them.
`chlorochromate` appeared 19 times, `methanesulfonyl` 12 and `mesylate` 15. So the entries below are
reagents this project's own routes have written and the classifier could not read.

THE SECOND HALF IS THE MORE USEFUL ONE. `DELIBERATELY_UNCLASSIFIED` asserts that certain reagents
classify as NOTHING, with the reason. That is not pedantry: `amine-base` carries
`("fmoc", "high", "is cleaved by amine base")`, so adding DIPEA or triethylamine to it — the
obvious-looking fix when a coupling step "fails to classify" — would report a high-severity Fmoc
cleavage on EVERY coupling in EVERY peptide route, and high-severity hazards are the ones that
reach the model's fix lines. That mistake is now impossible to make silently.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import compat_tables as T

# reagent text -> the class it must be read as. Written the way a route writes it, including the
# spelled-out forms, because the spelled-out form is what the harness data showed routes using.
EXPECTED = {
    # --- peptide coupling. The gap that started this: a step whose only activator was one of
    # these reached no coupling gate, so none of the activation hazards could fire.
    "HBTU, DIPEA, DMF": "acylating",
    "HATU, DIPEA, DMF": "acylating",
    "TBTU, NMM, DMF": "acylating",
    "HCTU, NMM, DMF": "acylating",
    "COMU, DIPEA, DMF": "acylating",
    "PyBOP, DIPEA, DMF": "acylating",
    "PyAOP, DIPEA, DMF": "acylating",
    "DIC, Oxyma, DMF": "acylating",
    "DCC, DMAP, DCM": "acylating",
    "EDC, HOBt, DMF": "acylating",
    "T3P, pyridine": "acylating",
    "acetic anhydride, pyridine": "acylating",
    "acetyl chloride, DCM": "acylating",

    # --- Fmoc removal. `\bpiperidine\b` does not match the first two.
    "20% piperidine in DMF": "amine-base",
    "5% piperazine in DMF": "amine-base",
    "20% 4-methylpiperidine in DMF": "amine-base",
    "20% dipropylamine in DMF": "amine-base",
    "2% DBU in DMF": "amine-base",
    "morpholine, DMF": "amine-base",

    # --- acid cleavage, concentrated. TMSBr and Reagent K are named in our OWN remedy text for the
    # free-indole hazard, and classified as nothing, so a route that took our advice reached no gate.
    "TFA/H2O 95:5, 2 h": "strong-acid",
    "Reagent K: TFA/phenol/water/thioanisole/EDT 82.5:5:5:5:2.5": "strong-acid",
    "Reagent B: TFA/phenol/water/TIS 88:5:5:2": "strong-acid",
    "TMSBr/TFA, m-cresol, EDT, thioanisole, 0 C, 15 min": "strong-acid",
    # The BARE forms, which is where the gap actually was: both of these name no acid at all to a
    # pattern matcher, and both are reagents our own free-indole remedy text recommends.
    "TMSBr": "strong-acid",
    "cleave with Reagent K, 3 h": "strong-acid",
    "Reagent B, 2 h": "strong-acid",
    "HF, anisole, 0 C": "fluoride",

    # --- mild acid, the super-acid-labile regime.
    "AcOH/TFE/DCM 1:2:7, 1 h": "mild-acid",
    "20% HFIP in DCM, 2 x 15 min": "mild-acid",
    "TFE/DCM 2:8, 2-chlorotrityl resin": "mild-acid",

    # --- oxidants. PCC as an acronym was read and "pyridinium chlorochromate" was not, which is
    # the asymmetry the harness data caught: routes spell it out.
    "PCC, DCM, rt": "chromium-oxidant",
    "pyridinium chlorochromate in dichloromethane, rt": "chromium-oxidant",
    "pyridinium dichromate, DMF": "chromium-oxidant",
    "Jones reagent (CrO3/H2SO4)": "chromium-oxidant",
    "KMnO4, water": "chromium-oxidant",
    "Dess-Martin periodinane, DCM": "alcohol-oxidant",
    "TEMPO/NaOCl, DCM": "alcohol-oxidant",
    "Swern oxidation: DMSO, oxalyl chloride, Et3N, -78 C": "alcohol-oxidant",
    "mCPBA, DCM, 0 C": "peracid",
    "30% H2O2, AcOH": "peracid",

    # --- reductants.
    "sodium borohydride, MeOH": "mild-hydride",
    "lithium aluminium hydride, THF": "strong-hydride",
    "DIBAL-H, toluene, -78 C": "dibal",
    "BH3.THF": "borane",
    "H2 (1 atm), Pd/C, EtOH": "hydrogenation",

    # --- bases that are NOT amine bases.
    "sodium hydride, THF": "strong-base",
    "LDA, THF, -78 C": "strong-base",
    "sodium ethoxide in ethanol, 0-5 C": "alkoxide",
    "aqueous sodium hydroxide, heat": "hydroxide",

    # --- leaving-group formation. A sulfonyl chloride acylates a heteroatom but does NOT activate
    # a carboxyl for peptide coupling, so it is its own class; see the test below.
    "MsCl, Et3N, DCM, 0 C": "sulfonylating",
    "methanesulfonyl chloride, triethylamine, DCM": "sulfonylating",
    "TsCl, pyridine": "sulfonylating",
    "p-toluenesulfonyl chloride, pyridine, 0 C": "sulfonylating",
    "tosyl chloride, NEt3, DCM": "sulfonylating",
    "Tf2O, 2,6-lutidine, DCM, -78 C": "sulfonylating",
    "thionyl chloride, reflux": "deoxyhalogenation",
    "PBr3, ether": "deoxyhalogenation",
}

# reagent text -> why it must stay unread. Asserting the ABSENCE, so that adding a pattern for one
# of these becomes a deliberate act with a test to change rather than a quiet one-line edit.
DELIBERATELY_UNCLASSIFIED = {
    # The trap. `amine-base` carries ("fmoc", "high", "is cleaved by amine base"), and these bases
    # do NOT cleave Fmoc. Classifying them there would raise a high-severity Fmoc hazard on every
    # coupling in every peptide route, and high severity is what reaches the model's fix lines.
    "DIPEA, DMF": "a coupling's auxiliary base does not cleave Fmoc; the step classifies via its activator",
    "N,N-diisopropylethylamine, DMF": "the same base spelled out; still does not cleave Fmoc",
    "triethylamine, DCM": "an auxiliary base for an acylation, not a deprotection reagent",
    "Et3N, DCM": "triethylamine again, abbreviated; an auxiliary base and nothing more",
    "NMM, DMF": "N-methylmorpholine, a coupling base; does not cleave Fmoc the way morpholine does",
    "DMAP, DCM": "an acylation catalyst; the step classifies via the acylating agent",
    "pyridine, DCM": "solvent and auxiliary base",
    "2,4,6-collidine, DMF": "a weaker coupling base; read directly by has_epimerisation_care, not by a class",

    # Additives are read from the text by the helpers that care, not through a reagent class,
    # because what matters is which hazard they suppress or catalyse rather than what they attack.
    "HOBt, DMF": "an additive, not an activator; read by has_pyroglutamate_catalyst and has_aspartimide_care",
    "Oxyma, DMF": "same; read by has_aspartimide_care, and deliberately absent from the pyroglutamate catalysts",
    "HOAt, DMF": "an additive like HOBt; read from the text by the helpers, not through a class",

    # No class exists for these yet, and inventing one without its hazard set would be a class
    # that classifies and still reaches no gate — the same defect in a new place.
    "sodium cyanide in DMSO, 60 C": "no nucleophile class yet; needs its own hazard set and reading",
    "KCN, EtOH/water": "no nucleophile class yet; the same gap as sodium cyanide above",
    "sodium azide, DMF": "no nucleophile class yet; would need its own hazard set first",
    "hydroxylamine hydrochloride, pyridine, EtOH": "condenses with carbonyls; no class covers that, and inventing one without its hazards would classify and still reach no gate",
    "hydrazine hydrate, EtOH": "condenses with carbonyls and cleaves Dde; no class covers either yet",

    # Solvents must never classify, or every step classifies as something.
    "DMF, 45 min, rt": "a solvent must never classify, or every step in every route classifies as something",
    "dichloromethane, rt, 1 h": "a solvent; it appeared 57 times in the unclassified harness steps, correctly so",
    "ethanol, reflux": "a solvent, and the commonest token in the unclassified steps; correctly unread",
    "heated in water, 60-80 C": "a thermal step with no reagent at all, such as a decarboxylation",
}


class EveryReagentARouteWritesIsRead(unittest.TestCase):
    def test_each_entry_classifies_as_the_class_it_should(self):
        missing, wrong = [], []
        for text, expected in EXPECTED.items():
            got = T.classify(text)
            if not got:
                missing.append(text)
            elif expected not in got:
                wrong.append((text, expected, got))
        self.assertEqual(missing, [], f"{len(missing)} reagent(s) reach NO gate at all: {missing}")
        self.assertEqual(wrong, [], f"classified, but not as expected: {wrong}")

    def test_the_spelled_out_form_is_read_wherever_the_acronym_is(self):
        # The asymmetry the harness data caught: `PCC` was read and `pyridinium chlorochromate` was
        # not, and routes spell it out — 19 occurrences in the mined steps.
        for acronym, spelled in (("PCC, DCM", "pyridinium chlorochromate, DCM"),
                                 ("PDC, DMF", "pyridinium dichromate, DMF"),
                                 ("MsCl, Et3N", "methanesulfonyl chloride, triethylamine"),
                                 ("TsCl, pyridine", "p-toluenesulfonyl chloride, pyridine"),
                                 ("DIBAL-H, toluene", "diisobutylaluminium hydride, toluene"),
                                 ("LiAlH4, THF", "lithium aluminium hydride, THF")):
            with self.subTest(spelled):
                self.assertEqual(set(T.classify(acronym)), set(T.classify(spelled)),
                                 f"{acronym!r} and {spelled!r} must be read the same")


class WhatMustStayUnread(unittest.TestCase):
    def test_each_entry_still_classifies_as_nothing(self):
        leaked = {text: T.classify(text) for text in DELIBERATELY_UNCLASSIFIED if T.classify(text)}
        self.assertEqual(leaked, {}, "these must stay unread — see the reason beside each entry in "
                                     f"DELIBERATELY_UNCLASSIFIED: {leaked}")

    def test_an_auxiliary_amine_base_is_NEVER_read_as_amine_base(self):
        """The specific false positive this file exists to prevent.

        `amine-base` carries the Fmoc cleavage at HIGH severity. A coupling names DIPEA or NMM, so
        if either were classified there, every coupling step in every peptide route would report
        that its Fmoc is being cleaved — at the severity that reaches the model's fix lines.
        """
        for text in ("DIPEA, DMF", "triethylamine, DCM", "NMM, DMF", "pyridine, DCM",
                     "N,N-diisopropylethylamine, DMF"):
            with self.subTest(text):
                self.assertNotIn("amine-base", T.classify(text))

    def test_and_the_bases_that_DO_cleave_fmoc_are_read_as_amine_base(self):
        # The other side of the same line, so the distinction is pinned from both directions.
        for text in ("20% piperidine in DMF", "5% piperazine in DMF",
                     "20% 4-methylpiperidine in DMF", "2% DBU in DMF"):
            with self.subTest(text):
                self.assertIn("amine-base", T.classify(text))


class TheSulfonylatingClassIsNotTheAcylatingOne(unittest.TestCase):
    """A sulfonyl chloride acylates a heteroatom; it does not activate a carboxyl.

    Putting MsCl into `acylating` was the obvious move and it is wrong: that class carries the
    peptide ACTIVATION risks — the arginine lactam, the cysteine and histidine epimerisations, the
    pyroglutamate and capping paths — all of which are about a carboxyl being activated for a
    coupling. A mesylation of a serine hydroxyl activates nothing, so those must stay silent while
    the heteroatom hazards still fire.
    """

    MSCL = "MsCl, Et3N, DCM, 0 C"

    def test_it_is_its_own_class(self):
        self.assertIn("sulfonylating", T.classify(self.MSCL))
        self.assertNotIn("acylating", T.classify(self.MSCL))

    def test_it_attacks_the_heteroatoms_a_sulfonyl_chloride_really_does(self):
        attacked = {group for group, _severity, _why in T.ATTACKS.get("sulfonylating", [])}
        for group in ("amine", "alcohol", "phenol", "thiol", "free-alpha-carboxyl"):
            with self.subTest(group):
                self.assertIn(group, attacked)

    def test_it_carries_NONE_of_the_peptide_activation_risks(self):
        risks = {group for group, _s, _w in T.ACTIVATION_RISKS.get("sulfonylating", [])}
        self.assertEqual(risks, set(), f"a sulfonylation activates no carboxyl: {risks}")

    def test_a_mesylation_of_a_serine_peptide_raises_the_carboxyl_flag_not_the_lactam(self):
        import reactions_worker as W
        # Ser-Arg with a free C-terminal acid and a free side-chain hydroxyl: the real case, where
        # the step means to mesylate the hydroxyl and the carboxylate is the competing site.
        # Ser-Arg with a free C-terminal acid and a free side-chain hydroxyl, and the product with
        # that hydroxyl MESYLATED. A real reactant/product pair, not the same molecule twice: the
        # alpha-carboxyl hazard only fires when the step is actually masking an alcohol, so handing
        # the same molecule in as both sides made it silent and the first version of this test
        # failed for that reason rather than for the one it was written to check.
        peptide = "NC(=N)NCCC[C@@H](C(=O)O)NC(=O)[C@@H](N)CO"
        mesylated = "NC(=N)NCCC[C@@H](C(=O)O)NC(=O)[C@@H](N)COS(C)(=O)=O"
        found = {h["group"] for h in W._compatibility(
            [{"reactants": [peptide], "products": [mesylated], "reagents": self.MSCL}])[0]["hazards"]}
        self.assertIn("free-alpha-carboxyl", found, f"hazards were {found}")
        self.assertNotIn("arg-delta-lactam", found,
                         "a mesylation does not activate the arginine's carboxyl")


class TheAuditItselfIsHonest(unittest.TestCase):
    def test_the_two_lists_do_not_overlap(self):
        overlap = set(EXPECTED) & set(DELIBERATELY_UNCLASSIFIED)
        self.assertEqual(overlap, set(), f"an entry cannot be both: {overlap}")

    def test_every_expected_class_is_a_real_class(self):
        known = {cls for cls, _label, _patterns in T.REAGENT_CLASSES}
        unknown = {cls for cls in EXPECTED.values() if cls not in known}
        self.assertEqual(unknown, set(), f"EXPECTED names classes that do not exist: {unknown}")

    def test_every_deliberate_exclusion_carries_a_reason(self):
        for text, reason in DELIBERATELY_UNCLASSIFIED.items():
            with self.subTest(text):
                self.assertGreater(len(reason), 20, f"{text!r} needs a real reason, got {reason!r}")


# Appended tests have been stranded twice in this directory by a `unittest.main()` sitting
# mid-file. It stays last.
if __name__ == "__main__":
    unittest.main()
