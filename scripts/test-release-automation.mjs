import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { githubClient, downloadSmall, readPublishedRelease } from './lib/github-release-api.mjs';
import { assertMainMerge, assertReleaseMatchesPackage, assertPublishedBuildMatches, assertCatalogDiff,
  assertCatalogIndexDiff, buildMatrix, isCatalogPath, recordedAssetBytes, selectPackages } from './lib/release-automation.mjs';
import { mainProtection, assertMainProtection, assertMainSigningPolicy } from './lib/release-protection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prototype = JSON.parse(fs.readFileSync(path.join(root, 'plugins/math-studio/plugin.json'), 'utf8'));
const manifest = (version = '1.0.1', id = 'test-package') => ({ ...prototype, id, version });
const published = (version, extra = {}) => ({ tag_name: `test-package-v${version}`, draft: false, prerelease: false, ...extra });
const source = 'a'.repeat(40), repository = 'NodusResearch/nodus-research-skill-marketplace';
const gate = () => ({ repository, source, branch: { protected: true, commit: { sha: source } },
  pullRequests: [{ merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: source, base: { ref: 'main', repo: { full_name: repository } } }],
  validation: { head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' },
});

test('a released version is skipped without rebuilding or resigning', () => assert.deepEqual(selectPackages([manifest()], [published('1.0.1')]), []));
test('version increases use SemVer, including 1.10 after 1.9', () => {
  assert.equal(selectPackages([manifest('1.10.0')], [published('1.9.9')]).length, 1);
  assert.equal(selectPackages([manifest()], [published('1.0.0')]).length, 1);
});
test('all pending packages are selected and published ones omitted', () => {
  const pending = selectPackages([manifest('1.0.2'), manifest('2.0.0', 'another-package')], [published('1.0.1')]);
  assert.deepEqual(pending.map(p => p.id), ['another-package', 'test-package']);
  assert.deepEqual(selectPackages(pending, [published('1.0.1')], 'test-package').map(p => p.id), ['test-package']);
});
test('new packages can publish their initial version', () => assert.equal(selectPackages([manifest('1.0.0')], []).length, 1));
test('downgrades and occupied draft/prerelease tags fail closed', () => {
  assert.throws(() => selectPackages([manifest('1.0.0')], [published('1.0.1')]), /must exceed/);
  for (const extra of [{ draft: true }, { prerelease: true }]) assert.throws(() => selectPackages([manifest()], [published('1.0.1', extra)]), /not a stable/);
});
test('package selectors reject traversal and unknown packages', () => {
  for (const id of ['../secrets', 'test;exit', 'TEST']) assert.throws(() => selectPackages([manifest()], [], id), /Invalid/);
  assert.throws(() => selectPackages([manifest()], [], 'absent'), /No such/);
});
test('each declared platform gets a runner and a version-pinned artifact', () => {
  const m = manifest(); m.compatibility = { ...m.compatibility, targets: ['any', 'darwin-x64', 'win32-x64'] };
  const rows = buildMatrix([m]).include;
  assert.deepEqual(rows.map(r => r.runner), ['ubuntu-latest', 'macos-15-intel', 'windows-latest']);
  assert.ok(rows.every(r => r.version === m.version && r.plugin === m.id));
  assert.throws(() => buildMatrix([{ ...m, compatibility: { targets: ['unknown'] } }]), /No runner/);
});
test('only a protected, merged main commit with successful push CI passes', () => assert.equal(assertMainMerge(gate()), true));
test('direct pushes, unmerged PRs, foreign repos and unprotected main fail before signing', () => {
  for (const mutate of [g => g.branch.protected = false, g => g.pullRequests = [],
    g => g.pullRequests[0].merged_at = null, g => g.pullRequests[0].base.repo.full_name = 'other/repo']) {
    const g = gate(); mutate(g); assert.throws(() => assertMainMerge(g));
  }
});
test('failed, unfinished, PR, wrong-commit and wrong-branch CI cannot authorize signing', () => {
  for (const extra of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }]) {
    const g = gate(); Object.assign(g.validation, extra); assert.throws(() => assertMainMerge(g), /must pass/);
  }
});
test('a superseded main run makes no release decisions', () => {
  const g = gate(); g.branch.commit.sha = 'b'.repeat(40); assert.equal(assertMainMerge(g), false);
});
test('a new version cannot inherit a smaller old archive bound', () => {
  const d = { assetVersion: '1.0.0', assetBytes: { any: 12 } };
  assert.equal(recordedAssetBytes(d, 'any', '1.0.1', 1000), 1000);
  assert.equal(recordedAssetBytes(d, 'any', '1.0.0', 1000), 12);
  assert.equal(recordedAssetBytes({ assetBytes: { any: 12 } }, 'any', '1.0.1', 1000), 1000);
  assert.throws(() => recordedAssetBytes({ assetVersion: '1.0.1', assetBytes: { any: -1 } }, 'any', '1.0.1', 1000));
});
test('catalog automation cannot change descriptions, capabilities or release URLs', () => {
  const d = { description: { en: 'Synthetic example' }, assetVersion: '1.0.0', assetBytes: { any: 12 } };
  assert.doesNotThrow(() => assertCatalogDiff(d, { ...d, assetVersion: '1.0.1', assetBytes: { any: 13 } }));
  assert.throws(() => assertCatalogDiff(d, { ...d, description: { en: 'Changed' } }));
  assert.throws(() => assertCatalogDiff(d, { ...d, permissions: { files: true } }));
  const index = { updatedAt: 'old', plugins: [{ id: 'test-package', version: '1.0.1', release: { tag: 'test-package-v1.0.1', assets: [{ target: 'any', bytes: 12 }] } }] };
  const after = structuredClone(index); after.updatedAt = 'new'; after.plugins[0].release.assets[0].bytes = 13;
  assert.doesNotThrow(() => assertCatalogIndexDiff(index, after));
  after.plugins[0].release.tag = 'another-tag'; assert.throws(() => assertCatalogIndexDiff(index, after));
});
test('the metadata path allowlist excludes source, credentials and traversal', () => {
  for (const p of ['catalog-v2.json', 'plugins/test-package/catalog.json']) assert.equal(isCatalogPath(p), true);
  for (const p of ['plugins/../catalog.json', '.github/workflows/validate.yml', 'plugins/test-package/src/worker.ts', 'plugins/test-package/skill.json']) assert.equal(isCatalogPath(p), false);
});
test('404 alone means absent; authentication and service failures must not masquerade as absence', async () => {
  const missing = githubClient(repository, 'synthetic-token', async () => new Response('', { status: 404 }));
  assert.equal(await missing.request('releases/tags/missing', { missing: true }), null);
  for (const status of [401, 403, 429, 500]) {
    const api = githubClient(repository, 'synthetic-token', async () => new Response('', { status }));
    await assert.rejects(api.request('releases/tags/missing', { missing: true }), new RegExp(String(status)));
  }
});
test('public release metadata downloads are bounded', async () => {
  await assert.rejects(downloadSmall('https://example.invalid/fixture', 8, async () => new Response('too many fixture bytes')), /exceeds/);
});
test('signed target and archive identities must match the current package', () => {
  const m = manifest(); const r = { plugin: m.id, version: m.version, targets: [{ target: 'any', asset: `${m.id}-${m.version}-any.nodus-plugin`, bytes: 12, sha256: 'a'.repeat(64) }] };
  assert.doesNotThrow(() => assertReleaseMatchesPackage(r, m));
  assert.throws(() => assertReleaseMatchesPackage({ ...r, version: '1.0.0' }, m));
  assert.throws(() => assertReleaseMatchesPackage({ ...r, targets: [] }, m));
  assert.throws(() => assertReleaseMatchesPackage({ ...r, targets: [{ ...r.targets[0], asset: '../escape' }] }, m));
  assert.doesNotThrow(() => assertPublishedBuildMatches(r, [{ manifest: m, target: 'any', bytes: 12, sha256: 'a'.repeat(64) }]));
  assert.throws(() => assertPublishedBuildMatches(r, [{ manifest: m, target: 'any', bytes: 13, sha256: 'b'.repeat(64) }]));
});
test('a published fixture verifies its signature, target, size and digest without network', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-release-fixture-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(temporary, 'trusted-keys.json'), JSON.stringify({ keys: [{ keyId: 'nr02', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }));
    const m = manifest();
    const target = { target: 'any', asset: `${m.id}-${m.version}-any.nodus-plugin`, bytes: 12, sha256: 'a'.repeat(64) };
    const release = { schemaVersion: 1, plugin: m.id, version: m.version, publisher: m.publisher, createdAt: '2026-01-01T00:00:00Z', targets: [target] };
    const bytes = Buffer.from(JSON.stringify(release)), signature = sign(null, bytes, privateKey);
    const record = { draft: false, prerelease: false, assets: [{ name: target.asset, state: 'uploaded', size: 12, digest: `sha256:${target.sha256}` }] };
    const api = { repository, request: async () => record };
    const fetcher = async url => new Response(url.endsWith('.sig') ? signature : bytes);
    assert.deepEqual(await readPublishedRelease(api, temporary, m, undefined, fetcher), release);
    record.assets[0].digest = `sha256:${'b'.repeat(64)}`;
    await assert.rejects(readPublishedRelease(api, temporary, m, undefined, fetcher), /does not match/);
    record.assets[0].digest = `sha256:${target.sha256}`;
    signature[0] ^= 0xff;
    await assert.rejects(readPublishedRelease(api, temporary, m, undefined, fetcher), /signature|verif/i);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('catalog synchronization refuses a local or non-main checkout before any git mutation', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts/sync-published-catalog.mjs')],
    { env: { ...process.env, CI: 'false', GITHUB_REF: 'refs/heads/main' }, stdio: 'pipe' }), /Command failed/);
});

