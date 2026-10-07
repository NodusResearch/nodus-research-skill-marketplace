# Chemistry Studio 2.5.23

A declared name is now compared against the built-in dictionary, which it never was.

## Two resolvers, and only one of them read the dictionary

The package carries a dictionary of 45 standard building-block structures, PubChem-sourced and
RDKit-validated. `resolveSpeciesName`, behind the `resolve-names` tool, has always tried it first,
so a route resolves those names offline.

`resolveNameReferences` did not. It is the other path — the one that fills `nameSmiles`, which is
what the route audit's name-versus-structure comparison actually reads — and it went straight to
OPSIN and then PubChem. Neither service reads the standard shorthand: `Fmoc-Lys(Boc)-OH` resolves
at neither. So for exactly the names the dictionary exists to cover, the candidate list came back
empty, the name was counted unresolved, and the comparison never ran — against a structure the
package already held a trusted answer for. The same path also meant no name could be checked at
all without a network, although the dictionary needed none.

It now consults the dictionary first, as the other resolver does.

The comparison itself is unchanged and was never wrong: it matches canonical structures, falls back
to skeleton and charge, treats a name silent about configuration as agreement, and treats an
unparseable candidate as silence rather than as a disagreement. What changes is that it is now
reachable for these names.

A dictionary hit is returned **alone**, not alongside whatever the network says. The comparison
accepts any one candidate that agrees, and a candidate silent about configuration satisfies the
skeleton-and-charge fallback — so offering a second answer beside the dictionary's would let an
inverted centre pass as agreement. One trusted answer is the point of holding the dictionary.

Covered by a test that stubs the network to throw and asserts the dictionary answers without a
single request, that a name outside the dictionary still reaches the resolvers, and that a resolver
failure is still silence.

# Chemistry Studio 2.5.22

A check that could not run no longer looks like a check that passed.

## The bond-edit check was silent either way

The bond-edit check reads each balanced step as a graph edit. It is budgeted, and a step whose
graph it cannot settle is reported as unchecked rather than refused — correctly, since such a step
has done nothing wrong. But `change: 'unchecked'` carried a `reason` field that never reached the
report, so a route whose bonds were never examined read exactly like one whose bonds were sound.
Worse, if the check THREW, the step was left with no report at all and was not even countable as
unchecked.

Both now record themselves, and the host states the gap beneath the verdict:

    Not examined: the bond-edit check could not settle 1 of 17 step(s) (step 9) — the search ran
    out of budget. Those checks say nothing about those steps either way — this is a gap in
    coverage, not a finding about the chemistry.

The verdict is unchanged by it. A gap in coverage is not a fault in the route.

## The packing check needed a third outcome, not a second

`checkPerMoleculePacking` also returned 'unchecked', for five different reasons — and three of
them are design limits rather than failures. The important one is a convergent coupling, where a
product legitimately carries more carbon than any single substrate: that is every coupling step in
a stepwise assembly, so reporting it would have buried the real case in noise.

It now distinguishes `'n/a'` (outside what packing models — silent) from `{ unchecked: reason }`
(the search gave up — reported).

# Chemistry Studio 2.5.21

The same 200-character name limit, in the two places 2.5.20 missed.

2.5.20 raised the limit where `resolve-names` validates its input. It did not raise it inside the
resolver itself, where `resolveSpeciesName` cut the name again before the lookup, nor in
`resolveNameReferences`, which returned NO candidates at all for a long name and so silently
skipped the check that compares a declared structure against its IUPAC name.

The effect was visible but partial: a six-unit chain went from five unresolved species to two.
The two that remained carried names 205 characters long, and OPSIN resolves them on the first
attempt — so the limit was never the service's, it was ours, in four places across three files,
each masking the next.

Every bound on a chemical name now refers to one exported constant, `MAX_CHEMICAL_NAME`, so the
next person finds all of them together. Truncation of OPSIN's own warning text is left at 200:
that is display, not identity.

# Chemistry Studio 2.5.20

A name cut short can never resolve.

## The cut was reported as the author's mistake

`resolve-names` truncated every name it was given to 200 characters before looking it up. A
systematic name for an assembled chain is far longer than that, and a cut name is syntactically
incomplete, so it resolved to nothing — and the step was then reported as "no structure resolved
for product …", which reads as a naming problem when the fault was the cut.

Measured on a six-unit chain: five steps unbuilt, and **every rejected name exactly 200 characters
long**. Chains of two to five units never reached the limit, so it first appears at six — and every
target longer than that was affected.

The bound is only a guard against a runaway reply, so it is now sized from the longest real case
rather than guessed: at roughly 40 characters per unit in the nested style a model actually writes,
a 13-unit chain's name runs near 580 characters and a 40-unit chain's near 1,660. The limit is
4000, which clears the longest by more than twice.

# Chemistry Studio 2.5.19

