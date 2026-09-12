import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validatePluginPackage, validateSkillPackage } from './contract.mjs';
import { isOfficialSkillCategory } from './categories.mjs';
const mentions = (instructions, id) => new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(instructions);
const root = fileURLToPath(new URL('../', import.meta.url));
const entries = [];
const plugins = [];
let standaloneSkills = 0;

// Only regular files inside the package directory are publishable content: no symlinks,
// no executables, nothing reached through a traversal.
function reader(directory) {
  return (file, encoding = 'utf8') => {
    const full = path.join(directory, file);
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) throw new Error(`Not a regular package file: ${full}`);
    if ((stat.mode & 0o111) !== 0) throw new Error(`Package files must not be executable: ${full}`);
    if (!fs.realpathSync(full).startsWith(fs.realpathSync(directory) + path.sep)) throw new Error(`Not a regular package file: ${full}`);
    return fs.readFileSync(full, encoding);
  };
}

// Every file a package ships must be declared, apart from a top-level README.md, which is
// repository documentation and is never installed. An undeclared file means the manifest
// and the published content disagree, which is a review failure rather than a warning.
function declaredOnly(directory, declared) {
  const present = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'));
  const extra = present.filter(file => file !== 'README.md' && !declared.includes(file));
  if (extra.length) throw new Error(`Undeclared files in ${path.basename(directory)}: ${extra.join(', ')}`);
}

// Every other top-level directory is a published v1 package and is validated as one, so a
// directory that is not a package has to be named here. `plugins/` holds capability API v2
// packages, whose plugin.json has a different shape and which scripts/validate-plugins.mjs
// and scripts/build-catalog-v2.mjs validate and publish instead; `build/` and
// `node_modules/` are untracked local output.
const NOT_A_PACKAGE = ['assets', 'scripts', 'templates', 'plugins', 'build', 'node_modules'];

for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory() || dir.name.startsWith('.') || NOT_A_PACKAGE.includes(dir.name)) continue;
  const directory = path.join(root, dir.name);
  const read = reader(directory);

  if (fs.existsSync(path.join(directory, 'plugin.json'))) {
    const manifest = JSON.parse(read('plugin.json'));
    if (manifest.id !== dir.name) throw new Error(`Directory must match plugin id: ${dir.name}`);
    const files = { 'plugin.json': read('plugin.json') };
    for (const file of manifest.skills ?? []) {
      const skill = JSON.parse(read(file));
      const base = path.posix.dirname(file);
      files[file] = read(file);
      files[`${base}/${skill.instructions}`] = read(`${base}/${skill.instructions}`);
      for (const tool of skill.tools ?? []) files[`${base}/${tool.entry}`] = read(`${base}/${tool.entry}`);
    }
    for (const file of manifest.capabilities ?? []) {
      const capability = JSON.parse(read(file));
      const base = path.posix.dirname(file);
      files[file] = read(file);
      files[`${base}/${capability.entry}`] = read(`${base}/${capability.entry}`);
      for (const asset of capability.assets ?? []) {
        const text = read(`${base}/${asset.path}`, asset.mimeType === 'model/gltf-binary' ? 'base64' : 'utf8');
        const bytes=Buffer.from(text,asset.mimeType==='model/gltf-binary'?'base64':'utf8');
        if(bytes.length!==asset.bytes || createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('Plugin asset SHA-256 mismatch: '+asset.path);
        files[`${base}/${asset.path}`] = text;
      }
    }
    declaredOnly(directory, Object.keys(files));
    const validated = validatePluginPackage({ manifest, files });
    // A published package cannot advertise a tool its instructions never reach. The id must
    // appear as a whole word, so a longer word that merely contains it does not count.
    for (const { package: skill } of validated.skills) {
      if (!isOfficialSkillCategory(skill.manifest.category)) throw new Error(`${dir.name}: category is not in the official catalog vocabulary.`);
      const instructions = skill.files[skill.manifest.instructions];
      for (const tool of skill.manifest.tools ?? []) {
        if (!mentions(instructions, tool.id)) throw new Error(`${dir.name}: SKILL.md never mentions the tool ${tool.id}.`);
      }
      for (const reference of skill.manifest.capabilities ?? []) {
        if (!reference.startsWith('self:')) continue;
        const capability = validated.capabilities.find(item => item.manifest.id === reference.slice(5));
        if (!capability) throw new Error(`${dir.name}: ${reference} is not a capability of this plugin.`);
        for (const tool of capability.manifest.tools) {
          if (!mentions(instructions, tool.id)) throw new Error(`${dir.name}: SKILL.md never mentions the capability tool ${tool.id}.`);
        }
      }
      // Categorize each bundled skill by its own discipline. For single-skill plugins,
      // preserve the existing package name and description, including compatibility notices.
      entries.push({
        ...skill.manifest,
        id: dir.name,
        name: validated.skills.length === 1 ? validated.manifest.name : skill.manifest.name,
        description: validated.skills.length === 1 ? validated.manifest.description : `${skill.manifest.description} ${validated.manifest.description}`,
      });
    }
    plugins.push(validated.manifest);
    continue;
  }

  const manifest = validateManifest(JSON.parse(read('skill.json')));
  if (manifest.id !== dir.name) throw new Error(`Directory must match id: ${dir.name}`);
  if (!isOfficialSkillCategory(manifest.category)) throw new Error(`${dir.name}: category is not in the official catalog vocabulary.`);
  const files = Object.fromEntries(['SKILL.md', ...manifest.tools.map(t => t.entry)].map(file => [file, read(file)]));
  declaredOnly(directory, ['skill.json', ...Object.keys(files)]);
  validateSkillPackage({ manifest, files });
  for (const tool of manifest.tools) {
    if (!mentions(files['SKILL.md'], tool.id)) throw new Error(`${dir.name}: SKILL.md never mentions the tool ${tool.id}.`);
  }
  entries.push(manifest);
  standaloneSkills++;
}

