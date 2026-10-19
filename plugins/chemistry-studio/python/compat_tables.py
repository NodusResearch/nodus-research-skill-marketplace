"""Tables for the functional-group compatibility check (reactions_worker.py `compatibility`).

Three curated tables, kept apart from the code so they can be read and corrected by a chemist:

  REAGENT_CLASSES  reagent class -> label and the words that name it in a step's conditions
  GROUPS           functional group -> label and SMARTS
  ATTACKS          reagent class -> the groups it attacks: severity and why
  PROTECT          group -> how to keep it through such a step (protecting groups as in Greene's
                   Protective Groups in Organic Synthesis), with the SMARTS of each protected form
                   so a textbook example of putting it on can be cited

Severity: "high" when the reagent reliably destroys the group under ordinary conditions,
"medium" when it depends on conditions, amount or substrate (a selectivity question).
The check is a heuristic. A flag is a question for the chemist, not a verdict.
"""

import re

# ------------------------------------------------------------------------------ reagent classes
# Patterns are matched case-insensitively against the step's conditions text and its agent names.
# \b on both sides where the token is a word; formula tokens use lookarounds so "LiAlH4" does not
# match inside a longer formula and "NaH" does not match "NaHCO3" or "NaHMDS".
_F = r"(?<![A-Za-z0-9])"   # start of a formula token
_E = r"(?![A-Za-z0-9])"    # end of a formula token

# The NAMED TFA cleavage cocktails, as one source of truth with their compositions written down.
#
# Two separate patterns used to carry these letters independently — the strong-acid class and
# `has_cation_scavenger` — and they had already drifted: the acid pattern read B, K, H, R and P
# while the scavenger pattern read only B, K and H. So a route writing bare "Reagent R" or
# "Reagent L" was read as an acid with NO scavenger, and the free-indole hazard fired on a cocktail
# that carries thioanisole, EDT and anisole. Both patterns are now built from this dict.
#
# Compositions verified against AAPPTEC's cleavage-cocktail table and *Amino Acids, Peptides and
# Proteins in Organic Chemistry* Vol 3 Ch. 10 Table 10.1. `covers_indole` is whether the cocktail
# carries a thiol or an electron-rich arene, which is what stands between a tert-butyl or trityl
# cation and a free tryptophan.
#
# THE FLAG IS NOT DECORATION. Vol 3's Table 10.1 also names Reagent W (TFA/water) and Reagent T
# (TFA/TES) — water only and silane only, both annotated "no: Trp". Neither is listed here, because
# their letters come only from the part of that table the PDF extraction damaged. If either is ever
# added it must go in with `covers_indole=False`, or the indole gate will clear on a cocktail the
# source says does not protect tryptophan.
NAMED_CLEAVAGE_COCKTAILS = {
    "K": ("TFA/phenol/water/thioanisole/EDT 82.5:5:5:5:2.5", True),   # recommended FOR Trp
    "B": ("TFA/phenol/water/TIS 88:5:5:2", True),                     # the odourless one; phenol
    "H": ("TFA/phenol/thioanisole/EDT/water/DMS/NH4I 81:5:5:2.5:3:2:1.5", True),
    "L": ("TFA/TIS/DTT/water 88:2:5:5", True),                        # DTT is the thiol here
    "R": ("TFA/thioanisole/EDT/anisole 90:5:3:2", True),              # also recommended for Trp
    "P": ("TFA/phenol 95:5", True),
}
_COCKTAIL_LETTERS = "".join(sorted(NAMED_CLEAVAGE_COCKTAILS)).lower()
_COCKTAIL_ANY = rf"\breagent ?[{_COCKTAIL_LETTERS}]\b"
_COCKTAIL_SCAVENGING = r"\breagent ?[{}]\b".format("".join(
    sorted(letter for letter, (_composition, covers) in NAMED_CLEAVAGE_COCKTAILS.items()
           if covers)).lower())

REAGENT_CLASSES = [
    ("strong-hydride", "strong hydride (LiAlH4 type)", [
        _F + r"LiAlH4" + _E, _F + r"LAH" + _E, r"lithium alumin(i)?um hydride", r"red-?al\b",
        r"super-?hydride", _F + r"LiEt3BH" + _E]),
    ("libh4", "lithium borohydride", [_F + r"LiBH4" + _E, r"lithium borohydride"]),
    ("dibal", "DIBAL-H", [r"\bdibal", r"di-?isobutyl ?alumin(i)?um hydride", _F + r"i-?Bu2AlH" + _E]),
    ("borane", "borane", [_F + r"BH3" + _E, r"\bborane\b", _F + r"9-BBN" + _E, r"\b9-?bbn\b", r"catecholborane"]),
    ("mild-hydride", "borohydride", [
        _F + r"NaBH4" + _E, r"sodium borohydride", _F + r"NaBH3CN" + _E, r"sodium cyanoborohydride",
        _F + r"NaBH\(OAc\)3" + _E, r"\bstab\b", r"triacetoxyborohydride", r"\b[lk]-?selectride"]),
    ("organometallic", "Grignard or organolithium", [
        r"grignard", r"[a-z0-9]+mg(br|cl|i)\b", _F + r"R?MgX" + _E, r"\b(n|s|t|sec|tert)-?buli\b", _F + r"BuLi" + _E,
        _F + r"(Me|Ph|Et|Vinyl)Li" + _E, r"\b(methyl|phenyl|butyl|vinyl|allyl)lithium\b", r"organolithium"]),
    ("cuprate", "organocuprate", [r"cuprate", r"gilman", _F + r"R2CuLi" + _E, _F + r"(Me|Bu|Ph|Vinyl)2CuLi" + _E]),
    ("strong-base", "strong base (LDA, NaH, alkoxide)", [
        _F + r"LDA" + _E, r"lithium diisopropylamide", _F + r"(Li|Na|K)HMDS" + _E, r"hexamethyldisilazide",
        _F + r"NaH" + _E, _F + r"KH" + _E, r"sodium hydride", _F + r"KO-?t-?Bu" + _E, r"\bt-?buok\b",
        r"potassium tert-?butoxide", _F + r"NaNH2" + _E, r"sodamide", r"sodium amide"]),
    ("hydroxide", "hydroxide (aqueous base)", [
        _F + r"(Na|K|Li|Cs|Ba)\(?OH\)?2?" + _E, r"(sodium|potassium|lithium|caesium|cesium) hydroxide", r"\bsaponif"]),
    ("alkoxide", "alkoxide base", [_F + r"(Na|K|Li)O(Me|Et|iPr|i-Pr)" + _E, r"sodium (methoxide|ethoxide)",
                                   r"potassium (methoxide|ethoxide)"]),
    # `\bpiperidine\b` does NOT match "4-methylpiperidine" or "piperazine", and those were the only
    # Fmoc-removal bases listed besides DBU and morpholine. So a route doing its deprotections with
    # piperazine, 4-methylpiperidine or dipropylamine — all of them recommended in the aspartimide
    # literature precisely because they are milder — classified as NO reagent class at all and
    # reached none of the amine-base gates: not aspartimide, not the diketopiperazine, not the
    # C-terminal cysteine racemisation, not even "fmoc is cleaved by base". Found while writing the
    # deprotection-additive suite, where a milder-base test passed for exactly that wrong reason.
    ("amine-base", "amine base (piperidine, DBU)",
     [r"\bpiperidine\b", r"\bmethylpiperidine\b", r"\bpiperazine\b", r"\bdipropylamine\b",
      _F + r"DBU" + _E, r"\bmorpholine\b"]),
    ("hydrazine", "hydrazine (Dde/Ddiv removal)",
     [r"\bhydrazine\b", _F + r"NH2NH2" + _E, r"\bH2NNH2\b"]),
    ("hydrogenation", "catalytic hydrogenation", [
        _F + r"H2" + _E + r"[^;]{0,40}(pd|pt|ni|rh|ru|raney|adams)", r"(pd|pt)\s*/\s*c\b[^;]{0,40}" + _F + r"H2" + _E,
        r"hydrogenat", r"\bpd/c\b", r"\bpd\(oh\)2", r"pearlman", r"raney", r"\bpto2\b", r"adams'? catalyst",
        r"transfer hydrogenation", r"ammonium formate"]),
    ("lindlar", "Lindlar hydrogenation", [r"lindlar"]),
    ("dissolving-metal", "dissolving metal (Birch)", [r"\bbirch\b", r"\b(na|li|k)\s*/\s*nh3\b", r"liquid (ammonia|nh3)"]),
    ("strong-acid", "strong acid", [
        _F + r"TFA" + _E, r"trifluoroacetic acid", _F + r"HCl" + _E, _F + r"HBr" + _E, _F + r"HI" + _E,
        _F + r"H2SO4" + _E, r"sulfuric acid", r"sulphuric acid", _F + r"TfOH" + _E, r"triflic acid",
        r"\bp-?tsoh\b", _F + r"TsOH" + _E, r"\bcsa\b", r"camphorsulfonic",
        _F + r"BF3" + _E, _F + r"TMSOTf" + _E, _F + r"BBr3" + _E, _F + r"BCl3" + _E,
        # The named SPPS cleavage cocktails and TMSBr. These are reagents OUR OWN remedy text
        # recommends — the free-indole message says "as in Reagent B or Reagent K", and TMSBr is
        # Chan & White's Protocol 16 — and bare "Reagent K" or bare "TMSBr" classified as nothing,
        # so a route that took the advice reached no gate at all. `has_cation_scavenger` already
        # matched "reagent k", which is what made the gap easy to miss: the scavenger was read and
        # the acid was not, so the hazard could only ever be cleared, never raised.
        _F + r"TMSBr" + _E, r"trimethylsilyl bromide", _COCKTAIL_ANY]),
    # Triethylsilane is a scavenger, but it also reduces a free indole. It is its own class so the
    # `free-indole` alkylation gate can stand aside and the reduction can be reported with the
    # Table 5 -71 signature instead of a cation-alkylation message.
    ("silane-reduction", "triethylsilane (indole-reducing)", [r"\bTES\b", r"triethylsilane"]),
    # The MILD acid regime of Fmoc/tBu work: cleaving a peptide off a super-acid-labile support
    # (2-chlorotrityl, SASRIN) or taking off a super-acid-labile side-chain group, with dilute TFA,
    # acetic acid, trifluoroethanol or hexafluoroisopropanol. Chemically this is a different regime
    # from the 95% TFA endgame, and it had no class at all: `AcOH/TFE/DCM 1:2:7` and `20% HFIP in
    # DCM` classified as NOTHING, so a route cleaving from 2-CTC reached none of the gates.
    #
    # It carries ONE hazard deliberately (the pyroglutamate path — Vol 3 Section 9.2.4 names these
    # exact resins as where the weak-acid regime bites). Populating it further is its own job with
    # its own reading; an empty-ish class that classifies correctly is better than a silent hole.
    #
    # Dilute TFA is matched by percentage ONLY at the low end, where the figure is unambiguous and a
    # misread cannot silence a flag — it can only add the mild class beside the strong one, and the
    # shared `seen` set stops a double report.
    ("mild-acid", "mild acid (dilute TFA, AcOH, TFE, HFIP — super-acid-labile cleavage)",
     [r"\bHFIP\b", r"hexafluoro-?isopropanol", r"\bTFE\b", r"trifluoroethanol",
      r"\bAcOH\b", r"acetic acid",
      r"(?<![\d.])(?:0?\.\d+|[1-9]|1[0-9]|20)\s*%\s*TFA"]),
    ("aqueous-acid", "aqueous acid (work-up)", [_F + r"H3O\+", r"aqueous acid", r"\bH\+(?![A-Za-z0-9])",
                                               r"(dilute|dil\.|aq\.?|aqueous|\d+(\.\d+)?\s*[NM])\s*(HCl|H2SO4)"]),
    ("fluoride", "fluoride (TBAF, HF)", [_F + r"TBAF" + _E, r"tetrabutylammonium fluoride", _F + r"HF" + _E,
                                         r"hf.?pyridine", _F + r"CsF" + _E, _F + r"TASF" + _E]),
    ("chromium-oxidant", "chromium or permanganate oxidant", [
        _F + r"CrO3" + _E, r"\bjones\b", _F + r"PCC" + _E, _F + r"PDC" + _E, _F + r"(Na|K)2Cr2O7" + _E,
        # `chlorochromate` spelled out: `PCC` was read and "pyridinium chlorochromate" was not,
        # and the mined harness steps show routes writing it out 19 times.
        r"dichromate", r"chlorochromate", r"chromic", _F + r"KMnO4" + _E, r"permanganate"]),
    ("alcohol-oxidant", "alcohol oxidant (Swern, DMP, TEMPO)", [
        r"\bswern\b", r"dess-?martin", _F + r"DMP" + _E, r"\btempo\b", _F + r"IBX" + _E, r"\btpap\b", r"\bley\b",
        _F + r"MnO2" + _E]),
    ("peracid", "peracid or peroxide oxidant", [
        r"\bm-?cpba\b", r"peracid", r"peroxy", r"peracetic", r"\boxone\b", r"\bdmdo\b",
        r"dimethyldioxirane",
        # Hydrogen peroxide itself was missing, and it is the oxidant a peptide chemist is most
        # likely to write: measured 2026-10-17, `classify('30% H2O2, AcOH')` returned [], so a
        # methionine or cysteine sitting in peroxide raised nothing at all. The rules for both
        # groups were already here (sulfide high, thiol high) — only the reagent was unrecognised.
        # The formula lookarounds keep it off H2O (a work-up) and off anything longer.
        _F + r"H2O2" + _E, r"hydrogen peroxide"]),
    # Air, which oxidises a free cysteine thiol to the disulfide given time and a mildly basic pH.
    # Phrases, not the bare word: "air-dried", "air-tight" and "a stream of air" are all ordinary
    # work-up language and must not read as an oxidation step. DMSO is deliberately absent — it is
    # the solvent half a peptide route runs in, and flagging every step in it would bury the real
    # ones; DMSO/TFA, which is used to close disulfides, is recognised through its acid instead.
    ("air-oxidation", "air (adventitious oxidant)", [
        r"air oxidation", r"\baerobic\b", r"atmospheric oxygen", r"open to (the )?air",
        r"exposure to air", _F + r"O2" + _E]),
    ("alkene-cleavage", "OsO4 or ozone", [_F + r"OsO4" + _E, r"osmium tetroxide", _F + r"O3" + _E, r"ozon",
                                          _F + r"NaIO4" + _E, r"periodate"]),
    ("acylating", "acylating agent", [
        _F + r"Ac2O" + _E, r"acetic anhydride", _F + r"AcCl" + _E, r"acetyl chloride", r"acid chloride",
        # TBTU, HCTU and PyAOP were missing, and the gap was silent rather than wrong: a step whose
        # only activator was one of them classified as NO reagent class at all, so it reached none
        # of the coupling gates. Found by writing the guanidino-capping suite, where
        # `classify("Fmoc-Ala-OH (3 eq), HCTU (3 eq), NMM, DMF")` returned [].
        r"acyl chloride", r"anhydride", r"benzoyl chloride", _F + r"BzCl" + _E,
        _F + r"(DCC|EDC|EDCI|DIC|HATU|HBTU|TBTU|HCTU|COMU|PyBOP|PyAOP|T3P)" + _E,
        r"carbodiimide"]),
    # Sulfonyl and triflyl chlorides, which make a leaving group out of a hydroxyl. A class of their
    # own rather than part of `acylating`, and the distinction is chemical rather than tidiness:
    # `acylating` carries the peptide ACTIVATION risks — the arginine lactam, the cysteine and
    # histidine epimerisations, the pyroglutamate and capping paths — and every one of those is
    # about a CARBOXYL being activated for a coupling. A mesylation of a serine hydroxyl activates
    # no carboxyl, so filing MsCl under `acylating` would have raised all of them on a step that
    # cannot cause any. What a sulfonyl chloride DOES do is acylate the heteroatoms, so those
    # hazards are carried over; see ATTACKS["sulfonylating"].
    ("sulfonylating", "sulfonylating agent (MsCl, TsCl, Tf2O)", [
        _F + r"MsCl" + _E, _F + r"TsCl" + _E, _F + r"TfCl" + _E, _F + r"NsCl" + _E,
        _F + r"Tf2O" + _E, r"triflic anhydride", r"trifluoromethanesulfonic anhydride",
        r"methanesulfon(yl|ic) (chloride|anhydride)", r"mesyl chloride",
        r"(p-)?toluenesulfonyl chloride", r"tosyl chloride", r"\bsulfonyl chloride\b"]),
    ("alkylating", "alkylating agent", [
        _F + r"(MeI|CH3I|EtI|EtBr|BnBr|BnCl|MeOTf|Me2SO4)" + _E, r"methyl iodide", r"iodomethane", r"benzyl bromide",
        r"dimethyl sulfate", r"alkyl halide", r"meerwein",
        # A trichloroacetimidate is sold to BE a benzylating (or PMB-ylating) agent, used with a
        # catalytic acid where a benzyl halide would need base. Measured 2026-10-14: a step reading
        # "benzyl trichloroacetimidate, TfOH, DCM" classified as `strong-acid` ALONE, and strong
        # acid attacks none of the groups an O-alkylation threatens, so the step raised no hazard
        # at all while benzylating the wrong oxygen.
        r"trichloroacetimidat"]),
    ("deoxyhalogenation", "deoxyhalogenating agent (SOCl2, PBr3)", [
        _F + r"PBr3" + _E, _F + r"SOCl2" + _E, r"thionyl chloride", _F + r"PCl[35]" + _E, _F + r"POCl3" + _E,
        _F + r"\(COCl\)2" + _E, r"oxalyl chloride", r"\bappel\b", _F + r"CBr4" + _E]),
    ("halogen", "halogen (Br2, Cl2, NBS)", [
        r"(?<![A-Za-z0-9(\[])N[BCI]S(?![A-Za-z0-9)\]])", _F + r"Br2" + _E, _F + r"Cl2" + _E, _F + r"I2" + _E,
        r"\bbromine\b", r"\bchlorine\b", r"\biodine\b"]),
    ("ylide", "phosphorus ylide (Wittig, HWE)", [r"wittig", r"ylide", r"phosphonium", r"\bhwe\b",
                                                 r"horner", r"ph3p=ch", r"phosphonate"]),
    ("pd-coupling", "Pd cross-coupling", [r"suzuki", r"\bheck\b", r"sonogashira", r"buchwald", r"stille", r"negishi",
                                          _F + r"Pd\(PPh3\)4" + _E, _F + r"Pd\(OAc\)2" + _E, _F + r"Pd2\(dba\)3" + _E,
                                          r"pd\(dppf\)", r"pd\(0\)"]),
]

