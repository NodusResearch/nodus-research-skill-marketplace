"""Apply ONE named transformation forward to a carried molecule.

Answers the `routeProgram` payload of a reactions_worker request, in one of three ops:

    {"op": "apply", "molecule": "<SMILES>", "reagents": ["<SMILES>", ...], "site": "<phrase>",
     "budgetSeconds": 20,
     "operation": {"kind": "named", "id": "<curated id>"}
                | {"kind": "smarts", "smarts": "<forward reaction SMARTS>"}
                | {"kind": "template", "id": "<retro template or its digest>", "indexDir": "<path>"}}
        -> {"ok": true, "product", "coProducts", "formula", "site"?}
    {"op": "describe", "molecule": "<SMILES>"}  -> {"ok": true, "formula", "sites", "summary"}
    {"op": "transforms"}                        -> {"ok": true, "transforms": [{"id", "summary", "site"}]}

A failure is {"ok": false, "error": <code>, "message": <one sentence>} and never an exception, so
the caller gets a code it can branch on rather than a traceback. The codes are exactly
unresolved-name, unknown-template, no-match, ambiguous-site, absent-site, unparsable, unavailable
and budget.

The point of the shape: the model names the operation and the toolkit holds the structure, so a
route costs one line per step instead of a restatement of every carried molecule at every step.

Nothing here screens the retro template index. Screening it against a large product did not finish
above ~100 heavy atoms, cost ~45 s a step, and reproduced the real step for 38% of steps overall
and none of the 20 steps above 80 heavy atoms (logs/stage0-template-coverage.md, 2026-10-09). The
curated forward set in route_transforms.json is the path; an index template is touched only when
the caller names one, and then only by reversing that one template.

A site is always a phrase, never an atom index: an index into a structure the model never sees
goes stale the moment the toolkit canonicalises differently from the model's mental copy.
"""

import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TRANSFORMS_PATH = os.path.join(HERE, "route_transforms.json")

DEFAULT_BUDGET = 20.0
# The floor is a millisecond rather than a second: a caller that asks for an absurd budget gets a
# `budget` answer instead of a silently inflated one, and the bound stays testable.
MIN_BUDGET, MAX_BUDGET = 0.001, 60.0
# What RunReactants may generate before it stops. A loose template on a large molecule can match in
# dozens of places and every match is an outcome; past a handful of DISTINCT outcomes the verdict is
# `ambiguous-site` regardless, so the cap bounds the work without ever changing the answer.
MAX_OUTCOMES = 256
MAX_REAGENTS = 4
# A reversed index template is not written for our slot order, so the carried molecule may fit more
# than one of its reactant templates. Each fit is tried; the count is bounded for the same reason.
MAX_SLOT_ASSIGNMENTS = 4

_ERRORS = ("unresolved-name", "unknown-template", "no-match", "ambiguous-site", "absent-site",
           "unparsable", "unavailable", "budget")

_tables_cache = {}
_rxn_cache = {}
_site_query_cache = {}
_MAPNO = re.compile(r":(\d+)\]")


class _OutOfBudget(Exception):
    pass


def _worker():
    """reactions_worker, for its canonicalisation. The worker runs with -I, so the directory this
    module sits in is put on the path explicitly, as _compat_tables does for its own table."""
    import sys

    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import reactions_worker

    return reactions_worker


def _fail(code, message):
    assert code in _ERRORS, code
    return {"ok": False, "error": code, "message": message}


def _check(deadline):
    if deadline is not None and time.monotonic() > deadline:
        raise _OutOfBudget()


def _norm(phrase):
    return " ".join(str(phrase).lower().split())


