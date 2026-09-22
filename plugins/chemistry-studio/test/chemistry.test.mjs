// Behaviour and contract tests for Chemistry Studio.
//
// The network is stubbed with reference fixtures; the chemistry itself is not. RDKit and
// OpenChemLib really run, so a structure that this package claims to have verified has
// actually been through the same validation a user's machine would perform.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { runConformanceSuite, conformanceFailures } from '../../../scripts/contract-v2.mjs';

// `fileURLToPath`, not `.pathname`: on Windows a file URL's pathname is `/D:/…`, and
// joining that onto anything produces `D:\D:\…`, which opens nothing.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chemistry-studio-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'capabilities/chemistry/capability.json'), 'utf8'));
const instructions = fs.readFileSync(path.join(root, 'skills/chemistry-studio/SKILL.md'), 'utf8').trim();

// The package is authored in TypeScript, so the tests exercise the same bundle the
// archive ships rather than a separately transpiled copy.
// Laid out exactly as the archive is, because the worker resolves its vendored
// dependencies relative to itself: capabilities/<id>/worker.js, vendor/ beside it.
fs.mkdirSync(path.join(scratch, 'capabilities/chemistry'), { recursive: true });
const bundle = path.join(scratch, 'capabilities/chemistry/surface.cjs');
await build({
  stdin: {
    contents: `
      export { default as createWorker } from './src/worker';
      export { validateChemicalReferences } from './src/engine/chemistryValidationCore';
      export { splitFences } from './src/engine/fences';
      export { documentView, summarize } from './src/view';
      export { assignLonePairs, forceTetrahedralPerspective } from './src/engine/chemistryScene';
      export { balanceReaction } from './src/engine/chemistryReaction';
      export { parseChemistryIntent } from './src/engine/chemistryIdentity';
      export { auditRoute } from './src/engine/chemistryRouteAudit';
    `,
    resolveDir: root, loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
  external: ['@rdkit/rdkit', 'node-tikzjax'],
  define: { 'import.meta.url': '__nodusModuleUrl', 'globalThis.__CHEMISTRY_INSTRUCTIONS__': JSON.stringify(instructions) },
  banner: { js: 'const __nodusModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
});
fs.mkdirSync(path.join(scratch, 'vendor'), { recursive: true });
fs.symlinkSync(path.resolve(root, '../../node_modules'), path.join(scratch, 'vendor/node_modules'), 'dir');
const lib = createRequire(import.meta.url)(bundle);

// ---------------------------------------------------------------- fixtures

const ETHANOL_SMILES = 'CCO';
const OPSIN = { status: 'SUCCESS', smiles: ETHANOL_SMILES, inchi: 'InChI=1S/C2H6O/c1-2-3/h3H,2H2,1H3' };

function stubHost(options = {}) {
  const calls = [];
  const state = new Map();
  return {
    calls,
    signal: options.signal ?? new AbortController().signal,
    log: () => {},
    network: {
      async fetch(endpointId, request) {
        calls.push(`${endpointId}${request.path}`);
        const declared = manifest.permissions.network.find(entry => entry.id === endpointId);
        assert.ok(declared, `${endpointId} is a declared endpoint`);
        assert.ok(declared.pathPrefixes.some(prefix => request.path.startsWith(prefix)), `${request.path} is inside a declared prefix`);
        const body = options.fetch?.(endpointId, request.path);
        if (body === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
      },
      downloadToTemp: async () => { throw new Error('not permitted'); },
    },
    model: { complete: async request => { calls.push('model'); return options.model?.(request) ?? ''; } },
    svg: {
      validate: async svg => ({ ok: typeof svg === 'string' && svg.trim().startsWith('<svg'), errors: [] }),
      inspect: async () => ({ elements: 1 }),
      refine: async request => request.svg,
    },
    subworker: {
      async run(request) {
        calls.push(`subworker:${request.entry}`);
        assert.equal(request.entry, 'validator.js', 'validation runs in the killable subworker');
        // The route checker sends the whole route in the same call and gets one audit back.
        if (request.input?.route) return lib.auditRoute(request.input.route);
        // The read-only inspector sends a batch in the same call, exactly as src/validator.ts
        // dispatches it: one parse per species, a failure staying local to its entry.
        if (Array.isArray(request.input?.batch)) {
          const results = [];
          for (const smiles of request.input.batch) {
            try {
              const checked = await lib.validateChemicalReferences({ references: [smiles], inspect: true });
              results.push({ smiles, ok: true, graph: checked.graph });
            } catch (error) {
              results.push({ smiles, ok: false, error: error instanceof Error ? error.message : 'Chemical validation failed.' });
            }
          }
          return { results };
        }
        // The real validator, in-process for the test: the chemistry is not stubbed.
        return lib.validateChemicalReferences(request.input);
      },
    },
    attachments: { store: async request => ({ attachmentId: `a1b2c3d4-0000-4000-8000-${String(calls.length).padStart(12, '0')}`, bytes: request.bytes.length }) },
    storage: {
      state: { get: async key => state.get(key) ?? null, set: async (key, value) => { state.set(key, value); }, delete: async key => { state.delete(key); }, keys: async () => [...state.keys()] },
      cache: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
      temp: { dir: async () => scratch, clear: async () => {} },
    },
  };
}

const ethanolHost = (extra = {}) => stubHost({
  fetch: (endpointId, target) => {
    if (endpointId === 'opsin' && target.includes('/opsin/ws/')) return OPSIN;
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [702] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES/JSON')) return { PropertyTable: { Properties: [{ CID: 702, SMILES: ETHANOL_SMILES }] } };
    return undefined;
  },
  ...extra,
});

const plan = (overrides = {}) => JSON.stringify({
  version: 2, kind: 'structure', depiction: 'skeletal',
  species: [{ id: 's1', input: { kind: 'name', value: 'ethanol' } }],
  ...overrides,
});

// ---------------------------------------------------------------- fences

test('the package reads only the fences it needs, and does not promote ordinary code', () => {
  const parts = lib.splitFences('Text\n\n```json\n{"a":1}\n```\n\n```chemistry-plan\n{"version":2}\n```\n');
  assert.deepEqual(parts.map(part => part.kind), ['markdown', 'other', 'markdown', 'chemistry-plan']);
  const svg = lib.splitFences('```svg\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n```');
  assert.equal(svg[0].kind, 'svg');
  assert.equal(svg[0].complete, true);
  const chemfig = lib.splitFences('```latex\n\\chemfig{H_3C-OH}\n```');
  assert.equal(chemfig[0].kind, 'chemfig');
});

// ---------------------------------------------------------------- drawing

test('a named species is resolved against references and drawn as a verified document', async () => {
  const host = ethanolHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({ invocationId: 'i1', toolId: 'compile', locale: 'en', input: { plan: plan(), question: 'Draw ethanol.' } });
  assert.ok(result.artifacts?.length, `expected a document, got ${JSON.stringify(result.notices ?? [])}`);
  const artifact = result.artifacts[0];
  assert.equal(artifact.artifactType, 'chemistry-document');
  assert.equal(artifact.artifactVersion, 2);
  assert.ok(['verified', 'partial'].includes(artifact.data.status));
  assert.equal(artifact.data.species[0].graph.canonicalSmiles.length > 0, true);
  assert.ok(host.calls.some(call => call.startsWith('subworker:')), 'the structure went through the killable validator');
  assert.ok(host.calls.some(call => call.startsWith('opsin') || call.startsWith('pubchem')), 'the identity came from a reference, not from the model');

  const view = artifact.view;
  assert.equal(view.schemaVersion, 1);
  assert.ok(view.nodes.some(node => node.kind === 'svg'), 'the document carries a drawing');
  assert.ok(view.nodes.some(node => node.kind === 'download'), 'and the verified document can be downloaded');
});

test('the read-only inspector returns a verified graph, never a drawing', async () => {
  const host = ethanolHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'i5', toolId: 'inspect', locale: 'en',
    input: { smiles: ['C[C@H](N)C(=O)O', 'C1CC'] },
  });

  const dossier = result.artifacts.find(artifact => artifact.data.inputSmiles === 'C[C@H](N)C(=O)O');
  assert.ok(dossier, 'the parseable species comes back as a dossier');
  assert.equal(dossier.artifactType, 'molecule-dossier');
  assert.equal(dossier.artifactVersion, 1);
  assert.ok(dossier.data.atoms.length > 0, 'with an atom table');
  assert.ok(dossier.data.bonds.length > 0, 'and a bond table');
  assert.ok(dossier.data.atoms.some(atom => atom.cip === 'S'), 'including the CIP descriptor');
  assert.equal(dossier.data.atoms.find(atom => atom.cip === 'S').element, 'C');

  // A species that cannot be parsed is dropped rather than failing the batch, and the
  // inspector draws nothing: there is no artifact or view carrying an SVG.
  assert.ok(!result.artifacts.some(artifact => artifact.data.inputSmiles === 'C1CC'));
  assert.ok(!result.view, 'inspection produces no drawing view');
  assert.doesNotMatch(JSON.stringify(result), /<svg/, 'and no SVG anywhere in the result');
  assert.deepEqual(result.notices, []);
});

// ---------------------------------------------------------------- synthesis routes

test('a stored drawing is a view-ready <svg> fragment, not a full XML document', () => {
  const document = {
    version: 2, status: 'verified', scope: 'reference-graph-and-molfile-roundtrip',
    engine: { name: 'RDKit', version: 'test' },
    species: [{
      id: 'target', input: { kind: 'smiles', value: 'CCO' }, references: [],
      graph: { canonicalSmiles: 'CCO', molfile: '', atoms: [], bonds: [] },
      svg: "<?xml version='1.0' encoding='iso-8859-1'?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    }],
    limitations: [],
  };
  const view = lib.documentView(document, 'en');
  const node = view.nodes.find(entry => entry.kind === 'svg');
  assert.ok(node, 'a drawing node is present');
  assert.ok(node.svg.startsWith('<svg'), JSON.stringify(node.svg.slice(0, 40)));
});

test('the route checker balances every step and confirms the intermediate is carried over', async () => {
  const host = stubHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'r1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC=O.[H][H]>>CCO'] },
  });
  const audit = result.artifacts.find(artifact => artifact.artifactType === 'route-audit')?.data;
  assert.ok(audit, 'a route audit is produced');
  assert.equal(result.artifacts[0].artifactVersion, 1);
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.equal(audit.steps.length, 2);
  assert.ok(audit.steps.every(step => step.ok && step.balanced), 'every step parsed and balanced');
  assert.equal(audit.links[0].ok, true);
  assert.equal(audit.links[0].reason, 'carried');
  assert.ok(audit.links[0].carried.some(entry => entry.canonicalSmiles === 'CC=O'), JSON.stringify(audit.links[0].carried));
  assert.ok(host.calls.some(call => call.startsWith('subworker:')), 'the whole route ran in the killable subprocess');
});

