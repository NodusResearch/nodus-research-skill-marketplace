// Builds Chemistry Studio for one platform target.
//
// RDKit and node-tikzjax travel whole inside the archive: both load assets their own
// loaders resolve beside themselves, so neither can be flattened into a bundle, and a
// package has no node_modules to fall back on — which is the point. It cannot pick up a
// different copy from the machine it lands on.
import fs from 'node:fs';
import path from 'node:path';
import { buildPlugin } from '../../scripts/build-plugin.mjs';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, not `.pathname`: on Windows a file URL's pathname is `/C:/…`,
// whose leading slash makes every path built from it point at a directory that is not
// there — and the failure reads as a missing file rather than as a bad path.
const root = fileURLToPath(new URL('.', import.meta.url));

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
  // No target: nothing in this package varies by platform. RDKit is WebAssembly and the
  // rest is JavaScript and data, which is why the four archives 2.0.0 published held
  // byte-identical code. `buildPlugin` defaults to `any`, and the manifest declares it.
})];
