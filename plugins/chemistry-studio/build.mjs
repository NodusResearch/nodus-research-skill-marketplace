// Builds Chemistry Studio for one platform target.
//
// RDKit and node-tikzjax travel whole inside the archive: both load assets their own
// loaders resolve beside themselves, so neither can be flattened into a bundle, and a
// package has no node_modules to fall back on — which is the point. It cannot pick up a
// different copy from the machine it lands on.
import fs from 'node:fs';
import path from 'node:path';
import { buildPlugin } from '../../scripts/build-plugin.mjs';

const root = new URL('.', import.meta.url).pathname;
const target = process.env.NODUS_PLUGIN_TARGET ?? `${process.platform}-${process.arch}`;

// The repair prompts have to quote the rules the model was actually given, so the skill's
// own instructions are compiled in rather than duplicated by hand.
const instructions = fs.readFileSync(path.join(root, 'skills/chemistry-studio/SKILL.md'), 'utf8').trim();

export default [await buildPlugin({
  root,
  entries: {
    'capabilities/chemistry/worker.js': 'src/worker.ts',
    'capabilities/chemistry/validator.js': 'src/validator.ts',
  },
  external: ['@rdkit/rdkit', 'node-tikzjax'],
  define: { 'globalThis.__CHEMISTRY_INSTRUCTIONS__': JSON.stringify(instructions) },
  // Vendored with their own transitive dependencies, under vendor/node_modules so Node's
  // own resolution finds them from the package's vendor root.
  vendorPackages: ['@rdkit/rdkit', 'node-tikzjax'],
  target,
})];
