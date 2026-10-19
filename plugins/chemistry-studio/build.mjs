// Builds Chemistry Studio.
//
// RDKit and node-tikzjax travel whole inside the archive: both load assets their own
// loaders resolve beside themselves, so neither can be flattened into a bundle, and a
// package has no node_modules to fall back on — which is the point. It cannot pick up a
// different copy from the machine it lands on.
//
// The Python runtime's dependency locks travel too, under a `<platform>-<arch>` subdirectory
// because the archive is target-independent (`compatibility.targets: ["any"]`) while a wheel is
// built for one platform and one interpreter. The host picks the lock matching the machine it
// runs on; a platform with no lock is told so plainly instead of resolving something unseen.
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

// route_program.py is imported by reactions_worker.py from its own directory, and
// route_transforms.json is read beside it, so both have to travel in the archive or the
// route-program op fails on an installed package while passing every test here.
//
// decompose.py is the same trap and was missed: it is imported the same way, its own tests pass
// here, and it was simply absent from the package. Measured 2026-10-12, the first run in which
// the decomposition was ever reached: "decomposition unavailable: The decomposition failed
// (exit 1: ModuleNotFoundError: No module named 'decompose')", eight times in one suite. Anything
// under python/ that the worker imports belongs in this list; test/test-plugin-python-files.mjs
// now checks the list against the directory so the next one cannot be forgotten.
const extraFiles = {
  'python/reactions_worker.py': 'python/reactions_worker.py',
  'python/compat_tables.py': 'python/compat_tables.py',
  'python/route_program.py': 'python/route_program.py',
  'python/route_transforms.json': 'python/route_transforms.json',
  'python/decompose.py': 'python/decompose.py',
  'python/peptide_aggregation.py': 'python/peptide_aggregation.py',
  'python/protection_table.py': 'python/protection_table.py',
  'python/peptide_sequence.py': 'python/peptide_sequence.py',
};
const lockRoot = path.join(root, 'runtimes');
if (fs.existsSync(lockRoot)) {
  for (const target of fs.readdirSync(lockRoot).sort()) {
    const dir = path.join(lockRoot, target);
    if (!fs.statSync(dir).isDirectory()) continue;
    const locks = fs.readdirSync(dir).filter(name => /^lock-\d+\.\d+\.json$/.test(name)).sort();
    for (const name of locks) {
      extraFiles[`capabilities/chemistry/runtimes/chemistry/${target}/${name}`] = `runtimes/${target}/${name}`;
    }
    if (locks.length) console.log(`${target}: ${locks.length} interpreter lock(s) — ${locks.map(name => name.slice(5, -5)).join(', ')}`);
  }
}

export default [await buildPlugin({
  root,
  entries: {
    'capabilities/chemistry/worker.js': 'src/worker.ts',
    'capabilities/chemistry/validator.js': 'src/validator.ts',
  },
  extraFiles,
  external: ['@rdkit/rdkit', 'node-tikzjax'],
  define: { 'globalThis.__CHEMISTRY_INSTRUCTIONS__': JSON.stringify(instructions) },
  // Vendored with their own transitive dependencies, under vendor/node_modules so Node's
  // own resolution finds them from the package's vendor root.
  vendorPackages: ['@rdkit/rdkit', 'node-tikzjax'],
  // No target: nothing in this package varies by platform. RDKit is WebAssembly and the
  // rest is JavaScript and data, which is why the four archives 2.0.0 published held
  // byte-identical code. `buildPlugin` defaults to `any`, and the manifest declares it.
})];
