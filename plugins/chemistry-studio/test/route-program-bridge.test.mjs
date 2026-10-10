// The bridge from a route-program trace to the existing audit's input. Fixtures are written by
// hand so the interpreter is not a dependency of the thing that reads its output.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'route-bridge-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const outfile = path.join(scratch, 'bridge.cjs');
await build({
  entryPoints: [path.join(root, 'src/engine/routeProgramToSteps.ts')],
  outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
});
const { routeProgramToAuditInput, programStepCount } = createRequire(import.meta.url)(outfile);

const tmpl = { kind: 'template', id: 't1' };
const startLine = { line: 1, ref: 'M1', from: null, reactants: [], reagents: [], products: ['CCO'], equation: null, provenance: null, failure: null, executed: true };
function apply(n, over = {}) {
  return {
    line: n + 1, ref: `M${n + 1}`, from: `M${n}`,
    reactants: [`R${n}`], reagents: [], products: [`R${n + 1}`],
    equation: `R${n}>>R${n + 1}`, provenance: tmpl, failure: null, executed: true, ...over,
  };
}
const notRun = (n) => apply(n, { reactants: [], products: [], equation: null, provenance: null, executed: false });

test('a complete three-step trace maps to exact steps, labels, carriers and target', () => {
  const trace = {
    lines: [startLine, apply(1), apply(2), apply(3)],
    firstFailure: null, stateBeforeFailure: null, product: { smiles: 'R4' },
  };
  const result = routeProgramToAuditInput(trace);
  assert.deepEqual(result.steps, ['R1>>R2', 'R2>>R3', 'R3>>R4']);
  assert.deepEqual(result.carriers, ['R1', 'R2', 'R3']);
  assert.deepEqual(result.labels, [
    [{ role: 'reactant', smiles: 'R1' }, { role: 'product', smiles: 'R2' }],
    [{ role: 'reactant', smiles: 'R2' }, { role: 'product', smiles: 'R3' }],
    [{ role: 'reactant', smiles: 'R3' }, { role: 'product', smiles: 'R4' }],
  ]);
  assert.equal(result.target, 'R4');
  assert.equal(programStepCount(trace), 3);
  for (const key of ['racemic', 'rearrangement', 'radical', 'stereoChoices']) assert.equal(key in result, false);
});

test('a failure keeps failed and unexecuted lines as empty slots, with every array aligned', () => {
  const failed = apply(2, { equation: null, products: [], executed: true, failure: { error: 'no-match', message: 'x' } });
  const trace = {
    lines: [startLine, apply(1), failed, notRun(3), notRun(4)],
    firstFailure: 3, stateBeforeFailure: { smiles: 'R2' }, product: null,
  };
  const result = routeProgramToAuditInput(trace);
  assert.deepEqual(result.steps, ['R1>>R2', '', '', '']);
  assert.equal(result.carriers.length, result.steps.length);
  assert.equal(result.labels.length, result.steps.length);
  assert.deepEqual(result.carriers, ['R1', null, null, null]);
  assert.deepEqual(result.labels.slice(1), [[], [], []]);
  assert.equal(programStepCount(trace), 4);
  assert.equal(result.target, undefined);
});

test('labels run reactants, then reagents, then products, with co-products marked', () => {
  const line = apply(1, {
    reactants: ['A'], reagents: ['B', 'C'], products: ['P', 'W1', 'W2'], equation: 'A.B.C>>P.W1.W2',
  });
  const result = routeProgramToAuditInput({ lines: [startLine, line], firstFailure: null, stateBeforeFailure: null, product: { smiles: 'P' } });
  assert.deepEqual(result.labels[0], [
    { role: 'reactant', smiles: 'A' },
    { role: 'agent', smiles: 'B' },
    { role: 'agent', smiles: 'C' },
    { role: 'product', smiles: 'P' },
    { role: 'product', byproduct: true, smiles: 'W1' },
    { role: 'product', byproduct: true, smiles: 'W2' },
  ]);
  for (const label of result.labels[0]) assert.equal('name' in label, false);
});

