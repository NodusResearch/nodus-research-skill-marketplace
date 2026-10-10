"""Apply ONE named transformation forward to a carried molecule.

Answers the `routeProgram` payload of a reactions_worker request, in one of three ops:

    {"op": "apply",
     "molecule": "<clean SMILES>" | "moleculeHandle": "<marked form, preferred when present>",
     "reagents": ["<SMILES>", ...],
     "sites" | "site": {"kind": "phrase", "phrase": "ester"} | {"kind": "handle", "mark": 901}
                     | [<either>, ...]   (two for a transformation that declares siteSlots)
                     | "<phrase>",       (what the first adapter sent)
     "markAs": 902, "budgetSeconds": 20,
     "operation": {"kind": "named", "id": "<curated id>"}
                | {"kind": "smarts", "smarts": "<forward reaction SMARTS>"}
                | {"kind": "template", "id": "<retro template or its digest>", "indexDir": "<path>"}}
        -> {"ok": true, "product", "coProducts", "formula", "productHandle", "marks",
            "site"?, "sites"?, "ring"?}
    {"op": "describe", "molecule"|"moleculeHandle": "..."} -> {"ok": true, "formula", "sites", "summary"}
    {"op": "transforms"}  -> {"ok": true, "transforms": [{"id", "summary", "site"}]}

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

PROVENANCE HANDLES. A phrase alone cannot address a growing molecule: after a few steps it carries
several copies of every group and every phrase is ambiguous. So an operation can also act at "the
place an earlier operation acted", and the way it refers to it is a mark.

A mark is an atom map number carried in the handle's own SMILES, and the handle is just that
SMILES. The reason for choosing that over any bookkeeping of atom indices is the one failure this
design must not have: a mark that migrates to the wrong atom would read exactly like a chemistry
mistake by the model. An atom map number cannot migrate, because it is a property OF the atom —
canonicalisation reorders atoms and the number goes with its atom, and RDKit's canonical ranking
accounts for the numbers, so two states that differ only in where a mark sits serialise differently
and are never silently merged. A mark can only be lost, which the response reports in `marks`.
Index bookkeeping would have had the opposite failure mode: silent, and invisible in a log.

What a mark does NOT do is share an atom. An atom holds one map number, so a `markAs` whose
footprint overlaps an older mark takes those atoms from it, and `marks` says what survived. Marks
on disjoint parts of the molecule — the mid-chain case this exists for — survive any number of
operations elsewhere untouched, because the reaction never names their atoms.

`molecule` and `product` are always clean canonical SMILES with no marks: they go into reaction
equations the existing route audit parses, and a mark leaking into one would corrupt the check.
`moleculeHandle` and `productHandle` are opaque above the adapter and are passed back unchanged.

TWO-SITE CLOSURES. A transformation that declares `siteSlots` in route_transforms.json joins TWO
places on one carried molecule. Its carried-side pattern is a component group — ([a].[b]) — which
RDKit matches only within a single molecule, so the two ends are guaranteed to be the same
molecule's. The two sites are normally two marks, which is the whole point: on a molecule carrying
several copies of the group, nothing else can say WHICH two are being joined.

Two rules make that safe. An outcome is kept only if it CONSUMED every site the program named, so
a ring closed anywhere else is discarded rather than returned as a near miss; and the atoms of the
competing copies are protected before the reaction runs, so the work does not grow with the
molecule and the outcome cap can never cut off the pair the program asked for.

The ring formed is reported as {"size", "bridgeAtoms"} and NOTHING is gated on it. Whether a given
span is reasonable is chemistry judgement that does not belong in a constant here; a five-membered
closure and a large macrocycle are different propositions and the number is the only way for a
caller or a report to tell them apart.
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
# A mark is the caller's to number, but it is bounded: a mark is written into the handle as an atom
# map number, and a runaway integer there is a handle no one can read back.
MARK_MIN, MARK_MAX = 1, 99_999

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


def _is_mark(value):
    return isinstance(value, int) and not isinstance(value, bool) and MARK_MIN <= value <= MARK_MAX


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


def _read(smiles, marked):
    """(molecule, {atom index: mark}) from a SMILES.

    A `moleculeHandle` keeps its atom map numbers, which ARE its marks. A plain `molecule` has
    them cleared instead: the contract says it is clean, and a stray number in one must not be
    read as provenance the caller never claimed."""
    from rdkit import Chem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None, None
    marks = {}
    for atom in mol.GetAtoms():
        number = atom.GetAtomMapNum()
        if not number:
            continue
        if marked and _is_mark(number):
            marks[atom.GetIdx()] = number
        else:
            atom.SetAtomMapNum(0)
    return mol, marks


def _marked_smiles(mol):
    from rdkit import Chem

    return Chem.MolToSmiles(mol)


def _components(mol, atoms):
    """How many connected pieces a set of atoms forms. A mark in two places cannot say where to
    act, so this is what separates one site from an ambiguous one."""
    remaining, pieces = set(atoms), 0
    while remaining:
        pieces += 1
        stack = [remaining.pop()]
        while stack:
            for neighbor in mol.GetAtomWithIdx(stack.pop()).GetNeighbors():
                if neighbor.GetIdx() in remaining:
                    remaining.discard(neighbor.GetIdx())
                    stack.append(neighbor.GetIdx())
    return pieces


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


def _reacting(rxn):
    """The map numbers of the atoms a template actually CHANGES, as against the ones it merely
    names to hold the pattern together. A new mark goes on the changed ones, so it stays as narrow
    as the chemistry: the wider the mark, the more often a later one has to take atoms from it."""
    try:
        rxn.Initialize()
    except Exception:
        pass
    changed = set()
    try:
        for slot, indices in enumerate(rxn.GetReactingAtoms()):
            template = rxn.GetReactantTemplate(slot)
            for index in indices:
                number = template.GetAtomWithIdx(index).GetAtomMapNum()
                if number:
                    changed.add(number)
    except Exception:
        return None
    return changed or None


def _fragments(outcome, owners, reacting, carried_slot, marks, canon):
    """One outcome as a record per product fragment, or None when RDKit cannot make a molecule of it.

    Returns {"records", "came", "used"}: the fragments, and the carried molecule's own atom indices
    that reached the products at all and that the reaction actually changed.

    Each record carries the clean SMILES, the fragment itself with its marks already on it, which
    of the carried molecule's atoms reached it, and two footprints in its own atom numbering:
    `changed` (what the reaction did, where a new mark goes) and `named` (everything the template
    touched, the fallback when the reaction's changes all left in a co-product).

    Marks are re-derived here and never read off a product atom that the template named. RDKit
    carries an atom map number through verbatim on an atom the template did not name, but clears it
    on one it did — so reading the product's own numbers would lose exactly the marks sitting where
    the reaction happened, which are the ones a route refers back to."""
    from rdkit import Chem

    records, came_in, used_up = [], set(), set()
    for product in outcome:
        try:
            Chem.SanitizeMol(product)
        except Exception:
            return None
        inherited, changed, named = {}, set(), set()
        for atom in product.GetAtoms():
            came = atom.GetIntProp("react_atom_idx") if atom.HasProp("react_atom_idx") else None
            number = atom.GetIntProp("old_mapno") if atom.HasProp("old_mapno") else None
            if number is not None:
                named.add(atom.GetIdx())
                if came is not None and owners.get(number) == carried_slot:
                    inherited[atom.GetIdx()] = came
                    came_in.add(came)
                    if reacting is None or number in reacting:
                        used_up.add(came)
                    atom.SetAtomMapNum(marks.get(came, 0))
                else:
                    # From a reagent, or built by the template: whatever number is on it is not a mark.
                    atom.SetAtomMapNum(0)
                if reacting is None or number in reacting:
                    changed.add(atom.GetIdx())
            elif came is None:
                # An atom the template created outright, so it is as new as the reaction gets.
                named.add(atom.GetIdx())
                changed.add(atom.GetIdx())
                atom.SetAtomMapNum(0)
        groups = Chem.GetMolFrags(product)
        frags = Chem.GetMolFrags(product, asMols=True, sanitizeFrags=False)
        for group, frag in zip(groups, frags):
            clean = canon(Chem.MolToSmiles(frag))
            if not clean:
                return None
            records.append({
                "clean": clean, "mol": frag, "heavy": frag.GetNumHeavyAtoms(),
                "inherited": frozenset(inherited[i] for i in group if i in inherited),
                # GetMolFrags lists a fragment's atoms in the order the fragment molecule holds
                # them, so the position in `group` is the index within the fragment.
                "changed": frozenset(at for at, i in enumerate(group) if i in changed),
                "named": frozenset(at for at, i in enumerate(group) if i in named),
            })
    if not records:
        return None
    # `used` is the carried molecule's own atom numbering, so a named site can be checked against
    # what the reaction actually did to it rather than against everything the template named.
    return {"records": records, "came": frozenset(came_in), "used": frozenset(used_up)}


def _carried(records):
    """(the carried fragment, the co-products) of one outcome.

    The carried molecule is the fragment that inherited the most atoms from the carried reactant —
    not the largest fragment. Largest is wrong as soon as a small acyl group comes off a large
    alcohol: what the route carries is the chain made of the atoms that went in, whatever its size.
    Ties go to the heavier fragment and then to the first SMILES alphabetically, so the answer does
    not depend on RDKit's enumeration order."""
    ranked = sorted(records, key=lambda record: (-len(record["inherited"]), -record["heavy"], record["clean"]))
    return ranked[0], ranked[1:]


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


def _ring(frag, reactants, owners, carried_slot):
    """The ring a closure forms: {"size", "bridgeAtoms", "bridge"}, or None when there is no closure
    to measure.

    A new bond is one whose two ends were not bonded in any reactant. Taking the new bonds back out
    separates the pieces they joined, so the cycle they close is the shortest path across each piece
    plus the bonds themselves — which is both the smallest ring through them and what a chemist
    means by the ring size. `bridgeAtoms` is the stretch the reagent contributed, told apart from
    the carried molecule's own stretch by which reactant its ends came from.

    Nothing is gated on any of it. Whether a span is reasonable is chemistry judgement that does not
    belong in a constant here; this only has to make the number visible."""
    def origin(atom):
        if not (atom.HasProp("old_mapno") and atom.HasProp("react_atom_idx")):
            return None
        return owners.get(atom.GetIntProp("old_mapno")), atom.GetIntProp("react_atom_idx")

    fresh = []
    for bond in frag.GetBonds():
        begin, end = bond.GetBeginAtom(), bond.GetEndAtom()
        left, right = origin(begin), origin(end)
        if left is None or right is None:
            continue
        if left[0] is None or right[0] is None or left[0] >= len(reactants) or right[0] >= len(reactants):
            continue
        if left[0] != right[0] or reactants[left[0]].GetBondBetweenAtoms(left[1], right[1]) is None:
            fresh.append((begin.GetIdx(), end.GetIdx()))
    if not fresh or len(fresh) > 2:
        return None
    cut = {frozenset(pair) for pair in fresh}

    def across(start, goal):
        """The shortest path from one atom to another without using the new bonds."""
        seen, queue = {start: None}, [start]
        while queue:
            nxt = []
            for at in queue:
                for neighbor in frag.GetAtomWithIdx(at).GetNeighbors():
                    other = neighbor.GetIdx()
                    if other in seen or frozenset((at, other)) in cut:
                        continue
                    seen[other] = at
                    if other == goal:
                        path, step = [], other
                        while step is not None:
                            path.append(step)
                            step = seen[step]
                        return path
                    nxt.append(other)
            queue = nxt
        return None

    def carried(at):
        where = origin(frag.GetAtomWithIdx(at))
        return where is not None and where[0] == carried_slot

    if len(fresh) == 1:
        path = across(*fresh[0])
        return None if path is None else {"size": len(path), "bridgeAtoms": 0, "bridge": frozenset()}
    (one, two), (three, four) = fresh
    best = None
    for left, right in (((one, three), (two, four)), ((one, four), (two, three))):
        first, second = across(*left), across(*right)
        if first is None or second is None:
            continue
        if best is None or len(first) + len(second) < best["size"]:
            bridge = [leg for leg in (first, second) if not any(carried(at) for at in leg)]
            best = {"size": len(first) + len(second),
                    "bridgeAtoms": len(bridge[0]) if bridge else 0,
                    "bridge": frozenset(bridge[0]) if bridge else frozenset()}
    return best


def _pair(sites, slots, mol, tables):
    """The named sites in the order the declared slots want them, or a failure naming what is wrong.

    Checked before anything is run: a mark that is not on the group the closure joins is a cheap
    `no-match`, not a search over the molecule."""
    def fits(site, phrase):
        pattern = tables["sites"].get(phrase)
        return bool(pattern) and any(site["atoms"] & match for match in _site_matches(mol, pattern))

    orders = ((0, 1), (1, 0)) if len(sites) == 2 else ((0,),)
    for order in orders:
        if all(fits(sites[at], slots[position]) for position, at in enumerate(order)):
            return [sites[at] for at in order]
    wanted = " and ".join(sorted(set(slots))) if len(set(slots)) > 1 else f"two {slots[0]} sites"
    return _fail("no-match", f"This transformation joins {wanted}, and what was named is not that.")


def _operation(payload, deadline):
    """{"rxn", "reagents", "site", "siteSlots", "flexible"} for the request's operation, or a failure.

    A reagent slot is {"role", "default"}: the default fills it when the caller leaves it out, so
    routine reagents like water never have to be named. `siteSlots` is non-empty only for a curated
    closure, and names what each of its two sites must be. `flexible` — the reactant order being
    negotiable — holds only for a reversed index template, which was not authored for this
    toolkit's carried-molecule-first convention."""
    def built(rxn, reagents, site=None, site_slots=(), flexible=False):
        return {"rxn": rxn, "reagents": list(reagents), "site": site,
                "siteSlots": [p for p in site_slots if isinstance(p, str)], "flexible": flexible}

    def anonymous(rxn):
        return [{"role": "reagent", "default": None}] * (rxn.GetNumReactantTemplates() - 1)

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
        return built(rxn, transform.get("reagents") or [], transform.get("site"), transform.get("siteSlots") or ())
    if kind == "smarts":
        smarts = operation.get("smarts")
        if not isinstance(smarts, str) or not smarts.strip():
            return _fail("unparsable", "The operation gives no reaction SMARTS.")
        rxn = _reaction(smarts.strip())
        if rxn is None:
            return _fail("unparsable", "That reaction SMARTS is not a reaction RDKit can run forward.")
        return built(rxn, anonymous(rxn))
    if kind == "template":
        index_dir, wanted = operation.get("indexDir"), operation.get("id")
        if not isinstance(index_dir, str) or not index_dir or not isinstance(wanted, str) or not wanted:
            return _fail("unknown-template", "A template operation needs both an index directory and a template id.")
        if not os.path.isdir(index_dir):
            return _fail("unknown-template", "That index directory does not exist.")
        rxn = _reversed_template(index_dir, wanted, deadline)
        if rxn is None:
            return _fail("unknown-template", "That template is not in the index, or does not reverse cleanly for forward use.")
        return built(rxn, anonymous(rxn), flexible=True)
    return _fail("unparsable", f"Operation kind {kind!r} is not one of named, smarts or template.")


def _slots(payload, slots, canon):
    """The reagent molecules for each slot, from the request and then the slot's default, or a
    failure.

    An unfilled slot is `no-match`: the request itself is well formed, the operation simply cannot
    be run on what it was given."""
    given = [r for r in (payload.get("reagents") or []) if isinstance(r, str) and r.strip()][:MAX_REAGENTS]
    filled = []
    for at, slot in enumerate(slots):
        value = given[at] if at < len(given) else (slot or {}).get("default")
        if not value:
            return _fail("no-match", f"This transformation needs a {(slot or {}).get('role') or 'reagent'} and none was given.")
        # A reagent carries no provenance, so a map number in one is cleared rather than inherited.
        mol, _ = _read(value, marked=False)
        if mol is None or canon(value) is None:
            return _fail("unparsable", f"The reagent {value!r} is not a SMILES RDKit can read.")
        filled.append(mol)
    return filled


def _requested_sites(payload):
    """The request's site specs as a list.

    A list is accepted although exactly one is applied today, so an operation that joins two places
    on the same molecule — a ring closure — is a branch in _apply rather than a change to the wire.

    Both `sites` and `site` are read, because the two sides of this contract landed separately and
    the adapter sends the plural. Silently ignoring the key the other side uses is the one thing
    this must not do: a dropped site falls back to the transformation's own phrase and would act
    somewhere the program never named. A bare string is read as a phrase, which is the shape the
    first adapter sent."""
    asked = payload.get("sites")
    if asked is None or asked == "" or asked == []:
        asked = payload.get("site")
    if asked is None or asked == "":
        return []
    return [spec for spec in asked] if isinstance(asked, list) else [asked]


def _resolve_site(spec, mol, marks, tables):
    """One site spec as {"phrase", "mark"?, "atoms"}, or a failure.

    Zero matches is `absent-site` and more than one is `ambiguous-site`, both of them errors: a
    toolkit that guessed which group the caller meant would be wrong silently, which is the one
    way this module must not fail."""
    if isinstance(spec, str):
        spec = {"kind": "phrase", "phrase": spec}
    if not isinstance(spec, dict):
        return _fail("unparsable", "A site must be an object with a kind, or a phrase.")
    kind = spec.get("kind") or ("handle" if spec.get("mark") is not None else "phrase")
    if kind == "phrase":
        phrase = spec.get("phrase")
        if not isinstance(phrase, str) or not phrase.strip():
            return _fail("unparsable", "A phrase site needs a phrase.")
        canonical = tables["sitesByNorm"].get(_norm(phrase))
        if canonical is None:
            return _fail("unresolved-name", f"{phrase.strip()!r} is not a site phrase this toolkit knows; ask for the site vocabulary.")
        places = _site_matches(mol, tables["sites"][canonical])
        if not places:
            return _fail("absent-site", f"The carried molecule has no {canonical}.")
        if len(places) > 1:
            return _fail("ambiguous-site", f"The carried molecule has {len(places)} places matching {canonical!r}; name a narrower site or a mark.")
        return {"phrase": canonical, "atoms": places[0]}
    if kind == "handle":
        mark = spec.get("mark")
        if not _is_mark(mark):
            return _fail("unparsable", f"A handle site needs a mark, a whole number from {MARK_MIN} to {MARK_MAX}.")
        atoms = frozenset(index for index, number in marks.items() if number == mark)
        if not atoms:
            return _fail("absent-site", f"Mark {mark} is not on the carried molecule: it was never set, or a later operation took its atoms.")
        pieces = _components(mol, atoms)
        if pieces > 1:
            return _fail("ambiguous-site", f"Mark {mark} sits in {pieces} separate places, so it cannot say where to act.")
        return {"phrase": None, "mark": mark, "atoms": atoms}
    return _fail("unparsable", f"Site kind {kind!r} is not one of phrase or handle.")


def _apply(payload, deadline):
    from rdkit import Chem, RDLogger
    from rdkit.Chem import rdMolDescriptors

    RDLogger.DisableLog("rdApp.*")
    canon = _worker()._canon
    tables = _tables()

    # The handle is preferred over the plain SMILES, because it is the same molecule plus the
    # provenance a later line needs; the plain one is what a route starts from.
    given = payload.get("moleculeHandle")
    from_handle = isinstance(given, str) and bool(given.strip())
    if not from_handle:
        given = payload.get("molecule")
    if not isinstance(given, str) or not given.strip():
        return _fail("unparsable", "The request carries neither a molecule nor a moleculeHandle.")
    mol, marks = _read(given.strip(), marked=from_handle)
    if mol is None:
        return _fail("unparsable", "The carried molecule is not a SMILES RDKit can read.")
    _check(deadline)

    mark_as = payload.get("markAs")
    if isinstance(mark_as, list):
        mark_as = mark_as[0] if mark_as else None
    if mark_as is not None and not _is_mark(mark_as):
        return _fail("unparsable", f"markAs must be a whole number from {MARK_MIN} to {MARK_MAX}.")

    built = _operation(payload, deadline)
    if "error" in built:
        return built
    rxn, declared, declared_slots, flexible = built["rxn"], built["site"], built["siteSlots"], built["flexible"]
    filled = _slots(payload, built["reagents"], canon)
    if isinstance(filled, dict):
        return filled
    _check(deadline)

    # What the caller asked for wins over the phrase the transformation expects, so a general
    # operation can be pointed at one group — or at one mark — without a new id.
    specs = _requested_sites(payload)
    if declared_slots:
        # A closure takes the sites it joins or none at all; one of two says nothing about the ring.
        if len(specs) not in (0, len(declared_slots)):
            return _fail("unparsable", f"This transformation joins {len(declared_slots)} sites and {len(specs)} "
                                       f"{'was' if len(specs) == 1 else 'were'} named; give all of them or none.")
    elif len(specs) > 1:
        return _fail("unparsable", "This toolkit acts at one site per operation; joining two places in one call is not built yet.")
    if not specs and declared:
        specs = [{"kind": "phrase", "phrase": declared}]

    sites = []
    for spec in specs:
        site = _resolve_site(spec, mol, marks, tables)
        if "error" in site:
            return site
        sites.append(site)
    if declared_slots and sites:
        ordered = _pair(sites, declared_slots, mol, tables)
        if isinstance(ordered, dict) and "error" in ordered:
            return ordered
        sites = ordered
    site_label = " and ".join((site["phrase"] or f"mark {site['mark']}") for site in sites) or None
    _check(deadline)

    guard = mol
    if declared_slots and sites:
        # Only the named copies may react. Without this, a molecule carrying n copies of the group
        # offers n(n-1) orderings of the pair, the work grows with the molecule, and the outcome cap
        # could cut off the very pair the program named. With it the work is the two orderings of
        # the named pair whatever the molecule's size, and the cap can never decide the answer.
        named = frozenset().union(*[site["atoms"] for site in sites])
        competing = set()
        for phrase in set(declared_slots):
            for match in _site_matches(mol, tables["sites"].get(phrase) or ""):
                competing |= set(match)
        competing -= named
        if competing:
            guard = Chem.Mol(mol)
            for at in competing:
                guard.GetAtomWithIdx(at).SetProp("_protected", "1")
    _check(deadline)

    arity = rxn.GetNumReactantTemplates()
    if len(filled) + 1 != arity:
        return _fail("no-match", f"This transformation takes {arity} reactants and {len(filled) + 1} were available.")
    if not flexible or arity == 1 or mol.HasSubstructMatch(rxn.GetReactantTemplate(0)):
        # The curated set is authored carried-molecule-first, so slot 0 is the convention; a
        # curated transformation that does not fit there has simply not applied, and says so below.
        assignments = [(0, (guard,) + tuple(filled))]
    else:
        # A reversed index template was not written for that convention, so a carried molecule that
        # does not fit slot 0 is offered the others and every fit is run.
        assignments = []
        for slot in range(1, arity):
            if mol.HasSubstructMatch(rxn.GetReactantTemplate(slot)):
                rest = list(filled)
                assignments.append((slot, tuple(guard if at == slot else rest.pop(0) for at in range(arity))))
            if len(assignments) >= MAX_SLOT_ASSIGNMENTS:
                break
        if not assignments:
            return _fail("no-match", "The carried molecule fits none of this transformation's reactant patterns.")

    owners, reacting = _owners(rxn), _reacting(rxn)
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
            made = _fragments(outcome, owners, reacting, carried_slot, marks, canon)
            if made is None:
                continue
            # EVERY named site must have been consumed. An outcome that acted somewhere else is not
            # a near miss, it is the wrong place — and for a closure it is the wrong ring.
            #
            # A closure is held to the atoms the reaction CHANGED, which for the curated closures is
            # exactly the two sites joined, so the test is as tight as the feature needs. Elsewhere
            # the wider footprint is right: a mark may sit on an atom the template names without
            # changing it, and pointing at that atom is still a statement about where to act.
            touched = (made["used"] or made["came"]) if declared_slots else made["came"]
            if sites and not all(touched & site["atoms"] for site in sites):
                continue
            main, others = _carried(made["records"])
            ring = _ring(main["mol"], reactants, owners, carried_slot) if declared_slots else None
            marked = Chem.Mol(main["mol"])
            if mark_as is not None:
                # A closure's mark covers the new bond and the bridge it installed, so a later line
                # can refer to the linkage rather than to one end of it.
                place = set(main["changed"] or main["named"]) | (ring["bridge"] if ring else frozenset())
                for at in place:
                    marked.GetAtomWithIdx(at).SetAtomMapNum(mark_as)
            product_handle = _marked_smiles(marked)
            # Keyed on the MARKED form as well as the clean one: two outcomes that differ only in
            # where a mark ended up are two different states for the next line, not one answer. An
            # isomorphic pair collapses here, because RDKit's canonical ranking accounts for the
            # numbers, so a symmetric molecule does not read as ambiguous.
            distinct[(main["clean"], tuple(sorted(r["clean"] for r in others)), product_handle)] = {
                "product": main["clean"], "coProducts": sorted(r["clean"] for r in others),
                "productHandle": product_handle, "ring": ring,
                "marks": sorted({a.GetAtomMapNum() for a in marked.GetAtoms() if a.GetAtomMapNum()})}

    if not distinct:
        if site_label:
            return _fail("no-match", f"This transformation does not apply at the {site_label} of the carried molecule.")
        return _fail("no-match", "This transformation does not apply to the carried molecule as given.")
    if len(distinct) > 1:
        if site_label:
            return _fail("ambiguous-site", f"This transformation gives {len(distinct)} different outcomes at the {site_label}; name a narrower site or a mark.")
        return _fail("ambiguous-site", f"This transformation applies in {len(distinct)} places and no site was named.")

    chosen = next(iter(distinct.values()))
    answer = {"ok": True, "product": chosen["product"], "coProducts": chosen["coProducts"],
              "formula": rdMolDescriptors.CalcMolFormula(Chem.MolFromSmiles(chosen["product"])),
              "productHandle": chosen["productHandle"], "marks": chosen["marks"]}
    if chosen["ring"]:
        answer["ring"] = {"size": chosen["ring"]["size"], "bridgeAtoms": chosen["ring"]["bridgeAtoms"]}
    if sites:
        reported = [{"phrase": site["phrase"], "atoms": sorted(site["atoms"]),
                     **({"mark": site["mark"]} if "mark" in site else {})} for site in sites]
        # `site` stays the first one, so a caller written against the one-site shape still reads.
        answer["site"], answer["sites"] = reported[0], reported
    return answer


def _describe(payload, deadline):
    from rdkit import Chem, RDLogger
    from rdkit.Chem import rdMolDescriptors

    RDLogger.DisableLog("rdApp.*")
    given = payload.get("moleculeHandle")
    from_handle = isinstance(given, str) and bool(given.strip())
    if not from_handle:
        given = payload.get("molecule")
    if not isinstance(given, str) or not given.strip():
        return _fail("unparsable", "The request carries no molecule.")
    mol, marks = _read(given.strip(), marked=from_handle)
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
    # phrase that cannot be acted on, and the caller needs to be told before it tries — which is
    # what the marks it still holds are for.
    listed = ", ".join(f"{phrase} ({count})" if count > 1 else phrase for phrase, count in counts.items())
    held = sorted(set(marks.values()))
    return {"ok": True, "formula": formula, "sites": list(counts), "marks": held,
            "summary": f"{formula}, {mol.GetNumHeavyAtoms()} heavy atoms; " + (listed or "no named site present")
                       + (f"; marks held: {', '.join(str(m) for m in held)}" if held else "") + "."}


def _transforms():
    # `siteSlots` is empty for a one-site transformation and holds the two phrases a closure joins,
    # so a caller can tell which operations need two sites without knowing their ids.
    return {"ok": True, "transforms": [{"id": t["id"], "summary": t.get("summary") or "",
                                        "site": t.get("site"), "siteSlots": list(t.get("siteSlots") or [])}
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
