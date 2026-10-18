"""The hazard panel: every sequence-dependent risk, driven by SYNTHETIC PEPTIDES built here.

WHY THIS SUITE EXISTS, and why it is not more unit tests. Phase 2.5 shipped nine hazards with 98
green unit tests, and then a real seven-residue route showed that THREE of the four high gates
could not fire at all. Two separate reasons, and neither was visible to a unit test:

  * `ATTACKS` is evaluated against groups already in the REACTANTS, but a deprotection CREATES the
    reactive thing — the amine is carbamated, the indole Boc-capped, the glutamine tritylated until
    the step runs. So the gates read a step too early, or never.
  * The FIXTURES hid it. The diketopiperazine test passed the same already-deprotected molecule in
    as both reactant and product. No real route does that, so the test passed for the wrong reason.

So the fixtures here are not drawn by hand. Each is a peptide BUILT from a one-letter sequence,
C-to-N, by running the package's own `n-peptide-coupling` and `fmoc-removal` transforms with the
package's own `peptideBuildingBlocks.ts` monomers. What the assertions see is the reactant/product
pair a real route would produce at that step, in that order, with the side chains still protected
exactly as far as the build has got. A gate that only fires on a hand-made molecule fails here.

Three consequences of building rather than drawing, all deliberate:

  1. The transforms declare `carries`, so the carried product is a known index, not the biggest
     fragment. Taking the biggest was the first thing tried and it selected DIBENZOFULVENE out of
     an Fmoc removal, which is a reagent byproduct and not the chain.
  2. Every built chain is checked back: its formula is pinned, and where the chain is free of
     protecting groups it is read back through `peptide_sequence.read_sequence` and must return the
     sequence it was built from. A fixture that silently builds the wrong peptide cannot pass.
  3. The sequences are the literature's own difficult pairs, not arbitrary ones — Asp-Gly for the
     aspartimide, Gly-Pro at the C-terminus for the diketopiperazine, and so on. Each test names
     the source for why that pair is the hazard's canonical case; see PEPTIDE-HAZARD-RUBRIC.md for
     the citations in full.
"""

import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "python")
sys.path.insert(0, PY)

from rdkit import Chem, RDLogger
from rdkit.Chem import rdChemReactions, rdMolDescriptors

import compat_tables as T
import peptide_sequence as S
import reactions_worker as W

RDLogger.DisableLog("rdApp.*")

# --------------------------------------------------------------------------- the builder

_TRANSFORMS = {t["id"]: t for t in
               json.load(open(os.path.join(PY, "route_transforms.json"), encoding="utf-8"))["transforms"]}
_COUPLE = rdChemReactions.ReactionFromSmarts(_TRANSFORMS["n-peptide-coupling"]["smarts"])
_UNFMOC = rdChemReactions.ReactionFromSmarts(_TRANSFORMS["fmoc-removal"]["smarts"])

# TEST-LOCAL, and a finding rather than a convenience. The package ships Fmoc-Trp(Boc)-OH as THE
# remedy for the free-indole hazard, but `boc-removal`'s site is `[NX3;H1,H0]`, which cannot match
# the indole's AROMATIC nitrogen — so no shipped transform can take that Boc off again, and a route
# that took the remedy could not express its own final deprotection. Checked: the group pattern's
# own comment already notes the aromatic nitrogen is invisible to the `boc` group, and the same is
# true of the transform. Until a widened or separate transform lands deliberately (it is a product
# change, with the endgame list and the generator to consider), the panel exposes the indole with
# this local reaction so the cleavage fixture is the molecule a real route would hold. If a shipped
# transform ever covers it, delete this and use that.
_UNBOC_AROMATIC = rdChemReactions.ReactionFromSmarts(
    "[nX3:1][CX3:2](=[OX1:3])[OX2:4][CX4:5]([CH3:6])([CH3:7])[CH3:8]"
    ">>[nH:1].[OX1:3]=[CX3:2]=[OX2:4].[CH2:6]=[CX3:5]([CH3:7])[CH3:8]")

# The monomer table is read straight from the package's own peptideBuildingBlocks.ts, the way
# test_peptide_dipeptides.py does, rather than through the route generator. The generator
# (peptide_route.py) is deliberately not part of the package yet — nothing upstream invokes it —
# and a test suite that imported it would be untestable on the shipped tree. Everything this
# suite needed from it was shallow: a regex over that file, a one-letter map, and a preference
# order over protected forms.
BLOCKS_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "engine",
                         "peptideBuildingBlocks.ts")


def _blocks():
    text = open(BLOCKS_TS, encoding="utf-8").read().split("PEPTIDE_BUILDING_BLOCKS")[1]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', text))


