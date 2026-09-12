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
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { runConformanceSuite, conformanceFailures } from '../../../scripts/contract-v2.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
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
