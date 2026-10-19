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
