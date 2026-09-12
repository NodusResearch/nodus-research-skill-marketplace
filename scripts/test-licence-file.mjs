// Finding the licence text a bundled component ships.
//
// This is the one thing standing between a published archive and distributing MIT code
// without the notice MIT requires, and it failed in the way that is hardest to see: the
// lookup was a list of exact filenames, so on macOS the filesystem matched `License`
// through `LICENSE` on our behalf and on Linux it did not. Same package, same version, two
// builds — one carrying the permission text and one carrying only "Licence: MIT".
//
// So the fixtures here are spelled deliberately, and this suite runs on all three
// platforms in validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLicenceFile } from './lib/licence-file.mjs';

/** A package directory holding exactly these files. */
function packageDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licence-'));
  for (const [name, contents] of Object.entries(files)) {
    if (contents === null) fs.mkdirSync(path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const nameOf = dir => {
  const found = findLicenceFile(dir);
  return found && path.basename(found);
};

test('a licence is found however its name is capitalised', () => {
  // `License` is the spelling that broke it: three of Chemistry Studio's own dependencies
  // use it, and it is in no list anybody writes from memory.
  for (const spelling of ['License', 'LICENSE', 'license', 'LICENCE', 'Licence', 'LicenSe',
    'LICENSE.md', 'License.md', 'license.txt', 'LICENSE.txt', 'COPYING', 'copying',
    'LICENSE-MIT', 'license-apache']) {
    const dir = packageDir({ 'package.json': '{}', [spelling]: 'the licence text' });
    assert.equal(nameOf(dir), spelling, spelling);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what is not a licence is not mistaken for one', () => {
  const dir = packageDir({
    'package.json': '{}',
    'LICENSE-CHECK.js': 'code',
    'licenses.json': 'data',
    'unlicensed.md': 'prose',
    'readme.md': 'prose',
  });
  assert.equal(nameOf(dir), undefined);
  fs.rmSync(dir, { recursive: true, force: true });

  // A package with nothing at all: the caller decides what to do, but it must be told.
  const empty = packageDir({ 'package.json': '{}' });
  assert.equal(nameOf(empty), undefined);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('a directory called LICENSE is not a licence', () => {
  // `fs.existsSync` said yes to this, and reading it throws EISDIR — a build failing on a
  // dependency that ships its licences in a folder.
  const dir = packageDir({ 'package.json': '{}', LICENSE: null, 'LICENSE.md': 'the real text' });
  assert.equal(nameOf(dir), 'LICENSE.md');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two spellings in one directory resolve the same way every time', () => {
  // Rare, but it decides the bytes of a published archive, so it cannot depend on the order
  // a filesystem happens to return entries in.
  const files = { 'package.json': '{}', LICENSE: 'apache text', 'LICENSE-MIT': 'mit text' };
  const first = packageDir(files);
  const second = packageDir(files);
  assert.equal(nameOf(first), nameOf(second));
  assert.equal(nameOf(first), 'LICENSE');
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test('the dependencies that exposed this still carry their permission text', () => {
  // The three from Chemistry Studio, read from this repository's own node_modules. Their
  // licence file is named `License`, and on Linux the published 2.0.0 shipped them without
  // the text MIT requires.
  const root = path.resolve(import.meta.dirname, '..');
  for (const name of ['combined-stream', 'delayed-stream', 'form-data']) {
    const dir = path.join(root, 'node_modules', name);
    if (!fs.existsSync(dir)) continue;
    const licence = findLicenceFile(dir);
    assert.ok(licence, `${name} ships a licence file that the lookup must find`);
    assert.match(fs.readFileSync(licence, 'utf8'), /Permission is hereby granted/,
      `${name}'s notice must carry the permission clause, not just the SPDX name`);
  }
});
