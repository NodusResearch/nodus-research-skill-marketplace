# Chemistry Studio 2.5.13

## Peptide building blocks resolve offline; resin intermediates ask for SMILES
A built-in dictionary of standard protected amino acids and the free proteinogenic set (PubChem-
sourced, RDKit-validated) resolves before the network, so a solid-phase route resolves consistently
offline. Name matching ignores spacing, dash style and case. Non-natural residues are not in the
dictionary and must be given as SMILES (route rules). A resin-bound intermediate name is detected and
returns an actionable message to give it as SMILES with the solid support as a single `*`, instead of
retrying a name that can never resolve.

# Chemistry Studio 2.5.12

## Solid-phase routes: a resin is one conserved `*`
A species attached to a solid support is written with one `*` at its attachment atom, standing for
the resin with its linker (for example `*OC(=O)CN`, glycine on the resin). The support is a
pseudo-element: conserved in every balance, labelled "(support)" in formulas and in a balance
shortfall, so a cleavage that loses the resin is refused and says why. Exactly one plain `*` or
`[*]` per species is accepted; several, or a labelled or isotopic one, is still a generic structure
and refused. Before this every solid-phase peptide route failed at its resin steps ("Unsupported
molecular input").

A balance shortfall now names every element from the shared table (a missing Mn or Cr once read
"element 25").

# Chemistry Studio 2.5.11

The bond-edit gate can audit recorded reactions, not only checked routes, and route search keeps up
with a much larger reaction index.

## Recorded reactions: omitted by-products (opt-in)
A recorded reaction usually lists only its main product. `skeletonChange(…, { omittedByproducts: true })`
lets whole carbon fragments of the left side leave as unlisted by-products — a Boc group, an ester's
alkoxy carbon, the CO2 of a decarboxylation (through a cut bond, which is not counted as a skeletal
shift) — while what remains must still be a sound edit. Carbons never arrive from nowhere. In this mode
the reading with the fewest bond changes wins, so a record that lists its solvents is not explained by
dropping the starting material and building the product from solvent fragments. Choosing what departs
is charged to the search budget and pruned to totals that can be reached, so a large molecule ends as
"unchecked" instead of searching for minutes. Off by default: a checked route's steps are balanced, so
a missing carbon there is still reported, and route checking is unchanged.

## Audit flags on recorded reactions
A reaction index built with the audit lists the records it flagged but kept (`audit-flags.tsv.zst`:
a record has no prose, so a real rearrangement cannot be declared and looks like a flagged one).
Precedent results — exact matches, the closest recorded reaction, recorded preparations and recorded
disconnections — now carry their `auditFlags`.

## Route search on a large index
Retro templates are screened by pattern fingerprint before any substructure search (a template can
only match a molecule holding all of its fingerprint bits), and table lookups find each wanted row
in its frame directly instead of splitting the frame. Both leave results unchanged; with a 9× larger
template set a one-step disconnection stays well inside route search's time budget.

# Chemistry Studio 2.5.10

The route checker now reads each balanced step as a bond edit, not only an atom count.

## Which bonds a step makes and breaks
After balance and continuity, each step is read as a graph edit: the carbon skeletons of both
sides are mapped (spectator fragments set aside, the fewest reactant C–C bonds broken to fit), then
extended to heteroatoms, giving a per-step ledger of bonds made (+) and broken (−) by element pair.

A step is refused — unless its prose declares a rearrangement, or a radical / C–H functionalisation
— when a carbon migrates (a 1,2-shift), a new C–C or C–heteroatom bond forms at a carbon nothing
activates (no charge, radical, multiple bond, heteroatom, leaving group or metal on it, and not next
to a carbonyl, alkene or arene), or a C–C bond breaks while its two carbons stay joined in the
product. The refusal names what to check; a passing step keeps its bond ledger for the report. Over
183 already-verified routes this refused no correctly described reaction and caught five balanced but
impossible ones.

New optional `rearrangement` and `radical` route inputs; new `skeleton` and `bonds` fields per step.

## A covalent metal oxide is one species
Chromium trioxide, osmium tetroxide and the like, returned by a reference as bare ions
(`[Cr+6].[O-2].[O-2].[O-2]`), now resolve to the covalent oxide, so a balance reads `CrO3`, not loose
`Cr` and `O` atoms.

Earlier 2.5.7–2.5.9 iterations (the carbon-packing escape for convergent couplings) are folded in.

---
# Chemistry Studio 2.5.8

Route proposals now carry more evidence and more specific feedback. A proposed route remains
a research hypothesis: these checks do not establish experimental feasibility, yield or safety.

## Search routes from recorded transformations

`propose-disconnections` proposes precursors from indexed ORD reactions and textbook transformations,
with the templates and reaction classes that support each proposal. `search-routes` combines
those transformations into bounded, multi-step searches towards the supplied starting materials.
Recorded solvents are kept as conditions rather than treated as precursors. ORD precedents also
carry their recorded reaction conditions when available; an index without retrosynthesis tables
returns a documented limitation rather than fabricated proposals.

## Check stock and functional-group compatibility

`check-stock` matches compounds against user-imported vendor lists by the InChIKey connectivity
block, including another form of the same compound, and distinguishes ready-to-ship stock from
make-on-demand listings. It reports the imported data, not a live availability guarantee.
`check-compatibility` flags functional groups that a step's reagents may attack as an advisory
check rather than a proof that the reaction will work.

## More useful route validation

`verify-route` accepts routes up to 96 steps and explains balancing failures using the actual
element or charge difference, including species on the wrong side or present on both sides.
It accepts coefficients up to 30, checks charged salt identities and treats hydrogen as H2.
Stereochemistry checks account for racemic declarations and for centres that can reach the final
target, avoiding demands for stereo choices that a subsequent step removes.

## Compatibility

The package keeps Capability API 2, Nodus 5.3.2 or newer and the existing permission set. Automatic
use of the new route-search, stock and compatibility tools requires the corresponding Nodus
synthesis integration in [Nodus PR #1046](https://github.com/Drakonis96/nodus/pull/1046).

# Chemistry Studio 2.5.6

A new tool. Nothing a route already reported as verified changes.

## Name a structure, not only a name
`resolve-structure` is the reverse of `resolve-names`: given isomeric SMILES it canonicalises each
with RDKit and, when PubChem holds the structure, returns its IUPAC name and CID
(`property/IUPACName,MolecularFormula`). A structure PubChem does not hold comes back `unnamed`
with its RDKit-canonical SMILES, so a checked structure still travels. New `structure-naming`
artifact.

This lets the application name a species that the author could only supply as a structure — an
exotic fused polycycle, a cage, a named literature intermediate whose systematic name neither the
model nor OPSIN can derive — instead of dead-ending the route on an unresolvable name.

## Works with every supported Nodus version
The synthesis instructions now follow whichever output contract the Research Assistant appends to a
route request: labelled IUPAC name lines on Nodus releases that resolve names, one
`reactants>agents>products` string per step on releases up to 5.6.0. Before this, the skill forbade
the reaction lines those releases parse. The package still declares Nodus 5.3.2 or newer.

# Chemistry Studio 2.5.5

Drawing and resolution fixes. Nothing a route already reported as verified changes.

## A resolved name reports one canonical structure
`resolve-names` now returns the RDKit-canonical isomeric SMILES rather than the reference
service's own spelling. A whole route is built from those strings, so tropinone written
`CN1C2CC(CC1CC2)=O` and the target's `CN1C2CCC1CC(=O)C2` are the same compound everywhere and are
no longer reported as different connectivity.

## Names resolve faster
The reference lookups run a few at a time instead of one after another, the resolve pass and the
route audit share one cache so a name is fetched once, and a PubChem outage opens a circuit that
falls through to OPSIN instead of retrying every name.

## Open centres are drawn, not refused
A step the route checker accepted is drawn with its open centres left open: a purchased reactant's
unspecified stereocentre, or a structure the request itself left under-specified, no longer fails
the drawing. The ChemFig round-trip accepts a layout that adds a geometry to a bond the reference
left unspecified (aconitic acid), and a species the dialect cannot represent at all — carbon
monoxide's zero-hydrogen carbon — is written as its formula text rather than failing the scheme.

## An application drawing call no longer asks the model for a fallback
The unverified SVG fallback is a chat behaviour. A direct application call (a route-step scheme)
now reports the refusal instead of spending a model call on a drawing it will discard.

# Chemistry Studio 2.5.4

Route-checking fixes. Nothing that was already drawn changes.

## Several balanced equations take the smallest one
A step whose declared species admit several balanced equations — six species over four elements is
already two-dimensional — was refused with "more than one balanced equation". The checker now takes
the smallest equation in which every declared species takes part and accepts it when it is unique,
and refuses only when two different equations tie for smallest (then the author is asked to split the
step). The Robinson tropinone assembly balances as 1:1:1 → 1:2:2 instead of being refused.

## Only what a step makes must specify its stereochemistry
An unspecified stereocentre on a purchased reagent (2,5-dimethoxytetrahydrofuran) failed the step,
even though the step neither sets nor keeps it. The check now counts unspecified centres on the
step's products only; an intermediate is still checked in the step that makes it, and a racemic
declaration still opts out.

## The skill instructions describe the names-first route
The synthesis section of SKILL.md still told the model to write `reactants>agents>products` lines
and to give each species an isomeric SMILES beside its name, contradicting the application's
names-only synthesis contract. It now describes the contract the application appends: IUPAC names
and roles only, resolved by `resolve-names` and checked by `verify-route`.

# Chemistry Studio 2.5.3

A validation-scope fix. Nothing the package draws changes.

## A bare counterion no longer downgrades the document

A structure with a spectator ion outside the certified organic element set — `[Na+]` in
`sodium phenoxide`, say — was reported as only partly verified: "the structure contains an
element outside the organic set, so stereochemical labelling and implicit valences were not
certified". A bare counterion has no stereochemistry and no implicit valence to certify, so it no
longer triggers that caveat. An out-of-set element that is actually bonded into the structure
still does.

# Chemistry Studio 2.5.2

A resolution fix. Nothing the package draws changes.

## A salt is resolved to its ions

`resolve-names` recommended a metal salt by its first PubChem record. PubChem sometimes holds a
curated record that writes a salt with a **bare neutral metal atom** — for `sodium phenoxide` it
returns phenol plus `[Na]` (C6H6NaO), not the salt. Route balances built on that structure could
never close.

When a name mentions a metal, both references are now read and the one that shows the metal as a
charged ion is preferred: `sodium phenoxide` resolves to `[O-]c1ccccc1.[Na+]` (OPSIN) while
`sodium acetylide` still keeps PubChem's curated mono-salt `C#[C-].[Na+]`, because there both
references are ionic and PubChem wins. A name without a metal is unchanged (PubChem first).

# Chemistry Studio 2.5.1

Name-first route support. The package can now resolve a systematic IUPAC name to a structure
and check author-supplied names against the structures they denote, so the application can
derive SMILES from names instead of trusting a model. This release folds in 2.4.0 and 2.5.0.

## resolve-names

A new read-only tool resolves a batch of names to structures: PubChem exact match first, OPSIN
as fallback. Each name comes back with a status, isomeric SMILES, formula, source and — when
it does not resolve — a feedback sentence. PubChem is tried first because OPSIN reads
`sodium acetylide` as the di-sodium salt and `hydrogen` as a radical, where PubChem returns
the mono salt and H2. An ambiguous or unresolved name is reported rather than guessed, so a
caller can hand it back to a model to restate as a true systematic name.

## verify-route names

`verify-route` accepts an optional per-step `labels` array. Each supplied name is resolved and
compared to the structure it was written beside: a name that denotes a different compound is
refused alongside an unbalanced step, and an unresolvable name is reported as unchecked.
Named species are returned with their resolved structure and a `nameOk` flag.

## Species limits

The per-step species backstop is raised from 12 to 48 (route total 160 to 256). The old 12 was
a model-facing instruction; a named salt expands to its ions in the equation, so a legitimate
redox step could exceed it. The 24 author labels per step and the killable subworker remain the
real guards.

# Chemistry Studio 2.2.1

A packaging fix. Nothing the package draws, verifies or refuses has changed.

## Five megabytes of code that never ran

Chemistry Studio vendors `tar-fs`, which carries `bare-fs`, `bare-path` and `bare-url`.
Each of those ships a prebuilt binary for every platform the Bare runtime supports —
Android, iOS, macOS, Linux and Windows — thirty-nine files and a little over five
megabytes. Node loads none of them: those modules are reached only under the `bare`
runtime condition, and a capability worker runs on Node.

They were worse than unused. Apple's notary service opens archives it finds inside a
submitted application and requires every Mach-O binary in them to carry a Developer ID
signature. The fifteen macOS and iOS binaries in 2.2.0 therefore rejected the Nodus 5.4.0
macOS builds outright: an application refused over code that could never execute in it,
and that nothing could sign, because the archive is pinned by digest against a manifest
signed for it.

Prebuilt native binaries no longer travel inside a capability package, and a build that
finds native code it did not expect now fails rather than publishing it.