test('the route checker names an unbalanced step and a disconnected step', async () => {
  const worker = lib.createWorker(stubHost());
  const unbalanced = await worker.invoke({ invocationId: 'r2', toolId: 'verify-route', locale: 'en', input: { steps: ['CCO>>CC=O'] } });
  const step = unbalanced.artifacts[0].data;
  assert.equal(step.continuous, false);
  assert.equal(step.steps[0].balanced, false);
  assert.ok(step.steps[0].differences.length, 'and says which element is off');
  assert.match(step.blocked.join(' '), /Step 1 is not balanced/);

  // Step 2 neither is fed by an earlier step nor feeds a later one. Step 1 feeds step 3.
  const broken = await worker.invoke({
    invocationId: 'r3', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC(=O)O.CCO>>CC(=O)OCC.O', 'CC=O.[H][H]>>CCO'] },
  });
  const audit = broken.artifacts[0].data;
  assert.equal(audit.continuous, false);
  assert.ok(audit.blocked.some(entry => /Step 2 is disconnected/.test(entry)), JSON.stringify(audit.blocked));
  assert.ok(audit.links.some(link => link.from === 0 && link.to === 2 && link.reason === 'carried'), 'step 1 carries into step 3 across the gap');
});

test('a merged step is accepted when it survives balance and refused when it does not', async () => {
  const worker = lib.createWorker(stubHost());
  // Two alkylations collapsed into one line: the species are listed once and the solver
  // infers the coefficients (2 NaNH2, 2 CCBr), so merging is not itself a failure.
  const merged = await worker.invoke({
    invocationId: 'rm1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['C#C.[Na+].[NH2-].CCBr>>CCC#CCC.[Na+].[Br-].N', 'CCC#CCC.[H][H]>>CC/C=C\\CC'] },
  });
  const mergedAudit = merged.artifacts[0].data;
  assert.equal(mergedAudit.steps[0].balanced, true, JSON.stringify(mergedAudit.steps[0].differences));
  assert.equal(mergedAudit.continuous, true, JSON.stringify(mergedAudit.blocked));

  // A merged esterification that dropped the water cannot balance and is refused.
  const unbalanced = await worker.invoke({
    invocationId: 'rm2', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO.CC(=O)O>>CC(=O)OCC'] },
  });
  const audit = unbalanced.artifacts[0].data;
  assert.equal(audit.steps[0].balanced, false);
  assert.equal(audit.continuous, false);
  assert.match(audit.blocked.join(' '), /Step 1 is not balanced/);
});

