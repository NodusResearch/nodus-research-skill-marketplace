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

## Contributing a Capability API v2 package

Capability API v2 packages live under `plugins/<id>` and may contain trusted Node or Python
runtime code. Contributors never sign packages and never need access to a publishing key.
They submit a pull request containing the source, manifests, migrations, dependency locks,
licence notices and tests. Maintainers review that code and its permissions before merging it.

A package that shows 3D models declares `nodus:3d` in its capability's `requires` and
`"models": true` in its permissions, hands the asset to `host.models.store(...)`, and
returns a `model` view node with the id it gets back. It ships no renderer: the viewer is
the application's. Assets must be self-contained glTF 2.0 — every URI an inline `data:`
one — because a model that referenced an external file would fetch it on whoever opened
that conversation next. See [the specification](SPECIFICATION.md#3d-models).

Beyond text, tables and SVG, a package can also return a formula, a chart, a hierarchy, a
marked-up passage, a comparison of two texts, a map, an image, a sound file or a IIIF
tiled image. Prefer these to drawing your own: they are rendered by the application, so
they theme with the rest of it and read the same wherever they came from. Three things
catch contributors out. Anything looked at rather than read needs `alt`, and review
rejects a package without it. `image` and `audio` need `"media": true`, and the bytes are
checked against their declared type, so a file that is not what it says it is will be
refused rather than stored. And `imageTiles` only loads if the service origin is already
in your `permissions.network` with `GET` and a matching path prefix — the view cannot
widen what the package was granted. See
[the specification](SPECIFICATION.md#result-kinds).

A package that declares a Python runtime must also ship its dependency locks: one per
target and per interpreter version it supports, generated by
`node scripts/build-runtime-lock.mjs <id>`. Every artifact in a lock is pinned by URL, size
and SHA-256, must be a wheel, and must come from the one host the capability's manifest
permits. Validation refuses a package that declares a runtime and ships no lock for a
target it publishes, because such a package installs and then fails at the first person
who tries to use it.

### Which targets your package declares

`compatibility.targets` decides how many archives get built, signed and published. Declare
**`["any"]`** unless the package genuinely differs per platform: a package of JavaScript,
WebAssembly and data is the same everywhere, and declaring four targets publishes the same
bytes four times, four times the build, four times the storage, for nothing.

Declare per-platform targets — `darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64` — when
something in the archive actually differs: a native module, a platform-specific binary, or a
Python runtime lock per target. If you are unsure, build both ways and compare the digests;
identical digests mean `any`.

Chemistry Studio 2.0.0 declares four and ships byte-identical code in all of them. It is the
example of getting this wrong, not the example to follow.

A target with no runner configured in `.github/workflows/release-plugin.yml` fails the
release at its first step, deliberately: adding a platform is a maintainer decision about
which runner image can honestly build it.

Maintainers editing that map: check the label still exists before you use it. GitHub retires
runner images, and a retired label does not fail — the job sits in `queued` for as long as
anyone lets it, while the other targets finish in under a minute. `macos-13` was retired and
a release waited three quarters of an hour on it. `macos-15-intel` is the last x86_64 image,
available until August 2027, and is the one the application's own release workflow uses.

### Build and check it locally before opening a pull request

Everything CI runs, you can run. In order, and all of it must pass:

```bash
npm ci                              # once
node scripts/build-notices.mjs <id> # regenerate the notices FIRST: the build packs them
node scripts/validate-plugins.mjs   # manifests, permissions, locks, migration ladder
npm run test:plugins                # your package's tests, plus the repository's own
node scripts/build-plugins.mjs      # builds every target your package declares
npm run validate                    # everything the pull request check runs
```

The order matters in one place: the notices are packed into the archive, so regenerating
them after the build produces a package whose notices describe a different build. The
release workflow generates them before the build that includes them for the same reason.

The build is reproducible, and that is worth something concrete: anyone can rebuild a
published version from its commit and get the same bytes, so a signature attests something
checkable rather than something asserted. Verify a published archive with

```bash
node scripts/build-plugins.mjs
shasum -a 256 build/<id>-<version>-<target>.nodus-plugin
```

and compare against the `sha256` for that target in the release's `release-manifest.json`.
It holds from any machine and in any timezone — a zip stores its timestamps in DOS format
and the encoder reads them with local getters, so this was true only on UTC until the
build started pinning components rather than an instant.

**Your tests run on Linux, Windows and macOS.** They did not always, and the day they
started, a path bug surfaced that had blocked a release: `new URL(import.meta.url).pathname`
is `/D:/…` on Windows, so joining it onto anything gives `D:\D:\…` and opens nothing. Use
`fileURLToPath`. Anything that touches a path, a line ending or a filename's case will
behave differently on one of the three, and the one you do not develop on is the one that
will find it.

**Every bundled dependency must ship a licence file the notice generator can find.** It
looks for `LICENSE`, `LICENCE`, `COPYING` in any capitalisation, with or without `.md` or
`.txt`. A dependency with neither a licence file nor a `license` field in its
`package.json` stops the build rather than shipping bytes nobody can account for.

### Publishing

An accepted package becomes official only when a maintainer starts the **Release capability
package** workflow from `main` and approves its protected `capability-signing` environment.
The workflow has three stages, and they are separate on purpose:

1. **plan** reads the package's declared targets and refuses immediately if the version has
   already been released.
2. **build** runs one job per target, on a runner of that platform. Each validates, tests,
   generates the third-party notices *before* the build that includes them, builds its own
   target, proves the build reproduces on that machine, and uploads it. No build job can
   reach the signing key.
3. **sign** builds nothing. It collects the per-target artifacts, refuses a declared target
   that no job produced, an undeclared target that appeared, an asset whose bytes do not
   match the index describing them, and the same target built twice with different bytes.
   Only then does it sign — once, over a manifest covering every target — verify the
   signature the way Nodus will, and publish every asset in a single release so a release
   is never visible holding some of its platforms.

`scripts/validate-workflows.mjs` enforces that separation as text on every push: a job that
reads the key without the protected environment, a signing job that runs a build, or
anything on a pull request that so much as names the key fails the check.

#### Running a release, step by step

```bash
gh workflow run "Release capability package" --ref main -f plugin=<id>
```

It must be `--ref main`: the `capability-signing` environment only accepts deployments from
`main`, so a release from a branch waits for an approval that can never be given.

The build matrix runs, then `sign` stops and waits. Approve it in the run's page under
**Review deployments**, or:

```bash
RUN=$(gh run list --workflow "Release capability package" --limit 1 --json databaseId --jq '.[0].databaseId')
ENV=$(gh api repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments --jq '.[0].environment.id')
gh api --method POST repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments \
  --input - <<< "{\"environment_ids\":[$ENV],\"state\":\"approved\",\"comment\":\"Release <id> <version>\"}"
```

**If any build fails, `sign` is skipped and nothing is published** — no tag, no release, no
assets. Fix the cause and run the workflow again under the same version. That is safe
precisely because nothing was published; it is the one case where re-running a release is
correct.

After it succeeds, record what was published and commit it:

```bash
gh release download <id>-v<version> --pattern 'release-manifest.*' --dir build --clobber
node scripts/record-release-sizes.mjs <id>   # reads the manifest AND verifies its signature
node scripts/build-catalog-v2.mjs
```

Both files are needed: the sizes are read from the signed manifest only after the signature
verifies, so the catalog cannot come to describe something nobody signed. The same numbers
are uploaded by the workflow as the `catalog-after-<id>` artifact if you would rather take
them from there. Commit `catalog-v2.json` and `plugins/<id>/catalog.json` through a pull
request like any other change.

Then, in the Nodus repository, pin the release in `electron/capabilities/bootstrap.json` —
release URL and every asset's name, size and SHA-256, taken from the same signed manifest —
and prove it:

```bash
NODUS_REQUIRE_BOOTSTRAP=1 node scripts/prepare-capability-bootstrap.mjs
node scripts/verify-cross-repo.mjs
NODUS_MARKETPLACE_DIR=<checkout> node scripts/verify-capability-migration-e2e.mjs
```

The first downloads every pinned package and refuses any whose bytes do not match its
digest; the second checks the pinned versions are the ones this repository publishes; the
third runs the 5.3.1 migration from them with no network.

#### What the signing secret has to contain

`CAPABILITY_SIGNING_KEY` is an **Ed25519 private key in PKCS#8 PEM form** — the block that
begins `-----BEGIN PRIVATE KEY-----`, header and footer included, exactly as
`npm run capabilities:keygen` prints it.

It is pasted into a web form, and three things happen to keys on that journey: the line
breaks arrive as the two characters `\` and `n`, the value arrives wrapped in quotes, or
only the base64 body is copied. All three used to reach OpenSSL as
`DECODER routines::unsupported`, after a full build matrix had already run. They are now
recovered, and what cannot be — the public half, a key that is not Ed25519, ssh-keygen's own
`-----BEGIN OPENSSH PRIVATE KEY-----` container — is named in the failure so the next
attempt is informed. An ssh-format key converts with `openssl pkey -in key -out key.pem`.

The private key is stored only as the `CAPABILITY_SIGNING_KEY` secret of the protected
`capability-signing` GitHub Environment. Its public half and `keyId` are committed to this
repository's `trusted-keys.json` and to Nodus's
`electron/capabilities/trustedKeys.json`, and Nodus's cross-repository CI fails if the two
ever stop matching. Package manifests must name that same `keyId`. Adding a package to this
repository does not grant it a signature automatically: review, merge and an explicitly
approved release are separate steps.

After publishing, the workflow records the exact published sizes in the catalog — read back
through the signature, from the manifest that describes what was actually published — and
uploads the result as an artifact. A maintainer commits `catalog-v2.json` and the package's
`catalog.json` from it, and updates Nodus's `electron/capabilities/bootstrap.json` with the
release URL and the signed asset metadata so an upgrade from 5.3.1 works with no network.
Never rewrite an existing release or reuse a version for different bytes; increment the
package version instead. Nodus refuses both anyway: a version it has already installed
cannot be replaced by different bytes under the same number.

### Rotating the signing key

Rotation is additive. The old key is retired, not deleted, because releases already
published were signed with it and must keep verifying.

1. Generate a new pair with `npm run capabilities:keygen` in the Nodus repository. It
   prints a public half and a private half and writes neither to any repository.
2. Put the private half in the `capability-signing` environment as
   `CAPABILITY_SIGNING_KEY`, replacing the previous value. Keep the previous value only
   long enough to be sure the new one works; a signing key is never stored anywhere else.
3. Add the new public half to `trusted-keys.json` here and to Nodus's
   `electron/capabilities/trustedKeys.json`, with a new `keyId`. Keep the old entry and
   give it a `retiredAt` timestamp: Nodus accepts a signature from a retired key for a
   release created before that date and refuses one created after it.
4. Bump the `publisher.keyId` in each package's `plugin.json` to the new id, and release
   each package again under a new version. Both repositories must be updated in the same
   change; the cross-repository check fails if the key lists differ.
5. Remove a retired key only once no supported Nodus version can still be asked to install
   a release it signed — in practice, once the bootstrap of every supported build has moved
   on. Removing it earlier turns those releases into packages that cannot be installed.

### Recovering from a bad release

A published release is immutable, so recovery is forward, never backwards.

- **A package that is broken but installable**: publish a new version. Nodus updates it on
  its own for anyone with automatic updates on, and anyone who already installed the bad
  one can roll back to the version they had, which the store keeps.
- **A package that must not be installed at all**: delete the GitHub release so the assets
  stop being served, and remove the entry from `catalog-v2.json` so it stops being offered.
  Neither uninstalls anything from a device that already has it; say so plainly in the
  advisory rather than implying a remote removal.
- **A signing key believed to be compromised**: rotate it as above, and retire the old key
  with a `retiredAt` earlier than the first release you do not trust. Every release signed
  after that timestamp stops verifying on every machine, which is the point.
- **A catalog that points at something that does not exist**: fix the catalog. Nothing in
  it is trusted — an entry that lies about a version, a size or an asset fails verification
  rather than installing something — so a wrong catalog is a broken download, not a
  security incident.

### Controlled public-image review

The repository-owner exception in [POLICY.md](POLICY.md#narrow-exception-controlled-public-image-relevance-review) permits approved public thumbnails and safe attribution metadata only through native `nodus:vision` relevance review. It does not authorize private/student data or a general model-call API. New image sources require documented licence review, strict endpoint declarations and deterministic negative tests; see [Research Visuals](plugins/research-visuals/README.md).
