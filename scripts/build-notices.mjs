// Collects the licence notices for everything bundled into a capability package.
//
// A package ships its dependencies inside its own archive, so it carries their notices
// too: the application's THIRD_PARTY_NOTICES no longer covers code it does not contain.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Pass the package id.');

const declared = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'bundled.json'), 'utf8'));

// A package ships its dependencies' dependencies too, so the notice has to cover the
// whole closure rather than the handful of names the package happens to import.
const modules = path.join(root, 'node_modules');
const seen = new Set();
const pending = [...declared.dependencies];
while (pending.length) {
  const name = pending.shift();
  if (seen.has(name) || !fs.existsSync(path.join(modules, name, 'package.json'))) continue;
  seen.add(name);
  pending.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')).dependencies ?? {}));
}

const sections = [];
for (const name of [...seen].sort()) {
  const dir = path.join(root, 'node_modules', name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenceFile = ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md', 'license', 'license.md', 'LICENSE.txt', 'LICENSE-MIT']
    .map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
  // A component with no licence text of its own still has to declare one; shipping bytes
  // nobody can account for is the thing this file exists to prevent.
  if (!licenceFile && !meta.license) throw new Error(`${name} declares no licence and ships no licence file; it cannot be bundled.`);
  sections.push(`## ${meta.name} ${meta.version}\n\nLicence: ${meta.license ?? 'see below'}\n${licenceFile ? `\n\`\`\`\n${fs.readFileSync(licenceFile, 'utf8').trim()}\n\`\`\`` : ''}`);
}

// One line ending, whatever the licences happened to use. This file is packed into the
// archive and the archive is pinned by digest, so text that varies with whoever wrote a
// licence would vary the package for no reason anyone could see.
const output = `# Third-party notices — ${id}\n\nThis package bundles the following components. Their licences apply to the copies inside\nthe published archive.\n\n${sections.join('\n\n')}\n`.replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(root, 'plugins', id, 'THIRD_PARTY_NOTICES.md'), output);
console.log(`Wrote notices for ${sections.length} bundled component(s).`);