test('charge balance is enforced even when the element totals match', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'rc1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['[Na]>>[Na+]'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.steps[0].balanced, false, 'same atoms, different charge is not balanced');
  assert.ok(audit.steps[0].differences.some(entry => /charge/.test(entry)), JSON.stringify(audit.steps[0].differences));
});

test('a species that takes no part is named, and removing it balances the step', async () => {
  const worker = lib.createWorker(stubHost());
  // Saponification written with an extra water. Water has coefficient 0 in the only balance —
  // it is neither consumed nor produced — so the step is refused and the idle molecule named.
  const withWater = 'CCOC(=O)C(C)(CC)C(=O)OCC.[Na+].[OH-].O>>[Na+].CC(C(=O)[O-])(CC)C(=O)[O-].CCO';
  const refused = await worker.invoke({ invocationId: 'idle1', toolId: 'verify-route', locale: 'en', input: { steps: [withWater] } });
  const audit = refused.artifacts[0].data;
  assert.equal(audit.steps[0].balanced, false);
  assert.match(audit.steps[0].differences.join(' '), /take\(s\) no part/);

  // The same step without the water balances.
  const without = 'CCOC(=O)C(C)(CC)C(=O)OCC.[Na+].[OH-]>>[Na+].CC(C(=O)[O-])(CC)C(=O)[O-].CCO';
  const ok = await worker.invoke({ invocationId: 'idle2', toolId: 'verify-route', locale: 'en', input: { steps: [without] } });
  assert.equal(ok.artifacts[0].data.steps[0].balanced, true, JSON.stringify(ok.artifacts[0].data.steps[0].differences));
});

test('a step that cannot be parsed names the offending species', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r8', toolId: 'verify-route', locale: 'en',
    input: { steps: ['C#C.CCBr>[NaNH2]>CC#C'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, false);
  assert.ok(audit.blocked.some(entry => entry.includes('[NaNH2]')), JSON.stringify(audit.blocked));
});

test('an empty extra field in a reaction SMILES is tolerated, not rejected', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r9', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCC#CCC.[H][H]>[Pd]>>CC/C=C\\CC'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.equal(audit.steps[0].ok, true);
  assert.equal(audit.steps[0].balanced, true);
  assert.equal(audit.steps[0].agents.length, 1, 'the agent is still read as an agent');
});

test('a reaction written with one separator is read as having no agents', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r11', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>CC=O.[H][H]'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.equal(audit.steps[0].ok, true);
  assert.equal(audit.steps[0].balanced, true);
  assert.equal(audit.steps[0].agents.length, 0);
});

test('catalysts and solvents are drawn above the arrow', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'O=Cc1ccccc1.[H][H]>[Pd]>OCc1ccccc1';
  const result = await worker.invoke({
    invocationId: 'r10', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles },
  });
  const document = result.artifacts?.[0]?.data;
  assert.ok(document, JSON.stringify(result.notices ?? result.view));
  const source = document.reaction?.chemfig?.source ?? '';
  assert.match(source, /\\arrow\{->\[/, 'the agent is an arrow label');
  assert.doesNotMatch(source, /\\vbox|not in balance/, 'and not a line beneath the equation');
});

test('carbon-free reagents are written as formula text, organic species stay drawn', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'CC=O.[H][H]>[Pd]>CCO';
  const result = await worker.invoke({
    invocationId: 'r12', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles },
  });
  const document = result.artifacts?.[0]?.data;
  assert.ok(document, JSON.stringify(result.notices ?? result.view));
  const source = document.reaction?.chemfig?.source ?? '';
  assert.match(source, /\\mathrm\{H_\{2\}\}/, 'hydrogen is written H2, not drawn');
  assert.match(source, /\\mathrm\{Pd\}/, 'the palladium catalyst is written as text');
  assert.match(source, /\\chemfig/, 'the organic species are still drawn');
});

test('a declared racemic step is drawn with its open centre instead of refused', async () => {
  const worker = lib.createWorker(stubHost());
  // The reduction product has one unspecified stereocentre: a single enantiomer is implied
  // by the SMILES, so drawing is refused by default.
  const smiles = 'CC(=O)CC.[H][H]>>CCC(C)O';
  const refused = await worker.invoke({
    invocationId: 'rr1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles },
  });
  assert.ok(!refused.artifacts?.length, 'an unspecified stereocentre is refused without a racemic declaration');

  // Declared racemic: the open centre is a stated outcome, so the scheme is drawn.
  const drawn = await worker.invoke({
    invocationId: 'rr2', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, racemic: true }), question: smiles },
  });
  const document = drawn.artifacts?.[0]?.data;
  assert.ok(document, JSON.stringify(drawn.notices ?? drawn.view));
  assert.ok(document.reaction, 'the racemic scheme is produced');
});

test('step conditions are written beneath the arrow, and dropped rather than fail the drawing', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'O=Cc1ccccc1.[H][H]>[Pd]>OCc1ccccc1';
  const result = await worker.invoke({
    invocationId: 'r14', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, conditions: 'H2 (1 atm), 25 °C, 4 h' }), question: smiles },
  });
  const document = result.artifacts?.[0]?.data;
  assert.ok(document, JSON.stringify(result.notices ?? result.view));
  const source = document.reaction?.chemfig?.source ?? '';
  assert.match(source, /\\arrow\{->\[[^\]]*\]\[[^\]]*\]\}/, 'conditions are a second arrow label below the agents');
  assert.match(source, /\$\^\\circ\$/, 'the degree sign is set in math');
  assert.match(source, /\\shortstack\{/, 'a longer label is stacked into rows');
  assert.match(source, /\\arrow\{->\[[^\]]*\]\[[^\]]*\]\}\[[^\]]+\]/, 'the arrow is given a length that matches the label');
  assert.equal(document.reaction?.conditions, 'H2 (1 atm), 25 °C, 4 h');

  // An annotation that sanitizes to nothing must not produce an empty second label.
  const blank = await worker.invoke({
    invocationId: 'r15', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, conditions: '$$ ^^ && %% ##' }), question: smiles },
  });
  const blankDocument = blank.artifacts?.[0]?.data;
  assert.ok(blankDocument, 'the scheme is still drawn');
  assert.equal(blankDocument.reaction?.conditions, undefined);
});

test('a common inorganic reagent is labelled in the formula a chemist writes', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r13', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>OS(=O)(=O)O>C=C.O'] },
  });
  const step = result.artifacts[0].data.steps[0];
  assert.equal(step.balanced, true, JSON.stringify(step.differences));
  assert.equal(step.agents[0].formula, 'H2SO4');
});