# ------------------------------------------------------------------------------ functional groups
GROUPS = {
    "ester": ("ester", "[#6][CX3](=O)[OX2][#6;!$(C([CH3])([CH3])[CH3])]"),
    "support ester": ("support ester", "[#0][OX2][CX3]=[OX1]"),
    "tbu-ester": ("tert-butyl ester", "[#6][CX3](=O)[OX2]C([CH3])([CH3])[CH3]"),
    "lactone": ("lactone", "[#6;R][CX3;R](=O)[OX2;R][#6;R]"),
    "acid": ("carboxylic acid", "[CX3](=O)[OX2H1]"),
    "acid-chloride": ("acid chloride", "[CX3](=O)Cl"),
    "anhydride": ("anhydride", "[CX3](=O)O[CX3](=O)"),
    "amide": ("amide", "[CX3](=O)[NX3;!$(N[CX3](=O)O)]"),
    "nh-amide": ("N–H amide", "[CX3](=O)[NX3;H1,H2;!$(N[CX3](=O)O)]"),
    # An UNPROTECTED asparagine or glutamine side chain. A carbodiimide or uronium activator
    # dehydrates a primary carboxamide to the nitrile, which deletes the side chain the residue
    # was chosen for. The CH2 in the pattern is what distinguishes a SIDE-CHAIN amide from a
    # C-terminal one: on a Rink-type peptide amide the carbonyl sits directly on the alpha carbon,
    # so `H-Ala-NH2`, `H-Gly-NH2` and the dipeptide amides stay silent, while free Asn (one CH2)
    # and free Gln (two) match. A Trt on the side chain makes it a secondary amide and so is
    # silent too, which is the point: the remedy is already in the building-block set.
    "asn-gln-amide": ("unprotected asparagine or glutamine side-chain amide",
                      "[NX3;H2][CX3](=[OX1])[CH2][CX4]"),
    # Asn deamidation is a SEQUENCE motif, not a lone amide: the side-chain amide closes on the
    # next backbone nitrogen to form a succinimide, which hydrolyses to Asp (or iso-Asp). The two
    # neighbours the literature singles out are glycine (no side chain) and serine (small, polar).
    # The pattern says "Asn side-chain amide - alpha carbon - carbonyl - next N - Gly/Ser", so a
    # mid-chain Asn-Ala or a protected Asn(Trt) (secondary amide) stays silent.
    "asn-deamidation-gly": ("Asn-Gly deamidation motif",
                            "[NX3;H2][CX3](=O)[CH2][CX4H1]([NX3])[CX3](=O)[NX3;H1][CH2][CX3]=O"),
    "asn-deamidation-ser": ("Asn-Ser deamidation motif",
                            "[NX3;H2][CX3](=O)[CH2][CX4H1]([NX3])[CX3](=O)[NX3;H1]"
                            "[CX4H1]([CH2][OX2])[CX3]=O"),
    # Sequence context, not a lone functional group: an aspartate SIDE-CHAIN ESTER whose
    # neighbour supplies a backbone N–H. Under repeated base that N–H closes onto the ester
    # (5-exo) to give the aspartimide, which then reopens to a mixture of the alpha- and
    # beta-linked peptide and epimerises the aspartate.
    #
    # Four entries, split by what FIXES each case rather than by how bad each case is, so the
    # advice attached below names only remedies the pattern has already shown to apply:
    #   - glycine next door is the classic worst case and the one the commercial
    #     Fmoc-Asp(OtBu)-(Dmb)Gly-OH dipeptide is sold for;
    #   - a serine, threonine or cysteine next door (recognised by the beta heteroatom, free or
    #     protected) is the case a pseudoproline dipeptide can cover, which glycine cannot be;
    #   - the remaining literature-prone neighbours have no special building block, so they get the
    #     general advice. That list was settled against several sources, because they disagree.
    #     *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3 Section 9.2.5 names
    #     Asp-Gly and Asp-Asn as most susceptible, then Asp-Ala and Asp-Gln, and then claims "with
    #     the other amino acids the cyclization does not occur because of steric hindrance". That
    #     last claim is WRONG and is the outlier: Mergler et al., "The aspartimide problem in
    #     Fmoc-based SPPS, Part II" (J Pept Sci 2003, 9, 518-526) measured the whole series in
    #     H-Val-Lys-Asp-Xaa-Tyr-Ile-OH and found considerable by-product for Xaa = Asp(OtBu),
    #     ARG(Pbf), Asn(Mtt), CYS(Acm) and unprotected THR - including the two residues Vol 3 would
    #     exclude. Iris Biotech's flyer IF18 summarises the field the same way: "preferably occurs
    #     at Asp-Aaa motifs (Aaa = glycine, aspartic acid, asparagine, glutamine or arginine)".
    #     So the arms below are glycine (its own group), the beta-heteroatom set (its own group,
    #     vindicated by Mergler's Cys and Thr), and here: alanine, the one- and two-carbon
    #     side-chain amides and acids (asparagine/aspartate, glutamine/glutamate) and ARGININE.
    #     Arginine is the one that matters most in practice, since Fmoc-Arg(Pbf)-OH is in almost
    #     every synthesis, and it was missing entirely.
    #   - a hindered trialkylmethyl ester (OMpe and relatives) downgrades the glycine case
    #     instead of silencing it, so taking the recommended precaution clears or lowers the
    #     flag rather than leaving a warning that can never be answered.
    # The four are disjoint by construction - CH2 against a substituted CH, beta heteroatom
    # against beta carbon, and a hindered ester against a labile one - so a site raises one
    # flag, never two.
    #
    # Deliberately silent where the chemistry is not a practical worry: proline next door has no
    # backbone N–H, a free aspartate has no ester to attack, glutamate would have to close a
    # six-membered ring, and bulky or beta-branched neighbours (Val, Leu, Ile, Phe, Tyr, Met,
    # Lys...) hinder the closure enough that flagging them would be wallpaper.
    "aspartimide-gly": ("aspartate side-chain ester followed by glycine",
                        "[OX2;$(O[CX4]);!$(O[CX4]([CX4])([CX4])[CX4;!H3])][CX3](=O)[CH2]"
                        "[CX4;H1]([NX3])[CX3](=O)[NX3;H1][CH2][CX3]=O"),
    "aspartimide-gly-hindered": ("hindered aspartate side-chain ester followed by glycine",
                                 "[OX2;$(O[CX4]([CX4])([CX4])[CX4;!H3])][CX3](=O)[CH2]"
                                 "[CX4;H1]([NX3])[CX3](=O)[NX3;H1][CH2][CX3]=O"),
    "aspartimide-beta-heteroatom": ("aspartate side-chain ester followed by serine, threonine or cysteine",
                                    "[OX2;$(O[CX4]);!$(O[CX4]([CX4])([CX4])[CX4;!H3])][CX3](=O)[CH2]"
                                    "[CX4;H1]([NX3])[CX3](=O)[NX3;H1][CX4;H1]([CX4][OX2,SX2])[CX3]=O"),
    "aspartimide-prone-xaa": ("aspartate side-chain ester followed by a literature-prone residue",
                              "[OX2;$(O[CX4]);!$(O[CX4]([CX4])([CX4])[CX4;!H3])][CX3](=O)[CH2]"
                              "[CX4;H1]([NX3])[CX3](=O)[NX3;H1]"
                              "[CX4;H1]([$([CH3]),"
                              "$([CH2][CX3](=O)[#7,#8]),"
                              "$([CH2][CH2][CX3](=O)[#7,#8]),"
                              "$([CH2][CH2][CH2][#7]~[CX3](~[#7])~[#7])])[CX3]=O"),
    # The alpha-carboxyl of an amino acid or of a peptide's C-terminal residue, still FREE. It is
    # the most acidic proton in the molecule, so an O-alkylation or O-acylation aimed at a
    # side-chain hydroxyl hits it first — giving the ester, not the ether, with the side chain left
    # bare. Measured twice on chainL-8 (benzyl trichloroacetimidate/TfOH, then BnBr/Ag2O) and
    # VERIFIED both times, because the wrong-selectivity product has the same molecular formula as
    # the intended one: atom balance cannot see this class at all.
    #
    # The carbon bearing the acid must carry the nitrogen directly, which is what separates this
    # from a SIDE-CHAIN carboxyl (free Asp/Glu, whose CH2 sits between) and from an ordinary
    # carboxylic acid with no alpha-amino group. Requiring O-H means the remedy — carrying the
    # alpha-carboxyl as its tert-butyl ester, or starting from the pre-protected monomer — CLEARS
    # the flag rather than leaving a warning nothing can answer.
    "free-alpha-carboxyl": ("free alpha-carboxyl of an amino-acid residue",
                            "[OX2;H1][CX3](=O)[CX4;H1,H2][NX3]"),
    # The indole of an UNPROTECTED tryptophan — the most electron-rich ring a peptide carries, and
    # so the one that catches the cations an acid cleavage sets loose (tert-butyl from a Boc, a tBu
    # ester or a tBu ether; trityl from a Trt; the sulfonyl cation from an Arg(Pbf)). The alkylated
    # indole is not recoverable, which is why the standard cocktails all carry a scavenger.
    #
    # Fmoc-Trp(Boc)-OH ships, and a Boc on the indole NITROGEN deactivates the ring, so the pattern
    # must not match it — the flag has to be answerable. Note the Boc there is invisible to the
    # `boc` group above, whose [NX3] cannot match an aromatic n, so it is not a cation source by
    # that reading either.
    "free-indole": ("unprotected tryptophan indole", "c1ccc2[nH]ccc2c1"),
    # The same indole, but the risk is reduction by a triethylsilane rather than alkylation by a
    # cation. Kept separate so the remedy can say "replace the silane with EDT" rather than
    # "add a scavenger", which would be wrong.
    "trp-indole-reduction": ("tryptophan indole (silane reduction)", "c1ccc2[nH]ccc2c1"),
    # Free side-chain hydroxyls of Ser/Thr, and the Tyr phenol. Strong acid can O-acylate the
    # former (the O-acyl then migrates to the backbone N) and alkylate the latter with the tBu
    # cation; a cation scavenger is the answer, which is why the gate is suppressed when one is
    # explicitly named.
    "ser-hydroxyl": ("serine side-chain hydroxyl", "[NX3][CX4H1]([CH2][OX2H1])[CX3]=O"),
    "thr-hydroxyl": ("threonine side-chain hydroxyl", "[NX3][CX4H1]([CX4H1]([CH3])[OX2H1])[CX3]=O"),
    "tyr": ("tyrosine phenol", "c1ccc([OX2H1])cc1"),
    # S-acetamidomethyl cysteine. Thiol scavengers can exchange with it; plain acid does not.
    "cys-acm": ("S-acetamidomethyl cysteine", "[SX2][CH2][NX3][CX3](=O)[CH3]"),
    # Dde and Ddiv are the same enamine chromophore on a side-chain amine, so one pattern answers
    # both. Hydrazine is the intended removal; the gate exists for a step that must leave it alone.
    "dde-enamine": ("Dde/Ddiv enamine", "[NX3;H1][CX3;H0]([#6])=[CX3]"),
    # An N-terminal GLUTAMINE with its alpha-amine free. That amine is five atoms from its own
    # side-chain amide carbonyl, so it closes the five-membered lactam and expels ammonia: the
    # peptide becomes the pyroglutamyl one, with no N-terminus left to extend.
    #
    # Three things are in the pattern rather than in a guard. The alpha-nitrogen must be H2 (a
    # mid-chain glutamine has an amide there and cannot attack); the side chain must be a PRIMARY
    # amide two carbons out (asparagine is one carbon short and would have to close a four-membered
    # ring); and a tritylated side-chain amide is H1, so Fmoc-Gln(Trt)-OH — which ships, and is
    # already the answer to the Asn/Gln dehydration flag — clears this one too.
    "n-terminal-gln": ("N-terminal glutamine with a free alpha-amine",
                       "[NX3;H2][CX4;H1]([CX3]=[OX1])[CH2][CH2][CX3](=[OX1])[NX3;H2]"),
    # An ARGININE whose alpha-carboxyl is still free, so a coupling agent can activate it. The
    # side-chain guanidine is three carbons from that carbonyl and closes a lactam on it, consuming
    # the residue without coupling it — a deletion, not a modification. Read through
    # ACTIVATION_RISKS rather than ATTACKS, because the carboxyl is consumed in the step either way.
    #
    # The bonds around the guanidine are left unspecified: the shipped Fmoc-Arg(Pbf)-OH writes it
    # as the C=N tautomer with the sulfonamide on one nitrogen, and a single-bond pattern matches
    # neither that nor free arginine.
    #
    # The DELTA nitrogen — the one bonded to the chain — carries `D2`, and that single token is
    # Benoiton Section 6.11 expressed structurally. "Cyclization occurs even for residues that are
    # protected on the side chain IF THE PROTECTOR IS NOT AT THE DELTA-ATOM", and of the
    # terminal-substituent approach, "the protection provided is not always complete". So:
    #   * free arginine        -> delta-N has two heavy neighbours (chain CH2, guanidine C) -> MATCHES
    #   * Fmoc-Arg(Pbf)-OH     -> the Pbf is an N-OMEGA sulfonyl, delta-N still D2          -> MATCHES
    #   * N-delta-acylated Arg -> three heavy neighbours                                    -> SILENT
    # which is what makes the structural remedy expressible: Figure 6.11 names
    # N-delta,N-omega-bis(Adoc) Boc- and Cbz-arginine as "derivatives that can be coupled without
    # this side-reaction occurring". H-COUNT CANNOT BE USED for this — in the Pbf tautomer the
    # delta nitrogen is written `=N` with no hydrogen at all, so `[#7;H1,H2]` would silence the
    # shipped block, which is exactly backwards.
    "arg-delta-lactam": ("arginine with its alpha-carboxyl free",
                         "[OX2H1][CX3](=O)[CX4;H1][CH2][CH2][CH2][#7;D2]~[CX3](~[#7])~[#7]"),
    # CYSTEINE and HISTIDINE waiting to be activated. Both acidify their own alpha-proton — the
    # cysteine through its sulfur, the histidine through an imidazole that can take the proton
    # itself — so the activated residue racemises before it couples and a D residue goes into the
    # chain. Same formula, same mass, same connectivity: balance and target-matching cannot see it.
    #
    # The trityl is NOT the remedy here, unlike the Asn/Gln and Trp cases: it sits on the sulfur or
    # the ring nitrogen and the alpha-proton is still acidified, so the patterns must match the
    # SHIPPED protected blocks as well as the free residues. Requiring a free S-H or N-H would
    # silence both of the blocks a real route actually uses.
    # A support-anchored DIPEPTIDE whose second residue has a free alpha-amine, with glycine or
    # proline in that second position. The amine sits six atoms from the ester holding residue 1 to
    # the support, closes onto it, and the peptide leaves the resin as the diketopiperazine: not an
    # erosion of yield but the END of the synthesis, with bare linker left behind.
    #
    # Nothing is unbalanced when it happens — a clean cyclic peptide and a clean resin alcohol — so
    # the atom checks cannot reach this one at all.
    #
    # Residue 2 is the gate, not the mere presence of a Gly or Pro: proline's amide prefers the cis
    # conformation that holds the amine over the ester, and glycine has no side chain in the way.
    # An anchored proline with alanine above it (H-Pro-Ala-resin) does not close and is silent.
    # Three things fall out of the one pattern rather than needing counts: the amine must be FREE
    # (so an Fmoc removal is the trigger, and the carbamate nitrogen — H1, exactly like proline's
    # ring N-H — is excluded explicitly), there must be EXACTLY two residues (one cannot cyclise;
    # with three, residue 2's nitrogen is an amide), and there must be a support.
    #
    # LIMITATION: the literature gate also asks for an acid-labile linker, and the support is a
    # single `*` here with no identity, so a Wang ester and a sturdier anchor are indistinguishable.
    # This is therefore slightly broader than the literature gate, by the part that is not visible.
    "resin-dipeptide-dkp": ("resin-bound dipeptide with glycine or proline at residue 2",
                            "[#0]OC(=O)[CX4][NX3][CX3](=O)"
                            "[$([CH2][NX3;H2;!$(N[CX3]=[OX1]);!$(N=*);!$([N+])]),"
                            "$([CX4;R][NX3;H1;R;!$(N[CX3]=[OX1])])]"),
    # An ARGININE whose guanidine is masked as a URETHANE (a carbamate — Boc, Alloc) rather than as
    # an arylsulfonyl. Vol 3 Section 9.2.10: those residues "suffer partial conversion into the
    # corresponding Orn residues ... caused by guanidino acylation during the coupling step followed
    # by decomposition under the strong basic conditions required for Fmoc removal", at -42 mass
    # units. Benoiton Section 6.11 describes the same bond breaking: "piperidine ruptures the
    # delta-N-epsilon-C bond of the adduct, generating an ornithine residue."
    #
    # The carbamate has to be ON a guanidine nitrogen, and that is the whole difficulty. Every
    # residue in Fmoc chemistry carries an alpha carbamate, and Fmoc-Lys(Boc)-OH carries one on a
    # side-chain amine, so a pattern that only looked for a carbamate would fire on the entire
    # synthesis. Guanidine bonds are left unspecified (`~`) for the same reason as
    # `arg-delta-lactam`: the tautomer a block is written in is not fixed.
    #
    # The shipped Fmoc-Arg(Pbf)-OH must NOT match — Pbf is an arylsulfonyl, and it is the remedy.
    "arg-urethane-guanidine": ("guanidine masked as a urethane (Boc, Alloc)",
                               "[#7]([CX3](=[OX1])[OX2][#6])~[CX3](~[#7])~[#7]"),
    "cys-epimerisation": ("cysteine with its alpha-carboxyl free",
                          "[OX2H1][CX3](=O)[CX4;H1][CH2][SX2]"),
    # A C-terminal CYSTEINE held to the support as an ESTER, which is a different hazard from the
    # one above and a different step. Benoiton Section 5.14: piperidine "causes epimerization at
    # S-protected cysteine residues that are esterified to a linker-resin". So the base that takes
    # the Fmoc off also takes the alpha-proton, and the sulfur is what makes it acidic enough.
    #
    # Disjoint from `cys-epimerisation` by construction: that one requires a FREE alpha-carboxyl
    # (the residue being activated), and here the carboxyl IS the resin ester. One sulfur cannot
    # raise both.
    "cys-resin-ester-epimerisation": ("resin-esterified cysteine",
                                      "[#0]OC(=O)[CX4;H1]([CH2][SX2])[NX3]"),
    "his-epimerisation": ("histidine with its alpha-carboxyl free",
                          "[OX2H1][CX3](=O)[CX4;H1][CH2]c1cnc[n;D2]1"),
    # Not attacked by anything in ATTACKS: it exists so a cleavage step can be told that it IS
    # releasing a tert-butyl cation. Ser(tBu)/Thr(tBu)/Tyr(tBu) are ethers, which `tbu-ester` does
    # not see, and on a real peptide they are often the only acid-labile groups present.
    "tbu-ether": ("tert-butyl ether", "[OX2;!$(O[CX3]=[OX1]);!$(O[CX3]=O)][CX4]([CH3])([CH3])[CH3]"),
    "nitrile": ("nitrile", "[CX2]#N"),
    "aldehyde": ("aldehyde", "[CX3H1](=O)[#6]"),
    "ketone": ("ketone", "[#6][CX3](=O)[#6]"),
    "enolizable-ketone": ("enolizable ketone", "[CX4;!H0][CX3](=O)[#6]"),
    "alcohol": ("alcohol", "[OX2H][CX4]"),
    "phenol": ("phenol", "[OX2H]c"),
    "diol": ("1,2- or 1,3-diol", "[OX2H][CX4][CX4,$([CX4][CX4])][OX2H]"),
    "amine": ("amine (N–H)", "[NX3;H2,H1;!$(N[C,S,P]=[O,S,N]);!$(N-a);!$(N[#7,#8])]"),
    # The FREE ALPHA-AMINO group of a resin-bound chain — the one a coupling is aiming at, and the
    # one a uronium coupling reagent will cap if it meets the amine before the carboxylic acid.
    #
    # The whole pattern turns on telling a CHAIN's N-terminus from a loose monomer's amine: the
    # chain's alpha-carbonyl is an AMIDE (it is already bonded to the next residue), a free amino
    # acid's is an acid. Without that the gate would match the incoming residue of every coupling.
    # A side-chain amine does not match either, being four carbons from its carbonyl rather than
    # on the alpha carbon.
    "n-terminal-amine-capping": ("free alpha-amino group of the chain",
                                 "[NX3;H2][CX4;H1,H2][CX3](=[OX1])[NX3;H1]"),
    "aniline": ("aniline (N–H)", "[NX3;H2,H1;!$(N[C,S]=[O,S,N])]-a"),
    "tertiary-amine": ("tertiary amine", "[NX3;H0;!$(N[C,S,P]=[O,S,N]);!$(N-a);!$(N[#7,#8]);!$([N+])]([#6])([#6])[#6]"),
    "thiol": ("thiol", "[SX2H]"),
    "sulfide": ("sulfide", "[#6][SX2;!$(S[SX2])][#6]"),
    # Methionine's side-chain thioether specifically. The generic `sulfide` above also matches an
    # S-trityl cysteine, which is deliberately stable to adventitious air; the two-CH2 chain is
    # what makes this the methionine case rather than every thioether.
    "met-sulfide": ("methionine sulfide", "[CH2][CH2][SX2][CH3]"),
    # The Asp-Pro peptide bond: the Asp side-chain carboxyl (free or protected) can close on the
    # proline nitrogen under strong acid, cleaving the chain at Asp-Pro. A sequence motif, not a
    # lone functional group.
    "asp-pro": ("Asp-Pro motif",
                "[NX3][CX4H1]([CH2][CX3](=O)[OX2])[CX3](=O)[NX3]1[CH2][CH2][CH2][CX4]1"),
    "alkene": ("alkene", "[CX3;!$(C=[O,N,S])]=[CX3;!$(C=[O,N,S])]"),
    "alkyne": ("alkyne", "[CX2]#[CX2]"),
    "terminal-alkyne": ("terminal alkyne", "[CX2H1]#[CX2]"),
    "alkyl-halide": ("alkyl halide", "[CX4][Cl,Br,I]"),
    "aryl-halide": ("aryl bromide or iodide", "c[Br,I]"),
    "aryl-chloride": ("aryl chloride", "cCl"),
    "nitro": ("nitro", "[NX3+](=O)[O-]"),
    "azide": ("azide", "[NX2]=[NX2+]=[NX1-]"),
    "epoxide": ("epoxide", "C1OC1"),
    "acetal": ("acetal or ketal", "[CX4]([OX2][#6])([OX2][#6])[#6,#1]"),
    "silyl-ether": ("silyl ether", "[Si][OX2][#6]"),
    "benzyl-ether": ("benzyl ether", "c[CH2][OX2][CX4,c;!$(C=O)]"),
    "benzyl-ester": ("benzyl ester", "c[CH2][OX2][CX3](=O)[#6]"),
    "boc": ("Boc carbamate", "[NX3][CX3](=O)OC(C)(C)C"),
    "cbz": ("Cbz carbamate", "[NX3][CX3](=O)O[CH2]c1ccccc1"),
    "fmoc": ("Fmoc carbamate", "[NX3][CX3](=O)OCC1c2ccccc2-c2ccccc21"),
    "trityl": ("trityl ether or amine", "[O,N,S]C(c1ccccc1)(c1ccccc1)c1ccccc1"),
    # An alpha-carbon of a free amino acid or peptide acid: the incoming BUILDING BLOCK in a coupling,
    # as opposed to the growing resin-bound chain (whose carboxyl is an ester to the support). The
    # pattern itself is achiral and matches L and D alike; the configuration is read from RDKit's
    # CIP label in `_compatibility`, because SMARTS cannot express "the wrong enantiomer".
    "d-amino-acid": ("D-alpha-amino-acid block", "[NX3][CX4;H1]([CX3]=[OX1])"),
}

