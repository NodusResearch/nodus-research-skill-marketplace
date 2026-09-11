// Builds the AlphaGenome package for one platform target.
//
// The Python adapter and the dependency lock travel inside the archive: the runtime is
// built on the user's machine from wheels this package pinned, never resolved from an
// index at install time.
import fs from 'node:fs';
import path from 'node:path';
import { buildPlugin } from '../../scripts/build-plugin.mjs';

const root = new URL('.', import.meta.url).pathname;
const target = process.env.NODUS_PLUGIN_TARGET ?? `${process.platform}-${process.arch}`;

const lock = path.join(root, 'runtimes', target, 'lock.json');
const extraFiles = { 'python/alphagenome_worker.py': 'python/alphagenome_worker.py' };
if (fs.existsSync(lock)) {
  extraFiles['capabilities/genomics/runtimes/alphagenome/lock.json'] = `runtimes/${target}/lock.json`;
} else {
  // A package without its lock still installs and still refuses to build a runtime,
  // which is the honest behaviour: it cannot pin what it was not given.
  console.warn(`No dependency lock for ${target}; the package will refuse to install its runtime.`);
}

export default [await buildPlugin({ root, entries: { 'capabilities/genomics/worker.js': 'src/worker.js' }, extraFiles, target })];
