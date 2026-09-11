# Nodus package formats

This repository publishes three formats. A **skill package** is one skill and its optional
sandboxed JavaScript tools. A **plugin** bundles one or more skills with its own sandboxed
capabilities. Both are direct children of the repository root, and both stay supported:
existing skill packages keep working, and Nodus treats them as single-skill plugins.

A **capability package v2** lives under `plugins/<id>` and is a different kind of thing: it
carries trusted runtime code, so it is installed only after an Ed25519 signature over its
release manifest verifies. The signature is the security boundary — not the process
isolation, which buys fault containment, cancellation and limits, and is not sold as a
sandbox.

Three capabilities belong to the application itself and can only ever be depended on:
`nodus:svg` for drawing, `nodus:image` for image generation, and `nodus:3d` for interactive
glTF and GLB models. A package hands over an asset and gets back a reference; what draws it
is always Nodus.

# Nodus skill package v1

Every published package is a direct child directory of the repository root. The directory name must exactly match the manifest `id`. Scanning is case-sensitive and looks for `<id>/skill.json`; templates nested below `templates/` are not catalog entries.

```text
my-skill/
  skill.json
  SKILL.md
  tools/              # only when tools are declared
    calculate.js
```

`skill.json` has exactly these fields (no additional properties):

```json
{
  "schemaVersion": 1,
  "id": "my-skill",
  "name": "My Skill",
  "version": "1.0.0",
  "author": "your-github-username",
  "description": "One short sentence explaining when to use this skill.",
  "category": "Data and statistics",
  "license": "AGPL-3.0-only",
  "instructions": "SKILL.md",
  "capabilities": [],
  "tools": []
}
```

