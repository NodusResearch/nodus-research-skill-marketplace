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
    ("amine-base", "amine base (piperidine, DBU)", [r"\bpiperidine\b", _F + r"DBU" + _E, r"\bmorpholine\b"]),
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
        _F + r"BF3" + _E, _F + r"TMSOTf" + _E, _F + r"BBr3" + _E, _F + r"BCl3" + _E]),
    ("aqueous-acid", "aqueous acid (work-up)", [_F + r"H3O\+", r"aqueous acid", r"\bH\+(?![A-Za-z0-9])",
                                               r"(dilute|dil\.|aq\.?|aqueous|\d+(\.\d+)?\s*[NM])\s*(HCl|H2SO4)"]),
    ("fluoride", "fluoride (TBAF, HF)", [_F + r"TBAF" + _E, r"tetrabutylammonium fluoride", _F + r"HF" + _E,
                                         r"hf.?pyridine", _F + r"CsF" + _E, _F + r"TASF" + _E]),
    ("chromium-oxidant", "chromium or permanganate oxidant", [
        _F + r"CrO3" + _E, r"\bjones\b", _F + r"PCC" + _E, _F + r"PDC" + _E, _F + r"(Na|K)2Cr2O7" + _E,
        r"dichromate", r"chromic", _F + r"KMnO4" + _E, r"permanganate"]),
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
        r"acyl chloride", r"anhydride", r"benzoyl chloride", _F + r"BzCl" + _E, _F + r"(DCC|EDC|EDCI|DIC|HATU|HBTU|PyBOP|T3P)" + _E,
        r"carbodiimide"]),
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
    #   - the remaining literature-prone neighbours (alanine, asparagine, aspartate) have no
    #     special building block, so they get the general advice;
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
    "aspartimide-prone-xaa": ("aspartate side-chain ester followed by alanine, asparagine or aspartate",
                              "[OX2;$(O[CX4]);!$(O[CX4]([CX4])([CX4])[CX4;!H3])][CX3](=O)[CH2]"
                              "[CX4;H1]([NX3])[CX3](=O)[NX3;H1]"
                              "[CX4;H1]([$([CH3]),$([CH2][CX3](=O)[#7,#8])])[CX3]=O"),
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
    "cys-epimerisation": ("cysteine with its alpha-carboxyl free",
                          "[OX2H1][CX3](=O)[CX4;H1][CH2][SX2]"),
    "his-epimerisation": ("histidine with its alpha-carboxyl free",
                          "[OX2H1][CX3](=O)[CX4;H1][CH2]c1cncn1"),
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
    "aniline": ("aniline (N–H)", "[NX3;H2,H1;!$(N[C,S]=[O,S,N])]-a"),
    "tertiary-amine": ("tertiary amine", "[NX3;H0;!$(N[C,S,P]=[O,S,N]);!$(N-a);!$(N[#7,#8]);!$([N+])]([#6])([#6])[#6]"),
    "thiol": ("thiol", "[SX2H]"),
    "sulfide": ("sulfide", "[#6][SX2;!$(S[SX2])][#6]"),
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
    "amine-base": [("fmoc", "high", "is cleaved by amine base"), ("acid-chloride", "high", "is aminolysed"),
        ("aspartimide-gly", "high", "closes to the aspartimide — Asp-Gly is the classic worst case, the glycine having "
                                    "no side chain to hinder it — which reopens to a mixture of alpha- and beta-linked "
                                    "peptide and epimerises the aspartate. The usual answer for this pair is backbone "
                                    "protection on the glycine (Hmb or Dmb, bought as the Fmoc-Asp(OtBu)-(Dmb)Gly-OH "
                                    "dipeptide); failing that, a hindered side-chain ester such as OMpe, a non-ester "
                                    "side-chain mask, an acidic modifier or a shorter deprotection, or a less basic "
                                    "amine than piperidine"),
        ("aspartimide-gly-hindered", "medium", "may still close to the aspartimide: the hindered ester slows the "
                                               "attack but Asp-Gly is prone enough that it is not always sufficient. "
                                               "If the chain sees many base treatments, move to backbone protection on "
                                               "the glycine (Fmoc-Asp(OtBu)-(Dmb)Gly-OH) or add an acidic modifier"),
        ("aspartimide-beta-heteroatom", "medium", "may close to the aspartimide, reopening to alpha- and beta-linked "
                                                  "peptide and epimerising the aspartate. Because the next residue is "
                                                  "a serine, threonine or cysteine, a pseudoproline dipeptide at that "
                                                  "position removes the backbone N-H outright; a hindered side-chain "
                                                  "ester such as OMpe, an acidic modifier or a shorter deprotection, "
                                                  "or a less basic amine than piperidine also apply"),
        ("aspartimide-prone-xaa", "medium", "may close to the aspartimide, reopening to alpha- and beta-linked peptide "
                                            "and epimerising the aspartate. Milder than the Asp-Gly case and dependent "
                                            "on how many base treatments the chain sees; no special dipeptide is sold "
                                            "for this neighbour, so the answers are a hindered side-chain ester such as "
                                            "OMpe, a non-ester side-chain mask, an acidic modifier or a shorter "
                                            "deprotection, or a less basic amine than piperidine"),
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
        ("tbu-ester", "high", "is cleaved by acid"), ("silyl-ether", "medium", "may be cleaved (TMS, TES, TBS more than TBDPS, TIPS)"),
        ("trityl", "high", "is cleaved by acid"), ("epoxide", "medium", "may be opened")],
    "aqueous-acid": [("acetal", "medium", "may be hydrolysed"), ("trityl", "medium", "may be cleaved"),
                     ("silyl-ether", "medium", "may be cleaved (TMS, TES)")],
    "fluoride": [("silyl-ether", "high", "is cleaved by fluoride")],
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
    "strong-acid": [
        ("free-indole", "high", "is laid BARE by this step, in the acid that is still full of the cations the other "
                                "protecting groups are shedding — tert-butyl, trityl, Pbf sulfonyl. The indole is "
                                "the most electron-rich ring in the peptide, so it takes them, and the alkylated "
                                "tryptophan cannot be recovered"),
        ("n-terminal-gln", "high", "is left free by this step, and it then cyclises to PYROGLUTAMATE: the alpha-amine "
                                   "closes onto its own side-chain amide and ammonia leaves, so the peptide ends up "
                                   "with no N-terminus. Acid at the end of a synthesis is where this bites, because "
                                   "nothing further acylates the amine"),
    ],
    "amine-base": [
        ("resin-dipeptide-dkp", "high", "is what this step CREATES, and it closes to the diketopiperazine, taking the "
                                        "peptide off the support: the amine this deprotection frees sits six atoms "
                                        "from the ester holding the first residue to the resin, and glycine or "
                                        "proline in that position closes it fast. This ENDS the synthesis rather "
                                        "than eroding it — bare linker is left behind — and the atom checks cannot "
                                        "see it, because a cyclic peptide and a resin alcohol both balance "
                                        "perfectly. The answer is to never have the resin-bound dipeptide: load the "
                                        "pair as one block, Fmoc-Gly-Pro-OH, in place of the anchored monomer"),
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
        ("cys-epimerisation", "medium", "may EPIMERISE while it is activated: the sulfur acidifies its "
                                        "alpha-proton and a tertiary amine base removes it, so a D residue goes "
                                        "into the chain. Nothing downstream can see that — the D peptide has the "
                                        "same formula and the same mass, so balance and target-matching both pass. "
                                        "Couple it with a weaker base (2,4,6-collidine in place of DIPEA) or with "
                                        "DIC/Oxyma, keep the pre-activation short, and stay cold"),
        ("his-epimerisation", "medium", "may EPIMERISE while it is activated: its own imidazole can take the "
                                        "alpha-proton, so the base is not the only route to it and a D residue "
                                        "goes into the chain. Nothing downstream can see that — same formula, same "
                                        "mass. Couple it with 2,4,6-collidine rather than DIPEA, or with "
                                        "DIC/Oxyma or HOAt, and keep the pre-activation short"),
    ],
}