test('branch protection requires every CI check even for admins and grants no bot bypass', () => {
  const desired = mainProtection(true);
  assert.equal(desired.enforce_admins, true);
  assert.equal(desired.required_status_checks.strict, true);
  assert.equal(desired.required_status_checks.checks.length, 4);
  assert.equal(desired.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.deepEqual(desired.required_pull_request_reviews.bypass_pull_request_allowances.apps, []);
  assert.deepEqual(desired.required_pull_request_reviews.bypass_pull_request_allowances.users, ['jorgepb96']);
  assert.equal(mainProtection(false).required_pull_request_reviews.required_approving_review_count, 1);
});
test('activation rejects missing CI checks, an app bypass or an open signing branch pattern', () => {
  const apiPolicy = () => { const p = mainProtection(true); return { ...p, enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    required_pull_request_reviews: { ...p.required_pull_request_reviews, bypass_pull_request_allowances: { users: [{ login: 'jorgepb96' }], apps: [], teams: [] } },
  }; };
  assert.doesNotThrow(() => assertMainProtection(apiPolicy(), true));
  const missing = apiPolicy(); missing.required_status_checks.checks.pop(); assert.throws(() => assertMainProtection(missing, true));
  const bypass = apiPolicy(); bypass.required_pull_request_reviews.bypass_pull_request_allowances.apps.push({ slug: 'github-actions' }); assert.throws(() => assertMainProtection(bypass, true));
  assert.doesNotThrow(() => assertMainSigningPolicy([{ name: 'main', type: 'branch' }]));
  for (const rules of [[], [{ name: '*', type: 'branch' }], [{ name: 'main', type: 'tag' }], [{ name: 'main', type: 'branch' }, { name: 'other', type: 'branch' }]]) {
    assert.throws(() => assertMainSigningPolicy(rules));
  }
});
