// Shared builder for capability packages.
//
// A package is a signed archive, so the build has to be reproducible: fixed entry
// ordering, fixed timestamps, no build host in the output. Two builds of the same commit
// must produce the same SHA-256, or the signature stops meaning anything.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import { validateCapabilityManifestV2, validatePluginManifestV2, assertMayProvide } from './contract-v2.mjs';

const EPOCH = new Date('2020-01-01T00:00:00Z');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function buildPlugin({ root, entries, extraFiles = {}, target = 'any' }) {
  const manifest = validatePluginManifestV2(read(path.join(root, 'plugin.json')));
  if (!manifest.compatibility.targets.includes(target)) throw new Error(`${manifest.id} does not declare the target ${target}.`);

  const files = new Map();
  files.set('plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  for (const relative of manifest.capabilities) {
    const capability = validateCapabilityManifestV2(read(path.join(root, relative)));
    assertMayProvide(manifest, capability.provides);
    if (capability.version !== manifest.version) throw new Error(`${capability.id} version does not match the package version.`);
    files.set(relative, Buffer.from(`${JSON.stringify(capability, null, 2)}\n`));
  }

  for (const relative of manifest.skills) {
    const skill = read(path.join(root, relative));
    if (skill.version !== manifest.version) throw new Error(`${skill.id} version does not match the package version.`);
    files.set(relative, Buffer.from(`${JSON.stringify(skill, null, 2)}\n`));
    const base = relative.slice(0, -'skill.json'.length);
    for (const extra of ['SKILL.md', ...(skill.tools ?? []).map((tool) => tool.entry)]) {
      files.set(base + extra, fs.readFileSync(path.join(root, base + extra)));
    }
  }

  for (const relative of manifest.migrations) {
    files.set(relative, fs.readFileSync(path.join(root, relative)));
  }

  for (const [published, source] of Object.entries(entries)) {
    const result = await build({
      entryPoints: [path.join(root, source)],
      bundle: true, platform: 'node', format: 'cjs', target: 'node20',
      write: false, minify: false, legalComments: 'inline',
      // The worker is loaded by the host bootstrap, which looks for a factory export.
      footer: { js: 'module.exports = module.exports?.default ?? module.exports;' },
      loader: { '.json': 'json' },
    });
    files.set(published, Buffer.from(result.outputFiles[0].contents));
  }

  for (const [published, source] of Object.entries(extraFiles)) {
    files.set(published, fs.readFileSync(path.join(root, source)));
  }

  for (const licence of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const file = path.join(root, licence);
    if (fs.existsSync(file)) files.set(licence, fs.readFileSync(file));
  }

  const zip = new AdmZip();
  // Sorted names and a fixed timestamp: the archive is a function of its contents only.
  for (const name of [...files.keys()].sort()) {
    zip.addFile(name, files.get(name), '', 0);
    const entry = zip.getEntry(name);
    entry.header.time = EPOCH;
  }
  const archive = zip.toBuffer();

  const outDir = path.join(root, '..', '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const asset = `${manifest.id}-${manifest.version}-${target}.nodus-plugin`;
  fs.writeFileSync(path.join(outDir, asset), archive);

  const digest = createHash('sha256').update(archive).digest('hex');
  console.log(`${asset}  ${archive.length} bytes  sha256:${digest}`);
  return { manifest, asset, target, bytes: archive.length, sha256: digest, files: [...files.keys()].sort() };
}