test('a declared racemate is reported, not refused, when a centre is left open on purpose', async () => {
  const worker = lib.createWorker(stubHost());
  const steps = ['CC(=O)CC.[H][H]>>CCC(C)O'];
  const plain = await worker.invoke({ invocationId: 'r16', toolId: 'verify-route', locale: 'en', input: { steps } });
  assert.equal(plain.artifacts[0].data.continuous, false);
  assert.match(plain.artifacts[0].data.blocked.join(' '), /unspecified/);

  const racemic = await worker.invoke({ invocationId: 'r17', toolId: 'verify-route', locale: 'en', input: { steps, racemic: true } });
  const audit = racemic.artifacts[0].data;
  assert.equal(audit.steps[0].racemic, true);
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
});

test('a convergent route is continuous when independent branches feed one step', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r4', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC(=O)O.CCO>>CC(=O)OCC.O', 'CC=O.CC(=O)OCC>>C/C=C/C(=O)OCC.O'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.ok(audit.links.some(link => link.from === 0 && link.to === 2 && link.reason === 'carried'), 'the first branch carries into the final step');
  assert.ok(audit.links.some(link => link.from === 1 && link.to === 2 && link.reason === 'carried'), 'the second branch carries into the final step');
});

test('water made in one step and used in another does not connect them', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'rw1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC(=O)O.CCO>>CC(=O)OCC.O', 'CC=O.O>>CC(O)O'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, false);
  assert.deepEqual(audit.isolated, [1], JSON.stringify(audit.blocked));
  assert.ok(!audit.links.some(link => link.carried.some(entry => entry.canonicalSmiles === 'O')), 'water is never a carried intermediate');
});

test('a spectator counterion does not connect two steps', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'rs1', toolId: 'verify-route', locale: 'en',
    input: { steps: [
      'CCOC(=O)CC(=O)OCC.CCBr.[Na+].CC[O-]>>CCOC(=O)C(CC)C(=O)OCC.CCO.[Na+].[Br-]',
      'Oc1ccccc1.[Na+].[OH-]>>[O-]c1ccccc1.[Na+].O',
      'CCOC(=O)C(CC)C(=O)OCC.[Na+].[OH-]>>CCC(C(=O)[O-])C(=O)[O-].[Na+].CCO',
    ] },
  });
  const audit = result.artifacts[0].data;
  assert.ok(audit.steps.every(step => step.balanced), JSON.stringify(audit.steps.map(step => step.differences)));
  assert.deepEqual(audit.isolated, [1], JSON.stringify(audit.blocked));
  assert.ok(!audit.links.some(link => link.carried.some(entry => entry.canonicalSmiles === '[Na+]')), 'sodium is never a carried intermediate');
  assert.ok(audit.links.some(link => link.from === 0 && link.to === 2 && link.reason === 'carried'), 'the diester still carries step 1 into step 3');
});

test('a step that only prepares an inorganic reagent still feeds the step that uses it', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'rp1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['[Na].N>>[Na+].[NH2-].[H][H]', 'C#C.[Na+].[NH2-]>>[C-]#C.[Na+].N', '[C-]#C.[Na+].CCBr>>CCC#C.[Na+].[Br-]'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.ok(audit.links.some(link => link.from === 0 && link.to === 1 && link.carried.some(entry => entry.canonicalSmiles === '[NH2-]')), JSON.stringify(audit.links));
});

test('a named target must be formed by the route, with its stereochemistry', async () => {
  const worker = lib.createWorker(stubHost());
  const run = async (steps, target) => (await worker.invoke({ invocationId: 'rt', toolId: 'verify-route', locale: 'en', input: { steps, target } })).artifacts[0].data;
  const route = ['CCO>>CC=O.[H][H]', 'CC=O.[H][H]>>CCO'];

  const formed = await run(route, 'OCC');
  assert.equal(formed.target.reason, 'formed');
  assert.equal(formed.target.formedAt, 1);
  assert.equal(formed.continuous, true, JSON.stringify(formed.blocked));

  const missing = await run(route, 'CC(=O)O');
  assert.equal(missing.target.reason, 'not-formed');
  assert.equal(missing.continuous, false);
  assert.match(missing.blocked.join(' '), /No step forms the target CC\(=O\)O/);

  const hydrogenation = ['CCC#CCC.[H][H]>[Pd]>CC/C=C\\CC'];
  const wrongIsomer = await run(hydrogenation, 'CC/C=C/CC');
  assert.equal(wrongIsomer.target.reason, 'stereo-mismatch');
  assert.equal(wrongIsomer.continuous, false);
  assert.equal((await run(hydrogenation, 'CCC=CCC')).target.reason, 'formed', 'a target without stereo matches either isomer');

  const unreadable = await run(route, 'not a smiles');
  assert.equal(unreadable.target.reason, 'unparsed');
  assert.equal(unreadable.continuous, true, 'an unreadable target does not block the route');
});

test('the same constitution with different stereochemistry is not the same intermediate', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({
    invocationId: 'r4', toolId: 'verify-route', locale: 'en',
    input: { steps: ['C/C=C\\C>>C/C=C/C', 'C/C=C\\C.[H][H]>>CCCC'] },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.links[0].reason, 'constitution-only', JSON.stringify(audit.links[0]));
  assert.equal(audit.links[0].ok, false);
  assert.ok(audit.links[0].skeletonOnly.length, 'and reports the two forms');
  assert.match(audit.blocked.join(' '), /same constitution but different stereochemistry/);
});

test('a declared carrier is checked by identity, and unspecified stereochemistry is reported', async () => {
  const worker = lib.createWorker(stubHost());
  const carried = await worker.invoke({
    invocationId: 'r5', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC=O.[H][H]>>CCO'], carriers: ['', 'O=CC'] },
  });
  const link = carried.artifacts[0].data.links[0];
  assert.equal(link.declaredCarrier.inProduct, true, 'the declared intermediate is in the products');
  assert.equal(link.declaredCarrier.inReactant, true, 'and unchanged in the reactants');
  assert.equal(link.ok, true);

  const mismatch = await worker.invoke({
    invocationId: 'r6', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO>>CC=O.[H][H]', 'CC=O.[H][H]>>CCO'], carriers: ['', 'CC(=O)O'] },
  });
  assert.equal(mismatch.artifacts[0].data.links[0].reason, 'declared-mismatch');

  const unspecified = await worker.invoke({ invocationId: 'r7', toolId: 'verify-route', locale: 'en', input: { steps: ['CC=CC.[H][H]>>CCCC'] } });
  const audit = unspecified.artifacts[0].data;
  assert.equal(audit.steps[0].unspecifiedStereocentres, 1, 'the unspecified double bond is counted');
  assert.equal(audit.continuous, false);
  assert.match(audit.blocked.join(' '), /unspecified/);
});

