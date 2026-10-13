// A package whose build does not produce a declared capability worker must not be built.
//
// validate-plugins.mjs only checks that a src/ directory exists, and the build used to bundle
// whatever its `entries` named, so a build.mjs that missed a capability, or published its
// worker under another path, produced an archive that signed and installed and then could not
// load the capability.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlugin } from './build-plugin.mjs';

const source = path.resolve(import.meta.dirname, '..', 'plugins', 'math-studio');

function scratchPackage(t) {
  // buildPlugin writes to <root>/../../build, so the package sits two levels down.
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'build-plugin-workers-'));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const root = path.join(top, 'plugins', 'math-studio');
  for (const relative of ['plugin.json', 'capabilities/mathematics/capability.json', 'skills/math-studio/skill.json', 'skills/math-studio/SKILL.md']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(source, relative), path.join(root, relative));
  }
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'worker.js'), 'export default () => ({ async health() { return { status: "ready", dataVersion: 0 }; } });\n');
  return { top, root };
}

test('a build that does not produce a declared worker fails', async (t) => {
  const { root } = scratchPackage(t);
  await assert.rejects(buildPlugin({ root, entries: {} }), /capabilities\/mathematics\/worker\.js/);
  await assert.rejects(buildPlugin({ root, entries: { 'capabilities/mathematics/main.js': 'src/worker.js' } }), /does not produce/);
});

test('a build that produces every declared worker succeeds', async (t) => {
  const { top, root } = scratchPackage(t);
  const built = await buildPlugin({ root, entries: { 'capabilities/mathematics/worker.js': 'src/worker.js' } });
  assert.ok(built.files.includes('capabilities/mathematics/worker.js'));
  assert.ok(fs.existsSync(path.join(top, 'build', built.asset)));
});
