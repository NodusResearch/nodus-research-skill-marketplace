// The skill's route section asked for "conditions and electron pushing in that step's prose",
// while the route contract Nodus appends to the same system prompt says "Do not work out reaction
// mechanisms (which proton moves, which intermediate is charged, in what order bonds form) …
// one sentence on why the step works is enough" (nodus shared/synthesisPrompt.ts, METHOD). The
// skill defers to that contract for everything else; it must not demand the mechanism the
// contract withholds, which costs reasoning the contract was written to save.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instructions = fs.readFileSync(path.join(root, 'skills/chemistry-studio/SKILL.md'), 'utf8');

test('the route section does not ask for electron pushing in each step', () => {
  const section = instructions.slice(instructions.indexOf('MULTI-STEP SYNTHESIS'), instructions.indexOf('A route is a proposal.'));
  assert.ok(section.length > 0, 'the synthesis section exists');
  assert.doesNotMatch(section, /electron pushing/i);
  assert.match(section, /as far as the appended contract asks/);
});
