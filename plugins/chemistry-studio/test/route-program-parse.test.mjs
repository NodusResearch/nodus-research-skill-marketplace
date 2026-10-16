// Contract tests for the route-program parser. The module is pure, so it is bundled alone: no
// toolkit, no vendored data, and the whole file runs in milliseconds.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'route-program-parse-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const bundle = path.join(scratch, 'routeProgram.cjs');
await build({
  entryPoints: [path.join(root, 'src/engine/routeProgram.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
});
const { parseRouteProgram } = createRequire(import.meta.url)(bundle);

const codes = (r) => r.diagnostics.map((d) => [d.code, d.line]);
const only = (r, code, line) => {
  assert.deepEqual(codes(r), [[code, line]], JSON.stringify(r.diagnostics));
  assert.ok(/^[A-Z].*\.$/.test(r.diagnostics[0].message), 'message is a sentence');
  assert.ok(!/error/i.test(r.diagnostics[0].message), 'message avoids the word error');
};

test('a well-formed program parses every field with input line numbers', () => {
  const text = [
    '# a comment',
    '',
    'M1 = start("glycine")',
    '  M2 = apply(M1, template="ord:T1234", reagents=["benzyl chloroformate"], site="the free amine")  ',
    '',
    'M3 = apply(M2, named="ester-hydrolysis", reagents=["water", smiles="[OH-]"])',
    'M4 = apply(M3, smarts="[C:1]=[O:2]>>[C:1][O:2]", reagents=["sodium borohydride"])',
    'note M4: the prose for this step goes here',
    'note M2: protect first',
    'target = M4',
  ].join('\n');
  const r = parseRouteProgram(text);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.program.target, 'M4');
  assert.deepEqual(r.program.lines, [
    { kind: 'start', line: 3, ref: 'M1', input: { name: 'glycine' } },
    { kind: 'apply', line: 4, ref: 'M2', from: 'M1', op: { kind: 'template', id: 'ord:T1234' },
      reagents: [{ name: 'benzyl chloroformate' }], site: { kind: 'phrase', phrase: 'the free amine' }, note: 'protect first' },
    { kind: 'apply', line: 6, ref: 'M3', from: 'M2', op: { kind: 'named', id: 'ester-hydrolysis' },
      reagents: [{ name: 'water' }, { smiles: '[OH-]' }] },
    { kind: 'apply', line: 7, ref: 'M4', from: 'M3', op: { kind: 'smarts', smarts: '[C:1]=[O:2]>>[C:1][O:2]' },
      reagents: [{ name: 'sodium borohydride' }], note: 'the prose for this step goes here' },
    { kind: 'target', line: 10, ref: 'M4' },
  ]);
});

test('both quote styles, smiles= and optional parts', () => {
  const r = parseRouteProgram([
    "M1 = start('glycine')",
    'M2 = start(smiles="NCC(=O)O")',
    "M3 = apply(M1, named='x')",
    'target = M3',
  ].join('\n'));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.program.lines[0].input, { name: 'glycine' });
  assert.deepEqual(r.program.lines[1].input, { smiles: 'NCC(=O)O' });
  assert.deepEqual(r.program.lines[2].reagents, []);
  assert.equal('site' in r.program.lines[2], false);
});

test('escaped delimiters are unescaped, other backslashes survive', () => {
  const r = parseRouteProgram([
    'M1 = start("say \\"hi\\"")',
    "M2 = start('it\\'s')",
    'M3 = start(smiles="F/C=C\\F")',
    'target = M1',
  ].join('\n'));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.program.lines[0].input, { name: 'say "hi"' });
  assert.deepEqual(r.program.lines[1].input, { name: "it's" });
  assert.deepEqual(r.program.lines[2].input, { smiles: 'F/C=C\\F' });
});

test('comma and bracket characters inside strings do not split arguments', () => {
  const r = parseRouteProgram('M1 = start("a, b)")\nM2 = apply(M1, smarts="[C,N]>>[C]", reagents=["x]"])\ntarget = M2');
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.program.lines[1].op, { kind: 'smarts', smarts: '[C,N]>>[C]' });
  assert.deepEqual(r.program.lines[1].reagents, [{ name: 'x]' }]);
});