test('an identity that no reference supports is not drawn from the model instead', async () => {
  // No OPSIN entry, no PubChem match: the reference simply does not exist.
  const host = stubHost({ fetch: () => undefined, model: () => '' });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'i2', toolId: 'compile', locale: 'en',
    input: { plan: plan({ species: [{ id: 's1', input: { kind: 'name', value: 'unobtainium oxide' } }] }), question: 'Draw unobtainium oxide.' },
  });
  assert.ok(!result.artifacts?.length, 'nothing is presented as verified');
  assert.ok(result.notices?.length || result.view, 'and the user is told why');
});

test('when the verified lane abstains, a fallback drawing is labelled unverified everywhere', async () => {
  const host = stubHost({
    fetch: () => undefined,
    model: () => '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><title>Sketch</title></svg>\n```',
  });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'i3', toolId: 'compile', locale: 'en',
    input: { plan: plan({ species: [{ id: 's1', input: { kind: 'name', value: 'unobtainium oxide' } }] }), question: 'Draw unobtainium oxide.' },
  });
  assert.ok(!result.artifacts?.length, 'an unverified drawing is never stored as a verified document');
  assert.ok(result.view, 'but it is still shown rather than costing the user the answer');
  const serialized = JSON.stringify(result.view);
  assert.match(serialized, /[Uu]nverified/);
  const drawing = result.view.nodes.find(node => node.kind === 'svg');
  assert.match(drawing.alt, /[Uu]nverified/, 'including in the text a screen reader gets');
});

// ---------------------------------------------------------------- chat hook

test('a drawing intent written as ordinary JSON is adopted, and two of them are refused', async () => {
  const worker = lib.createWorker(ethanolHost());
  const adopted = await worker.prepareChat({
    locale: 'en', question: 'Draw ethanol.',
    nodes: [
      { id: 'n0', kind: 'prose', content: 'Here is the structure.', complete: true },
      { id: 'n1', kind: 'fence', fence: 'json', content: plan(), complete: true },
    ],
  });
  assert.ok(adopted.some(mutation => mutation.op === 'promote-request'), 'the intent becomes a real call');
  assert.ok(adopted.some(mutation => mutation.op === 'claim' && mutation.suppressSvgRefinement), 'and the package takes the drawing lane');

  const conflicting = await worker.prepareChat({
    locale: 'en', question: 'Draw ethanol and methanol.',
    nodes: [
      { id: 'n0', kind: 'fence', fence: 'json', content: plan(), complete: true },
      { id: 'n1', kind: 'fence', fence: 'json', content: plan({ species: [{ id: 's1', input: { kind: 'name', value: 'methanol' } }] }), complete: true },
    ],
  });
  assert.ok(!conflicting.some(mutation => mutation.op === 'promote-request'), 'ambiguity is not resolved by guessing');
  assert.ok(conflicting.some(mutation => mutation.op === 'notice'), 'it is reported');
});

test('only one plan is drawn per reply, and a truncated one is not run', async () => {
  const worker = lib.createWorker(ethanolHost());
  const mutations = await worker.prepareChat({
    locale: 'en', question: 'Draw ethanol.',
    nodes: [
      { id: 'n0', kind: 'fence', fence: 'chemistry-plan', content: plan(), complete: true },
      { id: 'n1', kind: 'fence', fence: 'chemistry-plan', content: plan(), complete: true },
    ],
  });
  assert.equal(mutations.filter(mutation => mutation.op === 'promote-request').length, 1);
  assert.ok(mutations.some(mutation => mutation.op === 'remove'));

  const truncated = await worker.prepareChat({
    locale: 'en', question: 'Draw ethanol.',
    nodes: [{ id: 'n0', kind: 'fence', fence: 'chemistry-plan', content: '{"version":2', complete: false }],
  });
  assert.ok(!truncated.some(mutation => mutation.op === 'promote-request'));
});

// ---------------------------------------------------------------- projection

test('what the model may see later is the identities, never the picture', async () => {
  const host = ethanolHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({ invocationId: 'i4', toolId: 'compile', locale: 'en', input: { plan: plan(), question: 'Draw ethanol.' } });
  const projection = await worker.projectArtifactForModel({ artifactType: 'chemistry-document', artifactVersion: 2, data: result.artifacts[0].data });
  assert.match(projection, /ethanol/i);
  assert.doesNotMatch(projection, /<svg/, 'a drawing is not text for the model to reason over');
  assert.match(projection, /Chemistry Studio document/);
});

// ---------------------------------------------------------------- contract

test('the worker satisfies the capability contract it declares', async () => {
  const host = ethanolHost();
  const findings = await runConformanceSuite(manifest, lib.createWorker(host), {
    invocations: [
      { toolId: 'compile', input: { plan: plan(), question: 'Draw ethanol.' } },
      { toolId: 'inspect', input: { smiles: [ETHANOL_SMILES] } },
      { toolId: 'verify-route', input: { steps: ['CCO>>CC=O.[H][H]', 'CC=O.[H][H]>>CCO'] } },
    ],
    chatNodes: [
      { id: 'n0', kind: 'prose', content: 'Draw ethanol.', complete: true },
      { id: 'n1', kind: 'fence', fence: 'chemistry-plan', content: plan(), complete: true },
    ],
  });
  assert.deepEqual(conformanceFailures(findings), []);
});

// ---------------------------------------------------------------- what 5.3.1 left behind

const migrate = createRequire(import.meta.url)('../migrations/001-adopt-outcome-log.cjs');