Use English for names, descriptions, instructions and documentation. IDs use lowercase letters, digits and single hyphens, up to 64 characters. Names are at most 80 characters; descriptions 500; categories 60; licenses 80. The creator is a GitHub username, up to 39 characters. Versions use three numeric components, `major.minor.patch`. Increment the version for every published change. The official catalog uses the [category vocabulary](CONTRIBUTING.md#choose-a-category); independent marketplace repositories may define their own categories.

`SKILL.md` contains the method and when to apply it, expected input/output, limitations and evidence requirements; maximum 16,000 characters. Instructions cannot override the user's intent or the application's permission boundaries.

## Native capabilities

`capabilities` is an array of capability identifiers, with no duplicates. Empty means no
native tools. Unknown capabilities are rejected. Nodus registers five built-in capabilities,
each addressable as `nodus:<id>`; the bare names `svg`, `chemistry`, `image`, `genomics` and
`legal` remain accepted and normalize to their `nodus:*` identifier.

- `nodus:svg`: self-contained fenced SVG output and Nodus's existing visual validation.
- `nodus:chemistry`: Nodus's version-2 chemistry identity-intent resolver, with validated structures and deterministic ChemFig export. Native chemistry scope and refusal of unsupported mechanisms still apply.
- `nodus:image`: Nodus's configured image provider and model; standard provider charges may apply. One image per reply.
- `nodus:genomics`: the AlphaGenome integration, including key configuration and service terms.
- `nodus:legal`: the Legalize retrieval integration, including reviewed source licences and attribution.

All five are ordinary registered capabilities that any compatible package may declare.
Recognizing a manifest capability still does not mean a build implements it: installation and
local import reject capabilities the running build does not register, and an unsupported skill
cannot be enabled.

A skill inside a plugin may also declare `self:<capability-id>` to use a capability its own
plugin ships. There are no cross-plugin dependencies in v1.

Custom skills use the same routing and execution checks as built-in skills. Capabilities become available only when the skill is enabled for the current surface.

## Custom tools

A skill can declare up to 12 tools:

```json
{
  "id": "calculate",
  "description": "Input: { values: number[] }. Returns the sum of the values.",
  "entry": "tools/calculate.js",
  "runtime": "javascript-sandbox"
}
```

Each entry is exactly `tools/<tool-id>.js`. The file contains a JavaScript function expression, optionally async:

```js
(input) => ({ sum: input.values.reduce((sum, value) => sum + value, 0) })
```

Document and validate inputs in the tool. Return a JSON-serializable value. Source and input/output are bounded at 64,000 characters; a tool runs for at most five seconds. The runtime provides standard browser JavaScript, without Node.js, filesystem access, imports, network, credentials, persisted storage or a Nodus bridge. This supports custom calculations, parsers, transformations and generators. Shell commands, third-party integrations and arbitrary native executables are not supported by v1.

Nodus supplies enabled tool identifiers to the model. It invokes a tool using a fenced `nodus-tool` JSON block with `skillId`, `toolId` and `input`. The skill ID is the installed local ID supplied by Nodus, not the package slug. Up to four calls are processed per reply, and that budget is shared with any plugin capability calls in the same reply. Results are displayed as inert JSON; they are not interpreted as instructions or re-executed. This release does not perform a second model turn over results.

## Distribution and storage

Only the manifest, `SKILL.md` and explicitly declared tool sources are installed. All required files must be regular Git files (mode 100644); symlinks, executable files and path traversal are rejected. Extra repository documentation does not become executable package content. A source supports up to 500 packages and 12 MB of package data per scan. Public GitHub sources are supported; private repositories, arbitrary hosts and Git credentials are not supported by v1.

Nodus caches catalogs and installed contents in its profile, preserving them offline. Each installed or locally saved skill has a `skills/<local-id>/` directory with the same package layout. The versioned `chat-skills.json` library remains authoritative for activation, edits and provenance; package directories are materialized from it and can be regenerated after backup restore. Both the library and marketplace metadata are included in global auxiliary backups.

A scan pins all files to the same commit. Invalid packages are listed as skipped. Failed source-level requests preserve the previous catalog. Installation must use the reviewed catalog revision. Reinstallation replaces the package and resets both activation flags; deletion removes its managed directory.


# Nodus plugin v1

A plugin publishes several components under one versioned unit:

```text
my-plugin/
  plugin.json
  skills/<skill-id>/
    skill.json
    SKILL.md
    tools/                 # only when tools are declared
      calculate.js
  capabilities/<capability-id>/
    capability.json
    runtime.js
```

`plugin.json` has exactly these fields:

```json
{
  "schemaVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "your-github-username",
  "description": "One short sentence explaining what this plugin adds.",
  "license": "AGPL-3.0-only",
  "compatibility": { "capabilityApi": 1, "minNodusVersion": "5.3.1" },
  "skills": ["skills/my-skill/skill.json"],
  "capabilities": ["capabilities/my-capability/capability.json"]
}
```

The directory name must equal `id`. Each listed path must match `skills/<id>/skill.json` or
`capabilities/<id>/capability.json`, and the directory segment must equal the component's own
`id`. A plugin declares at most 40 skills and 20 capabilities.

## Versioning

`version` is SemVer. **Every skill and capability inside the plugin carries the same version
as the plugin**, and any change to any component requires incrementing it. Publishing
different content under a version that already exists is refused: Nodus records the content
digest of the version it installed and rejects a mismatch. Nodus never downgrades a plugin
automatically; going back to an earlier version is an explicit rollback by the user.

`compatibility.capabilityApi` is the capability API this plugin targets — currently `1`.
`compatibility.minNodusVersion` is the oldest Nodus release that can run it; older builds
refuse to install it rather than failing at runtime.

## Capabilities

`capability.json` declares the runtime, its entry file, its tools and the permissions it
needs:

```json
{
  "schemaVersion": 1,
  "id": "my-capability",
  "version": "1.0.0",
  "description": "What this capability computes and what it needs.",
  "runtime": "javascript-sandbox-v1",
  "entry": "runtime.js",
  "tools": [
    {
      "id": "convert",
      "description": "Convert a length. Input: { value: number, from: string, to: string }.",
      "inputSchema": { "type": "object", "properties": {}, "required": [], "additionalProperties": false },
      "resultKinds": ["json"]
    }
  ],
  "permissions": {}
}
```

`inputSchema` is a small JSON Schema subset — object types, properties, `required` and
`additionalProperties` — that Nodus enforces before the runtime is entered. `resultKinds`
lists which result shapes the tool may return; anything else is refused.

`runtime.js` is a JavaScript function expression, optionally async:

```js
(request, host) => ({ kind: 'json', value: { doubled: request.input.value * 2 } })
```

It receives the validated `{ toolId, input }` and a `host` object exposing only what the
manifest permitted.

### The sandbox

A capability runs in an ephemeral Chromium session created for that single call. It has no
Node, no `require`, no imports, no filesystem, no application bridge, no preload, no
navigation, no popups, no WebRTC and no direct network access. The page is served from a
session-scoped `nodus-capability://host` origin and may talk to nothing else. Shell commands,
npm dependencies, vault access, clipboard, arbitrary files and external React or HTML
components are not available and will not be added to this runtime.

Everything the runtime can reach goes through `host`, and only when declared:

```json
"permissions": {
  "network": [
    { "id": "api", "origin": "https://api.example.com", "pathPrefixes": ["/v1"], "methods": ["GET"] }
  ],
  "secrets": [
    { "id": "token", "label": "Example API key", "endpointId": "api", "header": "Authorization", "prefix": "Bearer ", "required": true }
  ],
  "storage": { "maxBytes": 65536 }
}
```

- `host.network.request(endpointId, { path, method, body })` performs an HTTPS request to a
  declared endpoint, method and path prefix. Redirects are refused, and localhost and private
  networks are refused after DNS resolution, not merely by name.
- Secrets are configured by the user in Nodus and injected into the request header by the
  application. **The runtime never receives the secret value** and has no way to read it.
- `host.storage.get()` / `host.storage.set(value)` read and write one JSON document that is
  namespaced per plugin and capability and bounded by `maxBytes`.

Requesting more permissions than the previous version blocks the update until the user
approves the new set.

### Results

A tool returns one object whose `kind` is `text`, `json`, `table`, `svg`, `image` or `file`.
Text is plain text and is rejected if it contains markup; SVG is sanitized; `image` and `file`
carry base64 data and are stored as opaque handles attached to the chat. HTML and any other
executable content are rejected outright. Results are inert data: they are never re-parsed as
a protocol block, never re-executed, and never trigger a second model turn.

Nodus invokes a capability tool with a fenced `nodus-capability` JSON block containing
`skillId`, `capabilityId`, `toolId` and `input`. **JavaScript tools and capability calls share
one budget of four calls per reply.** A result the model writes itself is refused.

## Distribution, updates and storage

Only the declared manifests, instructions, tool sources and capability runtimes are installed;
a `README.md` in the package directory is repository documentation and is never installed. All
files must be regular, non-executable Git files; symlinks and path traversal are rejected.

Nodus keeps plugins under `plugins/installed/<plugin-id>/`, retaining exactly the active and
the previous version plus a storage snapshot for each. Updates are atomic: a failed download,
validation, sandbox check or write leaves the active version running. Auto-update is enabled by
default for this official repository and is opt-in per plugin for community sources; sources are
checked at startup and every 24 hours. Instructions the user edited locally survive updates as an
overlay that can be reset to the author's version, and skills added by an update start disabled.


# Nodus capability package v2

A v2 package lives under `plugins/<id>` and is published as a signed release rather than
read from the repository. Only NodusResearch may publish one, and only NodusResearch may
provide the reserved capability ids (`nodus:chemistry`, `nodus:legal`, `nodus:genomics`).
`nodus:svg` and `nodus:image` belong to the application and can only ever be depended on.

## Layout

```
plugins/<id>/
  plugin.json                     the package manifest
  capabilities/<name>/capability.json
  capabilities/<name>/…           the worker source, bundled at build time
  skills/<name>/skill.json, SKILL.md
  migrations/001-….cjs            the data version ladder, in order
  runtimes/<runtime>.requirements.json
  runtimes/<target>/lock-<python>.json
  build.mjs, test/, LICENSE, RELEASE_NOTES.md, catalog.json
```

`plugin.json` declares the package id, version, publisher and `keyId`, the capability API
version, the minimum Nodus version, the targets it publishes, the built-in skills it
replaces, and the skills, capabilities and migrations it ships. `capability.json` declares
one capability: what it provides, its tools and their input schemas, the artifact types it
may produce, the chat protocols it claims, its settings, and its permissions. Every
permission is enforced by the host; a capability that calls a channel its manifest does not
declare gets an error, not a silent no-op.

## Chat protocols

A capability may claim fenced blocks in a reply. `requestProtocols` are blocks the model
writes to ask for work; `legacyResults` are blocks an earlier version of the same discipline
wrote before it became a package, which the application hands back to the package to render.
Exactly one capability may claim a fence, and each declares a priority that fixes the order
in which the pipeline runs them. The reply is parsed once into a generic tree shared by every
provider, and what a provider returns is typed mutations — never text to be re-parsed, so a
result can never become the next instruction.

## 3D models

`nodus:3d` is generic on purpose. A molecule, a bone, a pot and a building are the same
thing to it, and no discipline is named anywhere in it — a subject-specific 3D capability
would be exactly the coupling capability API v2 exists to remove.

A capability that wants to show a model declares `"models": true` in its permissions and
`nodus:3d` in its `requires`. At runtime it calls `host.models.store({ bytes, mimeType,
name })`, which validates the asset, keeps it beside the conversation and returns an
attachment id; the capability then returns a `model` view node referring to that id. It
never ships a renderer, a shader or a script, and there is no route by which it could.

Two formats are accepted, `model/gltf-binary` (`.glb`) and `model/gltf+json` (`.gltf`), and
both must be **self-contained**. glTF can reference buffers, images and shaders by URI, and
a viewer that honoured those would fetch whatever a document named, whenever anyone
reopened an old conversation. So every URI must be an inline `data:` one, or the asset is
refused — at review, at storage and again when it is read back. A model must be glTF 2.0,
must contain something to draw, must not require an extension the viewer does not
implement, and must fit the published size ceiling.

The viewer that opens it belongs to the application: rotate, zoom, pan, reset and fit, with
the model parsed from bytes already in memory and a resource path that resolves nowhere.

## Artifacts

A tool's result is an artifact: a type, a version, a one-line summary and data. The
application stores it beside the chat with its own digest and keeps only a reference in the
message. Each artifact type declares `modelVisibility`: `projection` lets the package offer
a sanitized text projection to later turns, `none` means the result is rendered on the
device and never returns to the model. An artifact type may also declare `decodes`, naming
on-disk formats written by earlier versions so an old conversation can still be opened.

## Migrations

`migrations` is the data version ladder: the nth script raises a profile from version n-1 to
n, and the numbering must run 001, 002, … in order. Each is a CommonJS module exporting one
function, run in the package's own worker with the host it has at runtime, and is expected
to be re-runnable. The application records only the version the scripts actually reached, and
a capability is not announced until that version matches what the package declares — so a
capability is never used against data that has not finished moving.

## Runtimes

A capability may declare a Python runtime. The interpreter is the user's; everything
installed into it is pinned by the package: one lock per target and interpreter version,
naming every wheel with its URL, size and SHA-256. The host downloads each through the
capability's own network permission, verifies it, and installs with `--no-index
--require-hashes`. Nothing is resolved from an index on the user's machine, and a package
that ships no lock for a target it publishes cannot be built.

## Distribution

The catalog (`catalog-v2.json`) is a directory, not a distribution channel: it says where
each package's signed release lives. Nothing in it is trusted — an entry that lies about a
version, a size or an asset fails verification rather than installing something. An install
verifies the signature, then the archive against the signed manifest, then extracts into a
staging tree, validates what came out, and only then activates it. The previous version is
kept so a bad release is one step from being undone. A version already installed cannot be
replaced by different bytes under the same number, and a package cannot be walked backwards
to an older version. An update that widens permissions is staged and waits for the user.