BLOCKS = _blocks()
THREE_TO_ONE = {
    "Ala": "A", "Arg": "R", "Asn": "N", "Asp": "D", "Cys": "C", "Gln": "Q", "Glu": "E",
    "Gly": "G", "His": "H", "Ile": "I", "Leu": "L", "Lys": "K", "Met": "M", "Phe": "F",
    "Pro": "P", "Ser": "S", "Thr": "T", "Trp": "W", "Tyr": "Y", "Val": "V",
}
ONE_TO_THREE = {v: k for k, v in THREE_TO_ONE.items()}


class NoBlockShips(Exception):
    """No Fmoc building block in the package's table for this residue."""


def block_for(residue):
    """The side-chain-protected Fmoc monomer the package ships for this residue.

    Protection is not decoration: `n-peptide-coupling` acylates a free amine, and a free
    side-chain amine is a second one, so the protected form is what a route actually couples.
    Same preference order the generator uses.
    """
    for key in (f"Fmoc-{residue}(Boc)-OH", f"Fmoc-{residue}(Pbf)-OH", f"Fmoc-{residue}(Trt)-OH",
                f"Fmoc-{residue}(OtBu)-OH", f"Fmoc-{residue}(tBu)-OH", f"Fmoc-{residue}-OH"):
        if key in BLOCKS:
            return key, BLOCKS[key]
    raise NoBlockShips(f"no Fmoc building block for {residue} in the package table")

# The conditions text each kind of step carries, written the way a route writes it.
PIPERIDINE = "20% piperidine in DMF, 2 x 5 min, rt"
COUPLING = "Fmoc-amino acid (3 eq), HBTU (3 eq), DIPEA (6 eq), DMF, 45 min, rt"
DIC_OXYMA = "Fmoc-amino acid (5 eq), DIC (5 eq), Oxyma (5 eq), DMF, 2 min, in situ, no base"
BARE_TFA = "TFA/H2O 95:5, 2 h"
TES_ONLY = "TFA/triethylsilane/H2O 95:2.5:2.5, 2 h"
TIS_ONLY = "TFA/triisopropylsilane/H2O 95:2.5:2.5, 2 h"
REAGENT_K = "Reagent K: TFA/thioanisole/water/phenol/EDT 82.5:5:5:5:2.5, 3 h"


def _carried(outcome):
    """The product the transform declares it carries, sanitized, or None if it will not sanitize."""
    # Index 0 for both transforms used here: `n-peptide-coupling` writes the peptide first and the
    # water second, `fmoc-removal` writes the amine first and then CO2 and dibenzofulvene.
    try:
        mol = outcome[0]
        Chem.SanitizeMol(mol)
        return Chem.MolToSmiles(mol)
    except Exception:
        return None


# A backbone amide: a carbonyl on a nitrogen on an alpha-carbon that itself bears a carbonyl. Used
# to tell a real coupling from a side-chain one.
_ALPHA_AMIDE = Chem.MolFromSmarts("[CX3](=[OX1])[NX3;H1][CX4;H1,H2][CX3]=[OX1]")


def _apply(rxn, *smiles, prefer_backbone=False):
    """Run a transform and return the carried product.

    `prefer_backbone` picks the outcome that formed a BACKBONE amide, and it is not an
    optimisation. `n-peptide-coupling`'s site is `free amine`, written as
    `[N;X3;H1,H2;!$(N[C,S]=O);!$(N=*);!$(N#*);!$([N+])]`, and the guanidine of the shipped
    Fmoc-Arg(Pbf)-OH has a nitrogen that satisfies it: NH2, three-coordinate, not acylated, not
    doubly bonded. So RunReactants offers acylation of the GUANIDINE as well as of the alpha-amine,
    and taking the first outcome built Ala-Arg with the aspartate hanging off the guanidine - a
    molecule no route would make, and one that silently answered False to the aspartimide pattern
    because there was no Asp-Arg backbone bond in it to match. Found by ADR failing where ADQ
    passed.

    In the real worker this does not arise, because a route names the site it means and
    `_resolve_site` honours it; the builder has no such instruction, so it scores the outcomes
    instead and takes the one with the most backbone amides.
    """
    mols = tuple(Chem.MolFromSmiles(s) for s in smiles)
    assert all(m is not None for m in mols), f"unparseable input: {smiles}"
    best, best_score = None, -1
    for outcome in rxn.RunReactants(mols):
        got = _carried(outcome)
        if not got:
            continue
        if not prefer_backbone:
            return got
        score = len(Chem.MolFromSmiles(got).GetSubstructMatches(_ALPHA_AMIDE))
        if score > best_score:
            best, best_score = got, score
    if best is not None:
        return best
    raise AssertionError(f"{rxn} produced nothing from {smiles}")