test('syntax: unparsable line', () => {
  const r = parseRouteProgram('M1 = start("a")\nthis is nonsense\ntarget = M1');
  only(r, 'syntax', 2);
  assert.equal(r.program.lines.length, 2);
});

test('syntax: unterminated string', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="oops)\ntarget = M1'), 'syntax', 2);
});

test('syntax: second target keeps the first', () => {
  const r = parseRouteProgram('M1 = start("a")\ntarget = M1\n\ntarget = M1');
  only(r, 'syntax', 4);
  assert.equal(r.program.target, 'M1');
  assert.equal(r.program.lines.filter((l) => l.kind === 'target').length, 1);
});

test('syntax: duplicate note keeps the first', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")\nnote M2: first\nnote M2: second\ntarget = M2');
  only(r, 'syntax', 4);
  assert.equal(r.program.lines[1].note, 'first');
});

test('syntax: reference outside M1..M999', () => {
  only(parseRouteProgram('M1 = start("a")\nM1000 = apply(M1, named="x")\ntarget = M1'), 'syntax', 2);
});

test('duplicate-ref', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")\nM2 = apply(M1, named="y")\ntarget = M2');
  only(r, 'duplicate-ref', 3);
  assert.equal(r.program.lines.find((l) => l.ref === 'M2').op.id, 'x');
});

test('unknown-ref: apply source', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M9, named="x")\ntarget = M2'), 'unknown-ref', 2);
});

test('unknown-ref: target', () => {
  only(parseRouteProgram('M1 = start("a")\ntarget = M7'), 'unknown-ref', 2);
});

test('unknown-ref: note for a missing ref', () => {
  only(parseRouteProgram('M1 = start("a")\nnote M5: hello\ntarget = M1'), 'unknown-ref', 2);
});

test('unknown-ref: note for a start line', () => {
  only(parseRouteProgram('M1 = start("a")\nnote M1: hello\ntarget = M1'), 'unknown-ref', 2);
});

test('forward-ref: apply source', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M3, named="x")\nM3 = apply(M1, named="y")\ntarget = M3');
  only(r, 'forward-ref', 2);
});

test('forward-ref: target', () => {
  const r = parseRouteProgram('M1 = start("a")\ntarget = M2\nM2 = apply(M1, named="x")');
  only(r, 'forward-ref', 2);
});

test('self-ref', () => {
  only(parseRouteProgram('M1 = start("a")\nM3 = apply(M3, named="x")\ntarget = M1'), 'self-ref', 2);
});

test('no-start', () => {
  const r = parseRouteProgram('# nothing here\nM2 = apply(M1, named="x")\ntarget = M2');
  assert.deepEqual(codes(r).filter(([c]) => c === 'no-start'), [['no-start', 3]]);
  assert.deepEqual(parseRouteProgram('').diagnostics.map((d) => d.code).sort(), ['no-start', 'no-target']);
});

test('no-target', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")'), 'no-target', 2);
});

test('unknown-op: none given', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, reagents=["w"])\ntarget = M1'), 'unknown-op', 2);
});

test('unknown-op: two given', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", smarts="[C]>>[C]")\ntarget = M1'), 'unknown-op', 2);
});

test('bad-species: empty name', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = start("  ")\ntarget = M1'), 'bad-species', 2);
});

test('bad-species: empty smiles in a reagent list', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", reagents=[smiles=""])\ntarget = M1'), 'bad-species', 2);
});

test('bad-species: name and smiles together', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = start("a", smiles="C")\ntarget = M1'), 'bad-species', 2);
});

test('bad-species: neither', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = start()\ntarget = M1'), 'bad-species', 2);
});

test('bad-site: blank site', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", site="   ")\ntarget = M1'), 'bad-site', 2);
});

test('totality: garbage input returns a ParseResult', () => {
  const inputs = ['\u0000￿(((', 'M1 = start(', 'M1 = apply(M1, reagents=[[', '"\'"\\', 'note :', 'target =', '=====', undefined, null];
  for (const g of inputs) {
    const r = parseRouteProgram(g);
    assert.ok(Array.isArray(r.program.lines));
    assert.ok(Array.isArray(r.diagnostics));
  }
});

