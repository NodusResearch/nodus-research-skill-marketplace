// Everything under python/ that the worker imports must travel in the package.
//
//   node --test test/test-plugin-python-files.mjs
//
// Why this exists. `decompose.py` sat in python/ with 27 passing tests of its own and was never
// listed in build.mjs, so it was absent from every package ever built. Nothing noticed, because
// the import is lazy and the call site had its own bug keeping it from ever running. The day that
// was fixed, the first suite to reach it logged, eight times:
//
//   [synthesisEvidence] decomposition unavailable: The decomposition failed
//   (exit 1: ModuleNotFoundError: No module named 'decompose')
//
// A test over the FILE LIST catches the next one before a build ships. It deliberately compares
// the manifest against the directory rather than naming the files, so adding a module and
// forgetting the manifest fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.dirname(here);
const manifest = fs.readFileSync(path.join(root, 'build.mjs'), 'utf8');

/** The python/ paths build.mjs copies into the archive. */
const packaged = new Set(
  [...manifest.matchAll(/'(python\/[^']+)':\s*'(python\/[^']+)'/g)].map((m) => m[1]),
);

/** Every file in python/ that is part of the worker, ignoring caches and tests. */
const onDisk = fs.readdirSync(path.join(root, 'python'))
  .filter((name) => /\.(py|json)$/.test(name))
  .filter((name) => !name.startsWith('test_'))
  .map((name) => `python/${name}`);

test('the python manifest is not empty and resolves to real files', () => {
  assert.ok(packaged.size >= 4, `only ${packaged.size} python file(s) parsed out of build.mjs`);
  for (const rel of packaged) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is packaged but not on disk`);
  }
});

test('every python module in the plugin is packaged', () => {
  const missing = onDisk.filter((rel) => !packaged.has(rel));
  assert.deepEqual(missing, [], `these travel with the worker but are not in build.mjs: ${missing.join(', ')}`);
});

test('decompose.py in particular', () => {
  // Named as well as swept: this is the regression, and a sweep that stopped working would go
  // quiet rather than fail.
  assert.ok(packaged.has('python/decompose.py'));
  assert.match(fs.readFileSync(path.join(root, 'python/decompose.py'), 'utf8'), /def /);
});

test('the worker imports nothing from python/ that is unpackaged', () => {
  // The import that actually failed was a plain `import decompose`, so the check is on the names
  // the worker imports rather than on paths.
  const worker = fs.readFileSync(path.join(root, 'python/reactions_worker.py'), 'utf8');
  const localModules = new Set(onDisk
    .filter((rel) => rel.endsWith('.py'))
    .map((rel) => path.basename(rel, '.py')));
  const imported = [...worker.matchAll(/^\s*(?:import|from)\s+([a-z_][a-z0-9_]*)/gm)]
    .map((m) => m[1]).filter((name) => localModules.has(name));
  for (const name of new Set(imported)) {
    assert.ok(packaged.has(`python/${name}.py`), `reactions_worker imports ${name} but it is not packaged`);
  }
});