# ------------------------------------------------------------------------------ what attacks what
# reagent class -> [(group, severity, why)]
ATTACKS = {
    "strong-hydride": [
        ("ester", "high", "is reduced to the alcohol"), ("tbu-ester", "high", "is reduced to the alcohol"),
        ("lactone", "high", "is reduced to the diol"), ("acid", "high", "is reduced to the alcohol (and consumes hydride)"),
        ("amide", "high", "is reduced to the amine"), ("nitrile", "high", "is reduced to the amine"),
        ("aldehyde", "high", "is reduced to the alcohol"), ("ketone", "high", "is reduced to the alcohol"),
        ("epoxide", "high", "is opened to the alcohol"), ("alkyl-halide", "medium", "may be reduced"),
        ("nitro", "medium", "may be reduced"), ("azide", "high", "is reduced to the amine"),
        ("acid-chloride", "high", "is reduced"), ("anhydride", "high", "is reduced")],
    "libh4": [
        ("ester", "high", "is reduced to the alcohol"), ("lactone", "high", "is reduced to the diol"),
        ("aldehyde", "high", "is reduced to the alcohol"), ("ketone", "high", "is reduced to the alcohol"),
        ("epoxide", "medium", "may be opened")],
    "dibal": [
        ("ester", "medium", "is reduced to the aldehyde or alcohol"), ("lactone", "medium", "is reduced to the lactol"),
        ("nitrile", "medium", "is reduced to the aldehyde (via the imine)"), ("aldehyde", "high", "is reduced to the alcohol"),
        ("ketone", "high", "is reduced to the alcohol")],
    "borane": [
        ("alkene", "high", "is hydroborated"), ("acid", "high", "is reduced to the alcohol"), ("amide", "medium", "is reduced to the amine"),
        ("aldehyde", "high", "is reduced to the alcohol"), ("ketone", "medium", "is reduced to the alcohol")],
    "mild-hydride": [
        ("aldehyde", "high", "is reduced to the alcohol"), ("ketone", "medium", "is reduced to the alcohol (aldehydes react faster)"),
        ("acid-chloride", "high", "is reduced"), ("anhydride", "medium", "is reduced")],
    "organometallic": [
        ("acid", "high", "quenches the reagent (acidic O–H)"), ("alcohol", "high", "quenches the reagent (acidic O–H)"),
        ("phenol", "high", "quenches the reagent (acidic O–H)"), ("amine", "high", "quenches the reagent (acidic N–H)"),
        ("aniline", "high", "quenches the reagent (acidic N–H)"), ("thiol", "high", "quenches the reagent (acidic S–H)"),
        ("terminal-alkyne", "medium", "is deprotonated"),
        ("aldehyde", "high", "adds the organometallic"), ("ketone", "high", "adds the organometallic"),
        ("ester", "high", "adds the organometallic (twice)"), ("lactone", "high", "adds the organometallic"),
        ("nitrile", "medium", "adds the organometallic"), ("acid-chloride", "high", "adds the organometallic"),
        ("anhydride", "high", "adds the organometallic"), ("epoxide", "medium", "is opened"),
        ("nh-amide", "medium", "quenches the reagent (acidic N–H)"), ("nitro", "medium", "reacts")],
    "cuprate": [
        ("aldehyde", "high", "adds the cuprate"), ("acid-chloride", "high", "gives the ketone"),
        ("acid", "medium", "quenches the reagent (acidic O–H)"), ("epoxide", "medium", "is opened")],
    "strong-base": [
        ("acid", "medium", "is deprotonated first (use an extra equivalent)"), ("alcohol", "medium", "is deprotonated first"),
        ("aldehyde", "medium", "may enolize or condense (aldol, Cannizzaro)"), ("alkyl-halide", "medium", "may eliminate (E2) or be substituted"),
        ("enolizable-ketone", "medium", "is enolized and may compete (aldol, alkylation at the wrong site)"),
        ("fmoc", "high", "is cleaved by base")],
    "alkoxide": [("ester", "medium", "may be transesterified (use the alkoxide that matches the ester)"),
                 ("fmoc", "high", "is cleaved by base"), ("acid-chloride", "high", "is converted to the ester")],
    "hydroxide": [
        ("ester", "high", "is saponified"), ("lactone", "high", "is opened"),
        ("acid-chloride", "high", "is hydrolysed"), ("anhydride", "high", "is hydrolysed"),
        ("fmoc", "high", "is cleaved by base"), ("alkyl-halide", "medium", "may be substituted or eliminated"),
        ("aldehyde", "medium", "may condense (aldol, Cannizzaro)")],
    "hydrazine": [
        ("dde-enamine", "high", "is CLEAVED by hydrazine (that is the intended Dde/Ddiv removal; if "
                                "it must survive, use a group that is stable to hydrazine)"),
        ("aldehyde", "high", "condenses to the hydrazone"), ("ketone", "high", "condenses to the hydrazone"),
        ("support ester", "high", "is cleaved by hydrazinolysis, releasing the peptide from the support"),
        ("ester", "medium", "may be cleaved by hydrazinolysis"),
    ],
    "amine-base": [("fmoc", "high", "is cleaved by amine base"), ("acid-chloride", "high", "is aminolysed"),
        # Read as a SURVIVOR rather than as something the step creates: in the route as written the
        # protected guanidine comes through the base intact, and what the literature says is that
        # it partly does not. See the note on `arg-urethane-guanidine`.
        ("arg-urethane-guanidine", "medium",
         "is RUPTURED by the base, turning the arginine into an ORNITHINE residue: the guanidino "
         "carbamate is acylated during the coupling and the adduct then decomposes under the base "
         "used for Fmoc removal, which breaks the bond to the side chain and takes the whole "
         "amidine away. The product is 42 mass units LIGHTER, and nothing downstream can see it — "
         "an ornithine peptide is a self-consistent molecule, so the balance and the target "
         "comparison both pass on the route as written. Mask the guanidine as an ARYLSULFONYL "
         "instead: Fmoc-Arg(Pbf)-OH ships and is not subject to this"),
        ("aspartimide-gly", "high", "closes to the aspartimide — Asp-Gly is the classic worst case, the glycine having "
                                    "no side chain to hinder it — which reopens to a mixture of alpha- and beta-linked "
                                    "peptide and epimerises the aspartate. The usual answer for this pair is backbone "
                                    "protection on the glycine (Hmb or Dmb, bought as the Fmoc-Asp(OtBu)-(Dmb)Gly-OH "
                                    "dipeptide). The cheapest answer, though, is in the deprotection itself: 0.1 M OXYMA in "
                                    "the piperidine suppresses this, and unlike HOBt it does not catalyse the "
                                    "glutamine-to-pyroglutamate cyclisation, so it is safe on a chain that also has "
                                    "an N-terminal Gln. A milder base (piperazine, 4-methylpiperidine) does the same. "
                                    "Failing those, a hindered side-chain ester such as OMpe, a non-ester side-chain "
                                    "mask, or a shorter deprotection. Do NOT reach for DBU: it makes this worse"),
        ("aspartimide-gly-hindered", "medium", "may still close to the aspartimide: the hindered ester slows the "
                                               "attack but Asp-Gly is prone enough that it is not always sufficient. "
                                               "If the chain sees many base treatments, move to backbone protection on "
                                               "the glycine (Fmoc-Asp(OtBu)-(Dmb)Gly-OH), or add 0.1 M Oxyma to the piperidine"),
        ("aspartimide-beta-heteroatom", "medium", "may close to the aspartimide, reopening to alpha- and beta-linked "
                                                  "peptide and epimerising the aspartate. Because the next residue is "
                                                  "a serine, threonine or cysteine, a pseudoproline dipeptide at that "
                                                  "position removes the backbone N-H outright; a hindered side-chain "
                                                  "ester such as OMpe, 0.1 M Oxyma in the piperidine, a milder base "
                                                  "(piperazine, 4-methylpiperidine) or a shorter deprotection also "
                                                  "apply"),
        ("aspartimide-prone-xaa", "medium", "may close to the aspartimide, reopening to alpha- and beta-linked peptide "
                                            "and epimerising the aspartate. Milder than the Asp-Gly case and dependent "
                                            "on how many base treatments the chain sees; no special dipeptide is sold "
                                            "for this neighbour, so the answers are a hindered side-chain ester such as "
                                            "OMpe, a non-ester side-chain mask, 0.1 M Oxyma in the piperidine, a "
                                            "milder base (piperazine, 4-methylpiperidine) or a shorter deprotection"),
                   ("ester", "medium", "activated esters may be aminolysed")],
    "hydrogenation": [
        ("alkene", "high", "is hydrogenated"), ("alkyne", "high", "is hydrogenated"),
        ("benzyl-ether", "high", "is cleaved (hydrogenolysis)"), ("benzyl-ester", "high", "is cleaved (hydrogenolysis)"),
        ("cbz", "high", "is cleaved (hydrogenolysis)"), ("nitro", "high", "is reduced to the amine"),
        ("azide", "high", "is reduced to the amine"), ("aryl-halide", "medium", "may be hydrodehalogenated"),
        ("aldehyde", "medium", "may be reduced"), ("trityl", "medium", "may be cleaved"),
        ("alkyl-halide", "medium", "may be hydrogenolysed")],
    "lindlar": [("alkene", "medium", "may be reduced if the catalyst is too active")],
    "dissolving-metal": [
        ("alkyne", "high", "is reduced (to the E-alkene)"), ("ketone", "high", "is reduced"), ("aldehyde", "high", "is reduced"),
        ("benzyl-ether", "medium", "may be cleaved"), ("aryl-halide", "medium", "may be reduced"), ("ester", "medium", "may be reduced")],
    "strong-acid": [
        ("boc", "high", "is cleaved by acid"), ("acetal", "high", "is hydrolysed by aqueous acid"),
        ("asp-pro", "high", "is cleaved at the Asp-Pro bond by acid"),
        ("tbu-ester", "high", "is cleaved by acid"), ("silyl-ether", "medium", "may be cleaved (TMS, TES, TBS more than TBDPS, TIPS)"),
        ("trityl", "high", "is cleaved by acid"), ("epoxide", "medium", "may be opened"),
        ("ser-hydroxyl", "medium", "may be O-acylated by the tBu cation, and the O-acyl can migrate "
                                    "to the backbone nitrogen; a cation scavenger and a short acid "
                                    "treatment are the answer"),
        ("thr-hydroxyl", "medium", "may be O-acylated by the tBu cation, and the O-acyl can migrate "
                                    "to the backbone nitrogen; a cation scavenger and a short acid "
                                    "treatment are the answer"),
        ("tyr", "medium", "may be alkylated by the tBu cation during acidolysis; a cation scavenger "
                          "(TIS, phenol) is the answer"),
        ("cys-acm", "medium", "may lose the Acm group or exchange with a thiol scavenger (EDT/DTT) "
                              "during acidolysis; omit the thiol or use a different Cys protection")],
    "aqueous-acid": [("acetal", "medium", "may be hydrolysed"), ("trityl", "medium", "may be cleaved"),
                     ("silyl-ether", "medium", "may be cleaved (TMS, TES)")],
    "fluoride": [("silyl-ether", "high", "is cleaved by fluoride")],
    # A sulfonyl chloride acylates the same heteroatoms an acyl chloride does, which is why these
    # mirror ATTACKS["acylating"] — minus every activation risk, because no carboxyl is activated.
    # `free-alpha-carboxyl` is the important one: the alpha-carboxyl is the most acidic proton in a
    # peptide, so a sulfonylation aimed at a side-chain hydroxyl hits it first and gives the mixed
    # sulfonate rather than the intended ester, with the side chain left bare.
    "sulfonylating": [
        ("amine", "high", "is sulfonylated to the sulfonamide, which the step does not intend and acid does not undo"),
        ("alcohol", "medium", "may be sulfonylated (which is often the point — say which hydroxyl is meant)"),
        ("phenol", "medium", "may be sulfonylated, being more acidic than an aliphatic hydroxyl"),
        ("thiol", "high", "is sulfonylated to the thiosulfonate"),
        ("free-alpha-carboxyl", "high", "is the most acidic proton here, so it is sulfonylated FIRST — giving the "
                                        "mixed sulfonate and leaving the side chain bare. Protect it as the "
                                        "tert-butyl ester, or take the residue with its side chain already masked"),
    ],
    "chromium-oxidant": [
        ("alcohol", "high", "is oxidized"), ("aldehyde", "high", "is oxidized to the acid"),
        ("alkene", "medium", "may be oxidized (KMnO4 cleaves or dihydroxylates)"), ("thiol", "high", "is oxidized"),
        ("sulfide", "medium", "may be oxidized"), ("amine", "medium", "may be oxidized"), ("diol", "high", "may be cleaved")],
    "alcohol-oxidant": [("alcohol", "high", "is oxidized"), ("thiol", "medium", "may be oxidized")],
    # Only the thiol. A thioether (methionine, or an S-tritylated cysteine) does not air-oxidise at
    # a rate worth a flag, and the shipped Fmoc-Cys(Trt)-OH staying silent here is the remedy
    # working. Unlike every other entry in this table, the "damage" may be the point: closing a
    # disulfide on air is a real step, so the message asks for it to be declared rather than
    # calling it a mistake.
    "air-oxidation": [
        ("met-sulfide", "medium", "may be oxidized to the sulfoxide on standing; keep the peptide under "
                                  "nitrogen or include EDT where the work-up allows it"),
        ("thiol", "medium", "may be oxidized to the DISULFIDE on standing, which dimerises the peptide or closes "
                            "a ring. If that is what this step is for, declare the disulfide as the product so the "
                            "route says so; if it is not, keep the cysteine S-tritylated (Fmoc-Cys(Trt)-OH ships) "
                            "or work under nitrogen")],
    "peracid": [
        ("alkene", "high", "is epoxidized"), ("sulfide", "high", "is oxidized to the sulfoxide"),
        ("tertiary-amine", "high", "is oxidized to the N-oxide"), ("amine", "medium", "may be oxidized"),
        ("ketone", "medium", "may undergo Baeyer–Villiger oxidation"), ("aldehyde", "medium", "may be oxidized"),
        ("thiol", "high", "is oxidized")],
    "alkene-cleavage": [("alkene", "high", "is dihydroxylated or cleaved"), ("alkyne", "medium", "may be cleaved"),
                        ("sulfide", "medium", "may be oxidized"), ("diol", "medium", "is cleaved by periodate")],
    "acylating": [
        ("amine", "high", "is acylated"), ("aniline", "medium", "may be acylated"), ("alcohol", "medium", "may be acylated"),
        ("phenol", "medium", "may be acylated"), ("thiol", "high", "is acylated"),
        ("asn-gln-amide", "medium", "may be dehydrated to the nitrile by the activating agent, which deletes the side "
                                    "chain the residue was chosen for. The standard answer is to carry the side chain "
                                    "as the N-trityl amide, which the building-block set already holds as "
                                    "Fmoc-Asn(Trt)-OH and Fmoc-Gln(Trt)-OH; adding HOBt or Oxyma, or shortening the "
                                    "pre-activation, also reduces it"),
        ("free-alpha-carboxyl", "high", "is acylated FIRST, in preference to the side-chain hydroxyl this step is "
                                        "masking: the result is the mixed anhydride (or, with an activator present, "
                                        "the activated ester) at the alpha-carboxyl, with the side chain still bare")],
    "alkylating": [
        ("amine", "high", "is alkylated"), ("thiol", "high", "is alkylated"), ("phenol", "medium", "may be alkylated (with base)"),
        ("acid", "medium", "may be alkylated (as the carboxylate)"), ("tertiary-amine", "medium", "may be quaternized"),
        ("aniline", "medium", "may be alkylated"),
        ("free-alpha-carboxyl", "high", "is alkylated FIRST, in preference to the side-chain hydroxyl this step is "
                                        "masking: the carboxylate is the better nucleophile and the more acidic "
                                        "proton, so the product is the alpha-benzyl ESTER with the side chain still "
                                        "bare. Atom balance cannot tell the two apart — the ester and the intended "
                                        "ether have the same molecular formula")],
    "deoxyhalogenation": [
        ("alcohol", "high", "is converted to the halide"), ("acid", "high", "is converted to the acid chloride"),
        ("amine", "medium", "may react")],
    "halogen": [
        ("alkene", "medium", "may add the halogen"), ("phenol", "medium", "may be halogenated on the ring"),
        ("aniline", "medium", "may be halogenated on the ring"), ("enolizable-ketone", "medium", "may be α-halogenated")],
    "ylide": [("aldehyde", "high", "is olefinated"), ("ketone", "medium", "may be olefinated"),
              ("acid", "medium", "quenches the ylide (acidic O–H)"), ("alcohol", "medium", "may quench the ylide (acidic O–H)")],
    "pd-coupling": [("aryl-halide", "medium", "may couple as well (a second aryl halide competes)"),
                    ("terminal-alkyne", "medium", "may couple (Sonogashira) or homocouple")],
}