def block(letter, override=None):
    """The package's protected Fmoc monomer for a one-letter residue."""
    if override:
        assert override in BLOCKS, f"{override} does not ship"
        return override, BLOCKS[override]
    return block_for(ONE_TO_THREE[letter])


class Step:
    """One route step, in the shape `_compatibility` reads."""

    def __init__(self, kind, reactants, products, conditions, label=""):
        self.kind, self.reactants, self.products = kind, reactants, products
        self.conditions, self.label = conditions, label

    def as_dict(self, conditions=None):
        return {"reactants": list(self.reactants), "products": list(self.products),
                "reagents": self.conditions if conditions is None else conditions}

    def hazards(self, conditions=None):
        out = W._compatibility([self.as_dict(conditions)])
        assert len(out) == 1, "one step in, one step out"
        return out[0]["hazards"]

    def groups(self, conditions=None):
        return {h["group"] for h in self.hazards(conditions)}

    def __repr__(self):
        return f"<{self.kind} {self.label}>"


def build(sequence, overrides=None, coupling=COUPLING, deprotection=PIPERIDINE):
    """Build `sequence` (one-letter, N-to-C) as a real SPPS route would, C-terminus first.

    Returns (final_chain_smiles, steps). `overrides` maps a position (1-based from the N-terminus,
    the way a sequence is written) to a block name, so a test can swap in the remedy block — a
    dipeptide block covers the position it starts at and the one after it.
    """
    overrides = overrides or {}
    steps = []
    # The C-terminal residue arrives as its monomer and is deprotected to give the free amine the
    # first coupling acylates. On a real synthesis it is esterified to the resin first; the resin
    # is only in the picture for the hazards that need it, which build their own substrate.
    tail = len(sequence)
    name, monomer = block(sequence[-1], overrides.get(tail))
    chain = _apply(_UNFMOC, monomer)
    steps.append(Step("deprotect", [monomer], [chain], deprotection, f"Fmoc off {name}"))

    position = tail - 1
    while position >= 1:
        override = overrides.get(position)
        name, acid = block(sequence[position - 1], override)
        coupled = _apply(_COUPLE, chain, acid, prefer_backbone=True)
        steps.append(Step("couple", [chain, acid], [coupled], coupling, f"+{name}"))
        chain = _apply(_UNFMOC, coupled)
        steps.append(Step("deprotect", [coupled], [chain], deprotection, f"Fmoc off {name}"))
        # A dipeptide block carries two residues, so it consumes two positions.
        position -= 2 if override and _is_dipeptide(override) else 1
    return chain, steps


def _is_dipeptide(name):
    # A dipeptide block names two residues, so it consumes two sequence positions. Counted off
    # the block's own name rather than looked up in the generator's table.
    return sum(1 for residue in THREE_TO_ONE if residue in name) >= 2


def cleavage(chain, conditions=BARE_TFA):
    """The final acid step, as a reactant/product pair.

    The PRODUCT side is what the three late gates read — an indole laid bare, a glutamine's amide
    uncapped — so it is built by actually removing the acid-labile groups rather than by handing
    the same molecule back, which is the fixture mistake this suite exists to avoid.
    """
    out = Chem.MolToSmiles(Chem.MolFromSmiles(chain))
    acidolyses = [(rdChemReactions.ReactionFromSmarts(_TRANSFORMS[name]["smarts"]),
                   ["O"] * len(_TRANSFORMS[name].get("reagents", [])))
                  for name in ("tert-butyl-ester-removal", "tert-butyl-ether-removal",
                               "n-trityl-removal", "s-trityl-removal", "imidazole-trityl-removal",
                               "pbf-removal", "boc-removal")]
    acidolyses.append((_UNBOC_AROMATIC, []))
    for rxn, water in acidolyses:
        while True:
            try:
                nxt = _apply(rxn, out, *water)
            except AssertionError:
                break
            if nxt == out:
                break
            out = nxt
    return Step("cleave", [chain], [out], conditions, "TFA cleavage")


def formula(smiles):
    return rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(smiles))


def advice(hazard):
    """All the text a reader is given for one hazard.

    The remedy is not in one place. `SUGGESTIONS` carries it for the groups that have an entry,
    and for the rest it is written into the `why` of the ATTACKS / ACTIVATION_RISKS / UNMASKED_RISKS
    row itself — `aspartimide-gly` and `resin-dipeptide-dkp` both work that way, and
    `suggestion(group, cls)` returns None for them. Asserting against `suggestion` alone reported
    those as having no remedy at all, which is how this was found.
    """
    return " ".join(str(hazard.get(key) or "") for key in ("why", "suggestion")).lower()


# --------------------------------------------------------------------------- the builder itself


