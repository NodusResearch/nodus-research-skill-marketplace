// Signs the release manifest for one capability package.
//
// The private key never touches the repository or a developer machine: it is read from
// the environment inside a protected GitHub Environment, used once, and not written
// anywhere. What is signed is the manifest of digests, so one small signature pins every
// published target.
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign as signBytes } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Pass the package id to sign.');

const pem = process.env.CAPABILITY_SIGNING_KEY;
if (!pem) throw new Error('CAPABILITY_SIGNING_KEY is not set. Signing runs only in the protected environment.');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'plugin.json'), 'utf8'));
const built = JSON.parse(fs.readFileSync(path.join(root, 'build/index.json'), 'utf8')).filter((entry) => entry.manifest.id === id);
if (!built.length) throw new Error(`${id} was not built.`);

const release = {
  schemaVersion: 1,
  plugin: manifest.id,
  version: manifest.version,
  publisher: { id: 'NodusResearch', keyId: manifest.publisher.keyId },
  createdAt: new Date().toISOString(),
  targets: built
    .map((entry) => ({ target: entry.target, asset: entry.asset, bytes: entry.bytes, sha256: entry.sha256 }))
    .sort((a, b) => a.target.localeCompare(b.target)),
};

// The signature covers these exact bytes, so the file written here is the file published.
const bytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not Ed25519.');

fs.writeFileSync(path.join(root, 'build/release-manifest.json'), bytes);
fs.writeFileSync(path.join(root, 'build/release-manifest.sig'), signBytes(null, bytes, key));
console.log(`Signed ${release.plugin} ${release.version} for ${release.targets.map((target) => target.target).join(', ')} with key ${release.publisher.keyId}.`);