# ------------------------------------------------------------- what the step UNMASKS, which then reacts
# reagent class -> [(group, severity, why)], read against the groups PRESENT IN THE PRODUCTS.
#
# The third reading, and it exists because the first two cannot see this shape at all. ATTACKS asks
# whether a group SURVIVES a step that attacks it, so it is evaluated only for groups already in
# the reactants. But a deprotection CREATES the reactive thing: the free amine, the bare indole,
# the primary amide. Before the step it is masked and matches nothing; after it, it is sitting in
# the very conditions that made it.
#
# Found 2026-10-17 by running a real route rather than a unit test on a measured seven-residue route: the
# diketopiperazine gate never fired on `Fmoc-Gly-Ala-resin + piperidine -> H-Gly-Ala-resin`, which
# is precisely its case, because the group exists only on the product side. The test that was
# supposed to prove it used the same already-deprotected molecule as both reactant and product,
# so it passed for the wrong reason. Two more gates had the same flaw and were firing a step late.
UNMASKED_RISKS = {
    # Cleaving off a super-acid-labile support is the case Vol 3 Section 9.2.4 names outright:
    # pyroglutamate "is catalyzed by weak acids, but not by strong acids such as the ones required
    # for final cleavage ... However, weak acids are used in the Fmoc/tBu strategy in the case of
    # super acid-labile group deprotection or for peptide cleavage from highly acid-sensitive
    # resins, such as 2-Cl-Trt and SASRIN." Needs no catalyst named in the conditions, unlike the
    # coupling and deprotection paths, because here the reagent is itself the weak-acid regime.
    "mild-acid": [
        ("n-terminal-gln", "high", "is free, and this is the weak-acid regime that catalyses its cyclisation to "
                                   "PYROGLUTAMATE — the alpha-amine closes onto its own side-chain amide and ammonia "
                                   "leaves, capping the chain for good. This is the case the literature singles out: "
                                   "mild-acid cleavage from a super-acid-labile support (2-chlorotrityl, SASRIN), "
                                   "where the acid is dilute enough to leave the amine nucleophilic for the whole "
                                   "step. Carry the glutamine as Fmoc-Gln(Trt)-OH, which ships, or keep the step as "
                                   "short as it can be"),
    ],
    "strong-acid": [
        ("free-indole", "high", "is laid BARE by this step, in the acid that is still full of the cations the other "
                                "protecting groups are shedding — tert-butyl, trityl, Pbf sulfonyl. The indole is "
                                "the most electron-rich ring in the peptide, so it takes them, and the alkylated "
                                "tryptophan cannot be recovered"),
        ("n-terminal-gln", "high", "is left free by this step and can cyclise to PYROGLUTAMATE: the alpha-amine "
                                   "closes onto its own side-chain amide and ammonia leaves, so the peptide ends up "
                                   "with no N-terminus, and nothing further can acylate it. Note WHERE in the step "
                                   "this happens: in concentrated acid the amine is protonated and cannot attack, so "
                                   "the risk is the DILUTE and RESIDUAL regime the work-up passes through — "
                                   "evaporating the acid and triturating. Remove the acid as quickly as possible, and "
                                   "better, carry the glutamine as Fmoc-Gln(Trt)-OH, which ships: a protected "
                                   "side-chain amide leaves nothing to close onto"),
    ],
    "silane-reduction": [
        ("trp-indole-reduction", "medium", "is REDUCED by the triethylsilane: the indole loses a double "
                                          "bond (-71 Da), and the product is not the tryptophan that was "
                                          "asked for. Replace TES with TIS or EDT"),
    ],
    "amine-base": [
        ("resin-dipeptide-dkp", "high", "is what this step CREATES, and it closes to the diketopiperazine, taking the "
                                        "peptide off the support: the amine this deprotection frees sits six atoms "
                                        "from the ester holding the first residue to the resin, and glycine or "
                                        "proline in that position closes it fast. This ENDS the synthesis rather "
                                        "than eroding it — bare linker is left behind — and the atom checks cannot "
                                        "see it, because a cyclic peptide and a resin alcohol both balance "
                                        "perfectly. Two answers, and the cited one is the cheaper: put the chain on "
                                        "a 2-CHLOROTRITYL linker, which eliminates this (the bulky trityl ester "
                                        "does not accept the intramolecular attack the way an alkyl ester does); "
                                        "or never have the resin-bound dipeptide at all, loading the pair as one "
                                        "block, Fmoc-Gly-Pro-OH, in place of the anchored monomer"),
        # Same base, same support, same source — and a hazard the tables did not carry. See the
        # note on `cys-resin-ester-epimerisation` and on `_TRITYL_LINKER`.
        # HOBt sitting in the piperidine is the collision made visible. The aspartimide advice
        # offers an additive in the deprotection; Benoiton 6.16 lists HOBt among the catalysts of
        # the glutamine cyclisation. Until this entry existed the pyroglutamate gate read only
        # `acylating` steps, so a route could be advised to add HOBt and walk into the other hazard
        # with no warning. Guarded by `has_pyroglutamate_catalyst`, which excludes Oxyma — which is
        # why Oxyma is what the aspartimide advice now leads with.
        ("n-terminal-gln", "medium", "is left free by this step, and this step names one of the weak acids or "
                                     "benzotriazoles that catalyse its cyclisation to PYROGLUTAMATE — the "
                                     "alpha-amine closes onto its own side-chain amide and ammonia leaves, so the "
                                     "chain is capped and nothing can extend it. If the additive is here to suppress "
                                     "aspartimide, use OXYMA instead of HOBt: it suppresses aspartimide at least as "
                                     "well and is not a catalyst for this. Otherwise carry the glutamine as "
                                     "Fmoc-Gln(Trt)-OH, which ships and leaves nothing to close onto"),
        ("asn-deamidation-gly", "medium",
         "may DEAMIDATE via the succinimide under the piperidine, converting Asn to Asp/iso-Asp; "
         "the side-chain amide closes on the next backbone nitrogen. Carry Asn as the trityl amide "
         "or keep the base treatment short"),
        ("asn-deamidation-ser", "medium",
         "may DEAMIDATE via the succinimide under the piperidine, converting Asn to Asp/iso-Asp; "
         "the side-chain amide closes on the next backbone nitrogen. Carry Asn as the trityl amide "
         "or keep the base treatment short"),
        ("cys-resin-ester-epimerisation", "medium",
         "EPIMERISES under the base that removes the Fmoc: the alpha-proton sits between the "
         "sulfur that acidifies it and the ester that holds the residue to the support, and "
         "piperidine takes it, so the C-terminal residue of the finished peptide is a D one. "
         "Nothing downstream can see that — same formula, same mass. Put the chain on a "
         "2-CHLOROTRITYL linker, whose cysteine ester is not subject to this, rather than on an "
         "alkoxybenzyl or other alkyl ester"),
    ],
}

