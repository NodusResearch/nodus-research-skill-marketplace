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

// One lock per interpreter version this package supports on this target. A wheel is
// built for a specific Python, so there is no single pinned set that fits every
// interpreter; the host picks the lock matching the one the user has.
const lockDir = path.join(root, 'runtimes', target);
const locks = fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter(name => /^lock-\d+\.\d+\.json$/.test(name)).sort() : [];
// Publishing this package without its locks would ship something that can never build its
// runtime, and would only say so at the first person who tried. It is a build failure.
if (!locks.length) throw new Error(`No dependency lock for ${target}. Run: node scripts/build-runtime-lock.mjs alphagenome`);

const extraFiles = { 'python/alphagenome_worker.py': 'python/alphagenome_worker.py' };
for (const name of locks) extraFiles[`capabilities/genomics/runtimes/alphagenome/${name}`] = `runtimes/${target}/${name}`;
console.log(`${target}: ${locks.length} interpreter lock(s) — ${locks.map(name => name.slice(5, -5)).join(', ')}`);

export default [await buildPlugin({ root, entries: { 'capabilities/genomics/worker.js': 'src/worker.js' }, extraFiles, target })];