def _tables():
    """The curated file, re-read when it changes on disk. Ids are never hard-coded in the adapter,
    so a transformation can be added by editing the file alone."""
    stamp = os.path.getmtime(TRANSFORMS_PATH)
    if _tables_cache.get("stamp") != stamp:
        with open(TRANSFORMS_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        order = [t for t in (data.get("transforms") or []) if isinstance(t, dict) and t.get("id")]
        _tables_cache.clear()
        _tables_cache.update({
            "stamp": stamp,
            "order": order,
            "byId": {t["id"]: t for t in order},
            "sites": dict(data.get("sites") or {}),
            "sitesByNorm": {_norm(phrase): phrase for phrase in (data.get("sites") or {})},
        })
    return _tables_cache


def _site_query(smarts):
    if smarts not in _site_query_cache:
        from rdkit import Chem

        _site_query_cache[smarts] = Chem.MolFromSmarts(smarts)
    return _site_query_cache[smarts]


def _site_matches(mol, smarts):
    """The distinct places a site pattern sits on a molecule, as atom sets. A symmetric group
    matches its own pattern several times in different atom orders — that is one place, not
    several, so placements are compared as sets."""
    query = _site_query(smarts)
    if query is None:
        return []
    places = []
    for match in mol.GetSubstructMatches(query, uniquify=True, maxMatches=MAX_OUTCOMES):
        atoms = frozenset(match)
        if atoms not in places:
            places.append(atoms)
    return places


def _reaction(smarts):
    """A forward reaction SMARTS, parsed once per process and only when it is sound: a template
    RDKit flags as an error would otherwise fail deep inside RunReactants with nothing to report."""
    if smarts in _rxn_cache:
        return _rxn_cache[smarts]
    from rdkit.Chem import rdChemReactions

    rxn = None
    try:
        rxn = rdChemReactions.ReactionFromSmarts(smarts)
        if rxn is not None and rxn.Validate(silent=True)[1]:
            rxn = None
    except Exception:
        rxn = None
    if rxn is not None and (rxn.GetNumReactantTemplates() < 1 or rxn.GetNumProductTemplates() < 1):
        rxn = None
    _rxn_cache[smarts] = rxn
    return rxn


def _owners(rxn):
    """Which reactant template each map number belongs to, so a product atom can be traced back to
    the carried molecule rather than to a reagent."""
    owners = {}
    for slot in range(rxn.GetNumReactantTemplates()):
        for atom in rxn.GetReactantTemplate(slot).GetAtoms():
            if atom.GetAtomMapNum():
                owners.setdefault(atom.GetAtomMapNum(), slot)
    return owners


def _pieces(outcome, owners, carried_slot, canon):
    """One outcome split into (SMILES, atoms it inherited from the carried molecule, heavy atoms)
    per product fragment, or None when RDKit cannot make a molecule of it."""
    from rdkit import Chem

    pieces = []
    for product in outcome:
        try:
            Chem.SanitizeMol(product)
        except Exception:
            return None
        inherited = {}
        for atom in product.GetAtoms():
            if atom.HasProp("old_mapno") and atom.HasProp("react_atom_idx"):
                if owners.get(atom.GetIntProp("old_mapno")) == carried_slot:
                    inherited[atom.GetIdx()] = atom.GetIntProp("react_atom_idx")
        groups = Chem.GetMolFrags(product)
        frags = Chem.GetMolFrags(product, asMols=True, sanitizeFrags=False)
        for group, frag in zip(groups, frags):
            smiles = canon(Chem.MolToSmiles(frag))
            if not smiles:
                return None
            pieces.append((smiles, frozenset(inherited[i] for i in group if i in inherited),
                           frag.GetNumHeavyAtoms()))
    return pieces or None


def _resolve(pieces):
    """(main product, co-products, footprint on the carried molecule) for one outcome.

    The carried molecule is the fragment that inherited the most atoms from the carried reactant —
    not the largest fragment. Largest is wrong as soon as a small acyl group comes off a large
    alcohol: what the route carries is the chain made of the atoms that went in, whatever its size.
    Ties go to the heavier fragment and then to the first SMILES alphabetically, so the answer does
    not depend on RDKit's enumeration order."""
    ranked = sorted(pieces, key=lambda piece: (-len(piece[1]), -piece[2], piece[0]))
    main = ranked[0]
    footprint = frozenset().union(*[piece[1] for piece in pieces])
    return main[0], sorted(piece[0] for piece in ranked[1:]), footprint


def _reversed_template(index_dir, wanted, deadline):
    """A retro template from the index, reversed for forward use, or None.

    Our templates are authored retro (target >> precursors), so forward use means swapping the
    sides. That is only honest when nothing is lost in the swap: the reversal must parse, RDKit must
    find no error in it, and both sides must carry the same map numbers. A reversal that fails any
    of those is reported as unknown rather than guessed at — and note the caveat even when it
    passes: the constraints a retro template puts on its target end up on the PRODUCT side, where
    they are not enforced, so a reversed template matches more loosely than its author intended.
    82,162 of the 82,940 templates of index-v5 reverse cleanly by that test, but reversing the
    methyl-ester-to-acid template and running it forward turns a tert-butyl carbamate into a
    carbamic acid: it fires where its author never meant it to. That is why this path is for a
    template the caller has named and vouched for, never one this module went looking for."""
    worker = _worker()
    import hashlib

    _check(deadline)
    rows = worker._retro_templates(index_dir)
    digest = _norm(wanted)
    for row in rows:
        _check(deadline)
        smarts = row[2]
        if smarts != wanted and hashlib.sha1(smarts.encode()).hexdigest()[:16] != digest:
            continue
        target, _, precursors = smarts.partition(">>")
        if not target or not precursors:
            return None
        rxn = _reaction(f"{precursors}>>{target}")
        if rxn is None or set(_MAPNO.findall(target)) != set(_MAPNO.findall(precursors)):
            return None
        return rxn
    return None


def _operation(payload, deadline):
    """(reaction, reagent slots, declared site phrase, slot order is negotiable) for the request's
    operation, or a failure.

    A slot is {"role", "default"}: the default fills it when the caller leaves it out, so routine
    reagents like water never have to be named. The order is negotiable only for a reversed index
    template, which was not authored for this toolkit's carried-molecule-first convention."""
    operation = payload.get("operation")
    if not isinstance(operation, dict):
        return _fail("unparsable", "The request carries no operation object.")
    kind = operation.get("kind")
    if kind == "named":
        transform = _tables()["byId"].get(operation.get("id"))
        if transform is None:
            return _fail("unresolved-name", f"No curated transformation is named {operation.get('id')!r}.")
        rxn = _reaction(transform["smarts"])
        if rxn is None:
            return _fail("unavailable", f"The curated SMARTS for {transform['id']} does not parse in this RDKit.")
        return rxn, list(transform.get("reagents") or []), transform.get("site"), False
    if kind == "smarts":
        smarts = operation.get("smarts")
        if not isinstance(smarts, str) or not smarts.strip():
            return _fail("unparsable", "The operation gives no reaction SMARTS.")
        rxn = _reaction(smarts.strip())
        if rxn is None:
            return _fail("unparsable", "That reaction SMARTS is not a reaction RDKit can run forward.")
        return rxn, [{"role": "reagent", "default": None}] * (rxn.GetNumReactantTemplates() - 1), None, False
    if kind == "template":
        index_dir, wanted = operation.get("indexDir"), operation.get("id")
        if not isinstance(index_dir, str) or not index_dir or not isinstance(wanted, str) or not wanted:
            return _fail("unknown-template", "A template operation needs both an index directory and a template id.")
        if not os.path.isdir(index_dir):
            return _fail("unknown-template", "That index directory does not exist.")
        rxn = _reversed_template(index_dir, wanted, deadline)
        if rxn is None:
            return _fail("unknown-template", "That template is not in the index, or does not reverse cleanly for forward use.")
        return rxn, [{"role": "reagent", "default": None}] * (rxn.GetNumReactantTemplates() - 1), None, True
    return _fail("unparsable", f"Operation kind {kind!r} is not one of named, smarts or template.")


def _slots(payload, slots, canon):
    """The reagent SMILES for each slot, from the request and then the slot's default, or a failure.

    An unfilled slot is `no-match`: the request itself is well formed, the operation simply cannot
    be run on what it was given."""
    from rdkit import Chem

    given = [r for r in (payload.get("reagents") or []) if isinstance(r, str) and r.strip()][:MAX_REAGENTS]
    filled = []
    for at, slot in enumerate(slots):
        value = given[at] if at < len(given) else (slot or {}).get("default")
        if not value:
            return _fail("no-match", f"This transformation needs a {(slot or {}).get('role') or 'reagent'} and none was given.")
        mol = Chem.MolFromSmiles(value)
        if mol is None:
            return _fail("unparsable", f"The reagent {value!r} is not a SMILES RDKit can read.")
        if canon(value) is None:
            return _fail("unparsable", f"The reagent {value!r} does not canonicalise.")
        filled.append(mol)
    return filled


def _apply(payload, deadline):
    from rdkit import Chem, RDLogger
    from rdkit.Chem import rdMolDescriptors

    RDLogger.DisableLog("rdApp.*")
    canon = _worker()._canon
    tables = _tables()

    smiles = payload.get("molecule")
    if not isinstance(smiles, str) or not smiles.strip():
        return _fail("unparsable", "The request carries no molecule.")
    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        return _fail("unparsable", "The carried molecule is not a SMILES RDKit can read.")
    _check(deadline)

    built = _operation(payload, deadline)
    if isinstance(built, dict):
        return built
    rxn, slots, declared, flexible = built
    filled = _slots(payload, slots, canon)
    if isinstance(filled, dict):
        return filled
    _check(deadline)

    # The phrase the caller gave wins over the one the transformation expects, so a caller can point
    # a general operation at a particular group without a new id.
    asked = payload.get("site")
    phrase = asked.strip() if isinstance(asked, str) and asked.strip() else declared
    site_atoms, site_phrase = None, None
    if phrase:
        canonical = tables["sitesByNorm"].get(_norm(phrase))
        if canonical is None:
            return _fail("unresolved-name", f"{phrase!r} is not a site phrase this toolkit knows; ask for the site vocabulary.")
        places = _site_matches(mol, tables["sites"][canonical])
        if not places:
            return _fail("absent-site", f"The carried molecule has no {canonical}.")
        if len(places) > 1:
            return _fail("ambiguous-site", f"The carried molecule has {len(places)} places matching {canonical!r}; name a narrower site.")
        site_atoms, site_phrase = places[0], canonical
    _check(deadline)

    arity = rxn.GetNumReactantTemplates()
    if len(filled) + 1 != arity:
        return _fail("no-match", f"This transformation takes {arity} reactants and {len(filled) + 1} were available.")
    if not flexible or arity == 1 or mol.HasSubstructMatch(rxn.GetReactantTemplate(0)):
        # The curated set is authored carried-molecule-first, so slot 0 is the convention; a
        # curated transformation that does not fit there has simply not applied, and says so below.
        assignments = [(0, (mol,) + tuple(filled))]
    else:
        # A reversed index template was not written for that convention, so a carried molecule that
        # does not fit slot 0 is offered the others and every fit is run.
        assignments = []
        for slot in range(1, arity):
            if mol.HasSubstructMatch(rxn.GetReactantTemplate(slot)):
                rest = list(filled)
                assignments.append((slot, tuple(mol if at == slot else rest.pop(0) for at in range(arity))))
            if len(assignments) >= MAX_SLOT_ASSIGNMENTS:
                break
        if not assignments:
            return _fail("no-match", "The carried molecule fits none of this transformation's reactant patterns.")

    owners = _owners(rxn)
    distinct = {}
    for carried_slot, reactants in assignments:
        _check(deadline)
        try:
            outcomes = rxn.RunReactants(reactants, MAX_OUTCOMES)
        except Exception:
            outcomes = ()
        _check(deadline)
        for outcome in outcomes:
            _check(deadline)
            pieces = _pieces(outcome, owners, carried_slot, canon)
            if pieces is None:
                continue
            product, co_products, footprint = _resolve(pieces)
            if site_atoms is not None and not (footprint & site_atoms):
                continue
            distinct[(product, tuple(co_products))] = footprint

    if not distinct:
        if site_atoms is not None:
            return _fail("no-match", f"This transformation does not apply at the {site_phrase} of the carried molecule.")
        return _fail("no-match", "This transformation does not apply to the carried molecule as given.")
    if len(distinct) > 1:
        if site_phrase:
            return _fail("ambiguous-site", f"This transformation gives {len(distinct)} different products at the {site_phrase}; name a narrower site.")
        return _fail("ambiguous-site", f"This transformation applies in {len(distinct)} places and no site was named.")

    (product, co_products), _footprint = next(iter(distinct.items()))
    formula = rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(product))
    answer = {"ok": True, "product": product, "coProducts": list(co_products), "formula": formula}
    if site_phrase:
        answer["site"] = {"phrase": site_phrase, "atoms": sorted(site_atoms)}
    return answer


