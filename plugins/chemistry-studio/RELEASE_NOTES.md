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