A step that inverts a stereocentre is now refused.

## The error no other check could reach

A route was found that balanced at every step, carried every intermediate over as the same
structure, formed exactly the bonds it claimed, and ended on an **exact** canonical match to the
requested target — stereochemistry included — while passing through compounds that cannot give it.
Eleven of its fourteen amide-forming steps coupled an (S) building block and declared an (R)
product.

Each check had a reason for missing it:

| check | why |
|---|---|
| atom and charge balance | compares COUNTS, and an epimer's are identical |
| continuity | compares consecutive declared structures, which agreed with each other |
| target comparison | the final declared product really was the target |
| skeleton ledger | the right bonds formed; only the configuration differed |

## What it does now

For every step, the specified CIP descriptors on each side are compared as a multiset. When both
sides carry the **same number** of specified centres but a different mix, a centre was inverted —
which a coupling, a deprotection or a cleavage does not do — and the step is refused, naming what
went in and what came out:

    This step inverts a stereocentre: its reactants carry 1 (S) and 0 (R) specified centres and
    its products 0 (S) and 1 (R), the same number on each side. A coupling, a deprotection or a
    cleavage does not change configuration, so either a declared structure has the wrong
    descriptor at one centre — give the product the configuration its reactant carries — or, if an
    inversion is genuinely intended, say in this step's own prose which centre inverts and why.

Differing counts mean a centre was **created or destroyed**, which is ordinary chemistry, so that
case is left alone: a ketone reduced to a single alcohol enantiomer is not reported.

## Also

The route review's step number was clamped with a hard-coded 15, silently relabelling every
finding above step 15 as step 15. On a 24-step route a correct finding about the macrolactamisation
at step 23 was reported against an unrelated deprotection at step 15, which reads as the review
inventing a molecule. It now clamps to the route's own length. Routes only began exceeding 15 steps
once they were asked to decompose rather than write one wide equation.

# Chemistry Studio 2.5.18

A refusal that reported ambiguity it had never found.

## "More than one balanced equation" was said having found none

A step's coefficients are solved from the null space of its element matrix. When that space has
more than one dimension the solver searches for the smallest positive whole-number equation and
refuses only if two tie, because then the choice would be a guess. The search covers four
directions.

Each basis vector carries a one in its own free column and zeros in the others, so past four
dimensions every combination the search can build leaves an exact zero in a direction it never
touched — and a zero means a species takes no part, which is rejected. The candidate set therefore
comes back **empty**, and an empty set is not a tie. The step was refused with:

    The declared species admit more than one balanced equation; name the intended byproducts, or
    split this transformation into consecutive balanced steps.

Nothing had been compared. Worse, the advice pointed at the byproducts, and a step short of a
*reactant* was sent to look at the wrong side — repeatedly, because the message never changed.

A step with thirteen species over six elements leaves seven directions free, so no declaration of
that shape could pass however correct it was.

## What it says now

The two cases are told apart. Past the search limit, the step is reported as not determined rather
than as ambiguous — it has not been shown to be unbalanced — and the element totals at the
coefficients as declared are given, since those are always computable:

    This step leaves 7 species free to vary independently, more than the checker determines
    coefficients for, so it has NOT been shown to be unbalanced — no coefficients were found.
    At the coefficients as declared, the reactants are short of N (3), S (1), so a species this
    step consumes is missing from Reactants; and the products are short of C (88), H (65), so a
    species this step forms is missing from Products or Byproducts, or a declared structure is
    not the compound intended.

Which side is short of which element is arithmetic, not advice, and it is the part an author can
act on. A genuine tie still reports a genuine tie, now with the same element detail.

# Chemistry Studio 2.5.17

A reaction class that named the wrong reaction.

## An ester reduction is not a hydrolysis

A step's reaction classes are read from its functional-group changes and used as search terms, so
a wrong class retrieves the wrong textbook page — which is worse than retrieving nothing. The rule
was:

    down("ester") and (up("acid") or up("alcohol") or up("ketone"))  ->  "ester hydrolysis"

A hydride reduction of an ester loses the ester and gains an alcohol, so it matched: a lithium
aluminium hydride step was labelled an ester hydrolysis.

A disappearing ester is a hydrolysis only when the **acid** appears — saponification gives the acid
or its salt alongside the alcohol. The alcohol test alone cannot stand in for it, because in
`ester + X -> Y + ethanol` the leaving group *is* an alcohol, so an alcohol appears in almost every
ester reaction. A reduction therefore also requires that no new carbonyl appears, which keeps an
organometallic addition (ester plus a Grignard reagent, giving a ketone) out of both classes: it
now claims neither rather than claiming the wrong one.

New class name: `reduction of an ester to an alcohol`. The host pairs it with a relevance rule, so
a passage offered for it has to be about reducing an ester rather than merely mentioning esters.

## Compatibility