test('the migration adopts the outcome log the built-in kept', async () => {
  const host = stubHost();
  const outcomes = [{ at: '2026-09-01T00:00:00.000Z', reason: 'not-drawn', question: 'Draw ferrocene.' }];
  const result = await migrate({ host, legacy: { chemistryOutcomes: outcomes }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal(result.dataVersion, 1);
  assert.deepEqual(await host.storage.state.get('outcomes'), outcomes);
  assert.match(result.notes, /Adopted 1 outcome record/);
});

test('a log the package has already written is not replaced by an older one', async () => {
  const host = stubHost();
  await host.storage.state.set('outcomes', [{ at: '2026-09-10T00:00:00.000Z', reason: 'not-drawn' }]);
  const result = await migrate({ host, legacy: { chemistryOutcomes: [{ at: '2026-01-01T00:00:00.000Z' }] }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal((await host.storage.state.get('outcomes'))[0].at, '2026-09-10T00:00:00.000Z');
  assert.match(result.notes, /already present/);
});

test('a diagnostic log that cannot be written never fails the migration', async () => {
  const host = stubHost();
  host.storage.state.set = async () => { throw new Error('quota exceeded'); };
  const result = await migrate({ host, legacy: { chemistryOutcomes: [{ at: '2026-01-01T00:00:00.000Z' }] }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal(result.dataVersion, 1, 'the package still reaches version 1');
  assert.match(result.notes, /diagnostic only/);
});

test('a drawing and a warning saved by the built-in still render', async () => {
  const host = ethanolHost();
  const worker = lib.createWorker(host);
  const produced = await worker.invoke({ invocationId: 'i1', toolId: 'compile', locale: 'en', input: { plan: plan(), question: 'Draw ethanol.' } });
  const document = produced.artifacts[0].data;

  const drawn = await worker.renderLegacyResult({ fence: 'chemistry-document', payload: JSON.stringify(document), locale: 'en' });
  assert.deepEqual(drawn, await worker.renderArtifact({ artifactType: 'chemistry-document', data: document, locale: 'en' }),
    'an old block draws exactly what a stored artifact of the same document draws');

  // The built-in also wrote bare notices. They were codes, and the same codes are still
  // the ones this package has words for.
  const notice = await worker.renderLegacyResult({ fence: 'chemistry-notice', payload: JSON.stringify({ code: 'unverified-svg', detail: 'hand drawn' }), locale: 'en' });
  assert.match(JSON.stringify(notice), /verified chemistry lane/);
  assert.match(JSON.stringify(notice), /hand drawn/);

  const unknown = await worker.renderLegacyResult({ fence: 'chemistry-notice', payload: JSON.stringify({ code: 'invented-by-someone' }), locale: 'en' });
  assert.match(JSON.stringify(unknown), /older version/, 'a code this package never had is shown as an older format, not looked up blindly');

  await assert.rejects(worker.renderLegacyResult({ fence: 'chemistry-document', payload: 'nope', locale: 'en' }), /UNREADABLE/);
});

// ---------------------------------------------------------------- explicit hydrogens

/** A scene built by hand, so what is being tested is the counting rule and not RDKit. */
const scene = (atoms, bonds) => ({
  atoms: atoms.map(([element, charge], index) => ({ id: `a${index}`, element, charge, isotope: 0, label: element, x: index, y: 0 })),
  bonds: bonds.map(([a, b, order], index) => ({ id: `b${index}`, a, b, order, stereo: 0 })),
});

test('a lone pair is counted, never supplied', () => {
  // Valence electrons, less the formal charge, less the bonds already drawn. Every one of
  // these is a number a model would otherwise be asked for, and would sometimes get wrong.
  const cases = [
    ['water', scene([['O', 0], ['H', 0], ['H', 0]], [[0, 1, 1], [0, 2, 1]]), [2, 0, 0]],
    ['ammonia', scene([['N', 0], ['H', 0], ['H', 0], ['H', 0]], [[0, 1, 1], [0, 2, 1], [0, 3, 1]]), [1, 0, 0, 0]],
    ['methane', scene([['C', 0], ['H', 0], ['H', 0], ['H', 0], ['H', 0]], [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]), [0, 0, 0, 0, 0]],
    ['hydroxide', scene([['O', -1], ['H', 0]], [[0, 1, 1]]), [3, 0]],
    ['ammonium', scene([['N', 1], ['H', 0], ['H', 0], ['H', 0], ['H', 0]], [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]), [0, 0, 0, 0, 0]],
    ['carbon dioxide', scene([['O', 0], ['C', 0], ['O', 0]], [[0, 1, 2], [1, 2, 2]]), [2, 0, 2]],
    ['hydrogen cyanide', scene([['H', 0], ['C', 0], ['N', 0]], [[0, 1, 1], [1, 2, 3]]), [0, 0, 1]],
  ];
  for (const [name, molecule, expected] of cases) {
    lib.assignLonePairs(molecule);
    assert.deepEqual(molecule.atoms.map(atom => atom.lonePairs), expected, name);
  }
});

test('a tetrahedral centre that wedges nothing is given a perspective', () => {
  // Chloroform has one four-coordinate carbon and no stereocentre, so nothing in the graph
  // asks for a wedge — and a flat drawing of it teaches the wrong shape.
  const chloroform = scene([['C', 0], ['Cl', 0], ['Cl', 0], ['Cl', 0], ['H', 0]], [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]);
  chloroform.atoms[1].x = 1; chloroform.atoms[1].y = 0;
  chloroform.atoms[2].x = 0; chloroform.atoms[2].y = 1;
  chloroform.atoms[3].x = -1; chloroform.atoms[3].y = 0;
  chloroform.atoms[4].x = 0; chloroform.atoms[4].y = -1;
  assert.equal(lib.forceTetrahedralPerspective(chloroform), true);
  const stereo = chloroform.bonds.map(bond => bond.stereo);
  assert.equal(stereo.filter(value => value === 1).length, 1, 'exactly one solid wedge');
  assert.equal(stereo.filter(value => value === 6).length, 1, 'exactly one hashed bond');
  // The renderer draws the narrow end at a bond's first atom, so the centre has to be it.
  for (const bond of chloroform.bonds.filter(b => b.stereo)) assert.equal(bond.a, 0, 'the wedge starts at the centre');

  // Ethane has two such carbons: which one would the perspective be about? Left alone.
  const ethane = scene([['C', 0], ['C', 0], ['H', 0], ['H', 0], ['H', 0], ['H', 0], ['H', 0], ['H', 0]],
    [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1], [1, 5, 1], [1, 6, 1], [1, 7, 1]]);
  assert.equal(lib.forceTetrahedralPerspective(ethane), false);
  assert.deepEqual(ethane.bonds.map(bond => bond.stereo), ethane.bonds.map(() => 0));
});

test('a depiction that was asked for is the one that is drawn', () => {
  // The identity has to appear in the request verbatim, so each case names what it asks for.
  const intent = (depiction, value) => JSON.stringify({ version: 2, kind: 'structure', depiction, species: [{ id: 's1', input: { kind: 'name', value } }] });

  // Both were refused outright before they could be derived. Now the refusal is the
  // opposite one: answering with a drawing that leaves out what was asked for.
  assert.throws(() => lib.parseChemistryIntent(intent('skeletal', 'water'), 'draw water with lone pairs'), /lone-pair depiction must not be replaced/);
  assert.throws(() => lib.parseChemistryIntent(intent('skeletal', 'chloroform'), 'show chloroform with explicit hydrogens'), /must not be replaced with a skeletal drawing/);
  assert.throws(() => lib.parseChemistryIntent(intent('skeletal', 'chloroform'), 'draw chloroform with a solid wedge and a hashed bond'), /must not be replaced with a skeletal drawing/);

  assert.equal(lib.parseChemistryIntent(intent('lone-pairs', 'water'), 'draw water with lone pairs').depiction, 'lone-pairs');
  assert.equal(lib.parseChemistryIntent(intent('wedge-dash', 'chloroform'), 'show chloroform with explicit hydrogens').depiction, 'wedge-dash');
  // And a plain request still gets a plain drawing.
  assert.equal(lib.parseChemistryIntent(intent('skeletal', 'water'), 'draw water').depiction, 'skeletal');
});

// ---------------------------------------------------------------- stoichiometry

/** Compositions as the reaction path builds them: atoms keyed by atomic number and isotope. */
const comp = (atoms, charge = 0) => ({ atoms: Object.fromEntries(Object.entries(atoms)), charge });
const H2 = comp({ '1:0': 2 }), O2 = comp({ '8:0': 2 }), H2O = comp({ '1:0': 2, '8:0': 1 });
const CH4 = comp({ '6:0': 1, '1:0': 4 }), CO2 = comp({ '6:0': 1, '8:0': 2 });

test('the coefficients are solved, not taken on trust', () => {
  // Two hydrogens and an oxygen make two waters. A model that says one of each is wrong,
  // and the point of solving is that being wrong about it stops mattering.
  assert.deepEqual(
    lib.balanceReaction([H2, O2, H2O], ['reactant', 'reactant', 'product'], [1, 1, 1]),
    [2, 1, 2]);

  // Methane combustion, the arithmetic a model most often fumbles mid-route.
  assert.deepEqual(
    lib.balanceReaction([CH4, O2, CO2, H2O], ['reactant', 'reactant', 'product', 'product'], [1, 1, 1, 1]),
    [1, 2, 1, 2]);

  // An equation the request already balanced comes back exactly as it was written, rather
  // than rescaled to some other multiple of itself.
  assert.deepEqual(
    lib.balanceReaction([H2, O2, H2O], ['reactant', 'reactant', 'product'], [4, 2, 4]),
    [4, 2, 4]);

  // Charge is conserved alongside the atoms: a proton and a hydroxide make one water.
  const proton = comp({ '1:0': 1 }, 1), hydroxide = comp({ '1:0': 1, '8:0': 1 }, -1);
  assert.deepEqual(
    lib.balanceReaction([proton, hydroxide, H2O], ['reactant', 'reactant', 'product'], [1, 1, 1]),
    [1, 1, 1]);
});

test('an agent takes no part in the balance', () => {
  // A catalyst is recovered and a solvent is not consumed, so neither belongs in the
  // matrix — and a platinum atom on one side only must not make the equation unsolvable.
  const platinum = comp({ '78:0': 1 });
  assert.deepEqual(
    lib.balanceReaction([H2, O2, platinum, H2O], ['reactant', 'reactant', 'agent', 'product'], [1, 1, 1, 1]),
    [2, 1, 1, 2]);
});

test('a counterion carried on both sides cancels instead of making the equation ambiguous', () => {
  // Acetylene dialkylation with sodium amide: the Na+ enters in [Na+].[NH2-] and leaves in
  // [Na+].[Br-]. It is a spectator, so it must not add a free coefficient; the rest solves to
  // 1 acetylene, 2 amide, 2 bromoethane, 1 hexyne, 2 ammonia, 2 bromide.
  const Na = comp({ '11:0': 1 }, 1), NH2 = comp({ '7:0': 1, '1:0': 2 }, -1), Br = comp({ '35:0': 1 }, -1);
  const acetylene = comp({ '6:0': 2, '1:0': 2 }), EtBr = comp({ '6:0': 2, '1:0': 5, '35:0': 1 });
  const hexyne = comp({ '6:0': 6, '1:0': 10 }), ammonia = comp({ '7:0': 1, '1:0': 3 });
  assert.deepEqual(
    lib.balanceReaction(
      [acetylene, EtBr, Na, NH2, hexyne, ammonia, Na, Br],
      ['reactant', 'reactant', 'reactant', 'reactant', 'product', 'product', 'product', 'product'],
      [1, 1, 1, 1, 1, 1, 1, 1]),
    [1, 2, 1, 2, 1, 2, 1, 2]);
});

test('what cannot be balanced says what is missing', () => {
  // Chlorine vanishing between the sides is the commonest failure in a proposed route: a
  // byproduct nobody wrote down. The message has to name it, or the next attempt is a guess.
  const HCl = comp({ '1:0': 1, '17:0': 1 }), MeOH = comp({ '6:0': 1, '1:0': 4, '8:0': 1 }), MeCl = comp({ '6:0': 1, '1:0': 3, '17:0': 1 });
  assert.throws(
    () => lib.balanceReaction([MeOH, HCl, MeCl], ['reactant', 'reactant', 'product'], [1, 1, 1]),
    /cannot be balanced[\s\S]*O: reactants 1, products 0|cannot be balanced[\s\S]*H: reactants/);

  // Ethanol burning can be written with carbon monoxide as well as carbon dioxide, and
  // choosing between them would be inventing which reaction was meant.
  const EtOH = comp({ '6:0': 2, '1:0': 6, '8:0': 1 }), CO = comp({ '6:0': 1, '8:0': 1 });
  assert.throws(
    () => lib.balanceReaction([EtOH, O2, CO2, CO, H2O], ['reactant', 'reactant', 'product', 'product', 'product'], [1, 1, 1, 1, 1]),
    /more than one balanced equation/);

  // One side missing entirely is not an equation.
  assert.throws(() => lib.balanceReaction([H2, O2], ['reactant', 'reactant'], [1, 1]), /at least one reactant and one product/);
});


// ---------------------------------------------------------------- IUPAC name checks

test('the route checker confirms a supplied IUPAC name denotes the structure it was written beside', async () => {
  const host = ethanolHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'rn1', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['CCO>>CC=O.[H][H]'],
      labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO' }]],
    },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.equal(audit.steps[0].reactants[0].name, 'ethanol');
  assert.equal(audit.steps[0].reactants[0].nameOk, true);
  assert.equal(audit.namesUnresolved, undefined, 'the name was resolved');
  assert.ok(host.calls.some(call => call.startsWith('opsin') || call.startsWith('pubchem')), 'the name was resolved against a reference');
});

test('a name that denotes a different compound is refused like an unbalanced step', async () => {
  // The species is ethanol (CCO) but the reference resolves the name "ethanol" to a
  // different graph, exactly the case the check exists to catch.
  const host = stubHost({
    fetch: (endpointId, target) => endpointId === 'opsin' && target.includes('/opsin/ws/')
      ? { status: 'SUCCESS', smiles: 'CC=O' }
      : undefined,
  });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'rn2', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['CCO>>CC=O.[H][H]'],
      labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO' }]],
    },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, false);
  assert.equal(audit.steps[0].reactants[0].nameOk, false);
  assert.equal(audit.steps[0].nameProblems.length, 1);
  assert.match(audit.blocked.join(' '), /the IUPAC name "ethanol" denotes a different structure/);
});

test('an unresolvable name is reported as unchecked, never as a disagreement', async () => {
  const host = stubHost();
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'rn3', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['CCO>>CC=O.[H][H]'],
      labels: [[{ role: 'reactant', name: 'mystery compound', smiles: 'CCO' }]],
    },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.continuous, true, JSON.stringify(audit.blocked));
  assert.equal(audit.namesUnresolved, 1);
  assert.equal(audit.steps[0].reactants[0].name, 'mystery compound');
  assert.equal(audit.steps[0].reactants[0].nameOk, undefined);
  assert.equal(audit.steps[0].nameProblems, undefined);
});

