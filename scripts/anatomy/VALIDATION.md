# Anatomy atlas 1.1.0 integration validation

Validated locally on macOS arm64 with Node 22 against a Nodus 5.3.2 development build
containing the companion generic integration. The marketplace branch is
`codex/anatomy-atlas-1.1`; the separate application branch is
`codex/plugin-readonly-model-assets` (final tested base `c0ad8cee`). Upstream runtime PR: https://github.com/Drakonis96/nodus/pull/765.
Upstream is merged as `ed567f211c05cb1db5a498310f64e4899cb153b5`. The README documents the compatible source build.
No new application or package release is claimed.

## Implementation under review

- Existing 79-structure SVG catalog, resolver and compressed source payload are retained.
  Five previous-version output hashes cover byte-for-byte default SVG compatibility.
- Reviewed English/Spanish aliases, explicit label modes and separate male/female panels.
- 114 geometry-backed atlas entries, six packaged GLBs, 646 deduplicated BodyParts3D OBJ
  mesh elements, 3,479 semantic entities and 4,334 source relationship assertions. These
  counts describe the snapshot, not completeness of human anatomy. Systems are partial.
- Source-labelled laterality, explicitly disclosed deltoid portion collections, curated
  PART-OF/IS-A traversal and inverse HAS-PART queries. FMA, UBERON and HRA identities remain
  distinct. Unqualified renal queries retain the existing UBERON identity.
- Pinned raw archives/files, SHA-256 verification, asset-specific HRA credits, BodyParts3D
  licence evidence and coordinate documentation, and the actual CC BY 3.0 Uberon licence.
  The historical BodyParts3D OBJ notice and HRA uterus metadata inconsistency are disclosed.
- Generic capability-local JSON/GLB/glTF declarations and ID-only read-only access in Nodus.
  Native selection preserves source geometry, transforms, grouping and stable extras IDs.
  Models use the existing generic viewer. No anatomy viewer or native anatomy capability.
- Native model history projection keeps individual contributor credits in application-managed
  presentation and immutable model metadata, outside subsequent model inference.

## Checks performed

Marketplace checks passed:

1. `node scripts/build-notices.mjs` for each of alphagenome, legalize and chemistry-studio.
2. `node scripts/validate-plugins.mjs`.
3. `npm run test:plugins`, including the existing package, licence, signature-shape and
   archive-determinism tests and the anatomy tests.
4. `node scripts/build-plugins.mjs`.
5. `npm run validate`, including TypeScript and catalog/template/workflow checks.
6. `node scripts/build-catalog-v2.mjs --check`.
7. `npm run test:anatomy`: 44 tests passed. Includes source corruption/missing-cache
   preflight failures, native model validation and all six GLBs with zero Khronos errors
   or warnings. No external validator resources are allowed.
8. Full final atlas/SVG rebuild from verified cached sources with `--offline`; all packaged
   bytes, manifest, runtime and mesh lock reproduced exactly. Source corruption is tested
   with a synthetic cache and must fail before changing packaged output.

Application checks passed:

- `npm run test:skill-capabilities`: 110 tests plus real Chromium sandbox and utility-worker
  checks. `NODUS_MARKETPLACE_DIR` was set, so all three built v2 package installations ran;
  these were not skipped. Existing Unit Converter import and skill-tool sandbox also ran.
- `scripts/test-plugin-assets.mjs`: seven generic declaration, path, hash, glTF/GLB subset,
  malformed-input and binary-container tests (included in the suite above).
- `scripts/test-capability-3d.mjs`: existing native 3D contract/security tests.
- `scripts/verify-anatomy-atlas.mjs` with `NODUS_MARKETPLACE_CHECKOUT`: actual directory
  installation, digest round trip, four tools in real Chromium via the shared chat-result
  pipeline and two synthetic saved-chat contexts labelled Assistant/Nodi. Checks native
  attachment storage/reconciliation, disabled capabilities, shared reply budget, invalid
  input, stale chats, cancellation, cross-capability IDs, blocked binary sandbox reads,
  symlinks, corruption and the model-history attribution boundary.
- `scripts/verify-anatomy-viewer.mjs`: actual React result component and native viewer in
  Chromium; four selected models pass Khronos validation, open, rotate, reset and close.
  External requests are refused. Captures of kidneys, digestive anatomy, uterus, deltoid
  portions and a number-only SVG quiz were inspected.
- `npm run typecheck` and `npm run build` (Cloudflare worker, renderer and Electron builds).
- `npm run test:e2e` on the committed application build: the complete smoke test passed
  using an isolated temporary profile.

These are synthetic, offline fixtures and direct pipeline/UI checks, without paid model
calls or real personal, patient or student records. They are not a claim of manual live
Assistant/Nodi conversations or scientific/clinical validation. The PR checks additionally
passed the marketplace suites and cross-repository integration on Linux, macOS and Windows.
Application CI: https://github.com/Drakonis96/nodus/actions/runs/34700087786.
Marketplace CI: https://github.com/NodusResearch/nodus-research-skill-marketplace/pull/26/checks.

## Existing dependency audit finding

`npm audit` reports the pre-existing pinned `adm-zip@0.5.16` tooling dependency
(GHSA-xcpc-8h2w-3j85 and GHSA-vwc7-r8mq-g2x9). This dependency is unchanged from
marketplace main and is not included in the offline anatomy runtime. The audit is
not counted as a passing check; updating repository archive tooling is separate work.

## Diff and commit status

Generated contracts came only from the companion Nodus sync script. The README catalog was
regenerated. Assets are binary files rather than base64 in runtime source; shared geometry
is deduplicated. Unrelated generated notices/build outputs are excluded from the change.
The plugin, skill, capability and displayed version all identify 1.1.0. No permissions,
existing call budgets or SVG sanitization rules were weakened.

Final implementation and merge commits use GitHub-native verified signing.
The large binary asset is uploaded separately before the signed implementation commit. No local signing key, environment
secret, new key or signing-configuration change is needed. The application PR and generated
contract preparation PR precede this dependent marketplace contribution. Release-package
signing remains separate in the protected environment.
