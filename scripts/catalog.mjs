import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateSkillPackage } from './contract.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const entries = [];
for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory() || dir.name.startsWith('.') || ['assets', 'scripts', 'templates'].includes(dir.name)) continue;
  const directory = path.join(root, dir.name);
  const read = file => {
    const full = path.join(directory, file);
    if (!fs.lstatSync(full).isFile() || !fs.realpathSync(full).startsWith(fs.realpathSync(directory) + path.sep)) throw new Error(`Not a regular package file: ${full}`);
    return fs.readFileSync(full, 'utf8');
  };
  const manifest = validateManifest(JSON.parse(read('skill.json')));
  if (manifest.id !== dir.name) throw new Error(`Directory must match id: ${dir.name}`);
  validateSkillPackage({ manifest, files: Object.fromEntries(['SKILL.md', ...manifest.tools.map(t => t.entry)].map(file => [file, read(file)])) });
  entries.push(manifest);
}
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\r\n]/g, ' ');
// Fixed column widths keep every category table identically proportioned; GitHub sizes markdown tables from their own content.
const columns = [['App / skill', 190], ['Contributor', 125], ['Description', 505]];
const head = `<thead><tr>${columns.map(([label, width]) => `<th width="${width}">${label}</th>`).join('')}</tr></thead>`;
const categories = [...new Set(entries.map(e => e.category))].sort();
const catalog = categories.map(category => `### ${escape(category)}\n\n<table>\n${head}\n<tbody>\n` + entries.filter(e => e.category === category).sort((a,b) => a.name.localeCompare(b.name)).map(e => `<tr><td><a href="${e.id}/">${escape(e.name)}</a></td><td><a href="https://github.com/${e.author}">@${escape(e.author)}</a></td><td>${escape(e.description)}</td></tr>`).join('\n') + `\n</tbody>\n</table>`).join('\n\n');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const updated = readme.replace(/<!-- catalog:start -->[\s\S]*?<!-- catalog:end -->/, `<!-- catalog:start -->\n\n${catalog}\n\n<!-- catalog:end -->`);
if (process.argv.includes('--check')) {
  if (updated !== readme) throw new Error('README catalog is stale. Run node scripts/catalog.mjs.');
} else fs.writeFileSync(path.join(root, 'README.md'), updated);
console.log(`Validated ${entries.length} skill packages in ${categories.length} categories.`);
