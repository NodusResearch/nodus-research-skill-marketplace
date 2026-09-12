import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'anatomy-visualization/capabilities/anatomy');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'capability.json')));
for(const asset of manifest.assets.filter(a=>a.mimeType.startsWith('model/'))){
  test('Khronos glTF validator: '+asset.id,async()=>{
    const report=await validator.validateBytes(new Uint8Array(fs.readFileSync(path.join(dir,asset.path))),{uri:asset.path,externalResourceFunction:async()=>{throw new Error('External resources prohibited');}});
    assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
    assert.equal(report.issues.numWarnings,0,JSON.stringify(report.issues));
  });
}

test('offline source preflight rejects missing and corrupted inputs before changing packaged output', async () => {
  const { default: os } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomy-corrupt-source-'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/anatomy/atlas-sources.lock.json')));
  const outputHash = () => createHash('sha256').update(fs.readFileSync(path.join(dir, 'assets/bodyparts3d-male.glb'))).digest('hex');
  const before = outputHash();
  try {
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/anatomy/build-atlas.mjs'), '--offline'], { env: { ...process.env, ANATOMY_SOURCE_CACHE: cache }, encoding: 'utf8' });
    const missing = run(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Missing pinned offline source/);
    fs.writeFileSync(path.join(cache, lock.sources[0].file), 'Synthetic corrupt source fixture');
    const corrupt = run(); assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /SHA-256 mismatch/);
    assert.equal(outputHash(), before);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});