class TheBuilderBuildsWhatItClaims(unittest.TestCase):
    """If this class fails, every hazard below is testing the wrong molecule."""

    def test_a_tripeptide_has_the_right_formula_and_two_new_amides(self):
        chain, steps = build("ADG")
        # Ala-Asp(OtBu)-Gly with a free N-terminus and a free C-terminal acid.
        self.assertEqual(formula(chain), "C13H23N3O6", chain)
        self.assertEqual(len([s for s in steps if s.kind == "couple"]), 2)

    def test_an_unprotected_chain_reads_BACK_as_the_sequence_it_was_built_from(self):
        # The loop closed: built by the route transforms, read by the backbone reader. Neither
        # knows about the other, so agreement is evidence the fixture is the peptide it claims.
        for sequence in ("AG", "AGG", "GAG"):
            with self.subTest(sequence):
                chain, _ = build(sequence)
                read = S.read_sequence(chain)
                self.assertIsNone(read.problem, f"{sequence}: {read.problem}")
                self.assertEqual(read.sequence, sequence, chain)

    def test_the_carried_product_is_the_chain_and_not_the_byproduct(self):
        # Taking the biggest fragment out of an Fmoc removal selects dibenzofulvene (C14H10),
        # which is how this was found. The chain is what the transform declares it carries.
        name, monomer = block("G")
        self.assertEqual(formula(_apply(_UNFMOC, monomer)), "C2H5NO2", "glycine, not dibenzofulvene")

    def test_every_step_is_a_distinct_reactant_product_pair(self):
        # The exact fixture flaw that hid three dead gates: reactant and product the same molecule.
        _, steps = build("ADG")
        for step in steps:
            with self.subTest(repr(step)):
                self.assertNotEqual(step.reactants[0], step.products[0], repr(step))

    def test_a_residue_with_no_shipped_block_is_refused_not_guessed(self):
        with self.assertRaises(NoBlockShips):
            block_for("Aib")


# --------------------------------------------------------------------------- 1. the DG challenge


