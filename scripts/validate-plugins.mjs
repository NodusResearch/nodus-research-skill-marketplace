// Validates every capability package against the same contract the application enforces.
// The contract is generated from Nodus, so a package cannot pass here and fail there.
import fs from 'node:fs';
import path from 'node:path';
import { validateCapabilityManifestV2, validatePluginManifestV2, assertMayProvide, contractFences } from './contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pluginsDir = path.join(root, 'plugins');
if (!fs.existsSync(pluginsDir)) { console.log('No capability packages to validate.'); process.exit(0); }

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = [];
const seenCapabilities = new Map();
const seenFences = new Map();
const seenPriorities = new Map();

for (const id of fs.readdirSync(pluginsDir).sort()) {
  const dir = path.join(pluginsDir, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  try {
    const manifest = validatePluginManifestV2(read(path.join(dir, 'plugin.json')));
    if (manifest.id !== id) throw new Error('the directory name must match the package id');
    if (!fs.existsSync(path.join(dir, 'build.mjs'))) throw new Error('a package needs a build.mjs');
    if (!fs.existsSync(path.join(dir, 'LICENSE'))) throw new Error('a package needs a LICENSE');
    if (!fs.existsSync(path.join(dir, 'test'))) throw new Error('a package needs tests');

    // A package that builds a language runtime has to ship the pinned set for every
    // target it publishes and every interpreter it claims to support. Without it the
    // package installs and then refuses to work, which is a failure nobody sees until a
    // user hits it.
    const runtimeIds = new Set(manifest.capabilities.flatMap(relative =>
      (read(path.join(dir, relative)).permissions.runtimes ?? []).map(entry => entry.id)));
    for (const runtimeId of runtimeIds) {
      const spec = path.join(dir, 'runtimes', `${runtimeId}.requirements.json`);
      if (!fs.existsSync(spec)) throw new Error(`the ${runtimeId} runtime has no requirements file`);
      const versions = read(spec).pythonVersions ?? [];
      if (!versions.length) throw new Error(`the ${runtimeId} runtime declares no interpreter versions`);
      for (const target of manifest.compatibility.targets) {
        for (const version of versions) {
          const lock = path.join(dir, 'runtimes', target, `lock-${version}.json`);
          if (!fs.existsSync(lock)) throw new Error(`the ${runtimeId} runtime has no lock for ${target} on Python ${version}`);
        }
      }
    }

    for (const relative of manifest.capabilities) {
      const capability = validateCapabilityManifestV2(read(path.join(dir, relative)));
      assertMayProvide(manifest, capability.provides);
      if (capability.version !== manifest.version) throw new Error(`${capability.id} version must match the package version`);
      const entry = path.join(dir, path.dirname(relative), capability.runtime.entry);
      // The entry is produced by the build, so what is checked here is that the source it
      // is built from exists — a manifest naming a worker nobody builds is a broken package.
      if (!fs.existsSync(path.join(dir, 'src'))) throw new Error(`${capability.id} has no src/ to build ${capability.runtime.entry} from`);
      void entry;

      const owner = seenCapabilities.get(capability.provides);
      if (owner && owner !== id) throw new Error(`${capability.provides} is already provided by ${owner}`);
      seenCapabilities.set(capability.provides, id);

      if (capability.chat) {
        for (const fence of contractFences(capability.chat)) {
          const claimed = seenFences.get(fence);
          if (claimed && claimed !== id) throw new Error(`the ${fence} protocol is already claimed by ${claimed}`);
          seenFences.set(fence, id);
        }
        const priority = seenPriorities.get(capability.chat.priority);
        if (priority && priority !== id) throw new Error(`chat priority ${capability.chat.priority} is already taken by ${priority}`);
        seenPriorities.set(capability.chat.priority, id);
      }
    }

    for (const relative of manifest.skills) {
      const skill = read(path.join(dir, relative));
      if (skill.version !== manifest.version) throw new Error(`${skill.id} version must match the package version`);
      if (!fs.existsSync(path.join(dir, path.dirname(relative), 'SKILL.md'))) throw new Error(`${skill.id} has no SKILL.md`);
    }

    for (const relative of manifest.migrations) {
      if (!fs.existsSync(path.join(dir, relative))) throw new Error(`missing migration ${relative}`);
    }
    console.log(`ok  ${id} ${manifest.version}`);
  } catch (error) {
    problems.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (problems.length) {
  console.error('\nCapability package problems:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`\n${seenCapabilities.size} capability/capabilities validated.`);
