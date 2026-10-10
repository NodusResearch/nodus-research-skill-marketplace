// The interpreter is pure, so these tests run it against a toy chemistry: molecules are strings,
// an operation appends its id, and a table says which operations are programmed to fail. Nothing
// here is real chemistry; what is under test is the order of execution and what gets recorded.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'route-program-exec-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const bundle = path.join(scratch, 'exec.cjs');
await build({
  entryPoints: [path.join(root, 'src/engine/routeProgramExec.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
});
const { executeRouteProgram } = createRequire(import.meta.url)(bundle);

// ---------------------------------------------------------------- fakes

/** `failures` maps an operation id (or `resolve:<name>`) to the OpErrorCode it should return. */
function fakeOps(failures = {}) {
  const calls = { resolve: [], apply: [] };
  return {
    calls,
    async resolve(species) {
      const name = species.name ?? species.smiles;
      calls.resolve.push(name);
      const code = failures[`resolve:${name}`];
      if (code) return { error: code, message: `cannot resolve ${name}` };
      return { smiles: name.toUpperCase() };
    },
    async apply(molecule, op, reagents, site) {
      const id = op.id ?? op.smarts;
      calls.apply.push({ from: molecule.smiles, id, site });
      const code = failures[id];
      if (code) return { error: code, message: `${id} failed on ${molecule.smiles}` };
      const resolved = [];
      for (const r of reagents) resolved.push({ smiles: (r.name ?? r.smiles).toUpperCase() });
      return {
        product: { smiles: `${molecule.smiles}+${id}` },
        coProducts: [{ smiles: `BY${id}` }],
        reagents: resolved,
        provenance: op,
      };
    },
  };
}

const start = (line, ref, name) => ({ kind: 'start', line, ref, input: { name } });
const apply = (line, ref, from, id, extra = {}) => ({
  kind: 'apply', line, ref, from, op: { kind: 'template', id }, reagents: [], ...extra,
});
const target = (line, ref) => ({ kind: 'target', line, ref });
const program = (lines) => ({ lines, target: lines.find((l) => l.kind === 'target')?.ref });

const threeStep = () => program([
  start(1, 'M1', 'a'),
  apply(2, 'M2', 'M1', 'x', { reagents: [{ name: 'r1' }, { name: 'r2' }], note: 'first' }),
  apply(3, 'M3', 'M2', 'y', { note: 'second' }),
  target(4, 'M3'),
]);

// ---------------------------------------------------------------- tests

test('a program that runs end to end records every field and the claimed product', async () => {
  const ops = fakeOps();
  const trace = await executeRouteProgram(threeStep(), ops);

  assert.equal(trace.firstFailure, null);
  assert.equal(trace.stateBeforeFailure, null);
  assert.deepEqual(trace.product, { smiles: 'A+x+y' });
  assert.equal(trace.lines.length, 4);
  assert.ok(trace.lines.every((t) => t.executed && t.failure === null));

  assert.deepEqual(trace.lines[0], {
    line: 1, ref: 'M1', from: null, reactants: [], reagents: [], products: ['A'],
    equation: null, provenance: null, names: { A: 'a' }, failure: null, executed: true,
  });
  assert.deepEqual(trace.lines[1], {
    line: 2, ref: 'M2', from: 'M1', reactants: ['A'], reagents: ['R1', 'R2'],
    products: ['A+x', 'BYx'], equation: 'A>R1.R2>A+x.BYx',
    provenance: { kind: 'template', id: 'x' }, names: { R1: 'r1', R2: 'r2' }, note: 'first', failure: null, executed: true,
  });
  assert.equal(trace.lines[2].equation, 'A+x>>A+x+y.BYy');
  assert.equal(trace.lines[3].executed, true);
  assert.equal(trace.lines[3].equation, null);
  assert.equal(ops.calls.apply.length, 2);
});

test('a failure in the middle stops the run and leaves the tail unexecuted without failures', async () => {
  const ops = fakeOps({ y: 'no-match' });
  const trace = await executeRouteProgram(threeStep(), ops);

  assert.equal(trace.firstFailure, 3);
  assert.deepEqual(trace.stateBeforeFailure, { smiles: 'A+x' });
  assert.equal(trace.product, null);
  assert.deepEqual(trace.lines[2].failure, { error: 'no-match', message: 'y failed on A+x' });
  assert.equal(trace.lines[2].executed, true);
  assert.equal(trace.lines[2].equation, null);
  assert.deepEqual(trace.lines[2].reactants, ['A+x']);
  assert.equal(trace.lines[3].executed, false);
  assert.equal(trace.lines[3].failure, null);
  assert.equal(trace.lines.length, 4);
});

test('firstFailure is the line number, not the index, when numbers do not start at one', async () => {
  const p = program([start(10, 'M1', 'a'), apply(14, 'M2', 'M1', 'x'), apply(15, 'M3', 'M2', 'y')]);
  const trace = await executeRouteProgram(p, fakeOps({ x: 'absent-site' }));
  assert.equal(trace.firstFailure, 14);
  assert.deepEqual(trace.lines.map((t) => t.line), [10, 14, 15]);
});

test('a failure on the first start line has no state before it', async () => {
  const ops = fakeOps({ 'resolve:a': 'unresolved-name' });
  const trace = await executeRouteProgram(threeStep(), ops);

  assert.equal(trace.firstFailure, 1);
  assert.equal(trace.stateBeforeFailure, null);
  assert.equal(trace.lines[0].failure.error, 'unresolved-name');
  assert.deepEqual(trace.lines.slice(1).map((t) => [t.executed, t.failure]), [[false, null], [false, null], [false, null]]);
  assert.equal(ops.calls.apply.length, 0);
});

test('every OpErrorCode a fake op returns is recorded unchanged', async () => {
  const codes = ['unresolved-name', 'unknown-template', 'no-match', 'ambiguous-site', 'absent-site', 'unparsable', 'unavailable', 'budget'];
  for (const code of codes) {
    const p = program([start(1, 'M1', 'a'), apply(2, 'M2', 'M1', 'x')]);
    const trace = await executeRouteProgram(p, fakeOps({ x: code }));
    assert.deepEqual(trace.lines[1].failure, { error: code, message: 'x failed on A' }, code);
    assert.equal(trace.firstFailure, 2);
  }
});

test('a from ref that is not bound fails the line as unavailable instead of throwing', async () => {
  const p = program([start(1, 'M1', 'a'), apply(2, 'M2', 'M9', 'x'), apply(3, 'M3', 'M2', 'y')]);
  const ops = fakeOps();
  const trace = await executeRouteProgram(p, ops);
  assert.equal(trace.firstFailure, 2);
  assert.equal(trace.lines[1].failure.error, 'unavailable');
  assert.equal(trace.stateBeforeFailure, null);
  assert.equal(trace.lines[2].executed, false);
  assert.equal(ops.calls.apply.length, 0);
});

test('notes land on the lines that carried them, and only those', async () => {
  const trace = await executeRouteProgram(threeStep(), fakeOps());
  assert.equal('note' in trace.lines[0], false);
  assert.equal(trace.lines[1].note, 'first');
  assert.equal(trace.lines[2].note, 'second');
  assert.equal('note' in trace.lines[3], false);
});

test('a note survives on an unexecuted line', async () => {
  const trace = await executeRouteProgram(threeStep(), fakeOps({ x: 'no-match' }));
  assert.equal(trace.lines[1].note, 'first');
  assert.equal(trace.lines[2].note, 'second');
  assert.equal(trace.lines[2].executed, false);
});

test('reagent order is preserved, in the trace and in the equation', async () => {
  const p = program([
    start(1, 'M1', 'a'),
    apply(2, 'M2', 'M1', 'x', { reagents: [{ name: 'zz' }, { smiles: 'aa' }, { name: 'mm' }] }),
    target(3, 'M2'),
  ]);
  const trace = await executeRouteProgram(p, fakeOps());
  assert.deepEqual(trace.lines[1].reagents, ['ZZ', 'AA', 'MM']);
  assert.equal(trace.lines[1].equation, 'A>ZZ.AA.MM>A+x.BYx');
});

test('the site phrase reaches ops.apply', async () => {
  const ops = fakeOps();
  const p = program([start(1, 'M1', 'a'), apply(2, 'M2', 'M1', 'x', { site: 'the free amine' })]);
  await executeRouteProgram(p, ops);
  assert.equal(ops.calls.apply[0].site, 'the free amine');
});

test('a signal that is already aborted throws before any chemistry runs', async () => {
  const ops = fakeOps();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(executeRouteProgram(threeStep(), ops, { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(ops.calls.resolve.length, 0);
});

test('an abort partway through throws and is not swallowed into the trace', async () => {
  const ac = new AbortController();
  const ops = fakeOps();
  const inner = ops.apply;
  ops.apply = async (...args) => {
    const out = await inner(...args);
    ac.abort();
    return out;
  };
  await assert.rejects(executeRouteProgram(threeStep(), ops, { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(ops.calls.apply.length, 1);
});

test('maxLines leaves the tail unexecuted, without a failure', async () => {
  const lines = [start(1, 'M1', 'a')];
  for (let i = 2; i <= 10; i++) lines.push(apply(i, `M${i}`, `M${i - 1}`, 'x'));
  const ops = fakeOps();
  const trace = await executeRouteProgram(program(lines), ops, { maxLines: 4 });

  assert.equal(trace.lines.length, 10);
  assert.deepEqual(trace.lines.map((t) => t.executed), [true, true, true, true, ...Array(6).fill(false)]);
  assert.ok(trace.lines.every((t) => t.failure === null));
  assert.equal(trace.firstFailure, null);
  assert.equal(trace.product, null);
  assert.equal(ops.calls.apply.length, 3);
});

test('ops.apply is not called for any line after the first failure', async () => {
  const lines = [start(1, 'M1', 'a')];
  for (let i = 2; i <= 8; i++) lines.push(apply(i, `M${i}`, `M${i - 1}`, i === 4 ? 'bad' : 'x'));
  const ops = fakeOps({ bad: 'ambiguous-site' });
  const trace = await executeRouteProgram(program(lines), ops);

  assert.equal(trace.firstFailure, 4);
  assert.equal(ops.calls.apply.length, 3);
  assert.equal(ops.calls.resolve.length, 1);
  assert.equal(trace.lines.filter((t) => !t.executed).length, 4);
});

test('a program with no target line runs and reports no product', async () => {
  const p = { lines: [start(1, 'M1', 'a'), apply(2, 'M2', 'M1', 'x')] };
  const trace = await executeRouteProgram(p, fakeOps());
  assert.equal(trace.firstFailure, null);
  assert.equal(trace.product, null);
});

test('a named start input carries its name against the structure it resolved to', async () => {
  const trace = await executeRouteProgram(threeStep(), fakeOps());
  assert.deepEqual(trace.lines[0].names, { A: 'a' });
});

test('reagent names are paired with resolved structures by index', async () => {
  const trace = await executeRouteProgram(threeStep(), fakeOps());
  assert.deepEqual(trace.lines[1].names, { R1: 'r1', R2: 'r2' });
});

test('only the named reagents contribute when some are given as structures', async () => {
  const p = program([
    start(1, 'M1', 'a'),
    apply(2, 'M2', 'M1', 'x', { reagents: [{ smiles: 'cc' }, { name: 'nn' }, { smiles: 'dd' }] }),
  ]);
  const trace = await executeRouteProgram(p, fakeOps());
  assert.deepEqual(trace.lines[1].names, { NN: 'nn' });
});

test('a short reagents array does not shift names onto the wrong species', async () => {
  const ops = fakeOps();
  const inner = ops.apply;
  ops.apply = async (...args) => {
    const out = await inner(...args);
    return { ...out, reagents: out.reagents.slice(1) };
  };
  const p = program([
    start(1, 'M1', 'a'),
    apply(2, 'M2', 'M1', 'x', { reagents: [{ name: 'r1' }, { name: 'r2' }] }),
  ]);
  const trace = await executeRouteProgram(p, ops);
  assert.deepEqual(trace.lines[1].names, { R2: 'r1' });
});

test('a species given only as a structure contributes no name', async () => {
  const ops = fakeOps();
  const p = program([
    { kind: 'start', line: 1, ref: 'M1', input: { smiles: 'cc' } },
    apply(2, 'M2', 'M1', 'x', { reagents: [{ smiles: 'dd' }] }),
  ]);
  const trace = await executeRouteProgram(p, ops);
  assert.equal('names' in trace.lines[0], false);
  assert.equal('names' in trace.lines[1], false);
});

test('names are absent on unexecuted, failed and target lines', async () => {
  const trace = await executeRouteProgram(threeStep(), fakeOps({ x: 'no-match' }));
  for (const t of trace.lines.slice(1)) assert.equal('names' in t, false);
  const ok = await executeRouteProgram(threeStep(), fakeOps());
  assert.equal('names' in ok.lines[3], false);
});

test('two names for one structure keep the first', async () => {
  const p = program([
    start(1, 'M1', 'a'),
    apply(2, 'M2', 'M1', 'x', { reagents: [{ name: 'same' }, { smiles: 'SAME' }, { name: 'SAME' }] }),
  ]);
  const trace = await executeRouteProgram(p, fakeOps());
  assert.deepEqual(trace.lines[1].names, { SAME: 'same' });
});