class AspartimideTheDGChallenge(unittest.TestCase):
    """Asp-Gly, the classic aspartimide sequence, as a built peptide rather than a drawn fragment.

    The chemistry: the aspartate side-chain ester is attacked by the NEXT residue's backbone N-H,
    closing the five-membered succinimide, which then reopens to a mixture of alpha- and
    beta-linked peptide and epimerises the aspartate. Glycine is the worst case because it has no
    side chain to hinder the closure. Repeated piperidine is what drives it, so the step that
    matters is the Fmoc removal, not the coupling.
    """

    def test_ADG_flags_on_the_piperidine_step(self):
        _, steps = build("ADG")
        deprotections = [s for s in steps if s.kind == "deprotect"]
        hit = [s for s in deprotections if "aspartimide-gly" in s.groups()]
        self.assertTrue(hit, f"no deprotection flagged it; groups were "
                             f"{[s.groups() for s in deprotections]}")

    def test_it_is_high_and_names_the_dipeptide_that_ships(self):
        _, steps = build("ADG")
        for step in steps:
            for hazard in step.hazards():
                if hazard["group"] != "aspartimide-gly":
                    continue
                self.assertEqual(hazard["severity"], "high", hazard)
                self.assertIn("dmb", advice(hazard), advice(hazard))
                return
        self.fail("aspartimide-gly never fired")

    def test_the_Dmb_dipeptide_block_CLEARS_it(self):
        # Fmoc-Asp(OtBu)-(Dmb)Gly-OH ships, and the Dmb caps the glycine backbone nitrogen that
        # would otherwise close the imide. Building ADG through it must silence the flag — a gate
        # whose remedy does not clear it is a warning nothing can answer.
        _, steps = build("ADG", overrides={2: "Fmoc-Asp(OtBu)-(Dmb)Gly-OH"})
        for step in steps:
            self.assertNotIn("aspartimide-gly", step.groups(), repr(step))

    def test_the_hindered_OMpe_ester_DOWNGRADES_rather_than_silences(self):
        # The honest middle: a trialkylmethyl ester slows the closure, it does not stop it. So the
        # flag must move to the hindered group at medium, not disappear.
        _, steps = build("ADG", overrides={2: "Fmoc-Asp(OMpe)-OH"})
        seen = set()
        for step in steps:
            seen |= step.groups()
        self.assertIn("aspartimide-gly-hindered", seen, seen)
        self.assertNotIn("aspartimide-gly", seen, "the plain group must not also fire")

    def test_a_serine_neighbour_is_the_beta_heteroatom_case(self):
        _, steps = build("ADS")
        seen = set()
        for step in steps:
            seen |= step.groups()
        self.assertIn("aspartimide-beta-heteroatom", seen, seen)
        self.assertNotIn("aspartimide-gly", seen)

    def test_an_alanine_neighbour_is_the_prone_xaa_case(self):
        _, steps = build("ADA")
        seen = set()
        for step in steps:
            seen |= step.groups()
        self.assertIn("aspartimide-prone-xaa", seen, seen)

    def test_proline_and_bulky_neighbours_stay_SILENT(self):
        # Proline has no backbone N-H to close with; valine and leucine hinder the closure enough
        # that flagging them would be wallpaper. A gate that fires on these is not a gate.
        for sequence in ("ADP", "ADV", "ADL", "ADF"):
            with self.subTest(sequence):
                _, steps = build(sequence)
                seen = set()
                for step in steps:
                    seen |= step.groups()
                self.assertFalse({g for g in seen if g.startswith("aspartimide")},
                                 f"{sequence}: {seen}")

    def test_exactly_one_aspartimide_group_fires_per_sequence(self):
        # The four groups are disjoint by construction. Two firing at once would mean the advice
        # names remedies the pattern has not established apply.
        for sequence in ("ADG", "ADS", "ADA", "ADT", "ADC", "ADN", "ADQ", "ADR", "ADE"):
            with self.subTest(sequence):
                _, steps = build(sequence)
                seen = set()
                for step in steps:
                    seen |= {g for g in step.groups() if g.startswith("aspartimide")}
                self.assertLessEqual(len(seen), 1, f"{sequence} raised {seen}")

    def test_the_motif_list_the_SOURCES_agree_on(self):
        """The susceptibility set, settled against the literature rather than against one book.

        This had to be resolved from several sources because they do not agree:

          * *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3 Section 9.2.5 names
            Asp-Gly and Asp-Asn as most susceptible, then Asp-Ala and Asp-Gln, and then says "with
            the other amino acids the cyclization does not occur BECAUSE OF STERIC HINDRANCE".
          * Mergler et al., "The aspartimide problem in Fmoc-based SPPS, Part II", J Pept Sci 2003,
            9, 518-526, MEASURED it in H-Val-Lys-Asp-Xaa-Tyr-Ile-OH and found considerable
            by-product for Xaa = Asp(OtBu), Arg(Pbf), Asn(Mtt), Cys(Acm) and unprotected Thr.
          * Iris Biotech's technical flyer IF18, summarising the same field: "preferably occurs at
            Asp-Aaa motifs (Aaa = GLYCINE, ASPARTIC ACID, ASPARAGINE, GLUTAMINE OR ARGININE)".

        So Vol 3's steric-hindrance claim is the OUTLIER and it is wrong: Mergler measured Cys and
        Thr, the two residues Vol 3 would exclude. Our `aspartimide-beta-heteroatom` group, which I
        had provisionally marked as unsupported after reading Vol 3, is correct and now cited. The
        genuine gaps were the other way round — GLUTAMINE and ARGININE, which three sources name
        and the pattern did not match at all. Arg is the one that matters in practice, since
        Fmoc-Arg(Pbf)-OH is in almost every synthesis.
        """
        expected = {
            "ADG": "aspartimide-gly",               # all sources, the classic worst case
            "ADN": "aspartimide-prone-xaa",         # Vol 3 top tier; Mergler Asn(Mtt)
            "ADD": "aspartimide-prone-xaa",         # Mergler Asp(OtBu); Iris "aspartic acid"
            "ADQ": "aspartimide-prone-xaa",         # Vol 3; Iris "glutamine"
            "ADR": "aspartimide-prone-xaa",         # Mergler Arg(Pbf); Iris "arginine"
            "ADS": "aspartimide-beta-heteroatom",   # the Ser hydroxyl is an internal catalyst
            "ADT": "aspartimide-beta-heteroatom",   # Mergler, unprotected Thr
            "ADC": "aspartimide-beta-heteroatom",   # Mergler, Cys(Acm)
        }
        for sequence, group in expected.items():
            with self.subTest(sequence):
                _, steps = build(sequence)
                seen = set()
                for step in steps:
                    seen |= step.groups()
                self.assertIn(group, seen, f"{sequence}: expected {group}, got "
                                           f"{{g for g in seen if 'aspart' in g}}")

    def test_glutamine_and_arginine_are_not_matched_as_the_GLY_case(self):
        # They belong in the generic tier: no dipeptide block exists for those pairs, so the advice
        # must not promise Fmoc-Asp(OtBu)-(Dmb)Xaa-OH, which ships only for glycine.
        for sequence in ("ADQ", "ADR"):
            with self.subTest(sequence):
                _, steps = build(sequence)
                seen = set()
                for step in steps:
                    seen |= step.groups()
                self.assertNotIn("aspartimide-gly", seen, f"{sequence}: {seen}")

    def test_lysine_is_not_arginine(self):
        # The arginine arm ends in a guanidine. Lysine is one carbon longer and ends in a plain
        # amine, and nothing names Asp-Lys as prone, so it must stay silent.
        _, steps = build("ADK")
        seen = set()
        for step in steps:
            seen |= step.groups()
        self.assertFalse({g for g in seen if g.startswith("aspartimide")}, f"ADK: {seen}")


