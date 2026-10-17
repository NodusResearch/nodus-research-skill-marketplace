"""On-resin aggregation: which window is suspect, and where a remedy could actually go.

The one sequence-dependent risk in this package that is NOT a structural gate. Every other hazard
is a fact about one step — a pattern plus a reagent class — and can be answered yes or no. This one
cannot: the literature is explicit that aggregation is not reliably predictable from sequence, so
anything said here is a suspicion. The useful output is therefore not "this will aggregate" but
"this window is suspect, and here are the positions in it where a remedy can be placed."

WHAT IS AND IS NOT A FREE PARAMETER

The scale (Kyte-Doolittle 1982), the window (5 residues) and the statistic (the mean) are fixed by
the worked example in the project's own risk notes, and the tests reproduce its numbers to two
decimals. The CUT is free, because no standard exists for this use: the only citable
Kyte-Doolittle threshold is a mean of 1.6 over NINETEEN residues, and that answers a different
question — whether a segment spans a membrane. The default below was chosen to agree with the two
windows the author had already called suspect (+2.22 and +1.16), which puts a ceiling of 1.16 on
any default that does not contradict the document it came from.

So every number here is a named module-level variable, and every function takes it as a keyword
argument. Disagreeing with one is a one-line change with the reasoning attached, not an excavation.

TWO NUMBERINGS, DELIBERATELY

Positions in `eligible` and the `start` of a window are 1-based from the N-terminus, as written —
that is how the risk notes name Ser7 and Thr10, and matching them matters more than internal
tidiness. The LENGTH window is counted from the resin, because that is the physical quantity: a
chain aggregates once enough of it has been built. Each position therefore also carries
`from_resin`, and `residue_positions` exists to make the conversion explicit rather than implied.
"""

# Kyte & Doolittle, J. Mol. Biol. 157 (1982) 105: hydropathy, positive being hydrophobic.
KYTE_DOOLITTLE = {
    "A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5, "Q": -3.5, "E": -3.5, "G": -0.4,
    "H": -3.2, "I": 4.5, "L": 3.8, "K": -3.9, "M": 1.9, "F": 2.8, "P": -1.6, "S": -0.8,
    "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2,
}

HYDROPATHY_WINDOW = 5
# A convention, not a citation. See the module docstring: <= 1.16 to stay consistent with the two
# windows the risk notes already call suspect, and high enough to stay silent on an ordinary
# hydrophilic sequence.
HYDROPATHY_SUSPECT = 1.0
HYDROPATHY_STRONG = 2.0
# Counted from the resin. Aggregation is unlikely before the chain is a few residues long, and the
# empirical window closes again around 21.
AGGREGATION_FIRST_RESIDUE = 5
AGGREGATION_LAST_RESIDUE = 21
# A pseudoproline needs a hydroxyl or thiol on the residue it is made from; Ser and Thr are the
# practical cases and Cys is rarer, which is why it is listed last and noted when it is the only
# option. Backbone protection (Hmb/Dmb) is not modelled here: it goes almost anywhere, so it is
# advice rather than a placement.
PSEUDOPROLINE_RESIDUES = ("S", "T", "C")
# One disrupting unit roughly every six residues, so a remedy more than this far from the suspect
# window is not answering it.
DISRUPTOR_REACH = 6
# What the package can actually supply, keyed by the (N-side, C-side) pair the block replaces.
# Only one pseudoproline dipeptide ships, so "eligible" and "placeable" are different lists and the
# advisory says which is which rather than proposing a reagent nobody has.
PSEUDOPROLINE_BLOCKS = {("A", "S"): "Fmoc-Ala-Ser(psiMe,Mepro)-OH"}

HEURISTIC_NOTE = ("A heuristic, and a weak one by construction: on-resin aggregation cannot be "
                  "predicted reliably from sequence, so this names a suspect window and where a "
                  "remedy could go, never that the synthesis will stall.")


def residue_positions(sequence):
    """(position from the resin, residue) for each residue, in written N-to-C order.

    The C-terminal residue is position 1 because it is the one anchored to the support."""
    total = len(sequence)
    return [(total - index, residue) for index, residue in enumerate(sequence)]


def hydropathy_windows(sequence, window=HYDROPATHY_WINDOW):
    """(1-based start from the N-terminus, the window's residues, its mean hydropathy)."""
    out = []
    for index in range(len(sequence) - window + 1):
        text = sequence[index:index + window]
        known = [KYTE_DOOLITTLE[residue] for residue in text if residue in KYTE_DOOLITTLE]
        if len(known) != window:
            continue
        out.append((index + 1, text, sum(known) / window))
    return out


def window_level(mean, suspect=HYDROPATHY_SUSPECT, strong=HYDROPATHY_STRONG):
    """Graded rather than binary: the cut is a convention, so a cliff at it would overstate."""
    if mean >= strong:
        return "strong"
    if mean >= suspect:
        return "suspect"
    return None


