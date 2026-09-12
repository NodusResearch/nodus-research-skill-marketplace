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

// Constructed from local components on purpose. A zip stores its timestamps in DOS
// format, and the encoder reads them with `getHours()` and friends — local getters — so a
// UTC instant encodes to a different value on every machine that is not on UTC. The build
// pinned the instant and the archive still came out differently: CI runs on UTC, and a
// maintainer in CET rebuilding the same commit got bytes an hour apart and no way to
// verify what was published. These components encode to the same DOS value everywhere.
const EPOCH = new Date(2020, 0, 1, 0, 0, 0, 0);

/** Every package a vendored dependency needs, transitively, read from the flat install.
 *  Optional dependencies that are not present are skipped rather than failing the build:
 *  a package that resolved without them here will resolve without them there. */
function closure(names, modules) {
  const seen = new Set();
  const pending = [...names];
  while (pending.length) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    const manifest = path.join(modules, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    seen.add(name);
    const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    pending.push(...Object.keys(meta.dependencies ?? {}));
  }
  return [...seen].sort();
}

/** Files only, sorted, so a vendored tree contributes the same bytes on every machine. */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Prebuilt native binaries inside a vendored dependency, which never travel.
 *
 *  `tar-fs` carries `bare-fs`, `bare-path` and `bare-url`, and each ships a prebuildify
 *  tree with one binary per platform — Android, iOS, macOS, Linux and Windows, thirty-nine
 *  files and five megabytes in Chemistry Studio 2.2.0. Node resolves none of them: those
 *  modules are reached only under the `bare` runtime condition, and a capability worker
 *  runs on Node.
 *
 *  They were worse than dead weight. Apple's notary service opens archives it finds inside
 *  a submitted application and requires every Mach-O in them to carry a Developer ID
 *  signature, which nothing here can give them — the archive is pinned by digest against a
 *  manifest signed for it. The fifteen macOS and iOS `.bare` files rejected both Nodus
 *  5.4.0 macOS builds, over code that never runs. */
const isNativePrebuild = (relative) => relative.split('/').includes('prebuilds');

// Mach-O thin and universal binaries, in both byte orders. 0xCAFEBABE is also a Java class
// file, which is not native code and which the notary has no opinion about.
const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function buildPlugin({ root, entries, extraFiles = {}, extraDirs = {}, vendorPackages = [], external = [], define = {}, target = 'any' }) {
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
      // Dependencies that carry WebAssembly or their own asset trees cannot be flattened
      // into a bundle; they travel in the archive and are required from there.
      external,
      ...(Object.keys(define).length ? {} : {}),
      write: false, minify: false, legalComments: 'inline',
      // A package is authored as ESM so its own tests can import it, and published as CJS
      // because that is what the host bootstrap loads. Left alone, esbuild turns
      // `import.meta.url` into an empty object in the CJS output, so a worker that used
      // the ESM idiom to find a file it ships would fail at load with no useful message.
      define: { 'import.meta.url': '__nodusModuleUrl', ...define },
      banner: { js: 'const __nodusModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
      // The worker is loaded by the host bootstrap, which looks for a factory export.
      footer: { js: 'module.exports = module.exports?.default ?? module.exports;' },
      loader: { '.json': 'json' },
    });
    files.set(published, Buffer.from(result.outputFiles[0].contents));
  }

  for (const [published, source] of Object.entries(extraFiles)) {
    files.set(published, fs.readFileSync(path.isAbsolute(source) ? source : path.join(root, source)));
  }

  // A vendored dependency needs its own dependencies too, or it resolves nothing on a
  // machine with no node_modules — which is every machine a package is installed on.
  for (const name of closure(vendorPackages, path.resolve(root, '..', '..', 'node_modules'))) {
    const base = path.join(path.resolve(root, '..', '..', 'node_modules'), name);
    for (const entry of walk(base)) {
      const relative = path.relative(base, entry).split(path.sep).join('/');
      if (isNativePrebuild(relative)) continue;
      files.set(path.posix.join('vendor/node_modules', name, relative), fs.readFileSync(entry));
    }
  }

  // A vendored dependency is copied whole, because its own loader resolves siblings at
  // runtime: RDKit finds its .wasm beside its .js, and node-tikzjax its TeX assets.
  for (const [published, source] of Object.entries(extraDirs)) {
    const base = path.isAbsolute(source) ? source : path.join(root, source);
    if (!fs.existsSync(base)) throw new Error(`Missing vendored directory: ${source}`);
    for (const entry of walk(base)) {
      files.set(path.posix.join(published, path.relative(base, entry).split(path.sep).join('/')), fs.readFileSync(entry));
    }
  }

  for (const licence of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const file = path.join(root, licence);
    if (fs.existsSync(file)) files.set(licence, fs.readFileSync(file));
  }

  // Nothing published from here carries unsigned native code. `isNativePrebuild` drops the
  // trees this has come up in; this refuses the archive outright for any other one, rather
  // than letting a dependency nobody read by hand break the notarization of every
  // application that bundles the package.
  for (const [name, bytes] of files) {
    if (name.toLowerCase().endsWith('.class') || bytes.length < 4) continue;
    if (MACH_O_MAGIC.has(bytes.readUInt32BE(0))) throw new Error(`${name} is a Mach-O binary. A package carrying unsigned native code cannot be bundled into a notarized macOS application.`);
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
