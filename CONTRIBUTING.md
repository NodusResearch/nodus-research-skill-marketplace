# Create and contribute a skill or plugin

1. In Nodus, open **Skills → My skills → Create skill**. Write an English name, brief description and instructions. Set your GitHub username, category and version.
2. Select only needed native capabilities (`nodus:svg`, `nodus:image`, `nodus:chemistry`, `nodus:genomics`, `nodus:legal`). For custom tools, add an ID, input/output description and a JavaScript function expression. See [the specification](SPECIFICATION.md) and [Descriptive Statistics](descriptive-statistics/).
3. Save the skill, enable it on one surface and try a concrete request. Test it independently in Assistant and Nodi. Check invalid input and disabled-tool behavior.
4. Select **Export** on the saved skill. Choose a parent folder. Nodus creates a package directory without overwriting existing directories. Alternatively, copy `templates/example-skill` to a new directory at the repository root and update the manifest ID to match.
5. Copy that directory into a fork of this repository. Keep one directory per skill. Run `node scripts/catalog.mjs` and `node scripts/catalog.mjs --check` with Node.js 22 or later.
6. Submit a pull request with the purpose, capabilities, test request and expected result, license/source credits and confirmation that you have read [the marketplace rules](POLICY.md). Do not include private input, credentials or generated research data.

Use an existing category where appropriate: Data analysis, Learning, Science, Thinking and writing, Visual creation. New descriptive categories are accepted. The README is generated and grouped by category, with app/skill name, creator username and brief description.

To publish independently, put the same directories at the root of any public GitHub repository and add its repository URL in **Skills → Marketplace → Add source**, then click **Update catalog**. There is no limit to the number of sources a user can add. If the official marketplace rejects a listing, hosting elsewhere does not imply official endorsement or override the rules of the hosting service or applicable law.

For updates, increment the manifest version and repeat validation and review. Users refresh the catalog, review the update and explicitly replace their installation; their existing installation is not modified automatically.

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
6. Expanding permissions in a later version is allowed, but say so explicitly in the pull
   request: existing users will be asked to approve the new set before the update applies.

[Unit Converter](unit-converter/) is a complete, deterministic worked example: one skill, one
capability, no permissions.
