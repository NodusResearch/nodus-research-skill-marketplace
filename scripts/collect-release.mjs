// Assembles one release out of the per-target builds.
//
// Each target is built on its own machine and uploaded on its own; this is where those
// pieces become a single thing to sign. The assembly is deterministic — the same set of
// per-target indexes always produces the same manifest input — and it is suspicious: an
// asset that is missing, whose bytes do not match the index that described them, or whose
// target was never declared, stops the release here rather than producing a signature
// over something nobody checked.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePluginManifestV2 } from './contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Usage: node scripts/collect-release.mjs <plugin-id>');

const build = path.join(root, 'build');
const manifest = validatePluginManifestV2(JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'plugin.json'), 'utf8')));

// Every `index-<target>.json` an uploading job left behind, in a fixed order.
const indexes = fs.readdirSync(build).filter(name => /^index-[a-z0-9-]+\.json$/.test(name)).sort();
if (!indexes.length) throw new Error('No per-target build index was collected.');

const byTarget = new Map();
for (const file of indexes) {
  for (const entry of JSON.parse(fs.readFileSync(path.join(build, file), 'utf8'))) {
    if (entry.manifest.id !== id) continue;
    const existing = byTarget.get(entry.target);
    // The same target built twice must have produced the same bytes, or the build is not
    // reproducible and there is no single answer to what this version is.
    if (existing && existing.sha256 !== entry.sha256) throw new Error(`${entry.target} was built twice with different bytes (${existing.sha256} and ${entry.sha256}).`);
    byTarget.set(entry.target, entry);
  }
}

const missing = manifest.compatibility.targets.filter(target => !byTarget.has(target));
if (missing.length) throw new Error(`${id} declares ${missing.join(', ')} but no job produced ${missing.length === 1 ? 'that target' : 'those targets'}.`);
const undeclared = [...byTarget.keys()].filter(target => !manifest.compatibility.targets.includes(target));
if (undeclared.length) throw new Error(`${id} does not declare ${undeclared.join(', ')}.`);

const entries = [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
for (const entry of entries) {
  const file = path.join(build, entry.asset);
  if (!fs.existsSync(file)) throw new Error(`${entry.asset} was described by a build index but not uploaded.`);
  const bytes = fs.readFileSync(file);
  if (bytes.byteLength !== entry.bytes) throw new Error(`${entry.asset} is ${bytes.byteLength} bytes; its build said ${entry.bytes}.`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) throw new Error(`${entry.asset} does not match the digest its build recorded.`);
  console.log(`ok  ${entry.asset}  ${entry.bytes} bytes  sha256:${digest}`);
}

fs.writeFileSync(path.join(build, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
console.log(`\nCollected ${entries.length} target(s) for ${id} ${manifest.version}: ${entries.map(entry => entry.target).join(', ')}.`);
