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
const sections = [];
for (const name of declared.dependencies) {
  const dir = path.join(root, 'node_modules', name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenceFile = ['LICENSE', 'LICENSE.md', 'LICENCE', 'license'].map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
  if (!licenceFile) throw new Error(`${name} ships no licence file; it cannot be bundled.`);
  sections.push(`## ${meta.name} ${meta.version}\n\nLicence: ${meta.license ?? 'see below'}\n\n\`\`\`\n${fs.readFileSync(licenceFile, 'utf8').trim()}\n\`\`\``);
}

const output = `# Third-party notices — ${id}\n\nThis package bundles the following components. Their licences apply to the copies inside\nthe published archive.\n\n${sections.join('\n\n')}\n`;
fs.writeFileSync(path.join(root, 'plugins', id, 'THIRD_PARTY_NOTICES.md'), output);
console.log(`Wrote notices for ${declared.dependencies.length} bundled component(s).`);