# --------------------------------------------------------------------------- 2. cleavage hazards


class FreeIndoleOnCleavage(unittest.TestCase):
    """Tryptophan alkylated by the cations an acid cleavage sets loose.

    Built as a real route does it: the indole is Boc-capped on the monomer and is laid BARE by the
    cleavage, so the gate has to read the PRODUCT side. A fixture that handed the deprotected
    peptide in as the reactant would pass while the product gate stayed dead.
    """

    def test_a_Trp_chain_with_a_tBu_ester_flags_on_bare_TFA(self):
        chain, _ = build("WD")
        step = cleavage(chain, BARE_TFA)
        self.assertIn("free-indole", step.groups(), f"product was {step.products[0]}")

    def test_the_indole_really_IS_bare_on_the_product_side_only(self):
        chain, _ = build("WD")
        step = cleavage(chain)
        pattern = Chem.MolFromSmarts(T.GROUPS["free-indole"][1])
        self.assertFalse(Chem.MolFromSmiles(step.reactants[0]).HasSubstructMatch(pattern),
                         "the Boc-capped indole must not match before the step")
        self.assertTrue(Chem.MolFromSmiles(step.products[0]).HasSubstructMatch(pattern),
                        "the cleavage must actually expose it")

    def test_a_thiol_cocktail_CLEARS_it(self):
        chain, _ = build("WD")
        for conditions in (REAGENT_K, "TFA/EDT/thioanisole/H2O 94:2.5:2.5:1",
                           "TFA/TIS/H2O/EDT 94:1:2.5:2.5"):
            with self.subTest(conditions):
                self.assertNotIn("free-indole", cleavage(chain, conditions).groups())

    def test_TRIETHYLsilane_alone_does_not_clear_it_but_TRIISOPROPYL_does(self):
        # The two silanes differ in exactly the property that matters, and the sources disagree
        # about how far that goes; see the long note on `_INDOLE_SCAVENGER`. Vol 3 Ch. 10 Table
        # 10.1 marks TFA/TES 95:5 "no: Trp" and TFA/TIS 95:5 "acceptable: Trp", because TES
        # "has the ability to reduce the indole function of this residue".
        chain, _ = build("WD")
        self.assertIn("free-indole", cleavage(chain, TES_ONLY).groups(),
                      "TES reduces a free indole")
        self.assertNotIn("free-indole", cleavage(chain, TIS_ONLY).groups(),
                         "TIS is the silane recommended FOR Trp-containing sequences")

    def test_carrying_the_Trp_as_Fmoc_Trp_Boc_OH_is_what_the_remedy_names(self):
        for hazard in cleavage(build("WD")[0], BARE_TFA).hazards():
            if hazard["group"] == "free-indole":
                self.assertIn("trp(boc)", advice(hazard), advice(hazard))
                return
        self.fail("free-indole never fired")


class NTerminalGlutamineToPyroglutamate(unittest.TestCase):
    """An N-terminal glutamine whose alpha-amine closes onto its own side-chain amide.

    Benoiton Section 6.16: "Pyroglutamyl is not formed when the carboxamide groups are protected",
    which is exactly why Fmoc-Gln(Trt)-OH is the remedy the package ships. The amide is tritylated
    until the cleavage uncaps it, so this is another product-side gate.
    """

    def test_a_chain_with_N_terminal_Gln_flags_on_cleavage(self):
        chain, _ = build("QAG")
        self.assertIn("n-terminal-gln", cleavage(chain, BARE_TFA).groups())

    def test_the_remedy_names_the_block_Benoiton_supports(self):
        for hazard in cleavage(build("QAG")[0]).hazards():
            if hazard["group"] == "n-terminal-gln":
                self.assertIn("gln(trt)", advice(hazard), advice(hazard))
                return
        self.fail("n-terminal-gln never fired")

    def test_a_MID_CHAIN_glutamine_stays_silent(self):
        # The alpha-nitrogen of a mid-chain Gln is an amide and cannot attack. If this fires the
        # gate is reading the side chain and not the position, and would flag every Gln anywhere.
        chain, _ = build("AQG")
        self.assertNotIn("n-terminal-gln", cleavage(chain).groups(),
                         "only the N-TERMINAL glutamine can cyclise")


# --------------------------------------------------------------------------- 3. activation hazards