def aggregation_advisory(sequence, suspect=HYDROPATHY_SUSPECT, strong=HYDROPATHY_STRONG,
                         window=HYDROPATHY_WINDOW, first_residue=AGGREGATION_FIRST_RESIDUE,
                         last_residue=AGGREGATION_LAST_RESIDUE):
    """Suspect windows, the positions in reach of one, and which of those can actually be built."""
    sequence = (sequence or "").strip().upper()
    notes = [HEURISTIC_NOTE]
    unknown = sorted({residue for residue in sequence if residue not in KYTE_DOOLITTLE})
    if unknown:
        notes.append(f"Not scored, because {', '.join(unknown)} is not a residue this scale covers: "
                     "any window containing it is left out rather than guessed at.")

    total = len(sequence)
    from_resin = dict(enumerate(range(total, 0, -1), start=1))  # written index -> position

    suspects = []
    for start, text, mean in hydropathy_windows(sequence, window=window):
        level = window_level(mean, suspect=suspect, strong=strong)
        if not level:
            continue
        # Every residue of the window must sit inside the length window. A hydrophobic run at the
        # very C-terminus is a run on a chain too short to aggregate, which is why the bound is
        # expressed from the resin and not from the N-terminus.
        positions = [from_resin[index] for index in range(start, start + window)]
        if min(positions) < first_residue or max(positions) > last_residue:
            continue
        suspects.append({"start": start, "residues": text, "mean": round(mean, 2), "level": level,
                         "from_resin": [min(positions), max(positions)]})

    # THREE different questions, kept apart because the risk notes keep them apart. "Ser7 and
    # Thr10 are pseudoproline-eligible" is a fact about the RESIDUES and holds wherever they sit;
    # "Ser7 sits about four residues from the hydrophobic stretch, inside the six-residue rule" is
    # the separate question of whether putting one there would answer anything; and whether the
    # dipeptide for that pair exists is a third question again, about stock.
    eligible = [{"position": index, "residue": residue, "from_resin": from_resin[index]}
                for index, residue in enumerate(sequence, start=1)
                if residue in PSEUDOPROLINE_RESIDUES]

    recommended, placeable = [], []
    if suspects:
        reach = range(min(w["start"] for w in suspects) - DISRUPTOR_REACH,
                      max(w["start"] + window - 1 for w in suspects) + DISRUPTOR_REACH + 1)
        for entry in eligible:
            index = entry["position"]
            if index not in reach or not (first_residue <= entry["from_resin"] <= last_residue):
                continue
            recommended.append(entry)
            pair = (sequence[index - 2], entry["residue"]) if index >= 2 else None
            block = PSEUDOPROLINE_BLOCKS.get(pair)
            if block:
                placeable.append({**entry, "pair": "-".join(pair), "block": block})
    if suspects and recommended and not placeable:
        notes.append("Eligible by chemistry but not buildable from stock: a pseudoproline needs the "
                     "dipeptide for that PAIR, and the only one that ships is "
                     f"{PSEUDOPROLINE_BLOCKS[('A', 'S')]}. Backbone protection (Hmb or Dmb) goes on "
                     "almost any residue and is the fallback.")
    if suspects and any(entry["residue"] == "C" for entry in recommended):
        notes.append("A cysteine pseudoproline is reported last for a reason: the chemistry is "
                     "established for Ser and Thr and much rarer for Cys.")
    return {"suspect": suspects, "spans": collapse(suspects, window=window), "eligible": eligible,
            "recommended": recommended, "placeable": placeable, "notes": notes}


def collapse(suspects, window=HYDROPATHY_WINDOW):
    """Overlapping windows merged into one span each, carrying the peak.

    A hydrophobic run of any length produces a window at every offset within it — six of them on a
    16-mer in testing — and six lines saying one thing is wallpaper. What a reader needs is the
    stretch and how bad its worst point is."""
    spans = []
    for entry in sorted(suspects, key=lambda w: w["start"]):
        first, last = entry["start"], entry["start"] + window - 1
        if spans and first <= spans[-1]["to"] + 1:
            current = spans[-1]
            current["to"] = max(current["to"], last)
            if entry["mean"] > current["peak"]:
                current["peak"], current["level"] = entry["mean"], entry["level"]
            current["from_resin"] = [min(current["from_resin"][0], entry["from_resin"][0]),
                                     max(current["from_resin"][1], entry["from_resin"][1])]
        else:
            spans.append({"from": first, "to": last, "peak": entry["mean"], "level": entry["level"],
                          "from_resin": list(entry["from_resin"])})
    return spans


def advise_for_target(smiles, **options):
    """The whole thing for one target structure: read the chain, then advise on it.

    The entry point the route path wants, so the caller never has to know that the sequence has to
    be read before the hydropathy means anything. Two refusals are deliberate and distinct: a
    target that is not a peptide gets `applies: False` and nothing else, because a hydropathy window
    over a small molecule is meaningless; a target that IS a peptide but could not be fully named
    gets `applies: True` with the problem, so the caller can say "could not read the chain" rather
    than going quiet — silence is indistinguishable from "no risk found"."""
    import peptide_sequence

    read = peptide_sequence.read_sequence(smiles)
    if not read.sequence:
        return {"applies": False, "sequence": "", "problem": read.problem,
                "suspect": [], "spans": [], "eligible": [], "recommended": [], "placeable": [],
                "notes": []}
    advisory = aggregation_advisory(read.sequence, **options)
    advisory["applies"] = True
    advisory["sequence"] = read.sequence
    advisory["problem"] = read.problem
    if read.problem:
        advisory["notes"] = [f"Partial read: {read.problem}"] + advisory["notes"]
    return advisory