# --------------------------------------------------------------------- what a species does to ITSELF
# reagent class -> [(group, severity, why)], read against the groups PRESENT IN THE REACTANTS.
#
# ATTACKS answers "this group survives into the product although the reagent attacks it", and so it
# is only ever evaluated for survivors. Some hazards have the opposite shape: the species is MEANT
# to react, and the risk is that it reacts with itself instead. An arginine being activated for a
# coupling is the case this was added for — its carboxyl is consumed whether the coupling works or
# the lactam closes, so ATTACKS can never see it.
#
# Same (group, severity, why) shape as ATTACKS so it reads the same way, and the two share one
# `seen` set so a pair cannot be reported twice.
ACTIVATION_RISKS = {
    "acylating": [
        ("arg-delta-lactam", "medium", "may close to the DELTA-LACTAM instead of coupling: once the "
                                       "carboxyl is activated, the side-chain guanidine is three carbons away and "
                                       "reaches it. The residue is consumed without being added, so the result is a "
                                       "DELETION — the chain is one residue short and every mass after it is wrong. "
                                       "Note that Fmoc-Arg(Pbf)-OH does NOT close this: the Pbf is an N-omega "
                                       "sulfonyl, and cyclisation occurs anyway unless the protector sits on the "
                                       "DELTA nitrogen, the one bonded to the chain. The complete answer is a "
                                       "delta-protected derivative (the N-delta,N-omega-bis-acylated arginines "
                                       "couple without this side reaction); failing that, activate IN SITU with a "
                                       "carbodiimide and an additive (DIC/Oxyma, added to the resin rather than "
                                       "pre-mixed), which is credited with reducing it, and use an excess"),
        # Read against the REACTANTS, which is right for this one: it is the growing chain's own
        # N-terminal glutamine, present as a reactant and cyclising instead of being acylated. The
        # cleavage path lives in UNMASKED_RISKS["strong-acid"] and reads the products; the two
        # share a `seen` set so a step that is both acid and HOBt reports it once.
        ("n-terminal-gln", "medium", "may cyclise to PYROGLUTAMATE instead of being acylated, because this step "
                                     "names one of the weak acids or benzotriazoles that catalyse it — the "
                                     "alpha-amine closes onto its own side-chain amide and ammonia leaves, so the "
                                     "chain is capped and every later coupling fails on it. Carry the glutamine as "
                                     "Fmoc-Gln(Trt)-OH, which ships and leaves nothing to close onto; failing that, "
                                     "swap HOBt for Oxyma and couple onto a glutamine N-terminus promptly rather "
                                     "than letting it stand in the catalyst"),
        # Not a species reacting with itself, but with the REAGENT instead of its partner — the
        # same shape as far as the reading goes, since the amine is consumed either way and so
        # ATTACKS can never see it. Guarded by `has_capping_risk`, which needs the protocol detail
        # and not just the reagent.
        ("n-terminal-amine-capping", "medium",
         "may be CAPPED by the coupling reagent itself instead of acylated by the amino acid: a "
         "uronium/guanidinium salt that meets the amine before it meets the carboxylic acid "
         "transfers its own tetramethylguanidino group, +98 mass units. The adduct is stable to "
         "everything that follows and survives the final cleavage, so the chain is TRUNCATED at "
         "this residue and no later coupling can touch it. Add the activator to the amino acid "
         "rather than to the resin — activate in situ, do not pre-mix — keep the activator at or "
         "below the amino acid in equivalents, or use a phosphonium salt (PyBOP, PyAOP) or a "
         "carbodiimide, none of which can do this"),
        ("cys-epimerisation", "medium", "may EPIMERISE while it is activated: the sulfur acidifies its "
                                        "alpha-proton and a tertiary amine base removes it, so a D residue goes "
                                        "into the chain. Nothing downstream can see that — the D peptide has the "
                                        "same formula and the same mass, so balance and target-matching both pass. "
                                        "The answer is NO BASE rather than a weaker one: activate in situ with "
                                        "DIC/Oxyma, where the absence of base is what keeps the epimerisation down "
                                        "even hot. Keep the pre-activation short, because an activated cysteine "
                                        "standing in a tertiary amine is where this happens. A weaker base "
                                        "(2,4,6-collidine for DIPEA) is accepted as a precaution but is the "
                                        "second-best answer"),
        ("his-epimerisation", "medium", "may EPIMERISE while it is activated: the alpha-proton is taken by the "
                                        "imidazole's own PI-nitrogen, so the base in the pot is not the only route "
                                        "to it and a D residue goes into the chain. Nothing downstream can see "
                                        "that — same formula, same mass. The shipped Fmoc-His(Trt)-OH is already "
                                        "the standard answer and the reason this is only medium: the trityl sits "
                                        "on the TAU-nitrogen and withdraws enough electron density to leave the "
                                        "pi-nitrogen a poor base, so coupling is minimally epimerising. It "
                                        "REDUCES rather than prevents, though, and by a wide margin: at 80 C a "
                                        "tau-trityl histidine has been measured at 16.6% racemisation against "
                                        "0.8% for a pi-protected one. Only substitution on the PI-nitrogen "
                                        "itself prevents it, and Fmoc-His(Bum)-OH now ships for exactly that: "
                                        "tert-butoxymethyl on the pi-nitrogen, TFA-labile so it leaves with "
                                        "everything else at the end. (Not Bom, the benzyloxymethyl analogue — "
                                        "that one is HF-labile and belongs to Boc chemistry.) One cost to plan "
                                        "for: deprotection releases FORMALDEHYDE, which needs a scavenger of "
                                        "its own or it modifies the peptide. If the block is not wanted, the "
                                        "conditions still help: "
                                        "DIC/Oxyma or HOAt, 2,4,6-collidine in place of DIPEA, and a short "
                                        "pre-activation"),
    ],
}

# Conditions that answer an epimerisation flag: a weaker base than DIPEA, or an additive that
# suppresses racemisation. TEMPERATURE IS DELIBERATELY NOT READ — "0 °C" and "10 °C" differ by one
# character, and misparsing one would silence the flag on a route that deserves it, so a cold
# coupling has to say collidine or Oxyma to clear this.
_EPIMERISATION_CARE = re.compile(r"\bcollidine\b|trimethylpyridine|\boxyma\b|\bHOAt\b"
                                 r"|cyanohydroxyimino|\bOPfp\b|pentafluorophenyl", re.I)


def has_epimerisation_care(text):
    """Whether a coupling's conditions name something that suppresses racemisation."""
    return bool(_EPIMERISATION_CARE.search(text or ""))