test('too-many-lines: emitted once, at the first excess statement', () => {
  const body = ['M1 = start("a")'];
  for (let i = 2; i <= 300; i++) body.push(`M${i} = apply(M${i - 1}, named="x")`);
  body.push('target = M300');
  const r = parseRouteProgram(body.join('\n'));
  assert.deepEqual(codes(r), [['too-many-lines', 257]]);
  assert.equal(r.program.lines.length, 256);
});

test('site forms: phrase, @last and @M<n> handles', () => {
  const r = parseRouteProgram([
    'M1 = start("a")',
    'M2 = apply(M1, named="x", site="the free amine")',
    'M3 = apply(M2, named="y", site=@last)',
    'M4 = apply(M3, named="z", site=@M2)',
    'target = M4',
  ].join('\n'));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.program.lines.slice(1, 4).map((l) => l.site), [
    { kind: 'phrase', phrase: 'the free amine' },
    { kind: 'handle', ref: 'last' },
    { kind: 'handle', ref: 'M2' },
  ]);
});

test('a quoted @last is a phrase, not a handle', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", site="@last")\ntarget = M2');
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.program.lines[1].site, { kind: 'phrase', phrase: '@last' });
});

test('bad-site: malformed handle', () => {
  for (const h of ['@', '@first', '@M0', '@M1000', '@last2']) {
    only(parseRouteProgram(`M1 = start("a")\nM2 = apply(M1, named="x", site=${h})\ntarget = M1`), 'bad-site', 2);
  }
});

test('unknown-ref through a handle', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")\nM3 = apply(M2, named="y", site=@M7)\ntarget = M3'), 'unknown-ref', 3);
});

test('forward-ref through a handle', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", site=@M3)\nM3 = apply(M2, named="y")\ntarget = M3');
  only(r, 'forward-ref', 2);
});

test('self-ref through a handle', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")\nM3 = apply(M2, named="y", site=@M3)\ntarget = M3'), 'self-ref', 3);
});

test('bad-site: @last on the first apply line', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", site=@last)\nM3 = apply(M2, named="y", site=@last)\ntarget = M3');
  only(r, 'bad-site', 2);
  assert.ok(/first apply/.test(r.diagnostics[0].message));
});

test('a handle is refused where a string is required', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = start(@last)\ntarget = M1'), 'syntax', 2);
});

// `carry=` — which fragment continues the route when a step cuts the molecule in two.
//
// Added 2026-10-14 because the gap it closes was found the expensive way: the engine and the
// contract were taught `carry=` and the PARSER was not, so chainP-4 wrote a complete and otherwise
// correct eight-step tetrapeptide program, used the argument exactly as the rules describe, and was
// refused with "The apply call does not take carry=" after 888 s. A rule the parser rejects is
// worse than no rule.
test('carry: the word form', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", carry="largest")\ntarget = M2');
  assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics));
  assert.deepEqual(r.program.lines[1].carry, { kind: 'largest' });
  const small = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", carry="SMALLEST")\ntarget = M2');
  assert.deepEqual(small.program.lines[1].carry, { kind: 'smallest' }, 'the word is read without regard to case');
});

test('carry: the fragment form uses the same shape as reagents', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", carry=[smiles="COC(=O)CN"])\ntarget = M2');
  assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics));
  assert.deepEqual(r.program.lines[1].carry, { kind: 'smiles', smiles: 'COC(=O)CN' });
});

test('carry: a word that is neither says so and points at the fragment form', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", carry="the peptide")\ntarget = M1');
  assert.deepEqual(codes(r), [['syntax', 2]], JSON.stringify(r.diagnostics));
  assert.match(r.diagnostics[0].message, /carry=\[smiles="\.\.\."\]/, 'the message shows the form that would have worked');
});

test('carry: absent on an ordinary line, so nothing changes for a step that does not split', () => {
  const r = parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x")\ntarget = M2');
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.program.lines[1].carry, undefined);
});

test('carry: given twice is caught like any other repeated argument', () => {
  only(parseRouteProgram('M1 = start("a")\nM2 = apply(M1, named="x", carry="largest", carry="smallest")\ntarget = M1'), 'syntax', 2);
});