def _describe(payload, deadline):
    from rdkit import Chem, RDLogger
    from rdkit.Chem import rdMolDescriptors

    RDLogger.DisableLog("rdApp.*")
    smiles = payload.get("molecule")
    if not isinstance(smiles, str) or not smiles.strip():
        return _fail("unparsable", "The request carries no molecule.")
    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        return _fail("unparsable", "The molecule is not a SMILES RDKit can read.")
    counts = {}
    for phrase, smarts in _tables()["sites"].items():
        _check(deadline)
        places = _site_matches(mol, smarts)
        if places:
            counts[phrase] = len(places)
    formula = rdMolDescriptors.CalcMolFormula(mol)
    # The count rides in the summary rather than in `sites`: a phrase that sits in two places is a
    # phrase that cannot be acted on, and the caller needs to be told before it tries.
    listed = ", ".join(f"{phrase} ({count})" if count > 1 else phrase for phrase, count in counts.items())
    return {"ok": True, "formula": formula, "sites": list(counts),
            "summary": f"{formula}, {mol.GetNumHeavyAtoms()} heavy atoms; " + (listed or "no named site present") + "."}


def _transforms():
    return {"ok": True, "transforms": [{"id": t["id"], "summary": t.get("summary") or "", "site": t.get("site")}
                                       for t in _tables()["order"]]}


def handle(payload):
    if not isinstance(payload, dict):
        return _fail("unparsable", "The routeProgram request is not an object.")
    budget = payload.get("budgetSeconds")
    budget = min(max(float(budget), MIN_BUDGET), MAX_BUDGET) if isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget > 0 else DEFAULT_BUDGET
    deadline = time.monotonic() + budget
    op = payload.get("op") or "apply"
    try:
        if op == "transforms":
            return _transforms()
        if op == "describe":
            return _describe(payload, deadline)
        if op == "apply":
            return _apply(payload, deadline)
        return _fail("unparsable", f"op {op!r} is not one of apply, describe or transforms.")
    except _OutOfBudget:
        return _fail("budget", f"Stopped after the {budget:g} s budget without an answer.")
    except Exception as error:
        # There is no code for "the toolkit broke", so a broken toolkit reads as unavailable, with
        # the cause in the message: a traceback up the wire would be a crash the adapter cannot act on.
        return _fail("unavailable", f"The toolkit could not answer: {type(error).__name__}: {error}"[:300])