# What the literature credits with suppressing the arginine lactam, as opposed to what seemed
# plausible. *Peptide Synthesis: Methods and Protocols* (MiMB 2103) Ch. 6 p. 95: high-efficiency
# SPPS "decreased levels of side reactions such as gamma-lactam formation in arginine and
# aspartimide formation presumably due to optimized coupling and deprotection conditions", where
# the coupling is "in situ carbodiimide-based activation using DIC/Oxyma for 2 min". Benoiton
# Section 4.21 item 8 is the other half, naming a pre-activation that exposes the activated
# intermediate to tertiary amine as an origin of impurity in its own right.
#
# So the claim being encoded is narrow on purpose: it is about an IN-SITU carbodiimide coupling,
# not about any carbodiimide and not about Oxyma wherever it appears. A bare DIC with a
# pre-activation does not clear the flag, because that is not what the source measured. TIME IS
# NOT READ, for the same reason temperature is not read above — "2 min" and "20 min" differ by one
# character, and misparsing one would silence a flag on a route that deserves it.
_LACTAM_CARE = re.compile(r"\bin[- ]situ\b|\bno[- ]premix\b|without pre[- ]?activation"
                          r"|\bno pre[- ]?activation\b", re.I)
_CARBODIIMIDE = re.compile(r"\bDIC\b|\bDCC\b|\bEDC\b|diisopropylcarbodiimide"
                           r"|dicyclohexylcarbodiimide", re.I)


def has_lactam_care(text):
    """Whether a coupling is run the way the literature credits with suppressing the Arg lactam.

    Both halves are required: the activation has to be in situ (or explicitly not pre-activated)
    AND carbodiimide-based. Either alone overclaims the source.
    """
    text = text or ""
    return bool(_LACTAM_CARE.search(text)) and bool(_CARBODIIMIDE.search(text))


# What catalyses an N-terminal glutamine's cyclisation to pyroglutamate DURING CHAIN ASSEMBLY, as
# opposed to during the final cleavage. Benoiton Section 6.16: "The cyclization is catalyzed by weak
# carboxylic acids such as acetic acid, trifluoroacetic acid, and Boc-amino acids, as well as by
# 1-hydroxybenzotriazole. Hence, amino-terminal glutaminyl residues should be kept away from these
# acids as much as possible."
#
# This list is Benoiton's, not a guess at a mechanism. HOBt is the one that matters in practice
# because it is in most coupling cocktails, which is exactly why the gate was walking past the step
# where the literature says the risk is. OXYMA IS DELIBERATELY ABSENT: it is not on the list, and
# leaving it off is what makes the flag answerable by a change a route can actually make.
_PYROGLUTAMATE_CATALYST = re.compile(
    r"\bHOBt\b|hydroxybenzotriazole|\bHOAt\b|hydroxyazabenzotriazole"
    r"|\bAcOH\b|acetic acid|\bAc2O\b|acetic anhydride", re.I)


def has_pyroglutamate_catalyst(text):
    """Whether a step names one of the weak acids or benzotriazoles Benoiton lists as catalysing it."""
    return bool(_PYROGLUTAMATE_CATALYST.search(text or ""))


# The regime a concentrated final cleavage passes through AFTER the acid is removed. Vol 3 Section
# 9.2.4 is explicit that strong acids do not catalyse pyroglutamate formation because the amine is
# protonated, and Benoiton's own case is "left at pH 2-3" — so the risk is the dilute/residual
# work-up, not the 95% TFA itself. A strong-acid step that says nothing about a work-up is treated
# as concentrated throughout and stays silent; the mild-acid class covers the dilute cocktails that
# are themselves the step (1% TFA, AcOH/TFE, HFIP). No bare percentage is parsed here, for the same
# reason temperature and time are not: "95%" and "5%" are one character apart.
_DILUTE_WORKUP = re.compile(
    r"\bevaporat|\btriturat|\bdilut|\bresidual\b|\bwork-?up\b|\baqueous\b|\bph\s*[0-9]"
    r"|\bprecipitat|\bconcentrat\w*\s+(?:in\s+)?vacuo", re.I)


def has_dilute_workup(text):
    """Whether the step names the dilute/residual regime that can free an amine to cyclise."""
    return bool(_DILUTE_WORKUP.search(text or ""))


# The linker that answers two hazards at once. Benoiton Section 5.23: "The obstacles of
# piperazine-2,5-dione formation and epimerization at esterified cysteine are ELIMINATED IF THE
# LINKER IS 2-CHLOROTRITYL CHLORIDE", and Section 5.24 again for cysteine — the 2-chlorotrityl
# ester is "not subject to the epimerization that is caused by piperidine at cysteine residues
# attached to supports through other alkyl esters". A bulky, acid-labile trityl ester, not an
# alkyl one.
#
# READ FROM THE CONDITIONS, and that is a weakness worth stating rather than hiding. The route
# representation writes the support as a single `*`, so a Wang ester and a 2-chlorotrityl ester
# are the same molecular graph and the linker cannot be read structurally. A deprotection step
# will often not name the resin at all, so this clears less often than it should. It is why both
# hazards that rely on it keep a second, structural answer in their message — the dipeptide block
# for the diketopiperazine — and why the cysteine one is medium.
_TRITYL_LINKER = re.compile(r"2[- ]?chlorotrityl|\b2[- ]?CTC\b|\bCl[- ]?Trt\b|chlorotrityl"
                            r"|\bBarlos\b", re.I)


def has_trityl_linker(text):
    """Whether the step says the chain is on a 2-chlorotrityl (or equivalent trityl) support."""
    return bool(_TRITYL_LINKER.search(text or ""))


# Guanidino capping needs BOTH halves, and that is what keeps it from being wallpaper. Every
# coupling in every synthesis presents a free amine to a coupling reagent — that is what a coupling
# IS — so the reagent alone cannot be the gate. Vol 3 Section 9.2.9 names the protocol detail: "The
# reaction occurs if the coupling agent is added in solution to the resin BEFORE the incoming amino
# acid or if the coupling agent is used IN EXCESS with respect to the amino acid."
#
# URONIUM/GUANIDINIUM ONLY. Those salts carry the electrophilic carbon that ends up on the amine.
# The phosphonium salts (PyBOP, PyAOP) do not, Vol 3 contrasts them explicitly, and switching to one
# is part of the remedy — so they must stay silent or the advice could not be taken. A carbodiimide
# is silent for the same reason.
#
# EQUIVALENTS ARE NOT READ. The excess trigger is real but "3 eq" and "2 eq" differ by one
# character, and this package already refuses to read temperature and time for exactly that reason:
# misparsing one would silence a flag on a route that deserves it. Recorded as a known gap.
_URONIUM = re.compile(r"\bHBTU\b|\bTBTU\b|\bHATU\b|\bHCTU\b|\bHDMU\b|\bCOMU\b"
                      r"|tetramethyluronium|tetramethylguanidinium", re.I)
_PREACTIVATION = re.compile(r"pre[- ]?activat|pre[- ]?mix|premix"
                            r"|activat\w*\s+(?:for\s+)?\d+\s*(?:s|sec|min|h)\w*\s*(?:,\s*)?then"
                            r"|then add (?:to )?(?:the )?resin", re.I)
_NO_PREACTIVATION = re.compile(r"\b(?:no|without)\s+pre[- ]?(?:activat\w*|mix\w*)", re.I)


# What answers an aspartimide flag in the DEPROTECTION, as opposed to in the building block.
#
#   * An ADDITIVE in the piperidine. Mergler et al. measured 0.1 M HOBt or 2,4-dinitrophenol as
#     reducing it significantly; the 2025 ChemBioChem review "Aspartimide Formation and Its
#     Prevention in Fmoc Chemistry SPPS" reports Oxyma Pure as more effective than HOBt or HOAt.
#   * A MILDER BASE. Piperazine and 4-methylpiperidine remove Fmoc while suppressing aspartimide,
#     and dipropylamine likewise at comparable deprotection efficiency.
#
# None of them ELIMINATES it, so this does not touch the severities — it clears the flag for a route
# that has done what the literature asks, which is the difference between advice and nagging.
#
# DBU DEFEATS THE CLEARANCE, and that is deliberate rather than an omission. Vol 3 Section 9.2.5:
# "Fmoc removal with DBU also promotes aspartimide formation." A route reaching for DBU should not
# be able to buy its way out with an additive, so the check fails closed when DBU is named.
#
# OXYMA LEADS THE ADVICE because of the collision with pyroglutamate: HOBt suppresses aspartimide
# and CATALYSES the glutamine cyclisation (Benoiton 6.16), while Oxyma is on neither list but the
# aspartimide one. One additive answers both hazards; see `has_pyroglutamate_catalyst`.
_ASPARTIMIDE_CARE = re.compile(r"\boxyma\b|cyanohydroxyimino|ethyl 2-cyano-2-\(hydroxyimino\)"
                               r"|\bHOBt\b|hydroxybenzotriazole|\bHOAt\b"
                               r"|dinitrophenol|\bDNP\b"
                               r"|\bpiperazine\b|\bmethylpiperidine\b|\bdipropylamine\b", re.I)
_DBU = re.compile(r"(?<![A-Za-z])DBU(?![A-Za-z])|diazabicyclo", re.I)


def has_aspartimide_care(text):
    """Whether a deprotection names an additive or a milder base that suppresses aspartimide.

    Fails closed on DBU, which the literature names as making it worse.
    """
    text = text or ""
    if _DBU.search(text):
        return False
    return bool(_ASPARTIMIDE_CARE.search(text))


def has_capping_risk(text):
    """Whether a coupling could cap the chain's N-terminus with its own activator.

    Both halves required: a uronium/guanidinium salt AND an explicit pre-activation or pre-mix. A
    route that activates in situ, or that says nothing either way, does not raise it.
    """
    text = text or ""
    if _NO_PREACTIVATION.search(text):
        return False
    return bool(_URONIUM.search(text)) and bool(_PREACTIVATION.search(text))