test('a byproduct label is carried through onto the product side', async () => {
  const worker = lib.createWorker(ethanolHost());
  const result = await worker.invoke({
    invocationId: 'rn4', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['CCO>>C=C.O'],
      labels: [[
        { role: 'reactant', name: 'ethanol', smiles: 'CCO' },
        { role: 'product', name: 'water', smiles: 'O', byproduct: true },
      ]],
    },
  });
  const product = result.artifacts[0].data.steps[0].products.find(entry => entry.canonicalSmiles === 'O');
  assert.ok(product, 'water is on the product side');
  assert.equal(product.byproduct, true);
});

// ---------------------------------------------------------------- name resolution

const resolveHost = (fetch) => stubHost({ fetch });

test('resolve-names prefers PubChem and does not let OPSIN override a curated record', async () => {
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [2733336] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 2733336, IsomericSMILES: 'C#[C-].[Na+]', MolecularFormula: 'C2HNa' }] } };
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: '[C-]#[C-].[Na+].[Na+]' };
    return undefined;
  });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({ invocationId: 'rn1', toolId: 'resolve-names', locale: 'en', input: { names: ['sodium acetylide'] } });
  const resolution = result.artifacts.find(artifact => artifact.artifactType === 'species-resolution');
  assert.ok(resolution, 'a species-resolution artifact is produced');
  assert.equal(result.artifacts[0].artifactVersion, 1);
  const entry = resolution.data.results[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.source, 'pubchem');
  assert.equal(entry.smiles, 'C#[C-].[Na+]');
  assert.equal(entry.formula, 'C2HNa');
});

