// Verifies a signed release exactly the way Nodus will, before it is published.
//
// A release that fails here would fail on every user's machine, so the check runs against
// the public key committed to the application rather than against anything this job holds.
import fs from 'node:fs';
import path from 'node:path';
import { verifyReleaseManifest, assertPackageMatchesRelease, validatePluginManifestV2 } from './contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Pass the package id to verify.');

const keys = JSON.parse(fs.readFileSync(path.join(root, 'trusted-keys.json'), 'utf8')).keys;
if (!keys.length) throw new Error('trusted-keys.json carries no public key, so a release cannot be verified.');

const manifestBytes = fs.readFileSync(path.join(root, 'build/release-manifest.json'));
const signature = fs.readFileSync(path.join(root, 'build/release-manifest.sig'));
const release = verifyReleaseManifest(manifestBytes, signature, keys);
if (release.plugin !== id) throw new Error(`The signed manifest is for ${release.plugin}, not ${id}.`);

const inner = validatePluginManifestV2(JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'plugin.json'), 'utf8')));
for (const target of release.targets) {
  const archive = fs.readFileSync(path.join(root, 'build', target.asset));
  assertPackageMatchesRelease(release, target.target, archive, inner);
  console.log(`ok  ${target.asset}  ${target.bytes} bytes  sha256:${target.sha256}`);
}
console.log(`\n${release.plugin} ${release.version} verifies against the published key ${release.publisher.keyId}.`);
