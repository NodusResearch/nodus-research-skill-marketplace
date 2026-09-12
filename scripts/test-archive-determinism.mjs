// A published archive has to be reproducible by somebody who was not there.
//
// The signature attests a digest, and a digest is only worth something if the bytes can be
// produced again from the source. The build pinned a fixed instant for every entry and the
// archives still came out differently: a zip stores timestamps in DOS format, the encoder
// reads them with local getters, and CI runs on UTC. A maintainer in any other timezone
// rebuilding the same commit got different bytes and no way to tell whether what was
// published matched the source.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

/** The timestamp the build stamps on every entry, as the build constructs it, encoded by
 *  the same library, in whatever timezone the child process is told to run in. */
function archiveIn(timezone) {
  const script = `
    import AdmZip from '${path.join(root, 'node_modules/adm-zip/adm-zip.js').replace(/\\/g, '\\\\')}';
    const EPOCH = new Date(2020, 0, 1, 0, 0, 0, 0);
    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('same bytes everywhere'));
    zip.addFile('b/c.txt', Buffer.from('and here'));
    for (const entry of zip.getEntries()) entry.header.time = EPOCH;
    process.stdout.write(zip.toBuffer().toString('base64'));
  `;
  const file = path.join(os.tmpdir(), `determinism-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, script);
  try {
    return execFileSync(process.execPath, [file], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

test('the same source produces the same archive in every timezone', () => {
  // UTC is what CI builds in; the others are where somebody checking the work might be.
  const digests = new Map(['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/Madrid', 'Australia/Eucla']
    .map(zone => [zone, createHash('sha256').update(archiveIn(zone)).digest('hex')]));

  const distinct = new Set(digests.values());
  assert.equal(distinct.size, 1,
    `the archive differs by timezone: ${[...digests].map(([zone, digest]) => `${zone}=${digest.slice(0, 12)}`).join(', ')}`);
});

test('the build pins the instant that survives being encoded', () => {
  // The fix is that the date is built from local components, so the DOS value it encodes to
  // is the same everywhere. A UTC instant is the thing that does not survive, so a change
  // back to one has to fail here rather than in a release nobody can reproduce.
  const source = fs.readFileSync(path.join(root, 'scripts/build-plugin.mjs'), 'utf8');
  const epoch = /const EPOCH = new Date\(([^)]*)\)/.exec(source);
  assert.ok(epoch, 'the build must pin a fixed timestamp for every entry');
  assert.doesNotMatch(epoch[1], /['"]/,
    'EPOCH must be built from components, not parsed from a string: a UTC instant encodes differently in every timezone');
});