test('resolve-names falls back to OPSIN when PubChem has no exact match', async () => {
  const worker = lib.createWorker(resolveHost((endpointId, target) => {
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: 'C#CCC' };
    return undefined; // pubchem 404
  }));
  const result = await worker.invoke({ invocationId: 'rn2', toolId: 'resolve-names', locale: 'en', input: { names: ['but-1-yne'] } });
  const entry = result.artifacts[0].data.results[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.source, 'opsin');
  assert.equal(entry.smiles, 'C#CCC');
});

test('an ambiguous PubChem match and a partial OPSIN parse are reported with feedback', async () => {
  const ambiguous = lib.createWorker(resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [1, 2] } };
    return undefined;
  }));
  const many = await ambiguous.invoke({ invocationId: 'rn3', toolId: 'resolve-names', locale: 'en', input: { names: ['ambiguous name'] } });
  const manyEntry = many.artifacts[0].data.results[0];
  assert.equal(manyEntry.status, 'ambiguous');
  assert.match(manyEntry.feedback, /exact matches/);

  const partial = lib.createWorker(resolveHost((endpointId, target) => {
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: 'CCC', warnings: ['unparsed segment'] };
    return undefined;
  }));
  const partialResult = await partial.invoke({ invocationId: 'rn4', toolId: 'resolve-names', locale: 'en', input: { names: ['partly parsed name'] } });
  const partialEntry = partialResult.artifacts[0].data.results[0];
  assert.equal(partialEntry.status, 'unresolved');
  assert.match(partialEntry.feedback, /partly interpreted/);
});

test('an entirely unknown name is unresolved with feedback, and duplicates are resolved once', async () => {
  const worker = lib.createWorker(resolveHost(() => undefined));
  const result = await worker.invoke({ invocationId: 'rn5', toolId: 'resolve-names', locale: 'en', input: { names: ['but-1-yne', 'but-1-yne'] } });
  const results = result.artifacts[0].data.results;
  assert.equal(results.length, 1, 'the duplicate name is resolved once');
  assert.equal(results[0].status, 'unresolved');
  assert.ok(results[0].feedback, 'a feedback sentence is returned for the model to act on');
});

test('resolve-names rejects an empty request', async () => {
  const worker = lib.createWorker(resolveHost(() => undefined));
  await assert.rejects(() => worker.invoke({ invocationId: 'rn6', toolId: 'resolve-names', locale: 'en', input: { names: ['', '   '] } }), /between one and/);
});

test('the per-step species cap is a generous backstop, not the old 12', async () => {
  const worker = lib.createWorker(stubHost());
  // 21 components parses fine: a real dichromate step can exceed the old 12.
  const accepted = await worker.invoke({ invocationId: 'cap1', toolId: 'verify-route', locale: 'en', input: { steps: [`${'C.'.repeat(20)}C>>C`] } });
  assert.equal(accepted.artifacts[0].data.steps[0].ok, true, accepted.artifacts[0].data.steps[0].error);

  // 49 reactants + 1 product = 50 components exceeds the 48 backstop.
  const refused = await worker.invoke({ invocationId: 'cap2', toolId: 'verify-route', locale: 'en', input: { steps: [`${'C.'.repeat(48)}C>>C`] } });
  const step = refused.artifacts[0].data.steps[0];
  assert.equal(step.ok, false);
  assert.match(step.error, /at most 48 species/);
});

test('a shared counterion written once per side balances uniquely; repeated tokens do not', async () => {
  // The name-first app derives this from named salts, writing each ion once per side.
  const deduped = 'C1(CCCCC1)O.[O-][Cr](=O)(=O)O[Cr](=O)(=O)[O-].[Na+].S(O)(O)(=O)=O>>C1(CCCCC1)=O.S(=O)(=O)([O-])[O-].[Cr+3].[Na+].O';
  const ok = await lib.auditRoute({ steps: [deduped] });
  assert.equal(ok.steps[0].balanced, true, JSON.stringify(ok.steps[0].differences));

  // The same equation with the shared sulfate and sodium repeated (as an un-deduped derivation
  // would write them) admits more than one balance and is refused.
  const repeated = 'C1(CCCCC1)O.[O-][Cr](=O)(=O)O[Cr](=O)(=O)[O-].[Na+].[Na+].S(O)(O)(=O)=O>>C1(CCCCC1)=O.S(=O)(=O)([O-])[O-].S(=O)(=O)([O-])[O-].S(=O)(=O)([O-])[O-].[Cr+3].[Cr+3].S(=O)(=O)([O-])[O-].[Na+].[Na+].O';
  const refused = await lib.auditRoute({ steps: [repeated] });
  assert.equal(refused.steps[0].balanced, false);
  assert.match(refused.steps[0].differences.join(' '), /more than one balanced equation/);
});
