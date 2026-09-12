// Finding a bundled component's licence text on disk.
//
// Its own module because it was a list of exact filenames, and a list of exact filenames is
// answered by the filesystem's opinion about case rather than by what is there: macOS
// matched `License` through `LICENSE` and Linux did not, so one build shipped the MIT text
// and the other shipped only the SPDX string for the same three libraries.
import fs from 'node:fs';
import path from 'node:path';

/** The spellings a licence file is actually given, matched without asking the filesystem
 *  to be case-insensitive on our behalf. */
const LICENCE = /^(licen[cs]e|copying)(-\w+)?(\.(md|txt))?$/i;

/** The licence file in `dir`, or undefined. Deterministic: the directory is read, filtered
 *  and sorted, so two machines with the same files choose the same one. */
export function findLicenceFile(dir) {
  return fs.readdirSync(dir)
    .filter((file) => LICENCE.test(file))
    .sort()
    .map((file) => path.join(dir, file))
    .find((file) => fs.statSync(file).isFile());
}