test('a carrier is null where the step has no carried molecule', () => {
  const orphan = apply(1, { reactants: [] });
  const result = routeProgramToAuditInput({ lines: [startLine, orphan], firstFailure: null, stateBeforeFailure: null, product: { smiles: 'R2' } });
  assert.deepEqual(result.carriers, [null]);
});

test('options.target overrides the trace product, and null falls back to it', () => {
  const trace = { lines: [startLine, apply(1)], firstFailure: null, stateBeforeFailure: null, product: { smiles: 'R2' } };
  assert.equal(routeProgramToAuditInput(trace, { target: 'OTHER' }).target, 'OTHER');
  assert.equal(routeProgramToAuditInput(trace, { target: null }).target, 'R2');
  const failedTrace = { lines: [startLine, apply(1, { executed: true, equation: null, failure: { error: 'no-match', message: 'x' } })], firstFailure: 2, stateBeforeFailure: null, product: null };
  assert.equal(routeProgramToAuditInput(failedTrace, { target: 'OTHER' }).target, 'OTHER');
});

test('output size grows linearly with route length, not with its square', () => {
  const sizes = [2, 4, 8, 16, 24, 32, 40].map((steps) => {
    const lines = [startLine];
    for (let n = 1; n <= steps; n += 1) lines.push(apply(n, {
      reactants: ['CC(=O)OCC1=CC=CC=C1'], reagents: ['O=C(Cl)C1=CC=CC=C1'], products: ['CC(=O)OCC1=CC=CC=C1C', 'Cl'],
      equation: 'CC(=O)OCC1=CC=CC=C1.O=C(Cl)C1=CC=CC=C1>>CC(=O)OCC1=CC=CC=C1C.Cl',
    }));
    const trace = { lines, firstFailure: null, stateBeforeFailure: null, product: { smiles: 'CC(=O)OCC1=CC=CC=C1C' } };
    const result = routeProgramToAuditInput(trace);
    assert.equal(result.steps.length, steps);
    return JSON.stringify(result).length / steps;
  });
  const ratio = Math.max(...sizes) / Math.min(...sizes);
  assert.ok(ratio <= 1.6, `bytes per step varied by ${ratio.toFixed(2)}x: ${sizes.map((s) => s.toFixed(0)).join(', ')}`);
});

test('a named reagent carries its name and the nameless carried molecule carries none', () => {
  const line = apply(1, { reactants: ['CARRIED'], reagents: ['ClS(Cl)=O'], products: ['P'], names: { 'ClS(Cl)=O': 'thionyl chloride' } });
  const [labels] = routeProgramToAuditInput({ lines: [startLine, line], firstFailure: null, stateBeforeFailure: null, product: { smiles: 'P' } }).labels;
  assert.deepEqual(labels, [
    { role: 'reactant', smiles: 'CARRIED' },
    { role: 'agent', smiles: 'ClS(Cl)=O', name: 'thionyl chloride' },
    { role: 'product', smiles: 'P' },
  ]);
  assert.equal('name' in labels[0], false);
});

test('co-products are flagged as byproducts whether or not they are named', () => {
  const line = apply(1, { reactants: ['A'], products: ['P', 'Cl', 'O'], names: { Cl: 'hydrogen chloride' } });
  const [labels] = routeProgramToAuditInput({ lines: [startLine, line], firstFailure: null, stateBeforeFailure: null, product: { smiles: 'P' } }).labels;
  assert.deepEqual(labels.slice(2), [
    { role: 'product', byproduct: true, smiles: 'Cl', name: 'hydrogen chloride' },
    { role: 'product', byproduct: true, smiles: 'O' },
  ]);
  assert.equal('byproduct' in labels[1], false);
  assert.deepEqual(labels.map(label => label.smiles), ['A', 'P', 'Cl', 'O']);
});