# ------------------------------------------------------- what the by-product WEIGHS, if anything
# group -> {"delta": <nominal mass change>, "kind": ..., "note": ...}
#
# What this is for. Build-plan item 25 wants a route SCORED on whether it handled a hazard, and
# nothing can do that today: a route that walks straight into one still verifies, because the
# by-product is a self-consistent molecule with its own balanced equation. A mass shift is the one
# thing that makes a hazard observable after the fact — it is what a chemist reads off the LC-MS of
# a crude peptide — so it turns "this route is at risk" into "look for this peak".
#
# EVERY NUMBER HERE WAS DERIVED FROM STRUCTURES, not recalled or copied. The literature quotes
# several of these and the derivations agree with all of them: -42 for ornithine and +98 for
# capping (Vol 3 Sections 9.2.10 and 9.2.9), -18 for the aspartimide and +67 for the piperidides
# (Section 9.2.5), +51 for 3-(piperidin-1-yl)alanine (Section 10.2.2.1), +16 and +56 and -71 from
# Chan & White's Table 5. The last of those is worth noting: Table 5's row survived the PDF
# extraction as "-7 1 CYS", and deriving Cys(Acm) -> Cys independently gives -71.08, which recovers
# the number the OCR broke.
#
# THREE OF THE FOUR KINDS ARE NOT NUMBERS, and that is the point rather than a gap:
#
#   "shift"      a nominal mass change. Detectable: look for the peak.
#   "same-mass"  the by-product is an ISOMER. Epimerisation is the case, and MS cannot see it at
#                all — which is exactly why those gates exist, since balance, formula and target
#                comparison all pass too. Writing 0 here says "do not go looking", which is more
#                useful than leaving the entry out and implying nobody checked.
#   "deletion"   a whole residue is missing, so the shift is the residue's own mass and depends on
#                which one. Detectable as an n-1 species, not as a fixed number.
#   "absent"     there is no product to weigh. The diketopiperazine takes the chain off the resin,
#                so the evidence is yield and bare linker, not a peak.
#
# Nominal (integer) masses, because that is how the sources quote them and how a crude trace is
# read. The monoisotopic figures differ in the second decimal and are not what anyone eyeballs.
MASS_SHIFTS = {
    "n-terminal-gln": {"delta": -17, "kind": "shift",
                       "note": "ammonia leaves as the lactam closes; derived Gln-Ala -> pyroGlu-Ala, -17.03"},
    "arg-urethane-guanidine": {"delta": -42, "kind": "shift",
                               "note": "the whole amidine goes with the ruptured bond, leaving ornithine; "
                                       "derived -42.04, and Vol 9.2.10 quotes -42"},
    "n-terminal-amine-capping": {"delta": 98, "kind": "shift",
                                 "note": "the tetramethylguanidino group from the uronium salt; derived +98.15 for "
                                         "the neutral adduct, which is the figure Vol 3 Section 9.2.9 quotes"},
    "aspartimide-gly": {"delta": -18, "kind": "shift",
                        "note": "water leaves as the succinimide closes; derived -18.01. The ring then reopens, so a "
                                "crude trace usually shows BOTH this and the +67 piperidides"},
    "aspartimide-gly-hindered": {"delta": -18, "kind": "shift",
                                 "note": "the same imide; the hindered ester slows the closure without changing what "
                                         "the by-product weighs, so the trace looks identical"},
    "aspartimide-beta-heteroatom": {"delta": -18, "kind": "shift",
                                    "note": "the same imide as the glycine case, and the same -18, whichever residue "
                                            "supplied the attacking backbone N-H"},
    "aspartimide-prone-xaa": {"delta": -18, "kind": "shift",
                              "note": "the same imide and the same -18; the neighbour changes how fast it forms, not "
                                      "what it weighs"},
    "cys-resin-ester-epimerisation": {"delta": 51, "kind": "shift",
                                      "note": "the beta-elimination route: the sulfur leaves as dehydroalanine and "
                                              "piperidine adds, giving 3-(piperidin-1-yl)alanine. Derived +51.07, and "
                                              "Vol 3 Section 10.2.2.1 quotes +51 Da. NOTE the other route from the "
                                              "same step, plain racemisation, is same-mass and invisible"},
    "asn-deamidation-gly": {"delta": 1, "kind": "shift",
                            "note": "Asn -> Asp by hydrolysis of the side-chain amide, +0.984 Da; the "
                                    "iso-Asp product has the same mass, so the trace cannot tell them apart"},
    "asn-deamidation-ser": {"delta": 1, "kind": "shift",
                            "note": "Asn -> Asp by hydrolysis of the side-chain amide, +0.984 Da; the "
                                    "iso-Asp product has the same mass, so the trace cannot tell them apart"},
    "asn-gln-amide": {"delta": -18, "kind": "shift",
                      "note": "dehydration of the side-chain amide to the nitrile"},
    "trp-indole-reduction": {"delta": -71, "kind": "shift",
                             "note": "the indole ring is reduced; -71 Da is the Table 5 signature, and the "
                                     "product is no longer tryptophan"},
    "ser-hydroxyl": {"delta": 56, "kind": "shift",
                      "note": "O-acylation by the tBu cation adds +56; the O-acyl can migrate to the "
                              "backbone nitrogen"},
    "thr-hydroxyl": {"delta": 56, "kind": "shift",
                      "note": "O-acylation by the tBu cation adds +56; the O-acyl can migrate to the "
                              "backbone nitrogen"},
    "tyr": {"delta": 56, "kind": "shift",
            "note": "t-butylation of the tyrosine ring adds +56"},
    "cys-acm": {"delta": -71, "kind": "shift",
                "note": "loss of the acetamidomethyl group; -71 Da is the Table 5 signature"},
    "free-indole": {"delta": None, "kind": "shift",
                    "note": "the shift is whichever cation reached the indole, so it names the culprit rather than "
                            "one number: +56 a tert-butyl, +212 an Arg(Mtr) sulfonyl, +252/+266 an Arg(Pbf)/(Pmc) "
                            "sulfonyl, +172 an EDT-derived dithioketal (Chan & White Table 5)"},
    "met-sulfide": {"delta": 16, "kind": "shift",
                    "note": "one oxygen on the methionine sulfide, to the sulfoxide; the sulfoxide is chiral, "
                            "so one Met gives two diastereomers in the trace"},
    "asp-pro": {"delta": None, "kind": "deletion",
                "note": "the Asp-Pro bond is hydrolysed; the chain is cut, so the evidence is two fragments, "
                        "not a single modified product"},
    "sulfide": {"delta": 16, "kind": "shift",
                "note": "one oxygen, to the sulfoxide; and it is CHIRAL, so one methionine gives three species in the "
                        "trace - unoxidised plus two diastereomers (Vol 3 Section 9.2.3)"},
    # The ones no mass can find, which is why they are gated at all.
    "cys-epimerisation": {"delta": 0, "kind": "same-mass",
                          "note": "a D residue is an ISOMER: same formula, same mass. MS cannot see it, and neither "
                                  "can the balance check or the target comparison. Chiral analysis or an enzymatic "
                                  "digest is the only way to look"},
    "his-epimerisation": {"delta": 0, "kind": "same-mass", "note": "as cys-epimerisation; an isomer, not a shift"},
    "d-amino-acid": {"delta": 0, "kind": "same-mass",
                     "note": "a D residue substituted for its L form is an ISOMER: same formula, same mass, same "
                             "connectivity. MS, the balance check and the target comparison all pass; only chiral "
                             "analysis (or the stereocentre reader) can see it"},
    "arg-delta-lactam": {"delta": None, "kind": "deletion",
                         "note": "the residue is consumed without coupling, so the by-product is the n-1 chain and the "
                                 "shift is that residue's own mass - for arginine, -156 as Arg(Pbf) never arrives. "
                                 "Look for a deletion peak, not a fixed offset"},
    "resin-dipeptide-dkp": {"delta": None, "kind": "absent",
                            "note": "there is no product to weigh: the dipeptide cyclises off the support, so the "
                                    "evidence is lost yield and bare linker rather than a peak"},
    # A PROTECTING GROUP STILL THERE when the route says it is gone. Different question from the
    # side reactions above and the commonest thing a crude peptide trace actually shows, so the
    # numbers are the ones a reader checks first. Positive, because the product is HEAVIER by the
    # group that failed to leave. All derived; the two Chan & White Table 5 quotes agree exactly
    # (+56 "incomplete removal of t-Bu groups", +242 "incomplete removal of Trt").
    "boc": {"delta": 100, "kind": "residual",
            "note": "a Boc that did not come off leaves the product 100 heavier; derived +100.12"},
    "cbz": {"delta": 134, "kind": "residual",
            "note": "a Cbz still in place; derived +134.13, and it needs hydrogenolysis or strong acid"},
    "fmoc": {"delta": 222, "kind": "residual",
             "note": "an Fmoc still in place; derived +222.24, and it is the easiest of these to spot"},
    "trityl": {"delta": 242, "kind": "residual",
               "note": "a trityl still in place; derived +242.32, which is exactly the +242 Chan & White's "
                       "Table 5 files as 'incomplete removal of Trt'"},
    "tbu-ester": {"delta": 56, "kind": "residual",
                  "note": "a tert-butyl ester still in place; derived +56.11, Table 5's +56"},
    "tbu-ether": {"delta": 56, "kind": "residual",
                  "note": "a tert-butyl ether still in place; derived +56.11. Note the same +56 also appears when a "
                          "tert-butyl cation ALKYLATES a side chain, so the number alone does not say which"},
    "silyl-ether": {"delta": 114, "kind": "residual",
                    "note": "a TBS ether still in place; derived +114.26. Other silyls differ - TBDPS is +238"},
    "benzyl-ether": {"delta": 90, "kind": "residual",
                     "note": "a benzyl ether still in place; derived +90.12"},
    "benzyl-ester": {"delta": 90, "kind": "residual",
                     "note": "a benzyl ester still in place; derived +90.12"},
    "acetal": {"delta": None, "kind": "shift",
               "note": "depends on which acetal: a dimethyl acetal on an aldehyde is +46, a 1,3-dioxolane +44, so "
                       "the number is not one value and the group alone does not fix it"},
    "free-alpha-carboxyl": {"delta": None, "kind": "shift",
                            "note": "the shift is whatever mask went on the wrong oxygen, so it depends on the "
                                    "reagent; the wrong-selectivity product has the SAME formula as the intended one, "
                                    "which is why this was measured twice before being believed"},
}

# WHY MOST OF THE REST WILL NEVER HAVE A NUMBER, which is a fact about the chemistry rather than
# work left undone. A peptide side reaction has a characteristic shift because the chain is the
# constant and the modification is a fixed fragment - an oxygen, an amidine, a guanidino group. A
# small-molecule hazard is not like that: "the ester is saponified" or "the ketone is reduced"
# changes the molecule by an amount that depends entirely on the substrate, so there is no
# signature to tabulate. The protecting groups above are the exception, because a group that failed
# to leave IS a fixed fragment. Asking for the rest would be asking for something that does not
# exist.
#
# The hazards this table is required to cover: the peptide set the rubric is about. Listed rather
# than derived from MASS_SHIFTS' keys, because the table also carries the residual protecting
# groups now and a set defined as "whatever is in the table" cannot catch a missing entry - it was
# written that way first, which made the coverage test tautological.
PEPTIDE_HAZARDS = frozenset({
    "n-terminal-gln", "arg-delta-lactam", "arg-urethane-guanidine", "n-terminal-amine-capping",
    "aspartimide-gly", "aspartimide-gly-hindered", "aspartimide-beta-heteroatom",
    "aspartimide-prone-xaa", "cys-epimerisation", "his-epimerisation",
    "cys-resin-ester-epimerisation", "resin-dipeptide-dkp", "asn-gln-amide", "free-indole",
    "free-alpha-carboxyl", "sulfide", "met-sulfide", "asp-pro",
    "asn-deamidation-gly", "asn-deamidation-ser", "trp-indole-reduction",
    "ser-hydroxyl", "thr-hydroxyl", "tyr", "cys-acm", "d-amino-acid",
})


def mass_shift(group):
    """What a hazard's by-product weighs relative to the intended peptide, or None if untabulated."""
    return MASS_SHIFTS.get(group)


# ------------------------------------------------------------------------------ how to keep a group
# group -> (suggestion, [(protected-form label, SMARTS of the protected form, SMARTS of the group it is made from)])
# They find a textbook example (Greene) of putting the protecting group on: a step whose reactant has
# the free group and whose product has the protected form.
_TBS = ("TBS ether", "[Si](C)(C)(C(C)(C)C)O[#6]", "[OX2H][#6]")
_TBDPS = ("TBDPS ether", "[Si](c1ccccc1)(c1ccccc1)(C(C)(C)C)O[#6]", "[OX2H][#6]")
_BN_ETHER = ("benzyl ether", "c1ccccc1[CH2]O[CX4]", "[OX2H][#6]")
_PMB = ("PMB ether", "COc1ccc([CH2]O[CX4])cc1", "[OX2H][#6]")
_MOM = ("MOM ether", "CO[CH2]O[CX4]", "[OX2H][#6]")
_BOC = ("Boc carbamate", "[NX3]C(=O)OC(C)(C)C", "[NX3;H2,H1;!$(NC=O)]")
_CBZ = ("Cbz carbamate", "[NX3]C(=O)O[CH2]c1ccccc1", "[NX3;H2,H1;!$(NC=O)]")
_FMOC = ("Fmoc carbamate", "[NX3]C(=O)OCC1c2ccccc2-c2ccccc21", "[NX3;H2,H1;!$(NC=O)]")
_DIOXOLANE = ("1,3-dioxolane acetal", "[CX4]1([#6])([#6,#1])OCCO1", "[CX3;!$(C(=O)[O,N])]=O")
_ACETONIDE = ("acetonide", "C[CX4]1(C)O[#6][#6]O1", "[OX2H][CX4][CX4][OX2H]")
_ME_ESTER = ("methyl ester", "[#6]C(=O)O[CH3]", "[CX3](=O)[OX2H1]")
_TBU_ESTER = ("tert-butyl ester", "[#6]C(=O)OC(C)(C)C", "[CX3](=O)[OX2H1]")
_OXAZOLINE = ("2-oxazoline", "C1=NCCO1", "[CX3](=O)[OX2H1]")
_ME_ETHER_AR = ("aryl methyl ether", "c[OX2][CH3]", "c[OX2H]")
_TRT_S = ("S-trityl thioether", "SC(c1ccccc1)(c1ccccc1)c1ccccc1", "[SX2H]")
_TRT_AMIDE = ("N-trityl amide", "[CX3](=O)[NX3;H1]C(c1ccccc1)(c1ccccc1)c1ccccc1",
              "[NX3;H2][CX3](=[OX1])[CH2][CX4]")
_DITHIANE = ("1,3-dithiane", "[CX4]1SCCCS1", "[CX3;!$(C(=O)[O,N])]=O")

PROTECT = {
    "alcohol": {
        "default": ("protect it as a silyl ether (TBS, or TBDPS for more acid stability; off with TBAF) or a benzyl ether (off by hydrogenolysis)", [_TBS, _TBDPS, _BN_ETHER]),
        "strong-acid": ("protect it as a benzyl or PMB ether (acid-stable; off by H2/Pd or DDQ)", [_BN_ETHER, _PMB]),
        "hydrogenation": ("protect it as a silyl ether (TBS, TBDPS) rather than a benzyl ether", [_TBS, _TBDPS]),
        "fluoride": ("protect it as a benzyl or MOM ether", [_BN_ETHER, _MOM]),
    },
    "phenol": {"default": ("protect it as a methyl, benzyl or silyl ether", [_ME_ETHER_AR, _BN_ETHER, _TBS])},
    # Unlike most entries here, this remedy needs nothing new: the trityl-protected blocks are
    # already the ones a solid-phase synthesis would reach for.
    "asn-deamidation-gly": {"default": ("carry Asn as Fmoc-Asn(Trt)-OH and keep the piperidine "
                                        "treatment short; avoid aqueous base", [])},
    "asn-deamidation-ser": {"default": ("carry Asn as Fmoc-Asn(Trt)-OH and keep the piperidine "
                                        "treatment short; avoid aqueous base", [])},
    "asn-gln-amide": {"default": ("carry the side chain as the N-trityl amide — Fmoc-Asn(Trt)-OH or "
                                  "Fmoc-Gln(Trt)-OH, removed by the same TFA as the other acid-labile groups",
                                  [_TRT_AMIDE])},
    "diol": {"default": ("protect the diol as an acetonide (acetone or 2,2-dimethoxypropane, acid cat.; off with aqueous acid)", [_ACETONIDE])},
    "amine": {
        "default": ("protect it as a carbamate: Boc (off with acid), Cbz (off by H2/Pd) or Fmoc (off with piperidine)", [_BOC, _CBZ, _FMOC]),
        "strong-acid": ("protect it as Cbz or Fmoc (acid-stable)", [_CBZ, _FMOC]),
        "hydrogenation": ("protect it as Boc or Fmoc (stable to hydrogenation)", [_BOC, _FMOC]),
        "strong-base": ("protect it as Boc or Cbz (base-stable)", [_BOC, _CBZ]),
        "hydroxide": ("protect it as Boc or Cbz (base-stable)", [_BOC, _CBZ]),
    },
    "aniline": {"default": ("protect it as an acetamide or a Boc carbamate", [_BOC])},
    "acid": {
        "default": ("carry it as an ester (methyl, or tert-butyl to resist nucleophiles) or a 2-oxazoline, and free it later", [_ME_ESTER, _TBU_ESTER, _OXAZOLINE]),
        "hydroxide": ("carry it as a tert-butyl ester (base-stable)", [_TBU_ESTER]),
    },
    # Unlike the generic acid entry, this one has a standard answer in solid-phase practice: do not
    # mask the side chain at all, take the residue already masked. Fmoc-Ser(tBu)-OH, Fmoc-Thr(tBu)-OH
    # and Fmoc-Tyr(tBu)-OH all ship in the building-block set, so the step disappears rather than
    # being made selective.
    "n-terminal-gln": {
        "default": ("carry the glutamine as Fmoc-Gln(Trt)-OH — it ships, and the trityl on the side-chain amide "
                    "leaves nothing for the alpha-amine to close onto — or leave the N-terminal Fmoc in place "
                    "until after the cleavage, so the amine is never free in acid",
                    [_TRT_AMIDE]),
    },
    "trp-indole-reduction": {"default": ("replace TES with TIS or EDT; TIS is the Trp-safe silane", [])},
    "ser-hydroxyl": {"default": ("add a cation scavenger (TIS, phenol) and keep the acid treatment "
                                 "short; check the O-to-N shift", [])},
    "thr-hydroxyl": {"default": ("add a cation scavenger (TIS, phenol) and keep the acid treatment "
                                 "short; check the O-to-N shift", [])},
    "tyr": {"default": ("add a cation scavenger (TIS, phenol) and keep the acid treatment short", [])},
    "support ester": {"default": ("avoid hydrazine while the peptide is on the support; hydrazinolysis "
                                   "cleaves the resin ester, so use a linker stable to the Dde removal or "
                                   "remove the orthogonal group before loading", [])},
    "dde-enamine": {"default": ("remove it deliberately with hydrazine; if it must survive, use a "
                                "different orthogonal group rather than exposing Dde/Ddiv to hydrazine", [])},
    "cys-acm": {"default": ("omit the thiol scavenger or use a different Cys protection; Acm is "
                             "not the block for an EDT cocktail", [])},
    "free-indole": {
        "default": ("add a cation scavenger to the cocktail — a thiol (EDT or DODT), or thioanisole with "
                    "phenol, optionally alongside triisopropylsilane; those are the components of the "
                    "standard cocktails, and naming them rather than a cocktail alias keeps every species "
                    "weighable. And/or carry the tryptophan as "
                    "Fmoc-Trp(Boc)-OH, which ships: the Boc on the indole nitrogen deactivates the ring and the "
                    "same acid takes it off. Water alone is not enough", []),
    },
    "free-alpha-carboxyl": {
        "default": ("protect the alpha-carboxyl before masking the side chain — carry it as the tert-butyl ester — "
                    "or, better, take the residue with its side chain already protected "
                    "(Fmoc-Ser(tBu)-OH, Fmoc-Thr(tBu)-OH, Fmoc-Tyr(tBu)-OH) and drop this step entirely",
                    [_TBU_ESTER, _ME_ESTER]),
    },
    "aldehyde": {"default": ("protect it as a 1,3-dioxolane acetal (ethylene glycol, TsOH; off with aqueous acid)", [_DIOXOLANE]),
                 "strong-acid": ("protect it as a 1,3-dithiane (acid-stable)", [_DITHIANE])},
    "ketone": {"default": ("protect it as a 1,3-dioxolane ketal (ethylene glycol, TsOH; off with aqueous acid)", [_DIOXOLANE]),
               "strong-acid": ("protect it as a 1,3-dithiane (acid-stable)", [_DITHIANE])},
    "enolizable-ketone": {"default": ("protect it as a 1,3-dioxolane ketal, or form the enolate selectively first", [_DIOXOLANE])},
    "thiol": {"default": ("protect it as a thioether (S-trityl; off with TFA)", [_TRT_S])},
    "ester": {"default": ("use a chemoselective reagent (NaBH4 for a ketone or aldehyde; DIBAL at −78 °C for one ester), a hindered tert-butyl ester, or change the order of steps", [_TBU_ESTER])},
    "lactone": {"default": ("use a chemoselective reagent or change the order of steps", [])},
    "nitrile": {"default": ("use a chemoselective reagent or introduce the nitrile later", [])},
    "amide": {"default": ("use a milder reagent or change the order of steps", [])},
    "boc": {"default": ("switch to Cbz or Fmoc, which survive acid", [_CBZ, _FMOC])},
    "cbz": {"default": ("switch to Boc or Fmoc, which survive hydrogenation", [_BOC, _FMOC])},
    "fmoc": {"default": ("switch to Boc or Cbz, which survive base", [_BOC, _CBZ])},
    "benzyl-ether": {"default": ("switch to a PMB ether (off with DDQ) or a silyl ether, or reduce without hydrogenolysis", [_PMB, _TBS])},
    "benzyl-ester": {"default": ("switch to a methyl or tert-butyl ester", [_ME_ESTER, _TBU_ESTER])},
    "silyl-ether": {"default": ("use a sturdier silyl group (TBDPS, TIPS) or a benzyl ether", [_TBDPS, _BN_ETHER])},
    "acetal": {"default": ("keep the step non-acidic or protect as a 1,3-dithiane", [_DITHIANE])},
    "tbu-ester": {"default": ("switch to a methyl or benzyl ester", [_ME_ESTER])},
    "trityl": {"default": ("keep the step non-acidic or switch protecting group", [])},
    "alkene": {"default": ("use a chemoselective reagent (e.g. reduce a nitro with Fe/HCl or SnCl2, remove Bn with BCl3 or DDQ) or introduce the alkene later", [])},
    "alkyne": {"default": ("use a chemoselective reagent or introduce the alkyne later", [])},
    "terminal-alkyne": {"default": ("protect it as a TMS or TIPS alkyne", [])},
    "nitro": {"default": ("reduce it in a later step, or use a reagent that leaves nitro groups alone", [])},
    "azide": {"default": ("introduce the azide later, or reduce the other group without H2/Pd", [])},
    "aryl-halide": {"default": ("introduce the halide later, or use a reagent that leaves aryl halides alone", [])},
    "alkyl-halide": {"default": ("use a non-nucleophilic, milder base or introduce the halide later", [])},
    "epoxide": {"default": ("introduce the epoxide later", [])},
    "sulfide": {"default": ("use a milder or more selective oxidant, or change the order of steps", [])},
    "met-sulfide": {"default": ("keep the peptide under nitrogen or add EDT to the cleavage/work-up; "
                                "reduce the sulfoxide if it has already formed", [])},
    "asp-pro": {"default": ("avoid prolonged strong acid at the Asp-Pro bond; use a milder cleavage or "
                            "shorten the acid treatment", [])},
    "tertiary-amine": {"default": ("protonate it (as the salt) or change the order of steps", [])},
}