const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\r\n]/g, ' ');
// Fixed column widths keep every category table identically proportioned; GitHub sizes markdown tables from their own content.
const columns = [['App / skill', 190], ['Contributor', 125], ['Description', 505], ['Capabilities', 180]];
const head = `<thead><tr>${columns.map(([label, width]) => `<th width="${width}">${label}</th>`).join('')}</tr></thead>`;
const table = rows => `<table>\n${head}\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`;
const capabilities = entry => entry.capabilities.length
  ? `✅ ${entry.capabilities.map(id => `<code>${escape(id)}</code>`).join(', ')}`
  : '❌';
const row = entry => `<tr><td><a href="${entry.id}/">${escape(entry.name)}</a></td><td><a href="https://github.com/${entry.author}">@${escape(entry.author)}</a></td><td>${escape(entry.description)}</td><td>${capabilities(entry)}</td></tr>`;
const categories = [...new Set(entries.map(e => e.category))].sort();
const sections = categories.map(category => `### ${escape(category)}\n\n` + table(entries.filter(e => e.category === category).sort((a, b) => a.name.localeCompare(b.name)).map(row)));
const catalog = 'Skills are grouped by subject, including those bundled in plugins. Capabilities: ✅ lists the declared capabilities; ❌ means none are declared. <code>self:</code> identifies a capability included in the same plugin.\n\n' + sections.join('\n\n');
const anchor = category => category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const index = `## Browse the catalog\n\n${entries.length} skills across ${categories.length} categories.\n\n`
  + categories.map(category => {
    const count = entries.filter(entry => entry.category === category).length;
    return `- [${escape(category)} (${count})](#${anchor(category)})`;
  }).join('\n');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
if (!/<!-- catalog-index:start -->[\s\S]*?<!-- catalog-index:end -->/.test(readme)) throw new Error('README category index markers are missing.');
if (!/<!-- catalog:start -->[\s\S]*?<!-- catalog:end -->/.test(readme)) throw new Error('README catalog markers are missing.');
const updated = readme
  .replace(/<!-- catalog-index:start -->[\s\S]*?<!-- catalog-index:end -->/, `<!-- catalog-index:start -->\n\n${index}\n\n<!-- catalog-index:end -->`)
  .replace(/<!-- catalog:start -->[\s\S]*?<!-- catalog:end -->/, `<!-- catalog:start -->\n\n${catalog}\n\n<!-- catalog:end -->`);
if (process.argv.includes('--check')) {
  if (updated !== readme) throw new Error('README catalog is stale. Run node scripts/catalog.mjs.');
} else fs.writeFileSync(path.join(root, 'README.md'), updated);
console.log(`Validated ${standaloneSkills} skill packages and ${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'}; cataloged ${entries.length} skills in ${categories.length} categories.`);
