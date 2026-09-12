# Legalize 2.0.0

Legalize is now an installable capability package rather than part of the Nodus
application. What it does has not changed: it finds legislation in a pinned
legalize-dev country snapshot and returns the text with its official source,
repository version, licence and attribution.

## What is different

- The country catalogue, the licence hashes, the retrieval and the attribution
  notice all live in this package. Installing or removing it adds or removes the
  `nodus:legal` capability; it is not built into Nodus any more.
- Results are stored as artifacts beside the conversation. A saved result keeps
  working after an update, and survives uninstalling the package.
- Messages are localized by the package. The built-in used to raise them in
  Spanish from a layer the translation system could not reach, so a reader in
  another language saw Spanish.
- The package reaches only `api.github.com`, `raw.githubusercontent.com` and
  `codeload.github.com`, all under `legalize-dev`, and only over the paths it
  declares. Nodus enforces that; the package cannot widen it.

## Unchanged on purpose

The attribution notice is reproduced word for word from the built-in. It is a
legal notice, not copy to be improved.

A country index cached by the built-in is adopted on first run when it is
complete and matches the snapshot, so the first search does not re-download a
catalogue the machine already has.
