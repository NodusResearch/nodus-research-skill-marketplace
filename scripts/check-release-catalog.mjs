// Catalog-only PRs must reproduce public signed releases. A PR with package/source
// changes still requires its code owner; these checks grant no bypass permission.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { githubClient, readPublishedRelease } from './lib/github-release-api.mjs';
import { assertCatalogDiff, assertCatalogIndexDiff, isCatalogPath } from './lib/release-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const requested = process.env.CATALOG_BASE_SHA;
if (requested && !/^[0-9a-f]{40}$/.test(requested)) throw new Error('An exact catalog base SHA is required.');
const base = git(['merge-base', requested || 'origin/main', 'HEAD']);
const files = git(['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean);
if (!files.length || files.some(file => !isCatalogPath(file))) {
  console.log('This is not a catalog-only change; ordinary source review applies.');
  process.exit(0);
}
const statuses = git(['diff', '--name-status', `${base}..HEAD`]).split('\n');
if (statuses.some(line => !line.startsWith('M\t'))) throw new Error('A catalog-only PR may only modify existing metadata files.');
const client = githubClient();
for (const file of files) {
  const before = JSON.parse(git(['show', `${base}:${file}`]));
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (file === 'catalog-v2.json') { assertCatalogIndexDiff(before, after); continue; }
  assertCatalogDiff(before, after);
  const id = file.split('/')[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'plugin.json'), 'utf8'));
  const release = await readPublishedRelease(client, root, manifest);
  if (!release) throw new Error(`No published signed release for ${id} ${manifest.version}.`);
  const expected = Object.fromEntries(release.targets.map(t => [t.target, t.bytes]).sort(([a], [b]) => a.localeCompare(b)));
  if (after.assetVersion !== release.version || JSON.stringify(after.assetBytes) !== JSON.stringify(expected)) {
    throw new Error(`Catalog metadata differs from the signed ${id} release.`);
  }
}
console.log('Catalog-only changes match published signatures and preserve all package metadata.');