# Conditions that answer an epimerisation flag: a weaker base than DIPEA, or an additive that
# suppresses racemisation. TEMPERATURE IS DELIBERATELY NOT READ — "0 °C" and "10 °C" differ by one
# character, and misparsing one would silence the flag on a route that deserves it, so a cold
# coupling has to say collidine or Oxyma to clear this.
_EPIMERISATION_CARE = re.compile(r"\bcollidine\b|trimethylpyridine|\boxyma\b|\bHOAt\b"
                                 r"|cyanohydroxyimino", re.I)


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
    "free-indole": {
        "default": ("add a cation scavenger to the cocktail — triisopropylsilane with a thiol (EDT or DODT), or "
                    "thioanisole and phenol, as in Reagent B or Reagent K — and/or carry the tryptophan as "
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
# A TRIALKYLSILANE IS ALSO ABSENT, and used to be here, which made this check clear on a cocktail
# the book prescribes only for peptides WITHOUT a free tryptophan. Table 4 lists TFA/TIS/water and
# TFA/TIS/water/EDT for peptides "except ... unprotected Trp", and only Reagent K for "All
# peptides"; the prose recommends silanes "particularly for peptides containing Arg(Pmc)/Arg(Pbf)
# and Trp(Boc)" — the PROTECTED residue — while it is EDT that "offers some protection to
# unprotected tryptophan against sulphonation". Table 5 then files a silane as a CAUSE of Trp
# damage, "reduction of the indole ring of Trp", whose remedy is to "omit silane scavengers from
# the cleavage cocktail and substitute for EDT". A silane is still the right answer for the
# stabilised cations (trityl, Tmob, the Rink linker) — it is just not the answer for this group,
# so it clears the flag only in company, through the thiol or arene that accompanies it.
_INDOLE_SCAVENGER = re.compile(
    r"\bEDT\b|ethanedithiol|\bDODT\b|dioxa[- ]?octanedithiol|\bdithiol\b|thioanisole"
    r"|dimethyl ?sulfide|\bDMS\b|\bthiocresol\b|\banisole\b|\bphenol\b|\bcresol\b"
    r"|reagent ?[bkh]\b", re.I)


def has_cation_scavenger(text):
    """Whether a step's conditions name something that takes a cation before a FREE indole does.

    A trialkylsilane alone does not qualify; see the note on `_INDOLE_SCAVENGER`.
    """
    return bool(_INDOLE_SCAVENGER.search(text or ""))
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


def label_of(cls):
    return next((label for c, label, _ in REAGENT_CLASSES if c == cls), cls)


def suggestion(group, cls):
    table = PROTECT.get(group)
    if not table:
        return None, []
    text, forms = table.get(cls) or table["default"]
    return text, forms
