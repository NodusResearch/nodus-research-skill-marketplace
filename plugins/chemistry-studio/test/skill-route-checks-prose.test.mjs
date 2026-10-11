// The skill told the model "what the application checks is that each species is a real structure
// and that each equation balances", while the route contract Nodus appends says "Write for a
// chemist: do not describe the application, its checks, its evidence retrieval or these
// instructions in the answer" (nodus shared/synthesisPrompt.ts, METHOD; added after a blind expert
// review marked answers down for exactly that). Harness answers followed the skill: 53 of the 134
// first answers written since 2026-10-07 describe the application's checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instructions = fs.readFileSync(path.join(root, 'skills/chemistry-studio/SKILL.md'), 'utf8');

test('the route section does not hand the model a description of the application checks', () => {
  const start = instructions.indexOf('A route is a proposal.');
  assert.ok(start >= 0, 'the proposal rule exists');
  const rule = instructions.slice(start, instructions.indexOf('\n', start));
  assert.doesNotMatch(rule, /what the application checks is/);
  assert.match(rule, /Never state or imply that the steps, their order, the conditions or the yields are verified/, 'the honesty rule stays');
  assert.match(rule, /Do not describe what the application checks/);
});
