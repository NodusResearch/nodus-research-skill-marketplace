// The templates are what contributors copy, so they must satisfy the same contract as a
// published package even though the catalog deliberately skips templates/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validatePluginPackage, validateSkillPackage } from './contract.mjs';
import { OFFICIAL_SKILL_CATEGORIES, isOfficialSkillCategory } from './categories.mjs';

const templates = fileURLToPath(new URL('../templates/', import.meta.url));
const read = (directory, file) => fs.readFileSync(path.join(directory, file), 'utf8');
let checked = 0;

for (const entry of fs.readdirSync(templates, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = path.join(templates, entry.name);

  if (fs.existsSync(path.join(directory, 'plugin.json'))) {
    const manifest = JSON.parse(read(directory, 'plugin.json'));
    const files = { 'plugin.json': read(directory, 'plugin.json') };
    for (const file of manifest.skills) {
      const skill = JSON.parse(read(directory, file));
      const base = path.posix.dirname(file);
      files[file] = read(directory, file);
      files[`${base}/${skill.instructions}`] = read(directory, `${base}/${skill.instructions}`);
      for (const tool of skill.tools ?? []) files[`${base}/${tool.entry}`] = read(directory, `${base}/${tool.entry}`);
    }
    for (const file of manifest.capabilities) {
      const capability = JSON.parse(read(directory, file));
      const base = path.posix.dirname(file);
      files[file] = read(directory, file);
      files[`${base}/${capability.entry}`] = read(directory, `${base}/${capability.entry}`);
    }
    const validated = validatePluginPackage({ manifest, files });
    for (const { package: skill } of validated.skills) {
      if (!isOfficialSkillCategory(skill.manifest.category)) throw new Error(`${entry.name}: category is not in the official catalog vocabulary.`);
    }
    checked++;
    continue;
  }

  const manifest = validateManifest(JSON.parse(read(directory, 'skill.json')));
  if (!isOfficialSkillCategory(manifest.category)) throw new Error(`${entry.name}: category is not in the official catalog vocabulary.`);
  validateSkillPackage({ manifest, files: Object.fromEntries(['SKILL.md', ...manifest.tools.map(tool => tool.entry)].map(file => [file, read(directory, file)])) });
  checked++;
}

if (!checked) throw new Error('No templates were validated.');
const contributing = fs.readFileSync(fileURLToPath(new URL('../CONTRIBUTING.md', import.meta.url)), 'utf8');
for (const category of OFFICIAL_SKILL_CATEGORIES) {
  if (!contributing.includes(`- ${category}\n`)) throw new Error(`CONTRIBUTING.md does not document the official category ${category}.`);
}
console.log(`Validated ${checked} templates.`);
