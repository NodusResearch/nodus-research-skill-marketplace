// Builds every capability package for this platform's targets and writes build/index.json,
// which the release workflow turns into a signed manifest.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const only = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const plugins = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && (!only.length || only.includes(entry.name)))
  .map((entry) => entry.name)
  .sort();

const results = [];
for (const id of plugins) {
  const builder = path.join(root, 'plugins', id, 'build.mjs');
  if (!fs.existsSync(builder)) throw new Error(`${id} has no build.mjs`);
  const module = await import(pathToFileURL(builder));
  results.push(...[].concat(module.default ?? module.result ?? []));
}
// Per-target as well as combined: a release is assembled from one index per target, each
// uploaded by the machine that built it, and scripts/collect-release.mjs merges them.
const target = process.env.NODUS_PLUGIN_TARGET ?? `${process.platform}-${process.arch}`;
fs.writeFileSync(path.join(root, 'build/index.json'), `${JSON.stringify(results, null, 2)}\n`);
fs.writeFileSync(path.join(root, `build/index-${target}.json`), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Built ${results.length} package(s).`);
