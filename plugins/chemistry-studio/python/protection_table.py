"""Structured protecting-group data: what removes each group, and what must not be present.

The generator and the compatibility gates used to answer these questions in three different places:
a regex/if chain in the route generator, a site phrase in `route_transforms.json`, and the reagent
tables in `compat_tables.py`. This module is the single structured answer for the shipped SPPS
groups.

Fields per group:
  sites        residue -> (transform id, site phrase, needs water). `default` applies when the
               residue is not listed. An empty mapping with `status: "manual"` means the group is
               shipped but the linear generator does not select it / no removal is wired.
  mass_shift   key into `compat_tables.MASS_SHIFTS`, or None when no residual mass is tabulated.
  compatible   scavengers the literature treats as safe for this removal.
  incompatible scavengers the literature calls out as destructive for this group or its residue.
  notes        the reason, in one sentence.

This is deliberately NOT a recipe: equivalents, time and temperature stay out.
"""

# Group token -> data. Tokens are the text inside the parentheses of a shipped block name, e.g.
# `Fmoc-Lys(Boc)-OH` -> "Boc", `Fmoc-Asp(OtBu)-OH` -> "OtBu", `Fmoc-Cys(Trt)-OH` -> "Trt".
GROUPS = {
    "Boc": {
        "label": "Boc carbamate",
        "sites": {
            "default": ("boc-removal", "boc carbamate", False),
            # The indole nitrogen is aromatic and needs its own transform; `boc-removal`'s site is
            # an aliphatic amine.
            "Trp": ("ring-nitrogen-boc-removal", "ring nitrogen boc", False),
        },
        "mass_shift": "boc",
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "Acid-labile; stable to piperidine. The Trp indole is the ring-nitrogen case.",
    },
    "OtBu": {
        "label": "tert-butyl ester",
        "sites": {"default": ("tert-butyl-ester-removal", "tert-butyl ester", False)},
        "mass_shift": "tbu-ester",
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "Acid-labile side-chain carboxyl protection (Asp/Glu).",
    },
    "tBu": {
        "label": "tert-butyl ether",
        "sites": {"default": ("tert-butyl-ether-removal", "tert-butyl ether", False)},
        "mass_shift": "tbu-ether",
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "Acid-labile side-chain hydroxyl protection (Ser/Thr/Tyr).",
    },
    "Pbf": {
        "label": "Pbf sulfonamide",
        "sites": {"default": ("pbf-removal", "pbf sulfonamide", True)},
        "mass_shift": None,
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "Acid-labile guanidine protection; water is consumed in the removal.",
    },
    "Trt": {
        "label": "trityl",
        "sites": {
            "Cys": ("s-trityl-removal", "s-trityl", True),
            "His": ("imidazole-trityl-removal", "imidazole trityl", True),
            "default": ("n-trityl-removal", "n-trityl", True),
        },
        "mass_shift": "trityl",
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "The freed atom decides the transform: sulfur, imidazole or amide nitrogen.",
    },
    "OMpe": {
        "label": "3-methylpent-3-yl ester",
        "sites": {"default": ("mpe-ester-removal", "3-methylpent-3-yl ester", False)},
        "mass_shift": None,
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "Acid-labile carboxyl protection; no residual mass key is tabulated.",
    },
    "Dmb": {
        "label": "Dmb amide (dipeptide auxiliary)",
        "sites": {"default": ("dmb-removal", "dmb amide", True)},
        "mass_shift": None,
        "aux": True,
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "The Asp-Gly dipeptide auxiliary, not the side-chain Dmb ester.",
    },
    "psiMe": {
        "label": "pseudoproline oxazolidine",
        "sites": {"default": ("pseudoproline-opening", "pseudoproline", True)},
        "mass_shift": None,
        "aux": True,
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "The Ala-Ser pseudoproline auxiliary; opened in the final acid.",
    },
    "Acm": {
        "label": "S-acetamidomethyl",
        "sites": {"default": ("acm-removal-hg", "S-acetamidomethyl", True)},
        "mass_shift": "cys-acm",
        "compatible": ("I2/MeOH", "Hg(II)/H2S", "Tl(III)"),
        "incompatible": ("EDT", "DTT"),
        "notes": "Acid-stable and orthogonal to Trt; removed by Hg(II)/I2/Tl(III). A thiol "
                 "scavenger can exchange with it.",
    },
    "StBu": {
        "label": "S-tert-butylsulfanyl",
        "sites": {"default": ("stbu-removal", "tert-butyl disulfide", False)},
        "mass_shift": None,
        "compatible": ("DTT", "mercaptoethanol", "Hg(II)"),
        "incompatible": (),
        "notes": "Removed by thiol-disulfide exchange; the mixed disulfide is resistant to further "
                 "interchange because the tert-butyl carbon is tertiary.",
    },
    "Dde": {
        "label": "Dde enamine",
        "sites": {"default": ("dde-removal", "Dde/Ddiv enamine", False)},
        "mass_shift": None,
        "compatible": ("hydrazine",),
        "incompatible": (),
        "notes": "Hydrazine-labile Lys protection for on-resin orthogonal work; Ddiv is preferred "
                 "where migration or premature loss is a concern.",
    },
    "Ddiv": {
        "label": "Ddiv enamine",
        "sites": {"default": ("dde-removal", "Dde/Ddiv enamine", False)},
        "mass_shift": None,
        "compatible": ("hydrazine",),
        "incompatible": (),
        "notes": "The more migration-resistant alternative to Dde; removed by the same hydrazine "
                 "step.",
    },
    "Alloc": {
        "label": "allyloxycarbonyl carbamate",
        "sites": {"default": ("alloc-removal", "alloc carbamate", True)},
        "mass_shift": None,
        "compatible": ("Pd(PPh3)4", "morpholine", "dimedone", "thiosalicylic acid"),
        "incompatible": (),
        "notes": "Pd(0)-labile amine protection; the allyl fragment is trapped by a nucleophile.",
    },
    "OAll": {
        "label": "allyl ester",
        "sites": {"default": ("allyl-ester-removal", "allyl ester", True)},
        "mass_shift": None,
        "compatible": ("Pd(PPh3)4", "morpholine", "dimedone", "thiosalicylic acid"),
        "incompatible": (),
        "notes": "Pd(0)-labile carboxyl protection; frees the acid for on-resin cyclisation or "
                 "branching while tBu/Boc groups survive.",
    },
    "Bum": {
        "label": "Bum (tert-butoxymethyl)",
        "sites": {},
        "mass_shift": None,
        "status": "manual",
        "compatible": ("TFA", "TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": (),
        "notes": "His(Bum) ships for manual use; the linear generator selects His(Trt), and no "
                 "Bum-specific removal transform is wired.",
    },
    "Fmoc": {
        "label": "side-chain Fmoc",
        "sites": {},
        "mass_shift": "fmoc",
        "status": "manual",
        "compatible": ("piperidine",),
        "incompatible": (),
        "notes": "A side-chain Fmoc is a branching template (bis-Fmoc lysine), not a linear SPPS "
                 "group; the generator does not select it.",
    },
}

# Ch 3 Table 5: the mass-difference diagnostics for a cleavage that went wrong. These are
# advisories, not gates: the sequence/conditions decide which one is worth saying. The `deltaLabel`
# is the string a reader sees because the book prints +254/266 as one row.
CLEAVAGE_DIAGNOSTICS = {
    "trp-indole-reduction": {
        "delta": -71, "deltaLabel": "-71", "residue": "Trp",
        "label": "Trp indole reduction",
        "cause": "a silane scavenger reduced the indole ring",
        "remedy": "omit the silane and use EDT instead",
    },
    "cys-acm-loss": {
        "delta": -71, "deltaLabel": "-71", "residue": "Cys(Acm)",
        "label": "loss of Acm",
        "cause": "the Acm protecting group was lost during cleavage",
        "remedy": "repeat the cleavage omitting thioanisole",
    },
    "met-sulfoxide": {
        "delta": 16, "deltaLabel": "+16", "residue": "Met",
        "label": "Met sulfoxide",
        "cause": "the sulfide was oxidised to the sulfoxide",
        "remedy": "use peroxide-free ether, include EDT/EMS, and reduce the sulfoxide",
    },
    "trp-boc-decarboxylation": {
        "delta": 44, "deltaLabel": "+44", "residue": "Trp(Boc)",
        "label": "Trp(Boc) decarboxylation",
        "cause": "the Trp(Boc) intermediate did not fully decarboxylate",
        "remedy": "lyophilise from 0.1% aqueous acetic acid and repeat as needed",
    },
    "t-butylation": {
        "delta": 56, "deltaLabel": "+56", "residue": "Cys/Met/Tyr/Trp",
        "label": "t-butylation",
        "cause": "incomplete tBu removal or alkylation by the tBu cation",
        "remedy": "increase the EDT content and use Trt/Trp(Boc) derivatives",
    },
    "trp-dithioketal": {
        "delta": 172, "deltaLabel": "+172", "residue": "Trp",
        "label": "Trp dithioketal",
        "cause": "prolonged EDT exposure formed a dithioketal, especially during Mtr removal",
        "remedy": "keep cleavage short, use Trp(Boc), or use TMSBr/TFA",
    },
    "arg-mtr-incomplete": {
        "delta": 212, "deltaLabel": "+212", "residue": "Arg(Mtr)",
        "label": "incomplete Mtr removal",
        "cause": "the Mtr group or a Trp-Mtr adduct survived",
        "remedy": "re-treat, use TMSBr/TFA, or switch to Arg(Pbf)",
    },
    "fmoc-incomplete": {
        "delta": 222, "deltaLabel": "+222", "residue": "N-terminus",
        "label": "Fmoc not removed",
        "cause": "the final Fmoc was still present before cleavage",
        "remedy": "treat with 20% piperidine in DMF, evaporate and triturate",
    },
    "trt-incomplete": {
        "delta": 242, "deltaLabel": "+242", "residue": "Cys/N-terminal Asn",
        "label": "incomplete trityl removal",
        "cause": "the trityl group survived the cleavage",
        "remedy": "re-treat with EDT and TIS, or use Asn(Mtt)",
    },
    "arg-pbf-incomplete": {
        "delta": 254, "deltaLabel": "+254/266", "residue": "Arg(Pbf/Pmc)",
        "label": "incomplete Pbf/Pmc removal",
        "cause": "the sulfonyl protecting group survived",
        "remedy": "re-treat with the cleavage cocktail or TMSBr/TFA",
    },
}


# Scavenger notes that belong to a RESIDUE, not a protecting group. Kept separate because the
# group table is keyed by the group, and `Trp` + TES is a fact about the indole, not about Boc.
RESIDUE_SCAVENGERS = {
    "Trp": {
        "compatible": ("TIS", "H2O", "EDT", "thioanisole", "phenol"),
        "incompatible": ("TES",),
        "notes": "TES reduces the indole; TIS is the Trp-safe silane.",
    },
    "Met": {
        "compatible": ("EDT", "TIS", "H2O"),
        "incompatible": (),
        "notes": "EDT and inert atmosphere keep the sulfide reduced.",
    },
    "Cys": {
        "compatible": ("EDT", "TIS", "H2O"),
        "incompatible": (),
        "notes": "EDT protects the thiol during acidolysis.",
    },
}


def removal(group, residue=None):
    """(transform, site phrase, needs_water) for this group on this residue, or None."""
    entry = GROUPS.get(group)
    if not entry or not entry["sites"]:
        return None
    return entry["sites"].get(residue) or entry["sites"].get("default")


def mass_shift_key(group):
    entry = GROUPS.get(group)
    return entry.get("mass_shift") if entry else None


def is_manual(group):
    entry = GROUPS.get(group)
    return bool(entry and entry.get("status") == "manual")


def is_auxiliary(group):
    entry = GROUPS.get(group)
    return bool(entry and entry.get("aux"))


def compatible_scavengers(group):
    entry = GROUPS.get(group)
    return entry.get("compatible", ()) if entry else ()


def incompatible_scavengers(group):
    entry = GROUPS.get(group)
    return entry.get("incompatible", ()) if entry else ()


def residue_scavengers(residue):
    return RESIDUE_SCAVENGERS.get(residue)


def all_groups():
    return sorted(GROUPS)
