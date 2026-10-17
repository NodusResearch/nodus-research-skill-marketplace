"""On-resin aggregation: say which window is suspect and where a remedy can go, never that it will.

PEPTIDE-TODO Phase 2.5 kept this item open while the other eight closed, and for a reason that is
not laziness: the literature is explicit that aggregation CANNOT be reliably predicted from
sequence. Every other gate in this package is a structural fact about one step — a pattern plus a
reagent class. This one is a property of the whole sequence, and the honest output is not a verdict
but a placement: "this window is suspect, and here are the positions in it where a remedy can
actually go."

So three things are deliberately separated here, and each is tested on its own:

  1. WHAT IS COMPUTABLE — a Kyte-Doolittle mean over a short window, and the empirical length
     window (aggregation is unlikely before about residue 5-6 from the resin, or after 21).
  2. WHERE A REMEDY COULD GO — a pseudoproline needs a Ser or Thr (occasionally Cys); backbone
     protection goes almost anywhere; the spacing rule is roughly one disrupting unit per six
     residues.
  3. WHETHER WE CAN ACTUALLY BUILD IT — which is narrower than (2) and the thing a route cares
     about. A pseudoproline is only placeable where the package ships the dipeptide for that PAIR,
     and today that is Fmoc-Ala-Ser(psiMe,Mepro)-OH alone. An advisory that names Val-Ser as a
     placement would be proposing a reagent nobody has.

The scale, the window and the statistic are NOT free parameters: PEPTIDE-RISKS.md's worked example
fixes them, and this file reproduces its numbers exactly. The CUT is a free parameter, because no
standard exists for this use — the only citable Kyte-Doolittle threshold (mean >= 1.6 over 19
residues) answers a different question, membrane spanning. The default was chosen to agree with the
two windows the author had already called suspect, and it is a named variable so disagreeing with it
is a one-line change.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import peptide_aggregation as A


class TheDocsWorkedExample(unittest.TestCase):
    """PEPTIDE-RISKS.md: 'window 1-5 (AAFFM) scores +2.22 and 2-6 +1.16, both suspect;
    pseudoproline-eligible positions are Ser7 and Thr10.' If this file cannot reproduce those
    numbers it is using a different scale or window from the one the author reasoned with."""

    SEQ = "AAFFMNSGDTH"

    def test_the_two_window_means(self):
        means = {start: round(mean, 2) for start, _text, mean in A.hydropathy_windows(self.SEQ)}
        self.assertEqual(means[1], 2.22)
        self.assertEqual(means[2], 1.16)

    def test_the_window_text_is_what_the_doc_names(self):
        windows = {start: text for start, text, _ in A.hydropathy_windows(self.SEQ)}
        self.assertEqual(windows[1], "AAFFM")
        self.assertEqual(windows[2], "AFFMN")

    def test_both_windows_are_called_suspect_by_the_default_cut(self):
        # The constraint the author's own judgment puts on the default: BOTH were called suspect,
        # so any default above 1.16 would contradict the document it came from.
        self.assertLessEqual(A.HYDROPATHY_SUSPECT, 1.16)
        flagged = [w["start"] for w in A.aggregation_advisory(self.SEQ)["suspect"]]
        self.assertIn(1, flagged)
        self.assertIn(2, flagged)

    def test_it_names_serine_7_and_threonine_10(self):
        eligible = {(p["position"], p["residue"]) for p in A.aggregation_advisory(self.SEQ)["eligible"]}
        self.assertIn((7, "S"), eligible)
        self.assertIn((10, "T"), eligible)


class TheCutIsAVariable(unittest.TestCase):
    def test_raising_it_silences_the_weaker_window(self):
        advisory = A.aggregation_advisory("AAFFMNSGDTH", suspect=1.5)
        flagged = [w["start"] for w in advisory["suspect"]]
        self.assertIn(1, flagged, "+2.22 still suspect")
        self.assertNotIn(2, flagged, "+1.16 is below 1.5")

    def test_the_strong_tier_grades_rather_than_cliffs(self):
        advisory = A.aggregation_advisory("DKRSEGVILFVILFVDKRSEG")
        self.assertTrue(any(w["level"] == "strong" for w in advisory["suspect"]),
                        f"an interior +3.9 window is strong: {advisory['suspect']}")
        mild = A.aggregation_advisory("AAFFMNSGDTH")["suspect"]
        self.assertTrue(any(w["level"] == "suspect" for w in mild), mild)

    def test_the_defaults_are_the_documented_ones(self):
        self.assertEqual(A.HYDROPATHY_WINDOW, 5)
        self.assertEqual(A.HYDROPATHY_SUSPECT, 1.0)
        self.assertEqual(A.HYDROPATHY_STRONG, 2.0)


class TheLengthWindow(unittest.TestCase):
    """Aggregation is unlikely before about residue 5-6 from the resin and after about 21. Counting
    is FROM THE RESIN, which is the C-terminus, so the orientation has to be pinned."""

    def test_a_hydrophobic_run_at_the_very_c_terminus_is_not_flagged(self):
        # Residues 1-5 from the resin: too early for the chain to aggregate.
        advisory = A.aggregation_advisory("DKRSEGNQVILFV")
        self.assertEqual(advisory["suspect"], [],
                         f"the hydrophobic run sits at residues 1-5 from the resin: {advisory}")

    def test_the_same_run_further_out_is_flagged(self):
        advisory = A.aggregation_advisory("VILFVDKRSEGNQ")
        self.assertTrue(advisory["suspect"], f"now it is residues 9-13 from the resin: {advisory}")

    def test_positions_are_counted_from_the_resin(self):
        # A 7-mer: the LAST residue written is residue 1, because that is the one anchored.
        self.assertEqual(A.residue_positions("QWRCSGA"),
                         [(7, "Q"), (6, "W"), (5, "R"), (4, "C"), (3, "S"), (2, "G"), (1, "A")])

    def test_the_bounds_are_variables_too(self):
        self.assertEqual((A.AGGREGATION_FIRST_RESIDUE, A.AGGREGATION_LAST_RESIDUE), (5, 21))
        advisory = A.aggregation_advisory("DKRSEGNQVILFV", first_residue=1)
        self.assertTrue(advisory["suspect"], "with the bound lifted, the early run shows")


class WhatCanActuallyBePlaced(unittest.TestCase):
    """The distinction that keeps the advice honest: eligible by chemistry is not the same as
    buildable with what ships."""

    def test_eligibility_is_about_the_RESIDUE_not_the_position(self):
        # The distinction the risk notes draw and an earlier draft of this module collapsed: both
        # Ser7 and Thr10 are eligible, and only Ser7 is in reach of the suspect window. Thr10 sits
        # two residues from the resin, too early for the chain to aggregate, so it is eligible and
        # not recommended -- which is exactly what the document says about it by saying nothing.
        advisory = A.aggregation_advisory("AAFFMNSGDTH")
        self.assertEqual({(p["position"], p["residue"]) for p in advisory["eligible"]},
                         {(7, "S"), (10, "T")})
        self.assertEqual([p["position"] for p in advisory["recommended"]], [7])

    def test_an_alanine_serine_pair_is_placeable_today(self):
        # Fmoc-Ala-Ser(psiMe,Mepro)-OH ships, so this one can actually be ordered.
        placeable = A.aggregation_advisory("VILFVILFASDKRSEG")["placeable"]
        self.assertTrue(any(p["block"] == "Fmoc-Ala-Ser(psiMe,Mepro)-OH" for p in placeable),
                        f"placeable was {placeable}")

    def test_a_valine_serine_pair_is_eligible_but_NOT_placeable(self):
        advisory = A.aggregation_advisory("VILFVILFVSDKRSEG")
        self.assertTrue(any(p["residue"] == "S" for p in advisory["eligible"]),
                        "a serine is eligible by chemistry")
        self.assertEqual([p for p in advisory["placeable"] if p["residue"] == "S"], [],
                         "but no Val-Ser pseudoproline block ships, so nothing can be ordered")

    def test_the_advisory_says_so_rather_than_going_quiet(self):
        advisory = A.aggregation_advisory("VILFVILFVSDKRSEG")
        self.assertTrue(advisory["notes"], "an eligible-but-unbuildable position needs saying")
        self.assertTrue(any("ships" in note or "block" in note for note in advisory["notes"]),
                        f"notes were {advisory['notes']}")


class ItRefusesToOverclaim(unittest.TestCase):
    def test_an_ordinary_hydrophilic_sequence_says_nothing(self):
        advisory = A.aggregation_advisory("QWRCSGADKRSEGNQD")
        self.assertEqual(advisory["suspect"], [], f"no wallpaper: {advisory}")

    def test_todays_measured_route_is_silent(self):
        # QWRCSGA, the hazard route: peak hydropathy -0.28. It trips six other gates and must not
        # trip this one.
        self.assertEqual(A.aggregation_advisory("QWRCSGA")["suspect"], [])

    def test_the_verdict_word_is_never_will(self):
        advisory = A.aggregation_advisory("VILFVILFASDKRSEG")
        blob = " ".join(advisory["notes"]).lower()
        self.assertNotIn("will aggregate", blob, f"it is a suspicion, not a finding: {blob}")
        self.assertTrue(any(k in blob for k in ("suspect", "cannot be predicted", "heuristic")), blob)

    def test_a_short_peptide_is_never_flagged(self):
        for sequence in ("A", "AA", "AAFF"):
            self.assertEqual(A.aggregation_advisory(sequence)["suspect"], [], sequence)

    def test_an_unknown_letter_is_reported_not_guessed(self):
        advisory = A.aggregation_advisory("AAFFMXNSGDTH")
        self.assertTrue(any("X" in note for note in advisory["notes"]), advisory["notes"])



class OverlappingWindowsCollapse(unittest.TestCase):
    """A hydrophobic run produces a window at every offset inside it. Six lines saying one thing is
    wallpaper; what a reader needs is the stretch and its worst point."""

    def test_six_windows_become_one_span(self):
        advisory = A.aggregation_advisory("VILFVILFASDKRSEG")
        self.assertGreater(len(advisory["suspect"]), 1, "the detail is still there")
        self.assertEqual(len(advisory["spans"]), 1, f"collapsed: {advisory['spans']}")

    def test_the_span_carries_the_peak_not_the_first_window(self):
        advisory = A.aggregation_advisory("VILFVILFASDKRSEG")
        span = advisory["spans"][0]
        self.assertEqual(span["peak"], max(w["mean"] for w in advisory["suspect"]))
        self.assertEqual(span["from"], 1)
        self.assertEqual(span["to"], max(w["start"] for w in advisory["suspect"]) + 4)

    def test_two_separate_runs_stay_separate(self):
        # Hydrophobic, a hydrophilic gap wider than one window, hydrophobic again.
        advisory = A.aggregation_advisory("GSVILFVDKRSEGQNDKVILFVSGQND", first_residue=1,
                                          last_residue=40)
        self.assertEqual(len(advisory["spans"]), 2, f"two runs: {advisory['spans']}")

    def test_nothing_suspect_means_no_spans(self):
        self.assertEqual(A.aggregation_advisory("QWRCSGADKRSEGNQD")["spans"], [])


class TheEntryPointForTheRoutePath(unittest.TestCase):
    QWRCSGA = ("N[C@@H](CCC(N)=O)C(=O)N[C@@H](Cc1c[nH]c2ccccc21)C(=O)N[C@@H](CCCNC(N)=N)C(=O)"
               "N[C@@H](CS)C(=O)N[C@@H](CO)C(=O)NCC(=O)N[C@@H](C)C(=O)O")

    def test_a_peptide_target_is_read_and_advised_in_one_call(self):
        out = A.advise_for_target(self.QWRCSGA)
        self.assertTrue(out["applies"])
        self.assertEqual(out["sequence"], "QWRCSGA")
        self.assertIsNone(out["problem"])
        self.assertEqual(out["spans"], [], "hydrophilic: nothing to report")

    def test_a_small_molecule_does_not_apply_at_all(self):
        # A hydropathy window over aspirin is meaningless, and the gate has to say so rather than
        # returning an empty advisory that reads like a clean bill of health.
        out = A.advise_for_target("CC(=O)Oc1ccccc1C(=O)O")
        self.assertFalse(out["applies"])
        self.assertTrue(out["problem"])
        self.assertEqual(out["notes"], [])

    def test_a_partial_read_applies_but_says_so(self):
        abu = "N[C@@H](CC)C(=O)N[C@@H](C)C(=O)N[C@@H](CO)C(=O)O"
        out = A.advise_for_target(abu)
        self.assertTrue(out["applies"], "it IS a peptide, so the advisory applies")
        self.assertTrue(out["problem"])
        self.assertTrue(out["notes"][0].startswith("Partial read"), out["notes"][:1])


# `unittest.main()` stays at the END of the file. It was mid-file once and
# the two classes appended after it were silently never collected — the run
# reported OK on 20 tests while 7 more did not exist as far as the runner was
# concerned. Same trap as test_route_program.py.
if __name__ == "__main__":
    unittest.main()
