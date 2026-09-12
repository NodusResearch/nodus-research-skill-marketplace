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
    invocations: [{ toolId: 'compile', input: { plan: plan(), question: 'Draw ethanol.' } }],
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