Additive. One class name changes for one family of steps, and the search term changes with it.

# Chemistry Studio 2.5.16

A balance that the arithmetic supported and the chemistry did not.

## A declared species takes one coefficient, not one per fragment

A reaction SMILES separates components with `.` and cannot say which of them belong to one
species, so a salt the author declared once arrived as several independent species — and each one
was a free coefficient for the solver. That freedom let a wrong equation balance:

    CH3MgBr + H2O -> CH4 + Mg(2+) + Br(-) + O(2-)

is one hydrogen short as written, and came back **balanced** at 2/1/2/2/2/1 — two of the
organometallic and one water. The author's own equation was 1:1 and simply had oxide where it
needed hydroxide. The arithmetic was right and the chemistry was not, which is the worst way for a
check to be wrong, because nothing in the report looks unusual except the coefficients.

The boundary was never lost, only absent from the string: `labels` carries each declared species
with its own SMILES. Each label now claims its fragments from its side and becomes one species
with one coefficient. A fragment no label claims stays a species of its own, so a caller that
sends no labels sees exactly the previous behaviour. A label whose fragments are not all present
groups nothing, rather than silently dropping atoms.

This also fixes two things that fell out of it. A multi-fragment label never matched any single
fragment, so a salt's name never attached to it in the report; now it does. And a salt's declared
stoichiometry survives: chromium(III) sulfate keeps its 2:3 ratio instead of being reduced to one
chromium and one sulfate whose counts the solver re-derives.

## A free oxide is not a species

A bare multiply-charged monatomic anion — `[O-2]`, `[N-3]`, `[S-2]` — is refused with its own
message. It is never the species a solution-phase route consumes or releases; the author means the
salt, the hydroxide or the acid. It was also exactly the free coefficient that enabled the balance
above, so this is the same fault caught at the other end.

## Pairs with a host change

The host that writes the reaction string previously discarded a repeated fragment, to stop two
salts sharing an ion from putting the same token on one side twice. That cost atoms: the set was
per role, so calcium chloride written as `[Ca+2].[Cl-].[Cl-]` lost a chloride, and any salt with
repeated counterions could then never balance. A host that writes every fragment needs this
version to regroup them; an older package sees the duplicates and reports several possible
equations, which is visible rather than silent.

## Compatibility

Additive and opportunistic. No schema change: `labels` already carried per-species SMILES. Without
labels, grouping does nothing.

# Chemistry Studio 2.5.15

Two reports that said more than the check could support.

## Configuration of a chiral building block
`inspect` and `verify-route` now report `alphaConfiguration` for a species written as a free acid
whose stereocentre carries a nitrogen: the CIP descriptor at that centre, or `unassigned` when the
author left it open. Absent for anything without such a centre.

This is reported, never judged. A block of the opposite configuration has the same formula, the
same atom counts and the same constitution as the intended one, so balance and continuity both
pass and no deterministic check can see the difference. The descriptor is put where a reader can
compare it with the name the author wrote. No verdict is implied: which letter belongs to a given
series flips when a sulfur-bearing branch outranks the carboxyl, so the letter alone proves
nothing.

## A species under Agents is no longer blamed on a guess
When a step does not balance, a species listed under Agents is named as the cause only when adding
whole copies of it to the reactant side balances the step exactly — and then the copy count is
given. The previous test was "this Agent contains some element the reactants are short of", which
on a large step named the reaction medium, because a medium contains carbon, hydrogen, nitrogen and
oxygen, and advised moving it to Reactants. That was wrong chemistry stated confidently.

When no species under Agents can account for the shortfall, one that carries the missing elements
is still named, but the instruction is conditional and the likelier fault is said out loud: the
declared products or byproducts are incomplete.

## Compatibility
Additive. `alphaConfiguration` is optional and absent unless measured; hosts that ignore it are
unaffected. No schema limits changed.

# Chemistry Studio 2.5.14

Three places where a check returned a confident verdict when it could not actually apply.

## Cumulated bonds
A cumulated system is refused only when both ends carry two substituents, which is when the axis
has a configuration SMILES can state. An end with one substituent and a lone pair has none, so a
standard amide coupling reagent is no longer refused, and nor is any route that uses one. Allenes
are still refused; ketenes, isocyanates and carbon dioxide pass.

## Degenerate balances
When the heaviest species on its own side comes out at coefficient 0, the solver has balanced a
different equation hidden inside the step. The step is now reported with the actual atom difference instead of
advice to delete the species, which would remove the thing the step exists to make. Zeroing a
small spurious byproduct is still reported as before.

## Larger steps
`verify-route` accepts steps up to 16,000 characters (was 4,000); label names, label SMILES and
carriers up to 4,000; `inspect` and `resolve-structure` SMILES up to 4,000. A step with ~40
reactants needs this.

## Compatibility
Capability API, Nodus minimum version and permissions are unchanged.

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