# "4 M HCl in dioxane" (or ether, EtOAc, MeOH) is the anhydrous strong acid that removes a Boc,
# not a dilute aqueous work-up, although it is written the same way.
_DILUTE_ACID = re.compile(r"(dilute|dil\.|aq\.?|aqueous|\d+(\.\d+)?\s*[NM])\s*(HCl|H2SO4)"
                          r"(?!\s*(?:/|in\s+)(?:1,4-)?(?:dioxane|ether|Et2O|EtOAc|MeOH|CPME))", re.I)
_AMIDE_BASE = re.compile(r"\bHMDS\b|hexamethyldisilazane|diisopropylamine|\biPr2NH\b|\bTMP\b|tetramethylpiperidine", re.I)
# What covers a FREE indole through an acid cleavage: a thiol, or an electron-rich arene, that
# takes the cation instead of the tryptophan.
#
# Two absences are deliberate, and both are sourced from Chan & White, *Fmoc Solid Phase Peptide
# Synthesis: A Practical Approach*, Ch. 3 §10.2 (p. 65 and Tables 4-5).
#
# WATER IS ABSENT. Almost every cocktail is written with a few percent of it, and it does not keep
# a tert-butyl or trityl cation off an indole (TFA/H2O 95:5 is precisely the mixture that alkylates
# Trp), so reading it as an answer would silence the flag on nearly every real route. The book is
# softer — "moderately effective", "some protection ... against sulphonation" — but "some
# protection" is not something a route can be scored against.
#
# WHICH TRIALKYLSILANE IT IS decides the answer, and this is the one place in the hazard set where
# two sources disagree and the citation had to be weighed rather than read.
#
#   * Chan & White argue against silanes as a class. Both silane cocktails in Table 4 are
#     prescribed for peptides "except ... unprotected Trp", only Reagent K is listed for "All
#     peptides", the prose recommends silanes "particularly for peptides containing
#     Arg(Pmc)/Arg(Pbf) and Trp(Boc)" — the PROTECTED residue — and Table 5 files "reduction of the
#     indole ring of Trp" with the remedy "omit silane scavengers from the cleavage cocktail and
#     substitute for EDT". It never separates TIS from TES.
#   * *Amino Acids, Peptides and Proteins in Organic Chemistry* Vol 3 Ch. 10 (printed pp. 357-358)
#     does separate them: "TES has better scavenging properties then TIS. However, the latter (TIS)
#     IS RECOMMENDED FOR Trp-CONTAINING SEQUENCES since the former (TES) has the ability to reduce
#     the indole function of this residue." Table 10.1 marks TFA/TES 95:5 "no: Trp" and TFA/TIS
#     95:5 "acceptable: Trp". Both rest on Pearson, Blanchette, Baker & Guindon, Tetrahedron Lett
#     30, 2739-2742 (1989).
#
# Resolved in favour of Vol 3: it is later, it is specifically about cleavage cocktails, and it
# names the reagents individually where Chan & White generalises. So TIS is accepted here and TES
# is not. An unnamed "silane" is not accepted either, because the two differ in exactly the
# property that matters and the ambiguity cannot be resolved.
#
# This reversed an earlier over-correction. The first version of this rule rejected EVERY silane on
# Chan & White alone, which flagged the very cocktail the specialist source recommends FOR
# tryptophan. A silane remains the right answer for the stabilised cations (trityl, Tmob, the Rink
# linker) regardless.
_INDOLE_SCAVENGER = re.compile(
    r"\btriisopropylsilane\b|\bTIS\b"
    r"|\bEDT\b|ethanedithiol|\bDODT\b|dioxa[- ]?octanedithiol|\bdithiol\b|thioanisole"
    r"|dimethyl ?sulfide|\bDMS\b|\bthiocresol\b|\banisole\b|\bphenol\b|\bcresol\b"
    r"|" + _COCKTAIL_SCAVENGING, re.I)


def has_cation_scavenger(text):
    """Whether a step's conditions name something that takes a cation before a FREE indole does.

    A trialkylsilane alone does not qualify; see the note on `_INDOLE_SCAVENGER`.
    """
    return bool(_INDOLE_SCAVENGER.search(text or ""))


_THIOL_SCAVENGER = re.compile(
    r"\bEDT\b|ethanedithiol|\bDODT\b|dioxa[- ]?octanedithiol|\bdithiothreitol\b|\bDTT\b|"
    r"\bTCEP\b|tris\(2-carboxyethyl\)phosphine|\bmercaptoethanol\b|\bthioanisole\b", re.I)


def has_thiol_scavenger(text):
    """Whether the step names a thiol (or thioanisole) that can exchange with Cys(Acm)."""
    return bool(_THIOL_SCAVENGER.search(text or ""))
_ZINC = re.compile(r"(?<![A-Za-z])Zn(Cl2|Br2|I2)(?![A-Za-z0-9])|\bEt2Zn\b", re.I)
_COPPER = re.compile(r"(?<![A-Za-z])Cu(I|Br|Cl|CN|SPh|\(I\)|OTf)?(?![a-z])|copper", re.I)


def classify(text):
    """The reagent classes named in a step's conditions text (in table order, each once)."""
    found = []
    # A dilute or aqueous mineral acid is a work-up, not a strong-acid step: it is matched as
    # aqueous acid and kept out of the strong-acid patterns.
    strong_text = _DILUTE_ACID.sub(" ", text)
    for cls, _label, patterns in REAGENT_CLASSES:
        haystack = strong_text if cls == "strong-acid" else text
        if any(re.search(p, haystack, re.I) for p in patterns):
            found.append(cls)
    # A Grignard or organolithium with a copper(I) or zinc salt is a cuprate or organozinc (conjugate
    # addition, ketones from acid chlorides), which leaves esters and ketones alone.
    # BuLi with a secondary amine (HMDS, diisopropylamine, TMP) makes an amide base in situ.
    if "organometallic" in found and _AMIDE_BASE.search(text):
        found.remove("organometallic")
        if "strong-base" not in found:
            found.append("strong-base")
    if "organometallic" in found and (_COPPER.search(text) or _ZINC.search(text)):
        found.remove("organometallic")
        if "cuprate" not in found:
            found.append("cuprate")
    # Organolithiums are also strong bases; Lindlar is not a general hydrogenation.
    if "lindlar" in found and "hydrogenation" in found:
        found.remove("hydrogenation")
    return found


# ------------------------------------------------------- the bridge: a transform id -> conditions
# `classify` reads a conditions STRING, which is what the free-text (LLM) route path supplies. A
# PROGRAM-MODE route does not have that string: each step identifies its operation by transform
# `id` and lists reagent SMILES, so `classify("fmoc-removal")` is [] and every hazard gate stays
# silent on a generated route. Verified 2026-10-17 by executing the generator's own routes and
# finding zero hazards fired — not because the molecules were clean, but because nothing told the
# checker what reagent each step used.
#
# This is that missing piece: the representative conditions an operation runs under, so a
# program-mode step can be handed to `classify` (and thence to `_compatibility`) exactly as a
# free-text step is. One entry per transform the peptide generator can emit — assembly, the
# dipeptide/pseudoproline endgame, global deprotection, and resin cleavage.
#
# The strings are real cocktails on purpose, so `classify` reads them through its ordinary
# patterns rather than through a second code path; `conditions_for_transform` is the only new
# surface. Checked against each transform's own `summary` in test_transform_conditions.py: where a
# summary names its reagent, the class it classifies to must match the class these conditions give,
# so this map cannot drift from the chemistry the executor describes.
_FMOC_REMOVAL = "20% piperidine in DMF, 2 x 5 min"
_COUPLING = "Fmoc-amino acid, HBTU, DIPEA, DMF, 45 min"
_ACID_CLEAVAGE = "TFA/H2O 95:5, 2 h"
_FORMYLATION = "formic acid, DIC/HOBt, DMF, 2 h"
_HYDRAZINOLYSIS = "hydrazine, DMF, 2 x 3 min"
_PD_ALLYL = "Pd(PPh3)4, morpholine, DMF, 2 h"
TRANSFORM_CONDITIONS = {
    # assembly
    "fmoc-removal": _FMOC_REMOVAL,
    "n-peptide-coupling": _COUPLING,
    "n-acylation": _COUPLING,
    "n-formylation": _FORMYLATION,
    "amide-formation": _COUPLING,
    # global deprotection and resin cleavage, all under the final acid
    "boc-removal": _ACID_CLEAVAGE,
    "ring-nitrogen-boc-removal": _ACID_CLEAVAGE,
    "tert-butyl-ester-removal": _ACID_CLEAVAGE,
    "tert-butyl-ether-removal": _ACID_CLEAVAGE,
    "mpe-ester-removal": _ACID_CLEAVAGE,
    "trityl-removal": _ACID_CLEAVAGE,
    "s-trityl-removal": _ACID_CLEAVAGE,
    "n-trityl-removal": _ACID_CLEAVAGE,
    "imidazole-trityl-removal": _ACID_CLEAVAGE,
    "pbf-removal": _ACID_CLEAVAGE,
    "dmb-removal": _ACID_CLEAVAGE,
    "pseudoproline-opening": _ACID_CLEAVAGE,
    "resin-cleavage": _ACID_CLEAVAGE,
    "resin-cleavage-amide": _ACID_CLEAVAGE,
    "dde-removal": _HYDRAZINOLYSIS,
    "alloc-removal": _PD_ALLYL,
    "allyl-ester-removal": _PD_ALLYL,
}


def conditions_for_transform(transform_id):
    """The conditions a program-mode step runs under, from its transform id, or None if unmapped.

    The bridge between a generated route (which names operations by id) and the hazard checker
    (which reads a conditions string). A caller checking a program-mode route passes this result as
    the step's `reagents`, so the same `classify` -> `_compatibility` path serves both route forms.
    Returns None for a transform outside the peptide set, so an unmapped id is a visible gap rather
    than a wrong class.
    """
    return TRANSFORM_CONDITIONS.get(transform_id)


def label_of(cls):
    return next((label for c, label, _ in REAGENT_CLASSES if c == cls), cls)


def suggestion(group, cls):
    table = PROTECT.get(group)
    if not table:
        return None, []
    text, forms = table.get(cls) or table["default"]
    return text, forms
