// Regenerates catalog-v2.json from the packages in plugins/.
//
// The catalog is a directory, not a distribution channel: it says where each package's
// signed release lives. Nothing in it is trusted by Nodus until that release's signature
// verifies, so a stale or wrong entry fails verification rather than installing something.
import fs from 'node:fs';
import path from 'node:path';
import { validateCapabilityCatalog, validatePluginManifestV2 } from './contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Sizes come from the build rather than from a hand-kept number: the catalog's size is
// only a download bound, but a figure nobody maintains drifts and then misleads.
const buildIndex = fs.existsSync(path.join(root, 'build/index.json'))
  ? read(path.join(root, 'build/index.json'))
  : [];
const builtBytes = new Map(buildIndex.map((entry) => [`${entry.manifest.id}:${entry.target}`, entry.bytes]));

const plugins = [];
for (const id of fs.readdirSync(path.join(root, 'plugins')).sort()) {
  const dir = path.join(root, 'plugins', id);
  if (!fs.statSync(dir).isDirectory()) continue;
  const manifest = validatePluginManifestV2(read(path.join(dir, 'plugin.json')));
  const description = read(path.join(dir, 'catalog.json'));
  plugins.push({
    id: manifest.id,
    name: manifest.name,
    description: description.description,
    version: manifest.version,
    path: `plugins/${manifest.id}`,
    replaces: manifest.replacesSkills,
    targets: manifest.compatibility.targets,
    release: {
      tag: `${manifest.id}-v${manifest.version}`,
      manifest: 'release-manifest.json',
      signature: 'release-manifest.sig',
      assets: manifest.compatibility.targets.map((target) => ({
        target,
        asset: `${manifest.id}-${manifest.version}-${target}.nodus-plugin`,
        bytes: builtBytes.get(`${manifest.id}:${target}`) ?? description.assetBytes?.[target] ?? 1,
      })),
    },
  });
}

const existing = fs.existsSync(path.join(root, 'catalog-v2.json')) ? read(path.join(root, 'catalog-v2.json')) : null;
const catalog = validateCapabilityCatalog({
  schemaVersion: 2,
  // Regenerating must not churn the file when nothing changed, so the timestamp only
  // moves when the packages do.
  updatedAt: existing && JSON.stringify(existing.plugins) === JSON.stringify(plugins) ? existing.updatedAt : new Date().toISOString(),
  plugins,
});

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
if (check) {
  const current = fs.existsSync(path.join(root, 'catalog-v2.json')) ? fs.readFileSync(path.join(root, 'catalog-v2.json'), 'utf8') : '';
  if (current !== serialized) {
    console.error('catalog-v2.json is out of date. Run: node scripts/build-catalog-v2.mjs');
    process.exit(1);
  }
  console.log('catalog-v2.json is up to date.');
} else {
  fs.writeFileSync(path.join(root, 'catalog-v2.json'), serialized);
  console.log(`catalog-v2.json written with ${catalog.plugins.length} package(s).`);
}
