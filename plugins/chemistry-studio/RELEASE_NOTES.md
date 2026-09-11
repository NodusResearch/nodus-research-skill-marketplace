# Chemistry Studio 2.0.0

Chemistry Studio is now an installable capability package rather than part of the
Nodus application. What it draws, and what it refuses to draw, has not changed: a
structure is resolved against references, validated, and presented with the
sources it was checked against.

## What is different

- RDKit, OpenChemLib and the TeX engine travel inside this package instead of the
  application. A Nodus install with no chemistry no longer carries thirty
  megabytes of chemistry.
- Structure validation runs in a subworker Nodus can kill. It is the slowest and
  least bounded part of the work, so a pathological molecule now costs one
  drawing rather than the package.
- The package reaches only OPSIN and PubChem, over the paths it declares, and may
  spend at most two model calls — one to repair a structurally invalid plan, one
  to draw an explicitly unverified fallback. Nodus enforces both; the package
  cannot widen them.
- A result is stored as an artifact beside the conversation, with the verified
  document and the ChemFig source as downloads rather than inline text.

## Unchanged on purpose

An unverified fallback is still labelled unverified everywhere it appears,
including in the text a screen reader gets. A drawing the verified lane did not
produce must not read like one that did.

Ambiguity is still reported rather than resolved by guessing: two drawing intents
in one reply produce a notice, not a coin flip.

What a later turn may know about a drawing is the identities and what was checked
against which sources — never the picture, and never anything that could be read
back as a new instruction.
