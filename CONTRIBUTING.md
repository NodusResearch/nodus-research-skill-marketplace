# Create and contribute a skill or plugin

1. In Nodus, open **Skills → My skills → Create skill**. Write an English name, brief description and instructions. Set your GitHub username, category and version.
2. Select only needed native capabilities. The editor lists them by short name — svg, image, chemistry, genomics, legal — and the exported manifest may write either the short name or its canonical `nodus:` identifier; Nodus treats them as the same capability. For custom tools, add an ID, input/output description and a JavaScript function expression. See [the specification](SPECIFICATION.md) and [Descriptive Statistics](descriptive-statistics/).
3. Save the skill, enable it on one surface and try a concrete request. Test it independently in Assistant and Nodi. Check invalid input and disabled-tool behavior.
4. Select **Export** on the saved skill. Choose a parent folder. Nodus creates a package directory without overwriting existing directories. Alternatively, copy `templates/example-skill` to a new directory at the repository root and update the manifest ID to match.
5. Copy that directory into a fork of this repository. Keep one directory per skill. Run `node scripts/catalog.mjs` and then `node scripts/catalog.mjs --check` with Node.js 22 or later, and commit the regenerated category index and catalog block in `README.md` — CI fails when either is stale.
6. Submit a pull request with the purpose, capabilities, test request and expected result, license/source credits and confirmation that you have read [the marketplace rules](POLICY.md). Do not include private input, credentials or generated research data.

## Choose a category

The official catalog uses a controlled vocabulary. Choose a field of knowledge when the skill belongs to one subject. Choose a general workflow when the skill applies across subjects. The README includes only categories that contain a published skill.

General workflows:

- Audio, video and presentations
- Data and statistics
- Design and visual communication
- Learning and teaching
- Planning and productivity
- Research and evidence
- Software and automation
- Sources, citations and knowledge management
- Thinking and decision-making
- Writing and communication

Fields of knowledge:

- Agriculture, food and veterinary research
- Earth and environmental sciences
- Economics, business and finance
- Engineering and technology
- Health and medicine
- Humanities and arts
- Law and public policy
- Life sciences
- Mathematics and computing
- Physical sciences
- Social and behavioural sciences

The catalog generator rejects categories outside this list. Explain a proposed addition in the pull request when none of these categories fits. Independent marketplace repositories may define their own categories.

To publish independently, put the same directories at the root of any public GitHub repository and add its repository URL in **Skills → Marketplace → Add source**, then click **Update catalog**. There is no limit to the number of sources a user can add. If the official marketplace rejects a listing, hosting elsewhere does not imply official endorsement or override the rules of the hosting service or applicable law.

For updates to a **skill package**, increment the manifest version and repeat validation and review. Users refresh the catalog, review the update and explicitly replace their installation; their existing installation is not modified automatically. **Plugins update differently** — see the section below.

## Contributing a plugin

A plugin ships several skills, or a skill together with its own sandboxed capability. Copy
`templates/example-plugin` to a new root directory named after the plugin id, and read the
[plugin section of the specification](SPECIFICATION.md#nodus-plugin-v1).

1. Give every component the same SemVer version as `plugin.json`, and increment all of them
   together for any change. Republishing different content under an existing version is
   refused by Nodus, not just by review.
2. Set `compatibility.minNodusVersion` to the oldest release you have actually tested.
3. Request the narrowest permissions that work. A capability with `"permissions": {}` has no
   host operations at all — prefer it whenever the work is self-contained. Declare each HTTPS
   endpoint with its exact origin, path prefixes and methods, and declare a secret rather than
   asking the user to paste a key into a prompt.
4. Name every tool your instructions rely on inside `SKILL.md`. The validator rejects a
   package whose instructions never mention a declared tool.
5. Install it locally before submitting: build the directory, then either import it in
   **Skills → Marketplace → Import**, or drop it into `plugins/inbox/` in your Nodus profile
   and approve it under **Waiting for review**. Exercise the capability from a real
   conversation on at least two surfaces.
6. Copy the directory into a fork of this repository, keeping one root directory per plugin,
   named after its `plugin.json` id. Run `node scripts/catalog.mjs` and then
   `node scripts/catalog.mjs --check` with Node.js 22 or later, and commit the regenerated
   category index and catalog block in `README.md`. Never edit `scripts/contract.mjs` by hand.
7. Submit a pull request following the template: purpose, every tool and capability, the exact
   permissions each capability requests and why, a reproducible request with its expected
   result, licence and source credits, and confirmation that you have read
   [the marketplace rules](POLICY.md).

**Updates work differently from skill packages.** From this official repository a plugin
auto-updates by default, so a published version reaches existing users without them
reinstalling it. Increment every component's version together, and say so explicitly in the
pull request if the new version widens any capability's permissions: Nodus holds such an update
until each user approves the new set. Instructions a user edited locally survive an update as an
overlay, and a user can always roll back to the previous version.

[Unit Converter](unit-converter/) is a complete, deterministic worked example: one skill, one
capability, no permissions.