class EpimerisationWhileActivated(unittest.TestCase):
    """Cysteine and histidine losing their alpha-proton while the carboxyl is activated.

    Invisible to everything downstream: the D-residue has the same formula and the same mass, so
    balance and target-matching both pass. These read the REACTANT side — the monomer being
    activated — which is why they are `ACTIVATION_RISKS` and not `ATTACKS`.
    """

    def test_the_coupling_that_adds_a_cysteine_flags(self):
        _, steps = build("AC")
        couplings = [s for s in steps if s.kind == "couple"]
        self.assertTrue(any("cys-epimerisation" in s.groups() for s in couplings),
                        [s.groups() for s in couplings])

    def test_the_coupling_that_adds_a_histidine_flags(self):
        _, steps = build("AHG")
        couplings = [s for s in steps if s.kind == "couple"]
        self.assertTrue(any("his-epimerisation" in s.groups() for s in couplings),
                        [s.groups() for s in couplings])

    def test_DIC_Oxyma_with_no_base_CLEARS_both(self):
        # M&P p. 95 (HE-SPPS): "The lack of base present during the coupling allowed
        # Fmoc-Cys(Trt)-OH to be coupled at 90 C without an increase in epimerization." The cited
        # answer is the absence of base, so in-situ DIC/Oxyma has to clear the flag.
        for sequence, group in (("AC", "cys-epimerisation"), ("AHG", "his-epimerisation")):
            with self.subTest(sequence):
                _, steps = build(sequence, coupling=DIC_OXYMA)
                for step in steps:
                    self.assertNotIn(group, step.groups(), repr(step))

    def test_a_chain_with_neither_residue_raises_neither_flag(self):
        _, steps = build("AGG")
        for step in steps:
            self.assertFalse({"cys-epimerisation", "his-epimerisation"} & step.groups(), repr(step))


class ArginineDeltaLactam(unittest.TestCase):
    """An activated arginine closing to the lactam instead of coupling, giving a DELETION.

    Benoiton calls it the delta-lactam and M&P the gamma-lactam; same ring. The consequence is the
    one that matters: the residue is consumed without being added, so the chain is one short and
    every mass after it is wrong.
    """

    def test_the_coupling_that_adds_an_arginine_flags(self):
        _, steps = build("ARG")
        couplings = [s for s in steps if s.kind == "couple"]
        self.assertTrue(any("arg-delta-lactam" in s.groups() for s in couplings),
                        [s.groups() for s in couplings])

    def test_it_says_the_consequence_is_a_deletion(self):
        _, steps = build("ARG")
        for step in steps:
            for hazard in step.hazards():
                if hazard["group"] == "arg-delta-lactam":
                    self.assertIn("deletion", hazard["why"].lower(), hazard["why"])
                    return
        self.fail("arg-delta-lactam never fired")

    def test_an_in_situ_carbodiimide_coupling_CLEARS_it(self):
        """The gap this test was first written to PIN is now closed, so it asserts the fix.

        It began life as `test_NOTHING_currently_clears_this_flag_which_is_a_gap`: nothing cleared
        the group at all, so the flag fired on a route that had taken the precaution its own remedy
        text recommends. `has_lactam_care` now reads the conditions, and M&P p. 95 is the source —
        HE-SPPS "decreased levels of side reactions such as gamma-lactam formation in arginine",
        the coupling being "in situ carbodiimide-based activation using DIC/Oxyma for 2 min".
        """
        _, steps = build("ARG", coupling=DIC_OXYMA)
        for step in steps:
            self.assertNotIn("arg-delta-lactam", step.groups(), repr(step))

    def test_but_a_PRE_ACTIVATED_onium_coupling_still_flags(self):
        # The suppression must be narrow. If HBTU with a 45-minute pre-activation also cleared it,
        # the gate would be silent on the case the source actually warns about.
        _, steps = build("ARG", coupling=COUPLING)
        self.assertTrue(any("arg-delta-lactam" in s.groups() for s in steps),
                        "the default HBTU/DIPEA coupling must still raise it")


# --------------------------------------------------------------------------- 4. the resin hazards


