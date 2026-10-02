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
        r"dimethyldioxirane"]),
    ("alkene-cleavage", "OsO4 or ozone", [_F + r"OsO4" + _E, r"osmium tetroxide", _F + r"O3" + _E, r"ozon",
                                          _F + r"NaIO4" + _E, r"periodate"]),
    ("acylating", "acylating agent", [
        _F + r"Ac2O" + _E, r"acetic anhydride", _F + r"AcCl" + _E, r"acetyl chloride", r"acid chloride",
        r"acyl chloride", r"anhydride", r"benzoyl chloride", _F + r"BzCl" + _E, _F + r"(DCC|EDC|EDCI|DIC|HATU|HBTU|PyBOP|T3P)" + _E,
        r"carbodiimide"]),
    ("alkylating", "alkylating agent", [
        _F + r"(MeI|CH3I|EtI|EtBr|BnBr|BnCl|MeOTf|Me2SO4)" + _E, r"methyl iodide", r"iodomethane", r"benzyl bromide",
        r"dimethyl sulfate", r"alkyl halide", r"meerwein"]),
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
    "peracid": [
        ("alkene", "high", "is epoxidized"), ("sulfide", "high", "is oxidized to the sulfoxide"),
        ("tertiary-amine", "high", "is oxidized to the N-oxide"), ("amine", "medium", "may be oxidized"),
        ("ketone", "medium", "may undergo Baeyer–Villiger oxidation"), ("aldehyde", "medium", "may be oxidized"),
        ("thiol", "high", "is oxidized")],
    "alkene-cleavage": [("alkene", "high", "is dihydroxylated or cleaved"), ("alkyne", "medium", "may be cleaved"),
                        ("sulfide", "medium", "may be oxidized"), ("diol", "medium", "is cleaved by periodate")],
    "acylating": [
        ("amine", "high", "is acylated"), ("aniline", "medium", "may be acylated"), ("alcohol", "medium", "may be acylated"),
        ("phenol", "medium", "may be acylated"), ("thiol", "high", "is acylated")],
    "alkylating": [
        ("amine", "high", "is alkylated"), ("thiol", "high", "is alkylated"), ("phenol", "medium", "may be alkylated (with base)"),
        ("acid", "medium", "may be alkylated (as the carboxylate)"), ("tertiary-amine", "medium", "may be quaternized"),
        ("aniline", "medium", "may be alkylated")],
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
_DITHIANE = ("1,3-dithiane", "[CX4]1SCCCS1", "[CX3;!$(C(=O)[O,N])]=O")

PROTECT = {
    "alcohol": {
        "default": ("protect it as a silyl ether (TBS, or TBDPS for more acid stability; off with TBAF) or a benzyl ether (off by hydrogenolysis)", [_TBS, _TBDPS, _BN_ETHER]),
        "strong-acid": ("protect it as a benzyl or PMB ether (acid-stable; off by H2/Pd or DDQ)", [_BN_ETHER, _PMB]),
        "hydrogenation": ("protect it as a silyl ether (TBS, TBDPS) rather than a benzyl ether", [_TBS, _TBDPS]),
        "fluoride": ("protect it as a benzyl or MOM ether", [_BN_ETHER, _MOM]),
    },
    "phenol": {"default": ("protect it as a methyl, benzyl or silyl ether", [_ME_ETHER_AR, _BN_ETHER, _TBS])},
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


_DILUTE_ACID = re.compile(r"(dilute|dil\.|aq\.?|aqueous|\d+(\.\d+)?\s*[NM])\s*(HCl|H2SO4)", re.I)
_AMIDE_BASE = re.compile(r"\bHMDS\b|hexamethyldisilazane|diisopropylamine|\biPr2NH\b|\bTMP\b|tetramethylpiperidine", re.I)
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
