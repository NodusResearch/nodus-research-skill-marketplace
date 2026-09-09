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
  "category": "Data analysis",
  "license": "AGPL-3.0-only",
  "instructions": "SKILL.md",
  "capabilities": [],
  "tools": []
}
```

Use English for names, descriptions, instructions and documentation. IDs use lowercase letters, digits and single hyphens, up to 64 characters. Names are at most 80 characters; descriptions 500; categories 60; licenses 80. The creator is a GitHub username, up to 39 characters. Versions use three numeric components, `major.minor.patch`. Increment the version for every published change.

`SKILL.md` contains the method and when to apply it, expected input/output, limitations and evidence requirements; maximum 16,000 characters. Instructions cannot override the user's intent or the application's permission boundaries.

## Native capabilities

`capabilities` is an array containing any combination of `svg`, `chemistry`, `image`, with no duplicates. Empty means no native tools. Unknown capabilities are rejected.

- `svg`: self-contained fenced SVG output and Nodus's existing visual validation.
- `chemistry`: Nodus's version-2 chemistry identity-intent resolver, with validated structures and deterministic ChemFig export. Native chemistry scope and refusal of unsupported mechanisms still apply.
- `image`: Nodus's configured image provider and model; standard provider charges may apply. One image per reply.

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

Nodus supplies enabled tool identifiers to the model. It invokes a tool using a fenced `nodus-tool` JSON block with `skillId`, `toolId` and `input`. The skill ID is the installed local ID supplied by Nodus, not the package slug. Up to four calls are processed per reply. Results are displayed as inert JSON; they are not interpreted as instructions or re-executed. This release does not perform a second model turn over results.

## Distribution and storage

Only the manifest, `SKILL.md` and explicitly declared tool sources are installed. All required files must be regular Git files (mode 100644); symlinks, executable files and path traversal are rejected. Extra repository documentation does not become executable package content. A source supports up to 500 packages and 12 MB of package data per scan. Public GitHub sources are supported; private repositories, arbitrary hosts and Git credentials are not supported by v1.

Nodus caches catalogs and installed contents in its profile, preserving them offline. Each installed or locally saved skill has a `skills/<local-id>/` directory with the same package layout. The versioned `chat-skills.json` library remains authoritative for activation, edits and provenance; package directories are materialized from it and can be regenerated after backup restore. Both the library and marketplace metadata are included in global auxiliary backups.

A scan pins all files to the same commit. Invalid packages are listed as skipped. Failed source-level requests preserve the previous catalog. Installation must use the reviewed catalog revision. Reinstallation replaces the package and resets both activation flags; deletion removes its managed directory.