class DiketopiperazineOffTheResin(unittest.TestCase):
    """The resin-bound dipeptide that cyclises and takes itself off the support.

    This ENDS a synthesis rather than eroding it, and the atom checks cannot see it: a cyclic
    dipeptide plus a resin alcohol balances perfectly. Glycine or proline at residue 2 closes it
    fast, which is why Fmoc-Gly-Pro-OH ships as a C-terminal block.
    """

    # The resin is the dummy atom the package's own `resin-cleavage` transform uses.
    GLY_PRO_RESIN_FMOC = ("*OC(=O)[C@@H]1CCCN1C(=O)CNC(=O)OCC1c2ccccc2-c2ccccc21")

    def _deprotect(self):
        bare = _apply(_UNFMOC, self.GLY_PRO_RESIN_FMOC)
        return Step("deprotect", [self.GLY_PRO_RESIN_FMOC], [bare], PIPERIDINE, "Fmoc off Gly-Pro")

    def test_the_step_that_frees_the_amine_flags_it(self):
        self.assertIn("resin-dipeptide-dkp", self._deprotect().groups())

    def test_the_reactant_side_does_NOT_match_which_is_why_it_needed_a_product_reading(self):
        # The original fixture passed the deprotected molecule in as both sides, so it never
        # exercised this. The Fmoc-capped amine must not match, or the gate would fire a step early.
        step = self._deprotect()
        pattern = Chem.MolFromSmarts(T.GROUPS["resin-dipeptide-dkp"][1])
        self.assertFalse(Chem.MolFromSmiles(step.reactants[0]).HasSubstructMatch(pattern))
        self.assertTrue(Chem.MolFromSmiles(step.products[0]).HasSubstructMatch(pattern))

    def test_it_is_high_and_names_the_dipeptide_block(self):
        for hazard in self._deprotect().hazards():
            if hazard["group"] == "resin-dipeptide-dkp":
                self.assertEqual(hazard["severity"], "high", hazard)
                self.assertIn("gly-pro", advice(hazard), advice(hazard))
                return
        self.fail("resin-dipeptide-dkp never fired")


# --------------------------------------------------------------------------- 5. the whole panel


class ThePanelAsAWhole(unittest.TestCase):
    """Properties that have to hold across the set, not for any one hazard."""

    CLEAN = ("AGG", "GAG", "AGA", "GGA")

    def test_an_ordinary_chain_raises_no_peptide_hazard_at_all(self):
        # Wallpaper is the failure mode on the other side. A route of alanine and glycine has no
        # sequence-dependent risk in it, and if the panel flags one, every real route gets noise.
        peptide_groups = {"aspartimide-gly", "aspartimide-gly-hindered", "aspartimide-prone-xaa",
                          "aspartimide-beta-heteroatom", "free-indole", "n-terminal-gln",
                          "arg-delta-lactam", "cys-epimerisation", "his-epimerisation",
                          "resin-dipeptide-dkp"}
        for sequence in self.CLEAN:
            with self.subTest(sequence):
                chain, steps = build(sequence)
                seen = set()
                for step in steps:
                    seen |= step.groups()
                seen |= cleavage(chain).groups()
                self.assertFalse(seen & peptide_groups, f"{sequence}: {seen & peptide_groups}")

    FIRES_ON = {
        "aspartimide-gly": ("ADG", None), "free-indole": ("WD", "cleave"),
        "n-terminal-gln": ("QAG", "cleave"), "arg-delta-lactam": ("ARG", None),
        "cys-epimerisation": ("AC", None), "his-epimerisation": ("AHG", None),
    }

    def test_every_hazard_the_panel_covers_NAMES_A_REMEDY_when_it_fires(self):
        # Gate first, then remedy: a flag a reader cannot act on is worse than no flag. Read off
        # the FIRED hazard rather than out of the SUGGESTIONS table, because for several groups the
        # remedy is written into the `why` and `suggestion` is None.
        for group, (sequence, where) in self.FIRES_ON.items():
            with self.subTest(group):
                chain, steps = build(sequence)
                found = [h for s in (steps if where != "cleave" else [cleavage(chain)])
                         for h in s.hazards() if h["group"] == group]
                self.assertTrue(found, f"{group} did not fire on {sequence}")
                for hazard in found:
                    self.assertGreater(len(advice(hazard)), 60, hazard)
                    self.assertTrue(any(word in advice(hazard) for word in
                                        ("fmoc-", "use ", "couple", "add ", "load ", "keep ",
                                         "carry", "protect", "replace", "omit")),
                                    f"{group} names no action: {advice(hazard)}")

    def test_each_hazard_group_the_panel_names_exists_in_the_tables(self):
        # Catches a rename landing in the tables without the panel following it, which would
        # otherwise show up as a test that quietly asserts nothing.
        for group in ("aspartimide-gly", "aspartimide-gly-hindered", "aspartimide-prone-xaa",
                      "aspartimide-beta-heteroatom", "free-indole", "n-terminal-gln",
                      "arg-delta-lactam", "cys-epimerisation", "his-epimerisation",
                      "resin-dipeptide-dkp"):
            with self.subTest(group):
                self.assertIn(group, T.GROUPS)


# Appended tests have twice been stranded by a `unittest.main()` sitting mid-file, where they
# import cleanly, never run, and report green. It stays last.
if __name__ == "__main__":
    unittest.main(verbosity=2)
