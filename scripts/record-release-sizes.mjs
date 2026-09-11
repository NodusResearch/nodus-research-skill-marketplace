// Writes the published asset sizes into the catalog, from the signed release manifest.
//
// The catalog's size is a download bound and nothing else — the signed manifest carries
// the exact byte count and digest an install is checked against — but a bound that is
// wrong in the small direction refuses a legitimate download, and one that is invented
// misleads. So it is recorded from the one document that is authoritative about what was
// published, and only after it was published.
import fs from 'node:fs';
import path from 'node:path';
import { verifyReleaseManifest } from './contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Usage: node scripts/record-release-sizes.mjs <plugin-id>');

const keys = JSON.parse(fs.readFileSync(path.join(root, 'trusted-keys.json'), 'utf8')).keys;
if (!keys.length) throw new Error('trusted-keys.json carries no public key.');

// Read through the signature, not around it: a manifest that does not verify describes
// nothing that was published.
const release = verifyReleaseManifest(
  fs.readFileSync(path.join(root, 'build/release-manifest.json')),
  fs.readFileSync(path.join(root, 'build/release-manifest.sig')),
  keys,
);
if (release.plugin !== id) throw new Error(`The signed manifest is for ${release.plugin}, not ${id}.`);

const catalogPath = path.join(root, 'plugins', id, 'catalog.json');
const description = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
description.assetBytes = Object.fromEntries(
  release.targets.map(target => [target.target, target.bytes]).sort(([a], [b]) => a.localeCompare(b)),
);
fs.writeFileSync(catalogPath, `${JSON.stringify(description, null, 2)}\n`);

console.log(`Recorded ${release.targets.length} asset size(s) for ${id} ${release.version}.`);
console.log('Run: node scripts/build-catalog-v2.mjs');
