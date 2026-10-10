// A route label may carry facts that need no name: which side a species is on, and whether it
// is a co-product. These tests drive the real audit (real RDKit) to hold that separation.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chemistry-label-nameless-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// Laid out as the archive is, because the engine resolves its vendored dependencies relative to
// itself: capabilities/<id>/ with vendor/ beside it.
fs.mkdirSync(path.join(scratch, 'capabilities/chemistry'), { recursive: true });
const bundle = path.join(scratch, 'capabilities/chemistry/surface.cjs');
await build({
  stdin: {
    contents: `export { auditRoute } from './src/engine/chemistryRouteAudit';`,
    resolveDir: root, loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
  external: ['@rdkit/rdkit', 'node-tikzjax'],
  define: { 'import.meta.url': '__nodusModuleUrl' },
  banner: { js: 'const __nodusModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
});
fs.mkdirSync(path.join(scratch, 'vendor'), { recursive: true });
fs.symlinkSync(path.resolve(root, '../../node_modules'), path.join(scratch, 'vendor/node_modules'), 'dir');
const { auditRoute } = createRequire(import.meta.url)(bundle);

// Fischer esterification: acetic acid + ethanol, sulfuric acid as the catalyst, ethyl acetate +
// water out. It balances, so the audit reaches the label pass, which only runs for steps that do.
const STEP = 'CC(=O)O.CCO>OS(=O)(=O)O>CC(=O)OCC.O';
const ETHYL_ACETATE = 'CC(=O)OCC';

const find = (species, smiles) => species.find(entry => entry.canonicalSmiles === smiles || entry.input === smiles);

test('the fixture step balances, so the label pass is reached', async () => {
  const audit = await auditRoute({ steps: [STEP] });
  assert.equal(audit.steps[0].ok, true, JSON.stringify(audit.steps[0]));
  assert.equal(audit.steps[0].balanced, true, JSON.stringify(audit.steps[0]));
});

test('a nameless label still marks its product as a co-product', async () => {
  // Without this flag, organicMains reads the water-forming partner as a main product.
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'product', smiles: 'O', byproduct: true }]],
  });
  const water = find(audit.steps[0].products, 'O');
  assert.ok(water, 'water is among the products');
  assert.equal(water.byproduct, true);
  assert.equal(find(audit.steps[0].products, ETHYL_ACETATE)?.byproduct, undefined, 'the unlabelled product is not flagged');
});

test('a nameless organic co-product is flagged exactly as a named one is', async () => {
  // organicMains filters on this flag, so a nameless organic co-product must carry it too.
  const named = await auditRoute({ steps: [STEP], labels: [[{ role: 'product', name: 'ethyl acetate', smiles: ETHYL_ACETATE, byproduct: true, nameSmiles: [ETHYL_ACETATE] }]] });
  const nameless = await auditRoute({ steps: [STEP], labels: [[{ role: 'product', smiles: ETHYL_ACETATE, byproduct: true }]] });
  assert.equal(find(named.steps[0].products, ETHYL_ACETATE).byproduct, true);
  assert.equal(find(nameless.steps[0].products, ETHYL_ACETATE).byproduct, true);
});

test('a nameless label raises no name problem and is not tallied as unresolved', async () => {
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[
      { role: 'reactant', smiles: 'CCO' },
      { role: 'product', smiles: 'O', byproduct: true },
    ]],
  });
  assert.equal(audit.steps[0].nameProblems, undefined);
  assert.equal(audit.namesUnresolved, undefined);
  assert.equal(find(audit.steps[0].reactants, 'CCO').nameOk, undefined, 'nothing was compared, so nothing is claimed');
  assert.equal(find(audit.steps[0].reactants, 'CCO').name, undefined);
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
});

test('a blank name is treated like a missing one', async () => {
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'product', name: '   ', smiles: 'O', byproduct: true }]],
  });
  assert.equal(audit.namesUnresolved, undefined);
  assert.equal(audit.steps[0].nameProblems, undefined);
  assert.equal(find(audit.steps[0].products, 'O').byproduct, true);
});

test('a name that disagrees with its structure is still a name problem', async () => {
  // The name resolves to acetaldehyde while the structure beside it is ethanol.
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO', nameSmiles: ['CC=O'] }]],
  });
  const ethanol = find(audit.steps[0].reactants, 'CCO');
  assert.equal(ethanol.nameOk, false);
  assert.equal(audit.steps[0].nameProblems.length, 1);
  assert.equal(audit.continuous, false);
  assert.match(audit.blocked.join(' '), /the name "ethanol" denotes a different structure/);
});

test('a name that matches its structure passes and stays on the species', async () => {
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO', nameSmiles: ['CCO'] }]],
  });
  const ethanol = find(audit.steps[0].reactants, 'CCO');
  assert.equal(ethanol.name, 'ethanol');
  assert.equal(ethanol.nameOk, true);
  assert.equal(audit.steps[0].nameProblems, undefined);
  assert.equal(audit.namesUnresolved, undefined);
});

test('a named label with no resolved structure is still tallied as unresolved', async () => {
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO' }]],
  });
  assert.equal(audit.namesUnresolved, 1);
});

test('a nameless agent is placed in the middle field, not among the reactants', async () => {
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'agent', smiles: 'OS(=O)(=O)O' }]],
  });
  const step = audit.steps[0];
  assert.ok(find(step.agents, 'OS(=O)(=O)O'), JSON.stringify(step.agents));
  assert.equal(find(step.reactants, 'OS(=O)(=O)O'), undefined);
  assert.equal(find(step.products, 'OS(=O)(=O)O'), undefined);
});

test('a nameless label is placed by role: the same species flags on the side it was declared for', async () => {
  // Water appears only as a product here; declaring it as a reactant must not flag the product.
  const audit = await auditRoute({
    steps: [STEP],
    labels: [[{ role: 'reactant', smiles: 'O', byproduct: true }]],
  });
  assert.equal(find(audit.steps[0].products, 'O').byproduct, undefined);
});
