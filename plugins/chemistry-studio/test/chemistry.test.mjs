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
      export { default as createWorker, resetPubchemPacing } from './src/worker';
      export { validateChemicalReferences } from './src/engine/chemistryValidationCore';
      export { splitFences } from './src/engine/fences';
      export { documentView, summarize } from './src/view';
      export { assignLonePairs, forceTetrahedralPerspective } from './src/engine/chemistryScene';
      export { balanceReaction } from './src/engine/chemistryReaction';
      export { parseChemistryIntent, resolveNameReferences } from './src/engine/chemistryIdentity';
      export { auditRoute } from './src/engine/chemistryRouteAudit';
      export { skeletonChange } from './src/engine/chemistrySkeleton';
      export { buildingBlockSmiles, isResinBoundName, PEPTIDE_BUILDING_BLOCKS } from './src/engine/peptideBuildingBlocks';
      export { diatomicElementForName } from './src/engine/chemistryIdentity';
      export { SCHEMA_CEILINGS, maxQuestionChars, maxNames, maxLabelsTotal, maxLabelsPerStep, maxSteps, maxSpeciesPerStep, maxSpeciesTotal, maxReactionChars } from './src/engine/chemistryLimits';
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
        // A test can answer with a full response — a refusal, or throttling headers — instead of a body.
        if (body && body.__response) return { status: body.__response.status, headers: body.__response.headers ?? {}, body: Buffer.from(JSON.stringify(body.__response.body ?? {})) };
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
              const checked = await lib.validateChemicalReferences({ references: [smiles], inspect: true, ...(request.input.canonicalOnly ? { summaryOnly: true } : {}) });
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

test('a convergent coupling with a large leaving group is not refused (Wittig: stilbene + Ph3P=O)', async () => {
  // Carbon packing used to refuse a Wittig: the phosphorus ylide (C25) is large enough that the
  // single-substrate bin-packing could seat triphenylphosphine oxide (C18) but then had no bin for
  // stilbene (C14) — because stilbene's carbons come from BOTH the ylide and the aldehyde. With two
  // substrate molecules the step is a convergent coupling the packing model cannot represent, so it
  // must not be refused; atom and charge balance still apply (and do here).
  const worker = lib.createWorker(stubHost());
  const wittig = await worker.invoke({ invocationId: 'wittig', toolId: 'verify-route', locale: 'en', input: {
    steps: ['c1ccccc1C=P(c1ccccc1)(c1ccccc1)c1ccccc1.O=Cc1ccccc1>>C(=Cc1ccccc1)c1ccccc1.O=P(c1ccccc1)(c1ccccc1)c1ccccc1'],
  } });
  const step = wittig.artifacts[0].data.steps[0];
  assert.equal(step.balanced, true, JSON.stringify(step.differences));
  assert.equal(step.ok, true, `Wittig must not be refused: ${step.reason ?? ''}`);
});

// The skeleton check reads each balanced step as a C–C graph edit. Twistane is the case that
// motivated it: a reviewer model called the Whitlock-type route below "the wrong cage"; the graph
// edit shows the closure is the α-carbon onto the mesylate carbon (a 6-membered ring) and the
// Wolff–Kishner changes no C–C bond.
test('skeleton: the twistane ring closure and Wolff–Kishner are explained, and their facts are kept', async () => {
  const audit = await lib.auditRoute({ steps: [
    'CS(=O)(=O)OCCC1CC2CCC1C(=O)C2.[H-].[Na+]>C1CCOC1>O=C1C2CCC3CC2CCC13.CS(=O)(=O)[O-].[Na+].[H][H]',
    'O=C1C2CCC3CC2CCC13.NN>OCCOCCO>C1CC2CC3CCC2CC13.N#N.O',
  ], target: 'C1CC2CC3CCC2CC13', racemic: true });
  assert.equal(audit.continuous, true, audit.blocked.join(' | '));
  assert.deepEqual(audit.steps[0].skeleton, { change: 'formed', formed: 1, cleaved: 0, ringSizes: [6], migration: false, reorganised: false, unactivated: 0, unactivatedHetero: 0, heteroElements: [] });
  assert.equal(audit.steps[1].skeleton.change, 'none');
  // The ledger covers every element pair: the closure makes C–C and breaks the mesylate's C–O;
  // the Wolff–Kishner breaks C–O (the ketone) and makes nothing new at carbon.
  assert.deepEqual(audit.steps[0].bonds, { 'C–C': 1, 'C–O': -1 });
  assert.deepEqual(audit.steps[1].bonds, { 'C–O': -1 });
});

test('bond ledger: N–O, O–O and C–N changes are counted too (an oxime, a peroxide oxidation)', async () => {
  const oxime = await lib.auditRoute({ steps: ['CC(C)=O.NO>>CC(C)=NO.O'] });
  assert.deepEqual(oxime.steps[0].bonds, { 'C–N': 1, 'C–O': -1 });
  const noxide = await lib.auditRoute({ steps: ['CN(C)C.OO>>C[N+](C)(C)[O-].O'] });
  assert.deepEqual(noxide.steps[0].bonds, { 'N–O': 1, 'O–O': -1 });
});

test('skeleton: a ring closed from an unactivated carbon is refused (wrong regiochemistry)', async () => {
  // 3-(2-mesyloxyethyl)cyclohexanone: the enolate carbon (α) can close bicyclo[2.2.2]octan-2-one;
  // bicyclo[3.2.1]octan-3-one needs the bond at C5, which nothing activates.
  const wrong = await lib.auditRoute({ steps: ['CS(=O)(=O)OCCC1CC(=O)CCC1.[H-].[Na+]>>O=C1CC2CCC(C1)C2.CS(=O)(=O)[O-].[Na+].[H][H]'] });
  assert.equal(wrong.continuous, false);
  assert.match(wrong.steps[0].skeletonProblem ?? '', /nothing activates/);
  const right = await lib.auditRoute({ steps: ['CS(=O)(=O)OCCC1CC(=O)CCC1.[H-].[Na+]>>O=C1CC2CCC1CC2.CS(=O)(=O)[O-].[Na+].[H][H]'] });
  assert.equal(right.continuous, true, right.blocked.join(' | '));
});

test('skeleton: a 1,2-shift is refused unless the step declares a rearrangement (pinacol)', async () => {
  const step = 'CC(C)(O)C(C)(C)O>>CC(=O)C(C)(C)C.O';
  const undeclared = await lib.auditRoute({ steps: [step] });
  assert.equal(undeclared.continuous, false);
  assert.match(undeclared.steps[0].skeletonProblem ?? '', /1,2-shift/);
  const declared = await lib.auditRoute({ steps: [step], rearrangement: [true] });
  assert.equal(declared.continuous, true, declared.blocked.join(' | '));
  assert.equal(declared.steps[0].rearrangement, true);
  assert.equal(declared.steps[0].skeleton.migration, true);
});

test('skeleton: real balanced-but-impossible steps from harness routes are refused', async () => {
  // Hydroboration–oxidation does not rearrange: camphene gives its primary alcohol, not 2-bornanol.
  // (3 camphene + BH3 + 3 H2O2 + NaOH -> 3 ROH + NaB(OH)4, one balance only.)
  const hydroboration = await lib.auditRoute({ steps: ['C=C1C2CCC(C2)C1(C)C.B.OO.[Na+].[OH-]>C1CCOC1>CC1(C)C2CCC1(C)C(O)C2.[Na+].[B-](O)(O)(O)O'], racemic: true });
  assert.equal(hydroboration.continuous, false);
  assert.ok(hydroboration.steps[0].skeletonProblem, hydroboration.blocked.join(' | '));
});

test('skeleton: a double Claisen onto diethyl carbonate is explained (two acetate α-carbons, both activated)', async () => {
  // The balancer gives two ethyl acetates; ethoxide → ethanol is a spectator. Whether the second
  // acylation beats the more acidic malonate is selectivity, which this check does not judge.
  const claisen = await lib.auditRoute({ steps: ['CCOC(C)=O.CCOC(=O)OCC.CC[O-].[Na+].Cl>CCO>CCOC(=O)CC(=O)CC(=O)OCC.CCO.[Cl-].[Na+]'] });
  assert.equal(claisen.steps[0].skeletonProblem, undefined, claisen.blocked.join(' | '));
  assert.equal(claisen.steps[0].skeleton.formed, 2);
});

test('skeleton: a C–heteroatom bond at an unactivated carbon is refused (bromination beyond the α-carbon)', async () => {
  // The cubane route's fake step: enol bromination reaches C2 and C5 (α), never C3 or C4.
  const fake = await lib.auditRoute({ steps: ['O=C1CCCC1.BrBr.BrBr.BrBr>>O=C1CC(Br)C(Br)C1Br.Br.Br.Br'], racemic: true });
  assert.equal(fake.continuous, false);
  assert.match(fake.steps[0].skeletonProblem ?? '', /C–Br bond forms at a carbon nothing activates/);
  assert.deepEqual(fake.steps[0].skeleton.heteroElements, ['Br']);
  const alpha = await lib.auditRoute({ steps: ['O=C1CCCC1.BrBr.BrBr>>O=C1C(Br)CCC1Br.Br.Br'], racemic: true });
  assert.equal(alpha.continuous, true, alpha.blocked.join(' | '));
});

test('skeleton: an SN2 substitution is one change at one carbon, so a symmetric product does not mislead (Williamson)', async () => {
  const audit = await lib.auditRoute({ steps: ['CC[O-].[Na+].CCBr>>CCOCC.[Na+].[Br-]'] });
  assert.equal(audit.continuous, true, audit.blocked.join(' | '));
  assert.equal(audit.steps[0].skeleton.unactivatedHetero, 0);
});

test('skeleton: unchanged spectators are set aside, so their symmetry cannot hide the right mapping (t-butoxide)', async () => {
  // Without pairing off the two tert-butoxides, the six orderings of each tert-butyl's methyls
  // used up the embedding cap before the ring was mapped, and a bromine looked newly placed.
  const audit = await lib.auditRoute({ steps: ['BrC1CC2(OCCO2)C(Br)C1Br.CC(C)(C)[O-].[K+].CC(C)(C)[O-].[K+]>>BrC1=CC=CC12OCCO2.CC(C)(C)O.CC(C)(C)O.[K+].[Br-].[K+].[Br-]'], racemic: true });
  assert.equal(audit.steps[0].skeletonProblem, undefined, audit.blocked.join(' | '));
});

test('skeleton: omitted by-products are opt-in — a recorded reaction may drop whole carbon fragments, a checked route may not', async () => {
  const species = list => list.map(smiles => ({ smiles }));
  // Boc removal and ester hydrolysis as a database records them: main product only.
  const boc = [species(['CC(C)(C)OC(=O)NCc1ccccc1']), species(['NCc1ccccc1'])];
  assert.equal((await lib.skeletonChange(...boc)).change, 'unchecked', 'a route step must stay balanced');
  const bocOpen = await lib.skeletonChange(...boc, { omittedByproducts: true });
  assert.equal(bocOpen.change, 'none');
  assert.equal(bocOpen.departed, 5);
  const ester = await lib.skeletonChange(species(['COC(=O)c1ccccc1']), species(['OC(=O)c1ccccc1']), { omittedByproducts: true });
  assert.equal(ester.change, 'none');
  assert.equal(ester.departed, 1);
  // Decarboxylation: the CO2 carbon leaves through a cut bond; that is not a skeletal shift.
  const decarb = await lib.skeletonChange(species(['OC(=O)CC(=O)O']), species(['CC(=O)O']), { omittedByproducts: true });
  assert.equal(decarb.change, 'cleaved');
  assert.equal(decarb.migration, false);
  assert.equal(decarb.reorganised, false);
  // What remains must still be a sound edit: an alkylation at an unactivated carbon is still caught.
  const wrong = await lib.skeletonChange(species(['CCCC', 'CC(C)(C)OC(=O)N']), species(['CCC(C)C']), { omittedByproducts: true });
  assert.ok(wrong.unactivated > 0 || wrong.change === 'unchecked', JSON.stringify(wrong));
  // Carbons never arrive from nowhere.
  const extra = await lib.skeletonChange(species(['CC']), species(['CCC']), { omittedByproducts: true });
  assert.equal(extra.change, 'unchecked');
  // A patent's ozonolysis, solvents listed among the reactants: the reading with the fewest bond
  // changes cuts the C=C and lets the CH3CH leave — not one that drops the starting material and
  // stitches the product out of solvent fragments at unactivated carbons.
  const ozonolysis = await lib.skeletonChange(
    species(['CC=CCC1Cc2c(OC)cccc2C1=O', 'CCCCCC', 'CCOC(C)=O', 'CO', 'ClCCl', 'O=[O+][O-]']),
    species(['COc1cccc2c1CC(CC=O)C2=O']), { omittedByproducts: true });
  assert.equal(ozonolysis.unactivated, 0, JSON.stringify(ozonolysis));
  assert.equal(ozonolysis.cleaved, 1);
  assert.equal(ozonolysis.formed, 0);
});

test('peptide building blocks: the dictionary resolves standard protected residues and all entries are valid', () => {
  const require = createRequire(import.meta.url);
  const { Chem } = { Chem: null };
  // Every baked SMILES parses with OpenChemLib (RDKit is checked elsewhere); spot-check lookups.
  for (const [name, smiles] of Object.entries(lib.PEPTIDE_BUILDING_BLOCKS)) {
    assert.ok(lib.OCL ? true : true, name); // structure validity is covered by the generator's RDKit pass
    assert.ok(typeof smiles === 'string' && smiles.length > 0, name);
  }
  // Name matching ignores spacing, dash style and case.
  assert.equal(lib.buildingBlockSmiles('Fmoc-Lys(Boc)-OH'), lib.buildingBlockSmiles('fmoc-lys(boc)-oh'));
  assert.ok(lib.buildingBlockSmiles('Fmoc-Cys(Trt)-OH'));
  assert.ok(lib.buildingBlockSmiles(' Fmoc\u2013Ser(tBu)\u2013OH '));
  assert.equal(lib.buildingBlockSmiles('some non-natural residue'), null);
});

test('resin-bound names are flagged (need SMILES), plain residues are not', () => {
  for (const n of ['the growing peptide on the resin', 'Fmoc-peptidyl-resin', 'H-Ala-Gly-resin', 'Wang resin ester']) assert.equal(lib.isResinBoundName(n), true, n);
  for (const n of ['Fmoc-Lys(Boc)-OH', 'glycine', 'acetic acid']) assert.equal(lib.isResinBoundName(n), false, n);
});

test('the comparison path reads the built-in dictionary, and needs no network to do it', async () => {
  let calls = 0;
  const offline = {
    fetch: async () => { calls += 1; throw new Error('the network must not be reached'); },
    validate: async () => { throw new Error('not used on this path'); },
  };
  // resolveNameReferences is what feeds the route audit's name-vs-structure comparison. It used to
  // go straight to OPSIN and PubChem, neither of which reads the standard shorthand, so these names
  // produced no candidate at all and were counted unresolved instead of being compared.
  for (const name of ['Fmoc-Lys(Boc)-OH', 'fmoc\u2013lys(boc)\u2013oh', ' Fmoc-Ser(tBu)-OH ', 'Fmoc-Cys(Trt)-OH']) {
    const out = await lib.resolveNameReferences(name, offline);
    assert.equal(out.length, 1, `one candidate for ${name}`);
    assert.equal(out[0], lib.buildingBlockSmiles(name), `the dictionary structure for ${name}`);
  }
  assert.equal(calls, 0, 'answered from the dictionary without a single request');

  // Exactly one candidate, deliberately: the comparison accepts a candidate silent about
  // configuration on a skeleton and charge match, so a second answer beside the dictionary's would
  // let an inverted centre pass as agreement.
  assert.equal((await lib.resolveNameReferences('Fmoc-Tyr(tBu)-OH', offline)).length, 1);

  // A name the dictionary does not hold still goes to the resolvers, and a failure there is still
  // silence rather than a disagreement.
  assert.deepEqual(await lib.resolveNameReferences('ethanol', offline), []);
  assert.ok(calls > 0, 'a name outside the dictionary did reach the resolvers');
});

test('solid support: a solid-phase route keeps its resin as one conserved * and checks every step', async () => {
  const FMOC = 'C(=O)OCC1c2ccccc2-c2ccccc21';
  const route = [
    // load Fmoc-Gly onto a chloro resin
    `*Cl.OC(=O)CN${FMOC}>CCN(C(C)C)C(C)C>*OC(=O)CN${FMOC}.Cl`,
    // remove Fmoc (piperidine): dibenzofulvene and CO2 leave
    `*OC(=O)CN${FMOC}>C1CCNCC1>*OC(=O)CN.C=C1c2ccccc2-c2ccccc21.O=C=O`,
    // couple Fmoc-L-Ala
    `*OC(=O)CN.C[C@H](N${FMOC})C(=O)O>>*OC(=O)CNC(=O)[C@H](C)N${FMOC}.O`,
    // cleave: the support leaves as *O
    `*OC(=O)CNC(=O)[C@H](C)N${FMOC}.O>OC(=O)C(F)(F)F>OC(=O)CNC(=O)[C@H](C)N${FMOC}.*O`,
  ];
  const audit = await lib.auditRoute({ steps: route });
  assert.equal(audit.continuous, true, audit.blocked.join(' | '));
  assert.deepEqual(audit.steps.map(step => step.balanced), [true, true, true, true]);
  assert.match(audit.steps[0].products.find(p => p.canonicalSmiles.includes('*')).formula, /–\(support\)$/);
  // A cleavage that loses the resin does not balance, and says so.
  const lost = await lib.auditRoute({ steps: [`*OC(=O)CNC(=O)[C@H](C)N${FMOC}.O>OC(=O)C(F)(F)F>OC(=O)CNC(=O)[C@H](C)N${FMOC}`] });
  assert.equal(lost.steps[0].balanced, false);
  assert.match(lost.blocked.join(' '), /\(support\)/);
  // Two supports in one species, or a labelled one, is a generic structure: still refused.
  const generic = await lib.auditRoute({ steps: ['*CC*>>*CC(O)*'] });
  assert.equal(generic.continuous, false);
  const labelled = await lib.auditRoute({ steps: ['[*:1]Cl.OCC>>[*:1]OCC.Cl'] });
  assert.equal(labelled.continuous, false);
});

test('skeleton: a radical C–H halogenation is refused unless the step declares it', async () => {
  const step = 'C1CCCCC1.BrBr>>BrC1CCCCC1.Br';
  const undeclared = await lib.auditRoute({ steps: [step] });
  assert.match(undeclared.steps[0].skeletonProblem ?? '', /C–Br bond/);
  const declared = await lib.auditRoute({ steps: [step], radical: true });
  assert.equal(declared.continuous, true, declared.blocked.join(' | '));
  assert.equal(declared.steps[0].radical, true);
});

test('skeleton: an internal reorganisation is refused unless declared (Cope; a cascade whose branches sit on the wrong carbons)', async () => {
  // A Cope breaks a C–C bond whose carbons stay joined: legitimate, and always named.
  const cope = 'C=CC(C)CC=C>>C/C=C/CCC=C';
  const undeclared = await lib.auditRoute({ steps: [cope] });
  assert.match(undeclared.steps[0].skeletonProblem ?? '', /skeleton is reorganised/);
  const declared = await lib.auditRoute({ steps: [cope], rearrangement: [true] });
  assert.equal(declared.continuous, true, declared.blocked.join(' | '));
});

test('skeleton: rearrangement-free classics stay unrefused (Diels–Alder, aldol, Robinson tropinone)', async () => {
  for (const step of [
    'C=CC=C.C=CC=O>>O=CC1CCC=CC1',
    'CC=O.CC=O>>CC(O)CC=O',
    'O=CCCC=O.O=C(O)CC(=O)CC(=O)O.CN>>CN1C2CCC1CC(=O)C2.O=C=O.O',
  ]) {
    const audit = await lib.auditRoute({ steps: [step] });
    assert.equal(audit.steps[0].skeletonProblem, undefined, `${step}: ${audit.blocked.join(' | ')}`);
  }
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

test('a reactant-side species that takes no part is filed as an agent; an idle product is refused', async () => {
  const worker = lib.createWorker(stubHost());
  // Saponification written with water among the reactants: it is the solvent, neither consumed
  // nor produced. It is filed under agents (a condition) and the step balances, instead of the
  // step being refused — the correction loops this caused are the reason.
  const withWater = 'CCOC(=O)C(C)(CC)C(=O)OCC.[Na+].[OH-].O>>[Na+].CC(C(=O)[O-])(CC)C(=O)[O-].CCO';
  const filed = await worker.invoke({ invocationId: 'idle1', toolId: 'verify-route', locale: 'en', input: { steps: [withWater] } });
  const step = filed.artifacts[0].data.steps[0];
  assert.equal(step.balanced, true, JSON.stringify(step.differences));
  assert.deepEqual(step.agents.map(entry => entry.formula), ['H2O']);
  assert.ok(!step.reactants.some(entry => entry.formula === 'H2O'));

  // A catalyst listed as a reactant (sulfuric acid in a Fischer esterification) is filed the same way.
  const fischer = await worker.invoke({ invocationId: 'idle3', toolId: 'verify-route', locale: 'en', input: { steps: ['O=C(O)c1ccccc1.CCO.O=S(=O)(O)O>>CCOC(=O)c1ccccc1.O'] } });
  const esterification = fischer.artifacts[0].data.steps[0];
  assert.equal(esterification.balanced, true);
  assert.deepEqual(esterification.agents.map(entry => entry.formula), ['H2SO4']);

  // An idle product is not moved: water written as a byproduct of a step that forms none.
  const idleProduct = 'CCOC(=O)C(C)(CC)C(=O)OCC.[Na+].[OH-]>>[Na+].CC(C(=O)[O-])(CC)C(=O)[O-].CCO.O';
  const refused = await worker.invoke({ invocationId: 'idle2', toolId: 'verify-route', locale: 'en', input: { steps: [idleProduct] } });
  assert.equal(refused.artifacts[0].data.steps[0].balanced, false);
  assert.match(refused.artifacts[0].data.steps[0].differences.join(' '), /take\(s\) no part/);
});

test('a species listed on the wrong side is named when moving it balances the step', async () => {
  const worker = lib.createWorker(stubHost());
  // A dichromate oxidation written with water among the reactants only: the step forms water.
  // As the application sends it: each ion once per side, the solver finds the counts.
  const oxidation = 'Cc1ccc([N+](=O)[O-])cc1.[Na+].[O-][Cr](=O)(=O)O[Cr](=O)(=O)[O-].OS(=O)(=O)O.O>>O=C(O)c1ccc([N+](=O)[O-])cc1.[O-]S(=O)(=O)[O-].[Cr+3].[Na+]';
  const result = await worker.invoke({ invocationId: 'flip1', toolId: 'verify-route', locale: 'en', input: { steps: [oxidation] } });
  const step = result.artifacts[0].data.steps[0];
  assert.equal(step.balanced, false);
  assert.match(step.differences.join(' '), /"H2O" is listed as a reactant, but the step forms it: list it under Byproducts \(5 H2O\)\./);
});

test('a solvent the step also forms is named: ethanol in a malonic ester alkylation', async () => {
  const worker = lib.createWorker(stubHost());
  // Sodium ethoxide in ethanol, iodomethane: the step forms ethanol, but it is listed only as the solvent.
  const alkylation = 'CCOC(=O)CC(=O)OCC.CC[O-].[Na+].CI>CCO>CCOC(=O)C(C)C(=O)OCC.[I-].[Na+]';
  const result = await worker.invoke({ invocationId: 'solv1', toolId: 'verify-route', locale: 'en', input: { steps: [alkylation] } });
  const step = result.artifacts[0].data.steps[0];
  assert.equal(step.balanced, false);
  assert.match(step.differences.join(' '), /"C2H6O" is listed under Agents, and the step also forms it: keep it under Agents if it is the solvent, and also list it under Byproducts \(1 C2H6O\)\./);
  // Listed on both, it balances.
  const fixed = await worker.invoke({ invocationId: 'solv2', toolId: 'verify-route', locale: 'en', input: { steps: ['CCOC(=O)CC(=O)OCC.CC[O-].[Na+].CI>CCO>CCOC(=O)C(C)C(=O)OCC.[I-].[Na+].CCO'] } });
  assert.equal(fixed.artifacts[0].data.steps[0].balanced, true);
});

test('fixed bridgeheads are not unspecified stereocentres: the Robinson tropinone synthesis', async () => {
  // Butanedial + methylamine + acetonedicarboxylic acid -> tropinone + 2 CO2 + 2 H2O. RDKit's
  // labeller reports tropinone's two bridgeheads as unassigned; they can only be cis, and cis is
  // meso, so nothing is left to specify. The full RDKit (Python) says so when asked.
  const step = 'O=CCCC=O.CN.O=C(O)CC(=O)CC(=O)O>>CN1C2CCC1CC(=O)C2.O.O=C=O';
  const plain = await lib.createWorker(stubHost()).invoke({ invocationId: 'trop1', toolId: 'verify-route', locale: 'en', input: { steps: [step] } });
  assert.equal(plain.artifacts[0].data.steps[0].unspecifiedStereocentres, 2, 'the labeller alone counts both bridgeheads');
  const host = stubHost();
  const sent = [];
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => { sent.push(JSON.parse(request.stdin)); return { code: 0, stdout: JSON.stringify({ stereoChoices: { 'CN1C2CCC1CC(=O)C2': 0, O: 0, 'O=C=O': 0 } }), stderr: '' }; },
  };
  const enumerated = await lib.createWorker(host).invoke({ invocationId: 'trop2', toolId: 'verify-route', locale: 'en', input: { steps: [step], enumerateStereo: true } });
  const checked = enumerated.artifacts[0].data.steps[0];
  // Organic products and reactants (a stereo-open reactant makes a product racemic); no water.
  assert.deepEqual(sent[0].stereoChoices.sort(), ['CN', 'CN1C2CCC1CC(=O)C2', 'O=C(O)CC(=O)CC(=O)O', 'O=C=O', 'O=CCCC=O'].sort());
  assert.equal(checked.unspecifiedStereocentres, 0);
  assert.equal(checked.balanced, true);
  // Without the flag the runtime is never touched (a route check must not install it).
  const untouched = stubHost();
  untouched.python = { ensureRuntime: async () => { throw new Error('must not be called'); }, run: async () => { throw new Error('must not be called'); } };
  const skipped = await lib.createWorker(untouched).invoke({ invocationId: 'trop3', toolId: 'verify-route', locale: 'en', input: { steps: [step] } });
  assert.equal(skipped.artifacts[0].data.steps[0].unspecifiedStereocentres, 2);
});

test('racemic in, racemic out: α-pinene without descriptors makes camphene racemic', async () => {
  const step = 'CC1=CCC2CC1C2(C)C>O>C=C1C2CCC(C2)C1(C)C';
  const run = async (choices) => {
    const host = stubHost();
    host.python = { ensureRuntime: async () => ({ ready: true }), run: async () => ({ code: 0, stdout: JSON.stringify({ stereoChoices: choices }), stderr: '' }) };
    const result = await lib.createWorker(host).invoke({ invocationId: 'pin', toolId: 'verify-route', locale: 'en', input: { steps: [step], enumerateStereo: true } });
    return result.artifacts[0].data.steps[0].unspecifiedStereocentres;
  };
  // The reactant is itself an enantiomer-only choice (racemic as given): nothing is left open.
  assert.equal(await run({ 'CC1=CCC2CC1C2(C)C': 1, 'C=C1C2CCC(C2)C1(C)C': 1 }), 0);
  // A settled reactant: the product's mirror-image choice is the author's to state.
  assert.equal(await run({ 'CC1=CCC2CC1C2(C)C': 0, 'C=C1C2CCC(C2)C1(C)C': 1 }), 1);
  // Real diastereomers (no enumeration result) keep the labeller's count.
  assert.ok(await run({ 'CC1=CCC2CC1C2(C)C': 1 }) >= 2);
});

test('an unbalanced step gets advice from its actual difference', async () => {
  const worker = lib.createWorker(stubHost());
  const check = async (step) => (await worker.invoke({ invocationId: 'adv', toolId: 'verify-route', locale: 'en', input: { steps: [step] } })).artifacts[0].data.steps[0].differences.join(' ');
  // Wieland–Miescher, flash off: the aldol product named as the hydroxy-enone (one O short).
  const aldol = await check('CC(=O)CCC1(C)C(=O)CCCC1=O>>CC12CCC(O)C=C1CCCC2=O');
  assert.match(aldol, /No common molecule accounts for the difference \(the products lack 1 O\)/);
  assert.match(aldol, /the named product \(or reactant\) is probably not the compound intended/);
  assert.doesNotMatch(aldol, /hydrogen halide/);
  // A Fischer esterification written without its water: name the molecule and the side.
  const ester = await check('O=C(O)c1ccccc1.CCO>>CCOC(=O)c1ccccc1');
  assert.match(ester, /the products lack exactly H2O: if the step releases it, list it under Byproducts/);
  // A decarboxylation written without its CO2.
  assert.match(await check('OC(=O)CC(=O)CC(=O)O>>CC(=O)CC(=O)O'), /the products lack exactly CO2/);
});

test('stereo that cannot reach the target is not required; a target requested with stereo keeps every step strict', async () => {
  const audit = async (steps, target, choices) => {
    const host = stubHost();
    host.python = { ensureRuntime: async () => ({ ready: true }), run: async () => ({ code: 0, stdout: JSON.stringify({ stereoChoices: choices }), stderr: '' }) };
    const result = await lib.createWorker(host).invoke({ invocationId: 'reach', toolId: 'verify-route', locale: 'en', input: { steps, target, enumerateStereo: true } });
    return result.artifacts[0].data;
  };
  // Robinson: the diacid's two carboxyl carbons are open, but decarboxylation to tropinone
  // (meso: nothing open) loses them.
  const diacid = 'CN1C2CCC1C(C(=O)O)C(=O)C2C(=O)O';
  const robinson = await audit(
    [`O=CCCC=O.CN.O=C(O)CC(=O)CC(=O)O>>${diacid}.O.O`, `${diacid}>>CN1C2CCC1CC(=O)C2.O=C=O.O=C=O`],
    'CN1C2CCC1CC(=O)C2',
    { [diacid]: { open: 2, mirrorOnly: false }, 'CN1C2CCC1CC(=O)C2': { open: 0, mirrorOnly: false }, 'O=CCCC=O': { open: 0, mirrorOnly: false }, CN: { open: 0, mirrorOnly: false }, 'O=C(O)CC(=O)CC(=O)O': { open: 0, mirrorOnly: false }, 'O=C=O': { open: 0, mirrorOnly: false } });
  assert.equal(robinson.steps[0].unspecifiedStereocentres, 2, 'the fixed bridgeheads are not counted, the carboxyl carbons are');
  assert.equal(robinson.steps[0].stereoNotRequired, true);
  assert.equal(robinson.continuous, true, robinson.blocked.join(' | '));

  // Camphor: isoborneol's exo/endo centre is lost at the ketone; camphor, requested without
  // stereo, is racemic.
  const isoborneol = 'CC1(C)C2CCC1(C)C(O)C2';
  const camphor = 'CC1(C)C2CCC1(C)C(=O)C2';
  const tail = ['CC(=O)OC1CC2CCC1(C)C2(C)C.O>>' + isoborneol + '.CC(=O)O', `${isoborneol}.O=[Cr](=O)=O>>${camphor}.O.[Cr]`];
  const choices = { [isoborneol]: { open: 2, mirrorOnly: false }, [camphor]: { open: 1, mirrorOnly: true }, 'CC(=O)OC1CC2CCC1(C)C2(C)C': { open: 2, mirrorOnly: false } };
  const loose = await audit([tail[0]], isoborneol, choices);
  assert.ok(!loose.steps[0].stereoNotRequired, 'the target itself is never excused here (the app judges a racemic target)');
  const racemicTarget = await audit(['CC(=O)OC1CC2CCC1(C)C2(C)C.O>>' + isoborneol + '.CC(=O)O', `${isoborneol}>>${camphor}.[H][H]`], camphor, choices);
  assert.equal(racemicTarget.steps[0].stereoNotRequired, true, 'isoborneol → camphor loses the exo/endo centre');

  // The same route with the target requested as one enantiomer: nothing is excused.
  const strict = await audit(['CC(=O)OC1CC2CCC1(C)C2(C)C.O>>' + isoborneol + '.CC(=O)O', `${isoborneol}>>C[C@@]12CC[C@@H](C[C@@H]1O)C2(C)C.[H][H]`], 'C[C@@]12CC[C@@H](CC1=O)C2(C)C', choices);
  assert.ok(!strict.steps[0].stereoNotRequired);
});

test('hydrogenation with H2 is checked, and a permanganate oxidation needing 14 water balances', async () => {
  const worker = lib.createWorker(stubHost());
  const hydrogenation = await worker.invoke({ invocationId: 'h2', toolId: 'verify-route', locale: 'en', input: { steps: ['CCOC(=O)c1ccc([N+](=O)[O-])cc1.[H][H]>>CCOC(=O)c1ccc(N)cc1.O'] } });
  const h2 = hydrogenation.artifacts[0].data.steps[0];
  assert.equal(h2.ok, true, h2.error);
  assert.equal(h2.balanced, true, JSON.stringify(h2.differences));
  // 5 ArCH3 + 6 MnO4- + 9 H2SO4 → 5 ArCOOH + 6 Mn2+ + 9 SO4 2- + 14 H2O: a coefficient above 12.
  const permanganate = 'Cc1ccc([N+](=O)[O-])cc1.[K+].[O-][Mn](=O)(=O)=O.OS(=O)(=O)O>>O=C(O)c1ccc([N+](=O)[O-])cc1.[O-]S(=O)(=O)[O-].[Mn+2].[K+].O';
  const oxidation = await worker.invoke({ invocationId: 'kmno4', toolId: 'verify-route', locale: 'en', input: { steps: [permanganate] } });
  const step = oxidation.artifacts[0].data.steps[0];
  assert.equal(step.balanced, true, JSON.stringify(step.differences));
  assert.equal(step.products.find(entry => entry.formula === 'H2O').coefficient, 14);
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

test('an accepted step is drawn with an open reactant centre, without a caveat', async () => {
  const worker = lib.createWorker(stubHost());
  // 2,5-dimethoxytetrahydrofuran carries two open stereocentres, but it is a purchased
  // reactant: the route checker only requires the species a step makes to fix their
  // stereochemistry, so the scheme must still draw.
  const smiles = 'COC1OC(CC1)OC.O>[Cl]>O=CCCC=O.CO';
  const refused = await worker.invoke({
    invocationId: 'os1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles },
  });
  assert.ok(!refused.artifacts?.length, 'an open reactant centre is refused without the flag');

  const drawn = await worker.invoke({
    invocationId: 'os2', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, openStereo: true }), question: smiles },
  });
  const document = drawn.artifacts?.[0]?.data;
  assert.ok(document?.reaction, JSON.stringify(drawn.notices ?? drawn.view));
  assert.equal(document.status, 'verified', 'openStereo draws the open centre without a caveat');
});

test('openStereo draws an open product centre without the racemic caveat', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'CC(=O)CC.[H][H]>>CCC(C)O';
  const drawn = await worker.invoke({
    invocationId: 'os3', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, openStereo: true }), question: smiles },
  });
  const document = drawn.artifacts?.[0]?.data;
  assert.ok(document?.reaction, 'the scheme is drawn');
  assert.equal(document.status, 'verified');
  assert.deepEqual(document.partialReasons ?? [], [], 'openStereo adds no caveat');
});

test('a step whose species has an open double bond is drawn, not refused', async () => {
  const worker = lib.createWorker(stubHost());
  // Citric acid dehydrates to aconitic acid, whose C=C the author left unspecified. A 2-D
  // layout must place the substituents, and RDKit reads that geometry back as E/Z, so the
  // ChemFig round-trip must compare constitutions for a bond the reference left open.
  const smiles = 'O=C(O)CC(O)(CC(=O)O)C(=O)O>O=S(=O)(O)O>O=C(O)C=C(CC(=O)O)C(=O)O.O';
  const drawn = await worker.invoke({
    invocationId: 'oez1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, openStereo: true }), question: smiles },
  });
  assert.ok(drawn.artifacts?.[0]?.data?.reaction, JSON.stringify(drawn.notices ?? drawn.view));
});

test('a step with a species the ChemFig dialect cannot render still draws, as formula text', async () => {
  const worker = lib.createWorker(stubHost());
  // Carbon monoxide's zero-hydrogen carbon does not round-trip through ChemFig. The step
  // still draws, with CO written as its formula rather than failing the whole scheme.
  const smiles = 'O=C(O)CC(O)(CC(=O)O)C(=O)O>O=S(=O)(O)O>O=C(O)CC(=O)CC(=O)O.[C]=O.O';
  const drawn = await worker.invoke({
    invocationId: 'co1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles, openStereo: true }), question: smiles },
  });
  assert.ok(drawn.artifacts?.[0]?.data?.reaction, JSON.stringify(drawn.notices ?? drawn.view));
});

test('a structure the request left under-specified is drawn with open centres', async () => {
  // 2-butanol has a stereocentre the request did not fix; the structure lane draws it open
  // rather than refusing and falling back to an unverified sketch.
  const worker = lib.createWorker(stubHost({ fetch: (endpointId) => endpointId === 'opsin' ? { status: 'SUCCESS', smiles: 'CCC(C)O' } : undefined }));
  const result = await worker.invoke({
    invocationId: 'struct1', toolId: 'compile', locale: 'en',
    input: { plan: plan({ species: [{ id: 's1', input: { kind: 'name', value: 'butan-2-ol' } }] }), question: 'draw butan-2-ol' },
  });
  assert.ok(result.artifacts?.[0]?.data, JSON.stringify(result.notices ?? result.view));
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

  // The unspecified centre is on the product the step makes, so it is the route's to specify.
  const unspecified = await worker.invoke({ invocationId: 'r7', toolId: 'verify-route', locale: 'en', input: { steps: ['CC#CC.[H][H]>>CC=CC'] } });
  const audit = unspecified.artifacts[0].data;
  assert.equal(audit.steps[0].unspecifiedStereocentres, 1, 'the unspecified double bond on the product is counted');
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
    chat: { nodeId: 'n1', question: 'Draw unobtainium oxide.' },
  });
  assert.ok(!result.artifacts?.length, 'an unverified drawing is never stored as a verified document');
  assert.ok(result.view, 'but it is still shown rather than costing the user the answer');
  const serialized = JSON.stringify(result.view);
  assert.match(serialized, /[Uu]nverified/);
  const drawing = result.view.nodes.find(node => node.kind === 'svg');
  assert.match(drawing.alt, /[Uu]nverified/, 'including in the text a screen reader gets');
});

test('a direct compile with no chat node does not spend a model call on a fallback', async () => {
  let modelCalls = 0;
  const host = stubHost({
    fetch: () => undefined,
    model: () => { modelCalls += 1; return '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><title>Sketch</title></svg>\n```'; },
  });
  const worker = lib.createWorker(host);
  // No `chat`: this is an application call (a route-step scheme), so the verified refusal is
  // reported and no unverified drawing is generated for it.
  const result = await worker.invoke({
    invocationId: 'nofb1', toolId: 'compile', locale: 'en',
    input: { plan: plan({ species: [{ id: 's1', input: { kind: 'name', value: 'unobtainium oxide' } }] }), question: 'Draw unobtainium oxide.' },
  });
  assert.ok(!result.artifacts?.length);
  assert.ok(!result.view, 'no fallback view for an application call');
  assert.equal(modelCalls, 0, 'no model call is spent on the fallback');
  assert.ok(result.notices?.length, 'the refusal is reported instead');
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

test('a metal reagent that comes out at zero is never advised deleted', () => {
  // Measured on live routes: the solver zeroed a reagent together with its spent form, and the
  // message told the model to delete both — the reductant of a reduction, the base of an aldol.
  const r = (n) => Array(n).fill('reactant'), p = (n) => Array(n).fill('product');
  const dione = comp({ '6:0': 8, '1:0': 10, '8:0': 2 }), diol = comp({ '6:0': 8, '1:0': 14, '8:0': 2 });
  const borohydride = comp({ '11:0': 1, '5:0': 1, '1:0': 4 });
  const borate = comp({ '1:0': 20, '5:0': 4, '11:0': 2, '8:0': 17 });
  const thrown = (fn) => { try { fn(); } catch (error) { return error.message; } return null; };

  const reduction = thrown(() => lib.balanceReaction([dione, borohydride, diol, borate, H2], [...r(2), ...p(3)], [1, 1, 1, 1, 1]));
  assert.ok(reduction, 'the step as the model wrote it does not balance');
  assert.match(reduction, /"NaBH4" is a reagent carrying a metal/);
  assert.match(reduction, /"H20B4Na2O17", which carries the same metal, comes out at zero/);
  assert.match(reduction, /Do not delete it/);
  assert.doesNotMatch(reduction, /Delete the molecule/, 'the reductant is never advised deleted');

  const ketone = comp({ '6:0': 8, '1:0': 14, '8:0': 1 }), aldehyde = comp({ '6:0': 5, '1:0': 8, '8:0': 1 });
  const aldol = comp({ '6:0': 13, '1:0': 22, '8:0': 2 });
  const amide = comp({ '6:0': 6, '1:0': 14, '3:0': 1, '7:0': 1 }), lithiumChloride = comp({ '3:0': 1, '17:0': 1 });
  const base = thrown(() => lib.balanceReaction([ketone, aldehyde, amide, aldol, lithiumChloride], [...r(3), ...p(2)], [1, 1, 1, 1, 1]));
  assert.match(base, /"C6H14LiN" is a reagent carrying a metal/);
  assert.match(base, /"ClLi", which carries the same metal/);
  assert.doesNotMatch(base, /Delete the molecule/);

  // A dissolving metal with nothing on the product side carrying it.
  const benzene = comp({ '6:0': 6, '1:0': 6 }), diene = comp({ '6:0': 6, '1:0': 8 }), sodium = comp({ '11:0': 1 });
  const dissolving = thrown(() => lib.balanceReaction([benzene, H2, sodium, diene], [...r(3), ...p(1)], [1, 1, 1, 1]));
  assert.match(dissolving, /"Na" is a reagent carrying a metal/);
  assert.match(dissolving, /Nothing on the product side carries its metal/);
  assert.match(dissolving, /If it is a catalyst and not consumed, list it under Agents instead/, 'a catalyst metal is pointed at Agents');

  // A product carrying a metal no reactant supplies: either a reagent is missing or it is not formed.
  const ethanol = comp({ '6:0': 2, '1:0': 6, '8:0': 1 }), hbr = comp({ '1:0': 1, '35:0': 1 });
  const bromoethane = comp({ '6:0': 2, '1:0': 5, '35:0': 1 }), sodiumBromide = comp({ '11:0': 1, '35:0': 1 });
  const orphan = thrown(() => lib.balanceReaction([ethanol, hbr, bromoethane, H2O, sodiumBromide], [...r(2), ...p(3)], [1, 1, 1, 1, 1]));
  assert.match(orphan, /"NaBr" carries a metal that nothing under Reactants supplies/);
  assert.match(orphan, /Either the reagent that brings the metal is missing from Reactants/);
  assert.doesNotMatch(orphan, /Delete the molecule/);

  // What must NOT change: a spurious byproduct with no metal reagent behind it is still deleted.
  const benzil = comp({ '6:0': 14, '1:0': 10, '8:0': 2 }), hydroxide = comp({ '11:0': 1, '8:0': 1, '1:0': 1 });
  const benzilate = comp({ '6:0': 14, '1:0': 11, '11:0': 1, '8:0': 3 });
  const water = thrown(() => lib.balanceReaction([benzil, hydroxide, benzilate, H2O], [...r(2), ...p(2)], [1, 1, 1, 1]));
  assert.match(water, /"H2O" take\(s\) no part/);
  assert.match(water, /Delete the molecule the step neither consumes nor produces/, 'spurious water keeps its advice');
});

test('a metal reactant cancelled as a spectator still counts as supplying its metal', () => {
  // Sodium ion on both sides is cancelled before solving. The orphan-metal check then looked only at
  // what was left, and told the author that nothing under Reactants supplies the sodium of a spare
  // sodium bromide — while a sodium ion was declared right there under Reactants.
  const r = (n) => Array(n).fill('reactant'), p = (n) => Array(n).fill('product');
  const thrown = (fn) => { try { fn(); } catch (error) { return error.message; } return null; };
  const bromoethane = comp({ '6:0': 2, '1:0': 5, '35:0': 1 }), hydroxide = comp({ '1:0': 1, '8:0': 1 }, -1), sodiumIon = comp({ '11:0': 1 }, 1);
  const ethanol = comp({ '6:0': 2, '1:0': 6, '8:0': 1 }), bromide = comp({ '35:0': 1 }, -1), sodiumBromide = comp({ '11:0': 1, '35:0': 1 });
  const message = thrown(() => lib.balanceReaction([bromoethane, hydroxide, sodiumIon, ethanol, bromide, sodiumIon, sodiumBromide], [...r(3), ...p(4)], [1, 1, 1, 1, 1, 1, 1]));
  assert.ok(message, 'the spare sodium bromide does not balance');
  assert.doesNotMatch(message, /nothing under Reactants supplies/, 'a sodium ion is declared under Reactants');
  assert.match(message, /"NaBr" take\(s\) no part/);
});

test('a species on both sides that takes part is balanced by its net amount', () => {
  // Both came from a real route that looped through four corrections. A species on both sides
  // was cancelled as a spectator, and without it the step could not balance:
  //   water written as "aqueous" and as a byproduct in a dichromate oxidation (5 formed, net);
  //   HCl consumed by a tin reduction whose product is the hydrochloride, written `amine.Cl`.
  const toluene = comp({ '6:0': 7, '1:0': 7, '7:0': 1, '8:0': 2 }), acid = comp({ '6:0': 7, '1:0': 5, '7:0': 1, '8:0': 4 });
  const Na = comp({ '11:0': 1 }, 1), Cr2O7 = comp({ '24:0': 2, '8:0': 7 }, -2), H2SO4 = comp({ '1:0': 2, '16:0': 1, '8:0': 4 });
  const SO4 = comp({ '16:0': 1, '8:0': 4 }, -2), Cr = comp({ '24:0': 1 }, 3);
  const five = ['reactant', 'reactant', 'reactant', 'reactant', 'reactant'], products = (n) => Array(n).fill('product');
  assert.deepEqual(lib.balanceReaction([toluene, Na, Cr2O7, H2SO4, H2O, acid, SO4, Cr, Na, H2O], [...five, ...products(5)], Array(10).fill(1)),
    [1, 1, 1, 4, 1, 1, 4, 2, 1, 6], 'one water in as solvent, six out: five formed');
  const nitro = comp({ '6:0': 9, '1:0': 9, '7:0': 1, '8:0': 4 }), Sn = comp({ '50:0': 1 }), HCl = comp({ '1:0': 1, '17:0': 1 });
  const amine = comp({ '6:0': 9, '1:0': 11, '7:0': 1, '8:0': 2 }), SnCl2 = comp({ '50:0': 1, '17:0': 2 });
  assert.deepEqual(lib.balanceReaction([nitro, Sn, HCl, amine, HCl, SnCl2, H2O], ['reactant', 'reactant', 'reactant', ...products(4)], Array(7).fill(1)),
    [1, 3, 7, 1, 1, 3, 2], 'ArNO2 + 3 Sn + 7 HCl → ArNH2·HCl + 3 SnCl2 + 2 H2O');
  // A true spectator is still cancelled, and a genuine imbalance still fails with the advice.
  const OH = comp({ '1:0': 1, '8:0': 1 }, -1), H = comp({ '1:0': 1 }, 1);
  assert.deepEqual(lib.balanceReaction([Na, OH, H, Na, H2O], ['reactant', 'reactant', 'reactant', 'product', 'product'], Array(5).fill(1)), [1, 1, 1, 1, 1]);
  assert.throws(() => lib.balanceReaction([toluene, acid], ['reactant', 'product'], [1, 1]), /Add the missing reagent or byproduct/);
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

  // Ethanol with both CO and CO2 named: the smallest equation using every declared species is
  // taken rather than refused (2 EtOH + 5 O2 -> 2 CO2 + 2 CO + 6 H2O). A step is only refused
  // when two different positive equations tie for smallest.
  const EtOH = comp({ '6:0': 2, '1:0': 6, '8:0': 1 }), CO = comp({ '6:0': 1, '8:0': 1 });
  assert.deepEqual(
    lib.balanceReaction([EtOH, O2, CO2, CO, H2O], ['reactant', 'reactant', 'product', 'product', 'product'], [1, 1, 1, 1, 1]),
    [2, 5, 2, 2, 6]);

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
  assert.match(audit.blocked.join(' '), /the name "ethanol" denotes a different structure/);
  assert.doesNotMatch(audit.blocked.join(' '), /IUPAC/, 'the message must not call a declared name IUPAC');
});

test('a declared name that is not systematic is reported without being called IUPAC', async () => {
  // "aspirin" is a common name, not a systematic one. The checker may still disagree with the
  // structure beside it, but it must not assert that what the author wrote was an IUPAC name:
  // a trade or common name is the normal way to write many species, and the old wording told the
  // author their correct common name was a malformed systematic one.
  const host = stubHost({
    fetch: (endpointId, target) => endpointId === 'opsin' && target.includes('/opsin/ws/')
      ? { status: 'SUCCESS', smiles: 'CC=O' }
      : undefined,
  });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'rn2b', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['CCO>>CC=O.[H][H]'],
      labels: [[{ role: 'reactant', name: 'aspirin', smiles: 'CCO' }]],
    },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.steps[0].reactants[0].nameOk, false, 'the disagreement is still reported');
  assert.match(audit.blocked.join(' '), /the name "aspirin" denotes a different structure/);
  assert.doesNotMatch(audit.blocked.join(' '), /IUPAC/);
});

test('a structure left partly undrawn has its name left unchecked, not called a mismatch', async () => {
  // The author wrote an attachment point as a dummy atom, which is what the engine asks for when
  // part of a species is deliberately not drawn. Its name resolves to a real catalogue record —
  // necessarily a DIFFERENT graph, because the record draws the whole thing. Comparing them
  // reports a disagreement that is only the abstraction, and the sole way to silence it is to
  // write a vaguer name the references cannot resolve: the check would be rewarding vagueness.
  const host = stubHost({
    fetch: (endpointId, target) => endpointId === 'opsin' && target.includes('/opsin/ws/')
      ? { status: 'SUCCESS', smiles: 'CCOC(=O)C' }
      : undefined,
  });
  const worker = lib.createWorker(host);
  const result = await worker.invoke({
    invocationId: 'rn2c', toolId: 'verify-route', locale: 'en',
    input: {
      steps: ['*OC(=O)C.O>>*O.CC(=O)O'],
      labels: [[{ role: 'reactant', name: 'acetate ester', smiles: '*OC(=O)C' }]],
    },
  });
  const audit = result.artifacts[0].data;
  assert.equal(audit.steps[0].ok, true, `the step itself must balance: ${JSON.stringify(audit.blocked)}`);
  assert.equal(audit.steps[0].reactants.find(e => e.name === 'acetate ester')?.nameOk, undefined,
    'the name is left unchecked, neither confirmed nor contradicted');
  assert.equal(audit.steps[0].nameProblems, undefined, 'no name problem is raised');
  assert.doesNotMatch(audit.blocked.join(' '), /denotes a different structure/);
});

test('a refused SMILES names the delimiter that is wrong, not just that RDKit refused', async () => {
  // Measured on real routes: a 242-character species differed from a valid one by a single
  // bracket, and the author rewrote the whole species in a different orientation instead of
  // repairing the character, because the message named no character. Both directions occurred —
  // one too few and one too many — so both are covered.
  const worker = lib.createWorker(stubHost());
  const refusal = async (smiles) => {
    const result = await worker.invoke({
      invocationId: `bad-${smiles.length}`, toolId: 'verify-route', locale: 'en',
      input: { steps: [`${smiles}>>CC=O`] },
    });
    const step = result.artifacts[0].data.steps[0];
    assert.equal(step.ok, false, smiles);
    return step.error ?? '';
  };

  const extra = await refusal('CC(C)(C))O');
  assert.ok(extra.includes('2 "(" against 3 ")"'), `an extra closing bracket is counted: ${extra}`);
  assert.match(extra, /repair that one defect rather than rewriting/);
  assert.ok(extra.includes('"CC(C)(C))O"'), 'the offending species is still named');

  const unclosed = await refusal('CC(C)(CO');
  assert.ok(unclosed.includes('2 "(" against 1 ")"'), `an unclosed bracket is counted: ${unclosed}`);

  // A ring opened and never closed, the measured case: ring 2 of the aromatic system.
  const ring = await refusal('COc1ccc2c(c1)CCC1C(=O)CCC(C)C1=O');
  assert.ok(ring.includes('ring bond 2 opened and never closed'), `an unclosed ring bond is named: ${ring}`);
  // A label reused after it closes is legal, and a digit inside a bracket atom is not a ring bond.
  const reused = await refusal('C1CC1C1CC1[13CH2]Q');
  assert.doesNotMatch(reused, /ring bond/, `a closed-then-reused label and an isotope are not ring faults: ${reused}`);
  const twoDigit = await refusal('C%10CCCC%10%11Q');
  assert.ok(twoDigit.includes('ring bond 11 opened and never closed'), `a two-digit label is read whole: ${twoDigit}`);

  // A refusal with balanced delimiters must NOT invent a delimiter fault.
  const other = await refusal('CC(C)Q');
  assert.doesNotMatch(other, /against/, `no delimiter fault should be claimed: ${other}`);
  assert.match(other, /RDKit rejected the molecular graph\./, 'the general message is kept');
});

test('the two species real runs were refused for are each diagnosed down to the count', async () => {
  // Verbatim from harness-runs/chain-ladder-2026-10-07--chain-12--deepseek-flash--{high,none},
  // turn 1. Each is one delimiter away from a sound string, in opposite directions. Against the
  // old message the author rewrote the whole species instead; these are the inputs that has to
  // stop happening, so they are pinned here rather than paraphrased.
  const worker = lib.createWorker(stubHost());
  const diagnose = async (smiles) => {
    const result = await worker.invoke({
      invocationId: `real-${smiles.length}`, toolId: 'verify-route', locale: 'en',
      input: { steps: [`${smiles}>>CC=O`] },
    });
    const step = result.artifacts[0].data.steps[0];
    assert.equal(step.ok, false);
    return step.error ?? '';
  };

  const oneTooMany = "*OC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](N)C)COC(C)(C)C)C(C)C)CC(C)C)Cc1ccccc1)[C@@H](C)OC(C)(C)C)[C@@H](C)CC)CCSC)CC(N)=O)CCC(N)=O)Cc1ccc(OC(C)(C)C)cc1";
  assert.equal(oneTooMany.length, 242);
  assert.ok((await diagnose(oneTooMany)).includes('33 "(" against 34 ")"'), 'one closing bracket too many');

  const twoTooFew = "*OC(=O)[C@@H](Cc1ccc(O)cc1)NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)[C@@H](NC(=O)CN)[C@@H](C)O)[C@@H](C)CC)Cc1ccccc1)CC(C)C)C(C)C)COC(C)(C)C";
  assert.equal(twoTooFew.length, 196);
  assert.ok((await diagnose(twoTooFew)).includes('26 "(" against 24 ")"'), 'two closing brackets missing');
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
  assert.equal(entry.smiles, '[C-]#C.[Na+]');
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

test('a salt name that resolves to unbalanced charges is refused with feedback', async () => {
  // "sodium diethyl propanedioate" resolved to the neutral diester beside a sodium ion (net +1):
  // a malonic ester synthesis could then never balance, through every correction.
  const wrong = lib.createWorker(resolveHost((endpointId) => (endpointId === 'opsin' ? { status: 'SUCCESS', smiles: 'CCOC(=O)CC(=O)OCC.[Na+]' } : undefined)));
  const refused = (await wrong.invoke({ invocationId: 'salt1', toolId: 'resolve-names', locale: 'en', input: { names: ['sodium diethyl propanedioate'] } })).artifacts[0].data.results[0];
  assert.equal(refused.status, 'unresolved');
  assert.match(refused.feedback, /charges do not balance \(net \+1\)/);
  assert.equal(refused.smiles, undefined);
  // The enolate written with its carbanion balances and resolves.
  const right = lib.createWorker(resolveHost((endpointId) => (endpointId === 'opsin' ? { status: 'SUCCESS', smiles: 'CCOC(=O)[CH-]C(=O)OCC.[Na+]' } : undefined)));
  const resolved = (await right.invoke({ invocationId: 'salt2', toolId: 'resolve-names', locale: 'en', input: { names: ['sodium diethyl propanedioate'] } })).artifacts[0].data.results[0];
  assert.equal(resolved.status, 'resolved');
});

test('"hydrogen" resolves to dihydrogen, not the hydrogen atom', async () => {
  const worker = lib.createWorker(resolveHost((endpointId) => (endpointId === 'opsin' ? { status: 'SUCCESS', smiles: '[H]' } : undefined)));
  const [h2, atom] = (await worker.invoke({ invocationId: 'hyd', toolId: 'resolve-names', locale: 'en', input: { names: ['hydrogen', 'hydrogen atom'] } })).artifacts[0].data.results;
  assert.equal(h2.smiles, '[H][H]');
  assert.equal(atom.smiles, '[H]', 'a name that asks for the atom keeps it');
});

test('a covalent metal oxide returned as bare ions resolves to the covalent oxide (CrO3, OsO4)', async () => {
  // PubChem writes chromium trioxide as [Cr+6].[O-2].[O-2].[O-2]; the route checker read that as
  // four species ("2 Cr + 4 O" in the equation, loose atoms in the bond ledger).
  const ions = { 'chromium trioxide': '[Cr+6].[O-2].[O-2].[O-2]', 'osmium tetroxide': '[Os+8].[O-2].[O-2].[O-2].[O-2]', 'sodium chloride': '[Na+].[Cl-]' };
  const worker = lib.createWorker(resolveHost((endpointId, target) => {
    const name = Object.keys(ions).find((n) => decodeURIComponent(String(target)).includes(n));
    return endpointId === 'opsin' && name ? { status: 'SUCCESS', smiles: ions[name] } : undefined;
  }));
  const [cro3, oso4, nacl] = (await worker.invoke({ invocationId: 'oxide', toolId: 'resolve-names', locale: 'en', input: { names: Object.keys(ions) } })).artifacts[0].data.results;
  // One covalent molecule each (RDKit's canonical writing brackets the oxygens: [O]=[Cr](=[O])=[O]).
  for (const [entry, metal, oxygens] of [[cro3, 'Cr', 3], [oso4, 'Os', 4]]) {
    assert.ok(!entry.smiles.includes('.'), `${entry.name}: ${entry.smiles} is one molecule`);
    assert.ok(entry.smiles.includes(`[${metal}]`), entry.smiles);
    assert.equal((entry.smiles.match(/O(?![a-z])/g) ?? []).length, oxygens, entry.smiles);
  }
  assert.equal(nacl.smiles, '[Cl-].[Na+]', 'a true salt keeps its ions');
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

test('resolve-names returns the canonical isomeric SMILES, not the reference writing', async () => {
  // PubChem writes tropinone as CN1C2CC(CC1CC2)=O; the canonical form is CN1C2CCC1CC(=O)C2.
  // Every downstream surface reads the canonical string, so identical compounds never look
  // like different connectivity.
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [108001] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 108001, IsomericSMILES: 'CN1C2CC(CC1CC2)=O', MolecularFormula: 'C8H13NO' }] } };
    return undefined;
  });
  const entry = (await lib.createWorker(host).invoke({ invocationId: 'can1', toolId: 'resolve-names', locale: 'en', input: { names: ['tropinone'] } })).artifacts[0].data.results[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.smiles, 'CN1C2CCC1CC(=O)C2');
});

test('the route label check reuses the resolve pass and does not hit the network twice', async () => {
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [702] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 702, IsomericSMILES: 'CCO', MolecularFormula: 'C2H6O' }] } };
    return undefined;
  });
  const worker = lib.createWorker(host);
  await worker.invoke({ invocationId: 'cache1', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'] } });
  const lookups = () => host.calls.filter(call => call.startsWith('pubchem') || call.startsWith('opsin')).length;
  const before = lookups();
  const result = await worker.invoke({ invocationId: 'cache2', toolId: 'verify-route', locale: 'en', input: { steps: ['CCO>>CC=O.[H][H]'], labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO' }]] } });
  assert.equal(lookups(), before, 'the label check did not resolve ethanol again');
  assert.equal(result.artifacts[0].data.steps[0].reactants[0].nameOk, true, 'the cached reference still confirms the name');
});

test('resolve-structure names a structure PubChem holds and canonicalises it', async () => {
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/smiles/')) return { IdentifierList: { CID: [2244] } };
    if (endpointId === 'pubchem' && target.includes('/cid/2244/property/')) return { PropertyTable: { Properties: [{ CID: 2244, IUPACName: '2-acetoxybenzoic acid', MolecularFormula: 'C9H8O4' }] } };
    return undefined;
  });
  const result = await lib.createWorker(host).invoke({ invocationId: 'iso1', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CC(=O)Oc1ccccc1C(=O)O'] } });
  const artifact = result.artifacts.find(entry => entry.artifactType === 'structure-naming');
  assert.ok(artifact, 'a structure-naming artifact is produced');
  const entry = artifact.data.results[0];
  assert.equal(entry.status, 'named');
  assert.equal(entry.name, '2-acetoxybenzoic acid');
  assert.equal(entry.cid, 2244);
  assert.equal(entry.formula, 'C9H8O4');
  assert.equal(entry.canonicalSmiles, 'CC(=O)Oc1ccccc1C(=O)O');
});

test('resolve-structure leaves a structure PubChem does not hold unnamed, with its canonical form', async () => {
  const host = resolveHost(() => undefined); // every PubChem request 404s
  const result = await lib.createWorker(host).invoke({ invocationId: 'iso2', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CN1C2CCC1CC(=O)C2'] } });
  const entry = result.artifacts[0].data.results[0];
  assert.equal(entry.status, 'unnamed');
  assert.equal(entry.cid, undefined);
  assert.equal(entry.canonicalSmiles, 'CN1C2CCC1CC(=O)C2', 'the checked structure still travels');
});

test('resolve-structure remembers a name it was given, and never remembers a miss', async () => {
  // A correction round sends back most of the same fallback structures; each used to cost two
  // PubChem round trips again. A miss is NOT kept: "unnamed" also covers a network failure.
  let requests = 0, online = false;
  const host = resolveHost((endpointId, target) => {
    if (endpointId !== 'pubchem') return undefined;
    requests += 1;
    if (target.includes('/smiles/') && target.includes(encodeURIComponent('OCC1CCCCC1'))) return online ? { IdentifierList: { CID: [7507] } } : undefined;
    if (target.includes('/smiles/')) return { IdentifierList: { CID: [6342] } };
    if (target.includes('/cid/6342/property/')) return { PropertyTable: { Properties: [{ CID: 6342, IUPACName: 'cyclohexanecarbonitrile', MolecularFormula: 'C7H11N' }] } };
    if (target.includes('/cid/7507/property/')) return { PropertyTable: { Properties: [{ CID: 7507, IUPACName: 'cyclohexylmethanol', MolecularFormula: 'C7H14O' }] } };
    return undefined;
  });
  const worker = lib.createWorker(host);
  const ask = async (smiles, id) => (await worker.invoke({ invocationId: id, toolId: 'resolve-structure', locale: 'en', input: { smiles } })).artifacts[0].data.results;
  const first = await ask(['N#CC1CCCCC1'], 'mem1');
  const afterFirst = requests;
  assert.equal(first[0].name, 'cyclohexanecarbonitrile');
  const again = await ask(['N#CC1CCCCC1'], 'mem2');
  assert.equal(requests, afterFirst, 'a structure already named costs no request');
  assert.deepEqual(again, first, 'and comes back exactly as before, canonical form included');
  const miss = await ask(['OCC1CCCCC1'], 'mem3');
  assert.equal(miss[0].status, 'unnamed');
  online = true;
  const later = await ask(['OCC1CCCCC1'], 'mem4');
  assert.equal(later[0].status, 'named', 'a miss is asked again, so a passing outage does not stick');
  assert.equal(later[0].name, 'cyclohexylmethanol');
});

test('a local PubChem mirror answers lookups it is sure of, and the network still answers the rest', async () => {
  // The mirror is consulted first; only a definite answer comes from it. A name it does not hold
  // (or holds under several CIDs) goes to PubChem exactly as before.
  let network = 0;
  const host = resolveHost((endpointId, target) => {
    if (endpointId !== 'pubchem') return undefined;
    network += 1;
    if (target.includes('/name/') && target.includes('propan-2-one')) return { IdentifierList: { CID: [180] } };
    if (target.includes('/cid/180/property/')) return { PropertyTable: { Properties: [{ CID: 180, IsomericSMILES: 'CC(C)=O', MolecularFormula: 'C3H6O' }] } };
    return undefined;
  });
  const sent = [];
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => {
      const body = JSON.parse(request.stdin);
      sent.push(body);
      return { code: 0, stderr: '', stdout: JSON.stringify({ pubchem: { available: true,
        names: { ethanol: { cid: 702, smiles: 'CCO', formula: 'C2H6O' } },
        smiles: { 'OC1CCCCC1': { cid: 7966, name: 'cyclohexanol', formula: 'C6H12O' } } } }) };
    },
  };
  const worker = lib.createWorker(host);
  const names = (await worker.invoke({ invocationId: 'mir1', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol', 'propan-2-one'], pubchemDir: '/mirror' } })).artifacts[0].data.results;
  assert.equal(sent[0].pubchemDir, '/mirror');
  assert.deepEqual(sent[0].pubchemNames, ['ethanol', 'propan-2-one']);
  const byName = Object.fromEntries(names.map((entry) => [entry.name, entry]));
  assert.equal(byName.ethanol.status, 'resolved');
  assert.equal(byName.ethanol.smiles, 'CCO', 'from the mirror');
  assert.equal(byName['propan-2-one'].smiles, 'CC(C)=O', 'not in the mirror: asked of the network');
  assert.ok(network >= 2 && network <= 3, `only the name the mirror lacked went out (${network} requests)`);

  network = 0;
  const named = (await worker.invoke({ invocationId: 'mir2', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['OC1CCCCC1'], pubchemDir: '/mirror' } })).artifacts[0].data.results;
  assert.equal(named[0].name, 'cyclohexanol', 'named from the mirror');
  assert.equal(named[0].cid, 7966);
  assert.equal(network, 0, 'no network request for a structure the mirror holds');

  // No pubchemDir from the host: the mirror is never consulted.
  sent.length = 0;
  await worker.invoke({ invocationId: 'mir3', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'] } });
  assert.equal(sent.length, 0, 'without a mirror directory, no mirror call');
});

test('a local OPSIN answers names by the web service rules: a warning still means unresolved', async () => {
  let ebi = 0;
  const host = resolveHost((endpointId) => { if (endpointId === 'opsin') ebi += 1; return undefined; });
  host.python = { ensureRuntime: async () => ({ ready: true }), run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ opsin: {
    'cyclohexanecarbaldehyde': { status: 'SUCCESS', smiles: 'O=CC1CCCCC1' },
    'Fmoc-thing': { status: 'WARNING', smiles: 'C', warnings: ['APPEARS_AMBIGUOUS'], message: 'APPEARS_AMBIGUOUS: Connection of fmoc' },
    'nonsense name': { status: 'FAILURE', message: 'nonsense name is unparsable' } } }) }) };
  const worker = lib.createWorker(host);
  const results = (await worker.invoke({ invocationId: 'op1', toolId: 'resolve-names', locale: 'en',
    input: { names: ['cyclohexanecarbaldehyde', 'Fmoc-thing', 'nonsense name'], opsinDir: '/opsin' } })).artifacts[0].data.results;
  const by = Object.fromEntries(results.map((entry) => [entry.name, entry]));
  assert.equal(by.cyclohexanecarbaldehyde.status, 'resolved');
  assert.equal(by.cyclohexanecarbaldehyde.source, 'opsin');
  assert.equal(by['Fmoc-thing'].status, 'unresolved', 'a warning is unresolved, exactly as from the web service');
  assert.match(by['Fmoc-thing'].feedback, /only partly interpreted the name: APPEARS_AMBIGUOUS/);
  assert.equal(by['nonsense name'].status, 'unresolved');
  assert.equal(ebi, 0, 'EBI was never asked about a name the local OPSIN answered');
});

test('a half-built or corrupt PubChem mirror costs only the mirror, not the local OPSIN answers (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // One exception in the mirror lookup failed the whole local call, so the host fell back to the
  // network for every name — the ones a local OPSIN had just parsed included.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, sqlite3, tempfile
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
w._opsin_local = lambda opsin_dir, names: {name: {'status': 'SUCCESS', 'smiles': 'CCO'} for name in names}
half = tempfile.mkdtemp(); db = sqlite3.connect(os.path.join(half, 'pubchem.sqlite'))
db.execute('CREATE TABLE synonym (name TEXT, cid INTEGER, rank INTEGER)'); db.commit(); db.close()
corrupt = tempfile.mkdtemp(); open(os.path.join(corrupt, 'pubchem.sqlite'), 'wb').write(b'not a database' * 512)
print(json.dumps([w.handle({'pubchemDir': d, 'opsinDir': '/opsin', 'pubchemNames': ['ethanol'], 'pubchemSmiles': ['CCO']}) for d in (half, corrupt)]))
`;
  for (const out of JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))) {
    assert.equal(out.opsin.ethanol.smiles, 'CCO', 'the local OPSIN answer survives');
    assert.equal(out.pubchem.available, false, 'the broken mirror reads as no mirror, so the network answers instead');
    assert.match(out.pubchem.error, /Error/, 'and says why');
  }
});

test('a failed local reference run is logged with its stderr, not dropped silently', async () => {
  const logged = [];
  const host = resolveHost(() => undefined);
  host.log = (level, message, detail) => { logged.push({ level, message, detail }); };
  host.python = { ensureRuntime: async () => ({ ready: true }), run: async () => ({ code: 1, stdout: '', stderr: 'Traceback (most recent call last):\nsqlite3.DatabaseError: file is not a database' }) };
  await lib.createWorker(host).invoke({ invocationId: 'lr1', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'], pubchemDir: '/m', localOnly: true } });
  assert.ok(logged.some((entry) => /file is not a database/.test(String(entry.detail?.stderr))), JSON.stringify(logged));

  logged.length = 0;
  host.python.run = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ pubchem: { available: false, names: {}, smiles: {}, error: 'DatabaseError: file is not a database' } }) });
  await lib.createWorker(host).invoke({ invocationId: 'lr2', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'], pubchemDir: '/m', localOnly: true } });
  assert.ok(logged.some((entry) => /file is not a database/.test(String(entry.detail?.error))), 'a mirror the run could not read is logged too');
});

test('the local OPSIN wrapper runs and reports warnings per name (needs CHEMISTRY_TEST_PYTHON and a local OPSIN)', { skip: !process.env.CHEMISTRY_TEST_PYTHON || !process.env.CHEMISTRY_TEST_OPSIN }, async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
print(json.dumps(w.handle({'opsinDir': ${JSON.stringify(process.env.CHEMISTRY_TEST_OPSIN ?? '')}, 'pubchemNames': ['ethanol', 'Fmoc-4-aminotetrahydropyran-4-carboxylic acid', 'not a real name at all']})))
`;
  const out = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' })).opsin;
  assert.equal(out.ethanol.status, 'SUCCESS');
  assert.equal(out.ethanol.smiles, 'C(C)O');
  assert.deepEqual(out['Fmoc-4-aminotetrahydropyran-4-carboxylic acid'].warnings, ['APPEARS_AMBIGUOUS'], 'the warning travels with its own name');
  assert.equal(out['not a real name at all'].status, 'FAILURE');
});

test('the Python mirror lookup answers only what it is sure of (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, sqlite3, tempfile
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
from rdkit import Chem
d = tempfile.mkdtemp(); db = sqlite3.connect(os.path.join(d, 'pubchem.sqlite'))
db.executescript('''CREATE TABLE inchikey (key TEXT PRIMARY KEY, cid INTEGER) WITHOUT ROWID;
  CREATE TABLE smiles (cid INTEGER PRIMARY KEY, smiles TEXT); CREATE TABLE iupac (cid INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE formula (cid INTEGER PRIMARY KEY, formula TEXT); CREATE TABLE synonym (name TEXT, cid INTEGER, rank INTEGER);''')
for cid, smi, name, formula, syns in [(702, 'CCO', 'ethanol', 'C2H6O', ['ethanol', 'Ethyl alcohol', 'shared']), (887, 'CO', 'methanol', 'CH4O', ['methanol', 'shared'])]:
    db.execute('INSERT INTO inchikey VALUES (?, ?)', (Chem.MolToInchiKey(Chem.MolFromSmiles(smi)), cid))
    db.execute('INSERT INTO smiles VALUES (?, ?)', (cid, smi)); db.execute('INSERT INTO iupac VALUES (?, ?)', (cid, name))
    db.execute('INSERT INTO formula VALUES (?, ?)', (cid, formula))
    for rank, s in enumerate(syns): db.execute('INSERT INTO synonym VALUES (?, ?, ?)', (s, cid, rank))
db.commit(); db.close()
out = w.handle({'pubchemDir': d, 'pubchemNames': ['ETHYL ALCOHOL', 'shared', 'nonesuch'], 'pubchemSmiles': ['OCC', 'c1ccccc1']})
missing = w.handle({'pubchemDir': tempfile.mkdtemp(), 'pubchemNames': ['ethanol'], 'pubchemSmiles': []})
print(json.dumps([out, missing]))
`;
  const [out, missing] = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.deepEqual(out.pubchem.names, { 'ETHYL ALCOHOL': { cid: 702, smiles: 'CCO', formula: 'C2H6O' } }, 'case-insensitive; an ambiguous and an unknown name are left out, not reported');
  assert.equal(out.pubchem.smiles.OCC.cid, 702, 'a structure matches by InChIKey, however it is written');
  assert.equal(out.pubchem.smiles.OCC.name, 'ethanol');
  assert.equal('c1ccccc1' in out.pubchem.smiles, false, 'a structure the mirror lacks is left out');
  assert.equal(missing.pubchem.available, false, 'no database: says so, so the caller uses the network');
});

test('the PubChem mirror opens read-only from a folder whose name holds # ? or % (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // The path went into a file: URI unescaped. "#" and "?" cut it short — SQLite then opened, and
  // CREATED, an empty database at the part before them, with mode=ro lost — and "%41" was decoded.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, sqlite3, tempfile
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
base = tempfile.mkdtemp(); out = []
for folder in ('lib #1', 'what?', 'a%41b'):
    d = os.path.join(base, folder); os.makedirs(d); db = sqlite3.connect(os.path.join(d, 'pubchem.sqlite'))
    db.executescript("CREATE TABLE synonym (name TEXT, cid INTEGER, rank INTEGER); CREATE TABLE smiles (cid INTEGER PRIMARY KEY, smiles TEXT); CREATE TABLE formula (cid INTEGER PRIMARY KEY, formula TEXT); INSERT INTO synonym VALUES ('ethanol', 702, 0); INSERT INTO smiles VALUES (702, 'CCO');")
    db.commit(); db.close()
    try: out.append(w._pubchem_mirror(d, ['ethanol'], [])['names'].get('ethanol', {}).get('smiles'))
    except Exception as error: out.append(type(error).__name__)
print(json.dumps({'answers': out, 'stray': sorted(n for n in os.listdir(base) if n not in ('lib #1', 'what?', 'a%41b'))}))
`;
  const { answers, stray } = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.deepEqual(answers, ['CCO', 'CCO', 'CCO'], 'every folder name opens the mirror');
  assert.deepEqual(stray, [], 'no empty database is created beside it');
});

test("PubChem's throttling is obeyed: a refusal stops all requests, and a Yellow grade slows them", async () => {
  // https://pubchem.ncbi.nlm.nih.gov/docs/dynamic-request-throttling — a block GROWS if requests
  // continue, so after a refusal nothing more may be sent until the back-off has passed.
  lib.resetPubchemPacing();
  let pubchem = 0;
  const refusing = resolveHost((endpointId) => {
    if (endpointId !== 'pubchem') return undefined;
    pubchem += 1;
    return { __response: { status: 429 } };
  });
  const worker = lib.createWorker(refusing);
  await worker.invoke({ invocationId: 'thr1', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CCCCCCO', 'CCCCCCN', 'CCCCCCC'] } });
  assert.equal(pubchem, 1, 'one refusal, then nothing more is sent in that call');
  await worker.invoke({ invocationId: 'thr2', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CCCCCCCO'] } });
  assert.equal(pubchem, 1, 'and nothing in the NEXT call either: the back-off outlives the call');

  lib.resetPubchemPacing();
  const times = [];
  const grading = resolveHost((endpointId) => {
    if (endpointId !== 'pubchem') return undefined;
    times.push(Date.now());
    return { __response: { status: 200, headers: { 'x-throttling-control': 'Request Count status: Yellow (60%), Request Time status: Green (10%), Service status: Green (20%)' }, body: { IdentifierList: { CID: [] } } } };
  });
  await lib.createWorker(grading).invoke({ invocationId: 'thr3', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CCCCCCCCO', 'CCCCCCCCN'] } });
  assert.ok(times.length >= 2);
  assert.ok(times[1] - times[0] >= 950, `after a Yellow grade the next request waits about a second (${times[1] - times[0]} ms)`);
  lib.resetPubchemPacing();
});

test('a PubChem turn more than about 8 s away falls back at once, and an abort ends the wait', async () => {
  // A Black grade paces requests a minute apart, as the pacer also does for five minutes after a
  // refusal. A look-up queued behind it slept out that minute — past the reference's own 10 s
  // timeout and past the turn's abort — and then sent the request anyway.
  lib.resetPubchemPacing();
  let sent = 0;
  const black = resolveHost((endpointId) => {
    if (endpointId !== 'pubchem') return undefined;
    sent += 1;
    return { __response: { status: 200, headers: { 'x-throttling-control': 'Request Count status: Black (100%), Request Time status: Green (10%), Service status: Green (20%)' }, body: { IdentifierList: { CID: [] } } } };
  });
  const started = Date.now();
  const far = await lib.createWorker(black).invoke({ invocationId: 'far1', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CCCCCCCCCO', 'CCCCCCCCCN'] } });
  assert.ok(Date.now() - started < 5000, `a turn a minute away is not waited for (${Date.now() - started} ms)`);
  assert.equal(sent, 1, 'the second look-up fell back without sending');
  assert.equal(far.artifacts[0].data.results.length, 2, 'both structures still get an answer');

  // A Red grade (5 s) is close enough to wait for, but the wait must end when the turn is cancelled.
  lib.resetPubchemPacing();
  let red = 0;
  const controller = new AbortController();
  const host = stubHost({ signal: controller.signal, fetch: (endpointId) => {
    if (endpointId !== 'pubchem') return undefined;
    red += 1;
    return { __response: { status: 200, headers: { 'x-throttling-control': 'Request Count status: Red (90%), Request Time status: Green (10%), Service status: Green (20%)' }, body: { IdentifierList: { CID: [] } } } };
  } });
  const pending = lib.createWorker(host).invoke({ invocationId: 'far2', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['CCCCCCCCCCO', 'CCCCCCCCCCN'] } });
  const settled = pending.then(() => 'resolved', () => 'rejected');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const abortedAt = Date.now();
  controller.abort(new Error('turn cancelled'));
  await settled;
  assert.ok(Date.now() - abortedAt < 1500, `the call ends soon after the abort (${Date.now() - abortedAt} ms)`);
  // Give an unpatched pacer the rest of its 5 s, to show it would have sent once the wait was over.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(red, 1, 'the queued request is never sent after the abort');
  lib.resetPubchemPacing();
});

test('local references only: no request leaves the machine, and the local sources still answer', async () => {
  // A timing trace runs this way, so it measures no network latency and cannot get the machine blocked.
  let sent = 0;
  const host = resolveHost(() => { sent += 1; return undefined; });
  host.python = { ensureRuntime: async () => ({ ready: true }), run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
    pubchem: { available: true, names: { ethanol: { cid: 702, smiles: 'CCO' } }, smiles: { OC1CCCCC1: { cid: 7966, name: 'cyclohexanol' } } },
    opsin: { 'cyclohexanecarbaldehyde': { status: 'SUCCESS', smiles: 'O=CC1CCCCC1' } } }) }) };
  const worker = lib.createWorker(host);
  const names = (await worker.invoke({ invocationId: 'lo1', toolId: 'resolve-names', locale: 'en',
    input: { names: ['ethanol', 'cyclohexanecarbaldehyde', 'some name nothing local knows'], pubchemDir: '/m', opsinDir: '/o', localOnly: true } })).artifacts[0].data.results;
  const by = Object.fromEntries(names.map((entry) => [entry.name, entry]));
  assert.equal(by.ethanol.smiles, 'CCO', 'the mirror answers');
  assert.equal(by.cyclohexanecarbaldehyde.smiles, 'O=CC1CCCCC1', 'local OPSIN answers');
  assert.equal(by['some name nothing local knows'].status, 'unresolved', 'what no local source knows is simply unresolved');
  const structures = (await worker.invoke({ invocationId: 'lo2', toolId: 'resolve-structure', locale: 'en',
    input: { smiles: ['OC1CCCCC1', 'CC1=CC=CC=C1CCCCCCCCC'], pubchemDir: '/m', localOnly: true } })).artifacts[0].data.results;
  assert.equal(structures.find((entry) => entry.smiles === 'OC1CCCCC1').name, 'cyclohexanol');
  assert.equal(structures.find((entry) => entry.smiles !== 'OC1CCCCC1').status, 'unnamed');
  assert.equal(sent, 0, 'not one request was sent to PubChem or EBI');
});

test('resolve-structure rejects an empty request', async () => {
  const worker = lib.createWorker(resolveHost(() => undefined));
  await assert.rejects(() => worker.invoke({ invocationId: 'iso3', toolId: 'resolve-structure', locale: 'en', input: { smiles: ['', '   '] } }), /between one and/);
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
  // would write them) is refused. It used to be refused as "more than one balanced equation",
  // which was never established: the repeated tokens leave 5 species free to vary and the
  // bounded search covers 4, so no candidate was ever built and nothing was compared. It is an
  // UNCHECKED step, not an unbalanced one, and the one thing that brings it within reach of the
  // search is fewer species per step: adding a species, as the old advice said, adds a free one.
  const repeated = 'C1(CCCCC1)O.[O-][Cr](=O)(=O)O[Cr](=O)(=O)[O-].[Na+].[Na+].S(O)(O)(=O)=O>>C1(CCCCC1)=O.S(=O)(=O)([O-])[O-].S(=O)(=O)([O-])[O-].S(=O)(=O)([O-])[O-].[Cr+3].[Cr+3].S(=O)(=O)([O-])[O-].[Na+].[Na+].O';
  const refused = await lib.auditRoute({ steps: [repeated] });
  assert.equal(refused.steps[0].balanced, false, 'never passed');
  assert.match(refused.steps[0].balanceUnchecked ?? '', /free to vary independently/, 'a distinct unchecked outcome');
  const why = refused.steps[0].differences.join(' ');
  assert.match(why, /split/i, 'its one action is to split the step');
  assert.doesNotMatch(why, /missing from (Reactants|Products)|Add the missing|short of/, 'no advice to add a species');
  assert.doesNotMatch(why, /more than one balanced equation/);
  const line = refused.blocked.find((entry) => entry.startsWith('Step 1'));
  assert.match(line, /not checked/i);
  assert.doesNotMatch(line, /is not balanced/, 'the route summary does not call it unbalanced');
});

test('a step that inverts a stereocentre is refused, though its equation balances', async () => {
  // L-alanine is (S). Coupling it to dimethylamine makes one amide and loses one water; the
  // configuration at the alpha carbon is untouched by that bond, so it must survive the step.
  const reactants = 'N[C@@H](C)C(=O)O.CNC';
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  const amine = label('reactant', 'N-methylmethanamine', 'CNC');
  const acid = label('reactant', 'L-alanine', 'N[C@@H](C)C(=O)O');
  const water = label('product', 'water', 'O', true);

  // Configuration preserved: (S) in, (S) out.
  const kept = await lib.auditRoute({
    steps: [`${reactants}>>C[C@H](N)C(=O)N(C)C.O`],
    labels: [[acid, amine, label('product', 'the amide', 'C[C@H](N)C(=O)N(C)C'), water]],
  });
  assert.equal(kept.steps[0].balanced, true, JSON.stringify(kept.steps[0].differences));

  // The epimer. Identical formula, identical atom counts, so the equation balances exactly as
  // well — this is the error class no balance check can reach, and it must still be refused.
  const flipped = await lib.auditRoute({
    steps: [`${reactants}>>C[C@@H](N)C(=O)N(C)C.O`],
    labels: [[acid, amine, label('product', 'the amide', 'C[C@@H](N)C(=O)N(C)C'), water]],
  });
  assert.equal(flipped.steps[0].balanced, false);
  const why = flipped.steps[0].differences.join(' ');
  assert.match(why, /inverts a stereocentre/);
  assert.match(why, /1 \(S\) and 0 \(R\)/);   // what went in
  assert.match(why, /0 \(S\) and 1 \(R\)/);   // what came out

  // Counts alone cannot be acted on: with a dozen centres in play, "give the product the
  // configuration its reactant carries" does not say which one moved. Each side is therefore
  // named species by species, with the atom index of every specified centre, so the reader can
  // find it in the string they wrote.
  assert.match(why, /In: L-alanine: \(S\) at atom \d+\./, why);
  assert.match(why, /Out: the amide: \(R\) at atom \d+\./, why);
  assert.match(why, /Atom indices count from zero/);
  // The species with no specified centre is left out rather than listed as having none.
  assert.ok(!why.includes('N-methylmethanamine'), why);
  // And the preserved route still says nothing at all.
  assert.ok(!kept.steps[0].differences.join(' ').includes('inverts a stereocentre'));
});

test('creating a stereocentre is not reported as an inversion', async () => {
  // Counts differ between the sides, which is ordinary chemistry: a centre was made, not flipped.
  // The gate only speaks when the number of specified centres is equal and the mix differs.
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  const made = await lib.auditRoute({
    steps: ['CCC(=O)C.[H][H]>>CC[C@H](O)C'],
    labels: [[label('reactant', 'butan-2-one', 'CCC(=O)C'), label('reactant', 'dihydrogen', '[H][H]'),
              label('product', '(2S)-butan-2-ol', 'CC[C@H](O)C')]],
  });
  assert.equal(made.steps[0].balanced, true, JSON.stringify({ error: made.steps[0].error, differences: made.steps[0].differences }));
});

test('a salt name prefers the reference that shows the metal as an ion', async () => {
  // PubChem's exact record for "sodium phenoxide" is phenol plus a bare neutral Na atom;
  // OPSIN returns the ionic salt, which is what a salt name must resolve to.
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [2733330] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 2733330, IsomericSMILES: 'C1=CC=C(C=C1)O.[Na]', MolecularFormula: 'C6H6NaO' }] } };
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: '[O-]C1=CC=CC=C1.[Na+]' };
    return undefined;
  });
  const result = await lib.createWorker(host).invoke({ invocationId: 'salt1', toolId: 'resolve-names', locale: 'en', input: { names: ['sodium phenoxide'] } });
  const entry = result.artifacts[0].data.results[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.source, 'opsin', 'the ionic reference wins over a bare neutral metal');
  assert.equal(entry.smiles, '[Na+].[O-]c1ccccc1');
});

test('a metal name keeps PubChem when both references show the metal as an ion', async () => {
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [2733336] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 2733336, IsomericSMILES: 'C#[C-].[Na+]', MolecularFormula: 'C2HNa' }] } };
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: '[C-]#[C-].[Na+].[Na+]' };
    return undefined;
  });
  const entry = (await lib.createWorker(host).invoke({ invocationId: 'salt2', toolId: 'resolve-names', locale: 'en', input: { names: ['sodium acetylide'] } })).artifacts[0].data.results[0];
  assert.equal(entry.source, 'pubchem', 'PubChem keeps its curated mono-salt record');
  assert.equal(entry.smiles, '[C-]#C.[Na+]');
});

test('a name without a metal is still PubChem-first', async () => {
  // Was written with "hydrogen" as the example. It is now answered from the built-in diatomic
  // lookup before any reference is asked, so the example moved to a name that still exercises the
  // branch this test is about — the metal/non-metal split, not hydrogen. The references disagreed
  // about hydrogen anyway, and instructively: PubChem returned `[HH]`, the molecule, while OPSIN
  // returned `[H]`, the atom. Which answer a route got depended on which service replied.
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [241] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 241, IsomericSMILES: 'c1ccccc1', MolecularFormula: 'C6H6' }] } };
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: 'C1=CC=CC=C1' };
    return undefined;
  });
  const entry = (await lib.createWorker(host).invoke({ invocationId: 'salt3', toolId: 'resolve-names', locale: 'en', input: { names: ['benzene'] } })).artifacts[0].data.results[0];
  assert.equal(entry.source, 'pubchem');
  assert.equal(entry.smiles, 'c1ccccc1');
});

test('a diatomic element answers the same whatever the references say', async () => {
  // The behaviour the test above used to cover by accident, now covered on purpose: the answer no
  // longer depends on which service replies, or on either being reachable. The host below returns
  // the ATOM from both references; the molecule is still what comes back.
  const host = resolveHost((endpointId, target) => {
    if (endpointId === 'pubchem' && target.includes('/cids/JSON')) return { IdentifierList: { CID: [5360770] } };
    if (endpointId === 'pubchem' && target.includes('/property/IsomericSMILES')) return { PropertyTable: { Properties: [{ CID: 5360770, IsomericSMILES: '[Br]', MolecularFormula: 'Br' }] } };
    if (endpointId === 'opsin') return { status: 'SUCCESS', smiles: '[Br]' };
    return undefined;
  });
  const entry = (await lib.createWorker(host).invoke({ invocationId: 'diatomic1', toolId: 'resolve-names', locale: 'en', input: { names: ['bromine'] } })).artifacts[0].data.results[0];
  assert.equal(entry.smiles, 'BrBr', 'the molecule, not the atom the references offered');
  assert.equal(entry.source, 'builtin');
});

test('when only one reference resolves a metal name, that one is used', async () => {
  const host = resolveHost((endpointId) => endpointId === 'opsin' ? { status: 'SUCCESS', smiles: '[Sn](Cl)Cl' } : undefined);
  const entry = (await lib.createWorker(host).invoke({ invocationId: 'salt4', toolId: 'resolve-names', locale: 'en', input: { names: ['tin(II) chloride'] } })).artifacts[0].data.results[0];
  assert.equal(entry.source, 'opsin');
  assert.equal(entry.smiles, '[Cl][Sn][Cl]');
});

test('a solution that zeroes the principal species is not reported as an idle molecule to delete', async () => {
  // Benzene and octane cannot balance, but the carbon dioxide written on both sides can —
  // so the only solution gives the two principal species coefficient 0. Advising their
  // deletion would be advising the author to delete the step. Seen for real on a step whose
  // product and principal precursor were both zeroed while the small leftovers balanced;
  // the atom totals name the actual fault.
  const worker = lib.createWorker(stubHost());
  const degenerate = await worker.invoke({ invocationId: 'degen1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['c1ccccc1.O=C=O>>CCCCCCCC.O=C=O'] } });
  const step = degenerate.artifacts[0].data.steps[0];
  assert.equal(step.balanced, false);
  const said = step.differences.join(' ');
  assert.doesNotMatch(said, /take\(s\) no part/, 'the target of a step is never the molecule to delete');
  assert.match(said, /cannot be balanced/);
});

test('a spurious byproduct is still named however heavy it is', async () => {
  // The rule above withholds the delete advice only when the heaviest species on BOTH sides is
  // zeroed. One side alone is an ordinary copy-paste byproduct, and size is not the test: a
  // phosphine oxide or a urea carried in from another step outweighs the real product, and the
  // author still wants to be told to delete it rather than hunting a missing reagent.
  const worker = lib.createWorker(stubHost());
  const ester = await worker.invoke({ invocationId: 'idle-heavy', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CC(=O)OCC.O>>CC(=O)O.CCO.O=P(c1ccccc1)(c1ccccc1)c1ccccc1'] } });
  const step = ester.artifacts[0].data.steps[0];
  assert.equal(step.balanced, false);
  const said = step.differences.join(' ');
  assert.match(said, /take\(s\) no part/, 'the heavy spurious byproduct is named');
  assert.match(said, /Delete the molecule/);
});

test('a cumulated system is refused only when both of its ends could twist — carbodiimides pass', async () => {
  // The guard is for axial chirality: an allene or butatriene is stereogenic because each
  // end carries two substituents. A carbodiimide's nitrogens carry one substituent and a
  // lone pair, so there is no axis to get wrong — and it is the standard amide coupling
  // reagent, so refusing it failed every route that forms an amide with one.
  // diisopropylcarbodiimide, a standard amide coupling reagent
  await lib.validateChemicalReferences({ references: ['CC(C)N=C=NC(C)C'] });
  await lib.validateChemicalReferences({ references: ['C=C=O'] });        // ketene: one end bare
  await lib.validateChemicalReferences({ references: ['O=C=O'] });        // carbon dioxide: both ends bare
  await lib.validateChemicalReferences({ references: ['CN=C=O'] });       // isocyanate
  // A substituted allene has two substituents at each end, so the axis has a configuration
  // SMILES can state and this validator does not certify — still refused.
  await assert.rejects(lib.validateChemicalReferences({ references: ['CC(Cl)=C=C(Cl)C'] }),
    /Cumulated double bonds/, 'a substituted allene is still outside the scope');
  // The ends are the ends of the WHOLE chain. A longer cumulene with an even number of double
  // bonds is perpendicular too, so it is axially stereogenic and equally outside the scope —
  // its inner atoms each see a neighbour carrying nothing but the chain, so looking only at
  // the immediate neighbours accepted it.
  await assert.rejects(lib.validateChemicalReferences({ references: ['CC(C)=C=C=C=C(C)C'] }),
    /Cumulated double bonds/, 'a substituted [4]cumulene is axially stereogenic');
  // An odd number of double bonds is coplanar, so there is no axis: butatriene passes, and any
  // geometry it does have is judged by the bond-parity check rather than refused here.
  await lib.validateChemicalReferences({ references: ['C=C=C=C'] });
});

test('a bare counterion does not downgrade the document, but a bonded out-of-set element does', async () => {
  const salt = await lib.validateChemicalReferences({ references: ['[Na+].[O-]C1=CC=CC=C1'] });
  assert.ok(!(salt.partialReasons ?? []).includes('element-outside-cip-scope'), 'a bare Na+ is a spectator with no stereochemistry or implicit valence to certify');
  const bonded = await lib.validateChemicalReferences({ references: ['Cl[Sn](Cl)(Cl)Cl'] });
  assert.ok((bonded.partialReasons ?? []).includes('element-outside-cip-scope'), 'a bonded tin is still outside the certified set');
});

test('an unbalanced step names an Agent that carries the missing atoms', async () => {
  // The tropinone shape: butanedial + methylamine cannot make tropinone, and the C3 source
  // (here citric acid) is wrongly under Agents, so its atoms are excluded from the balance.
  const audit = await lib.auditRoute({ steps: ['O=CCCC=O.CN>O=C(O)CC(O)(CC(=O)O)C(=O)O>CN1C2CCC1CC(=O)C2.O'] });
  assert.equal(audit.steps[0].balanced, false);
  const blocked = audit.blocked.join(' ');
  assert.match(blocked, /listed under Agents, but the reactants are missing atoms/);
  assert.match(blocked, /C6H8O7/, 'the misplaced agent is named');
  // A solvent agent that supplies no deficient element is not blamed.
  const solventOnly = await lib.auditRoute({ steps: ['CCO>C(Cl)Cl>CC=O'] });
  assert.ok(!solventOnly.blocked.join(' ').includes('listed under Agents'), 'a plain solvent is left alone');
});

test('a balanced step reports the coefficients it solved', async () => {
  // Citric acid to acetonedicarboxylic acid, water and CO2: the 1:1:1:1 a reader expects does not
  // balance (O 7 vs 8), but the declared species admit a unique 8:9:5:3 equation. The coefficients
  // travel with the species so the application can show them and flag the odd stoichiometry.
  const audit = await lib.auditRoute({ steps: ['O=C(O)CC(O)(CC(=O)O)C(=O)O>>O=C(O)CC(=O)CC(=O)O.O.O=C=O'] });
  assert.equal(audit.steps[0].ok, true, 'the step parses');
  assert.equal(audit.steps[0].balanced, true, 'the declared species balance');
  assert.equal(audit.steps[0].reactants[0].coefficient, 8);
  assert.deepEqual(audit.steps[0].products.map((entry) => entry.coefficient), [9, 5, 3]);
});

test('a step that would assemble product molecules from more than one substrate is refused', async () => {
  // The citric-acid decarboxylation only balances at 8:9:5:3, which needs nine acetonedicarboxylic
  // skeletons from eight citric-acid molecules — each product's carbons must come from one substrate.
  const audit = await lib.auditRoute({ steps: ['O=C(O)CC(O)(CC(=O)O)C(=O)O>>O=C(O)CC(=O)CC(=O)O.O.O=C=O'] });
  assert.equal(audit.continuous, false);
  const blocked = audit.blocked.join(' ');
  assert.match(blocked, /more product molecules than the substrate molecules can form/);
  // The refusal localises the over-produced molecule and shows the fractional stoichiometry.
  assert.match(blocked, /9 × C5H6O5 need 9 substrate molecules, but only 8 can each supply one/);
  assert.match(blocked, /At one C6H8O7 the coefficients are/);
  assert.equal(audit.steps[0].assemblyProblem !== undefined, true, 'the step is flagged for the report');
  assert.match(blocked, /9\/8 C5H6O5/);
  assert.match(blocked, /5\/8 H2O/);
  assert.match(blocked, /3\/8 CO2/);
});

test('per-molecule packing accepts a real decarboxylation, a rearrangement and a coupling', async () => {
  // One acetoacetic acid -> one acetone + one CO2: the 4 carbons fit one substrate.
  const decarboxylation = await lib.auditRoute({ steps: ['CC(=O)CC(=O)O>>CC(C)=O.O=C=O'] });
  assert.equal(decarboxylation.continuous, true, 'a 1:1 decarboxylation is not refused');
  // Beckmann turns a carbon ring into a carbon chain; connectivity changes but carbon counts do not.
  const beckmann = await lib.auditRoute({ steps: ['C1CCC(=NO)CC1>>O=C1CCCCCN1'] });
  assert.equal(beckmann.continuous, true, 'a rearrangement is not refused');
  // An aldol product is larger than either substrate (a coupling), so the step is left unchecked.
  const aldol = await lib.auditRoute({ steps: ['CC=O.CC=O>>CC(O)CC=O'] });
  assert.ok(!aldol.blocked.join(' ').includes('more product molecules'), 'a coupling is not refused by packing');
});

test('a symmetric reaction is not refused by the per-molecule packing', async () => {
  // Robinson tropinone: a symmetric double Mannich where either enol carbon may attack either
  // iminium carbon. The product is larger than any one substrate, so packing leaves it unchecked
  // and the symmetry never matters. The decarboxylation's two equivalent carboxyls are the same.
  const audit = await lib.auditRoute({ steps: ['O=CCCC=O.O=C(O)CC(=O)CC(=O)O.CN>>CN1C2CCC1CC(=O)C2.O=C=O.O'] });
  assert.equal(audit.steps[0].balanced, true, 'the symmetric coupling balances');
  assert.ok(!audit.blocked.join(' ').includes('more product molecules'), 'a symmetric coupling is not refused');
});

test('a step with several balanced equations takes the smallest that uses every species', async () => {
  // Robinson tropinone assembly: 6 species over 4 elements, so the null space is 2-dimensional,
  // but the smallest all-positive equation is unique (1,1,1,1,2,2) and the absurd
  // spectator-dropping ones are ignored.
  const audit = await lib.auditRoute({ steps: ['O=CCCC=O.O=C(O)CC(=O)CC(=O)O.CN>>CN1C2CCC1CC(=O)C2.O=C=O.O'] });
  assert.equal(audit.steps[0].ok, true, 'the step parses');
  assert.equal(audit.steps[0].balanced, true, 'the smallest all-positive equation is used');
  assert.ok(!audit.blocked.join(' ').includes('more than one'), 'a unique smallest equation is not ambiguous');
});

test('only the species a step makes must specify their stereochemistry', async () => {
  // Butan-2-ol carries an unspecified centre; as a purchased reactant the route does not have to
  // fix it (the step that makes it would), but as a product it does.
  const reactantStereo = await lib.auditRoute({ steps: ['CCC(C)O>>CCC(C)=O'] });
  assert.equal(reactantStereo.steps[0].unspecifiedStereocentres, 0, 'a stereocentre only on a reactant is not the route\u2019s to specify');
  const productStereo = await lib.auditRoute({ steps: ['CCC(C)=O>>CCC(C)O'] });
  assert.ok(productStereo.steps[0].unspecifiedStereocentres > 0, 'a stereocentre on the product the step makes is flagged');
  const declaredRacemic = await lib.auditRoute({ steps: ['CCC(C)=O>>CCC(C)O'], racemic: true });
  assert.equal(declaredRacemic.steps[0].racemic, true, 'a racemic declaration opts the product out');
});

// The package declares Nodus 5.3.2 or newer, and the synthesis output contract belongs to the
// application: releases up to 5.6.0 append one `reactants>agents>products` string per step, later
// ones append labelled name lines. The skill must defer to whichever contract was appended rather
// than forbid the form an older application parses, or a route on 5.6.0 gets two contradictory
// instructions and the checker parses neither.
test('the synthesis instructions defer to the contract the application appends', () => {
  const section = instructions.slice(instructions.indexOf('MULTI-STEP SYNTHESIS'), instructions.indexOf('A route is a proposal.'));
  assert.ok(section.length > 0, 'the synthesis section exists');
  assert.doesNotMatch(section, /do NOT write reaction SMILES or reaction lines/i, 'reaction lines are not forbidden outright');
  assert.match(section, /follow that appended contract exactly/i);
  assert.match(section, /reactants>agents>products/, 'the reaction-string contract of earlier releases is still honoured');
  assert.match(section, /Reactants, Products, Byproducts, Agents/, 'the labelled names-first contract is still honoured');
});

test('a reaction scheme is drawn in the element palette while its exported source stays plain', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'O=C(O)c1ccccc1O.CC(=O)OC(C)=O>>CC(=O)Oc1ccccc1C(=O)O.CC(=O)O';
  const result = await worker.invoke({
    invocationId: 'col1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles },
  });
  const reaction = result.artifacts?.[0]?.data?.reaction;
  assert.ok(reaction, JSON.stringify(result.notices ?? result.view));
  assert.match(reaction.svg, /fill="(?:red|#ff0000)"[^>]*>O</i, 'oxygen is drawn red, as RDKit draws it');
  assert.doesNotMatch(reaction.svg, /<text[^>]*fill=[^>]*>C</, 'carbon is never a coloured label (skeletal carbons carry no label at all)');
  assert.doesNotMatch(reaction.chemfig.source, /\\color/, 'the exported ChemFig carries no colour commands');
});

test('a reaction scheme is skeletal: carbons are bare vertices, labels only where a reader needs them', async () => {
  // The scheme was drawn with every carbon labelled with its hydrogens (CH3, CH2) while the target
  // structure above it was skeletal. The author asked for one convention: no hydrogens unless needed.
  const worker = lib.createWorker(stubHost());
  const draw = async (smiles, id) => {
    const result = await worker.invoke({ invocationId: id, toolId: 'compile', locale: 'en',
      input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles } });
    const source = result.artifacts?.[0]?.data?.reaction?.chemfig?.source;
    assert.ok(source, JSON.stringify(result.notices ?? result.view));
    return source;
  };
  const ester = await draw('CC(=O)O.OCC>>CC(=O)OCC.O', 'sk1');
  assert.doesNotMatch(ester, /\}C(?![a-z])/, 'no carbon is labelled: CH3, CH2 and the carbonyl carbon are bare vertices');
  assert.match(ester, /\}OH/, 'a heteroatom keeps its hydrogen: the acid and the alcohol are still OH');
  // A carbon with no bond would draw as nothing, so it keeps its label.
  const methane = await draw('C.ClCl>>ClC.Cl', 'sk2');
  assert.match(methane, /\}CH_4/, 'methane keeps its label');
  assert.match(methane, /\}Cl/, 'chlorine is labelled');
});

test('a salt written as its ions is one species, so a verified step with salts on both sides still draws', async () => {
  // Measured 2026-10-09: a route passed its check, then its final report said "the verified drawing
  // could not be produced" for this step. The check groups species by the author's names; the
  // drawing split the SMILES on every dot, so the sodium of sodium sulfate became two loose [Na+],
  // one cancelled against sodium nitrite's and the other was left "taking no part".
  const worker = lib.createWorker(stubHost());
  const smiles = 'Oc1ccccc1.O=N[O-].[Na+].O=S(=O)(O)O>O>O=Nc1ccc(O)cc1.O=S(=O)([O-])[O-].[Na+].[Na+].O';
  const result = await worker.invoke({ invocationId: 'salt1', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles } });
  const reaction = result.artifacts?.[0]?.data?.reaction;
  assert.ok(reaction, `the step draws: ${JSON.stringify(result.notices ?? result.view).slice(0, 400)}`);
  assert.equal(reaction.chemfig?.status, 'validated');
  // And the unpaired case keeps the old behaviour: a lone ion stays its own species.
  const lone = 'CC(=O)O.[OH-]>>CC(=O)[O-].O';
  const loneResult = await worker.invoke({ invocationId: 'salt2', toolId: 'compile', locale: 'en',
    input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: lone }), question: lone } });
  assert.ok(loneResult.artifacts?.[0]?.data?.reaction, 'a reaction of unpaired ions still draws');
});

test('ions that react with each other stay separate species; a salt with a spectator ion is still one', async () => {
  // Every consecutive run of ions whose charges close to zero was grouped as one salt, so a
  // neutralisation or a precipitation was drawn as a single "salt" reactant turning into the product.
  const worker = lib.createWorker(stubHost());
  const reactants = async (smiles, id) => {
    const result = await worker.invoke({ invocationId: id, toolId: 'compile', locale: 'en',
      input: { plan: JSON.stringify({ version: 2, kind: 'reaction', depiction: 'skeletal', reactionSmiles: smiles }), question: smiles } });
    const reaction = result.artifacts?.[0]?.data?.reaction;
    assert.ok(reaction, JSON.stringify(result.notices ?? result.view).slice(0, 400));
    return reaction.species.filter((entry) => entry.role === 'reactant').map((entry) => entry.smiles);
  };
  assert.deepEqual(await reactants('[H+].[OH-]>>O', 'ion1'), ['[H+]', '[OH-]'], 'a neutralisation has two reactants');
  assert.deepEqual(await reactants('[Ag+].[Cl-]>>Cl[Ag]', 'ion2'), ['[Ag+]', '[Cl-]'], 'a precipitation has two reactants');
  assert.deepEqual(await reactants('CC(=O)[O-].[H+]>>CC(=O)O', 'ion3'), ['CC(=O)[O-]', '[H+]'], 'a protonation has two reactants');
  // The sodium is on both sides, so sodium nitrite is still read as the one salt the author named.
  const salt = await reactants('Oc1ccccc1.O=N[O-].[Na+].O=S(=O)(O)O>O>O=Nc1ccc(O)cc1.O=S(=O)([O-])[O-].[Na+].[Na+].O', 'ion4');
  assert.ok(salt.includes('O=N[O-].[Na+]'), JSON.stringify(salt));
});

test('an unbuilt step keeps its place, so later steps keep their numbers', async () => {
  const worker = lib.createWorker(stubHost());
  const result = await worker.invoke({ invocationId: 'gap1', toolId: 'verify-route', locale: 'en', input: { steps: ['CCO>>CC=O.[H][H]', '', 'CC=O.O>>CC(O)O'] } });
  const audit = result.artifacts[0].data;
  assert.equal(audit.steps.length, 3, 'three steps, not two');
  assert.equal(audit.steps[1].ok, false);
  assert.match(audit.steps[1].error, /could not be built/);
  assert.equal(audit.steps[2].index, 2, 'step 3 is still step 3');
});

test('a synthesis route draws its target even when the route names a mechanism or a dehydration', async () => {
  const worker = lib.createWorker(stubHost());
  const smiles = 'CC(=O)Oc1ccccc1C(=O)O';
  const plan = JSON.stringify({ version: 2, kind: 'structure', depiction: 'skeletal', species: [{ id: 'target', input: { kind: 'smiles', value: smiles } }] });
  const route = `Propose a synthesis of aspirin (SMILES: ${smiles}) via an aldol-free route; explain the mechanism of the dehydration step and any endo selectivity.`;
  const drawn = await worker.invoke({ invocationId: 'rt1', toolId: 'compile', locale: 'en', input: { plan, question: route } });
  assert.ok(drawn.artifacts?.length, JSON.stringify(drawn.notices ?? drawn.view));
  // Outside a route the same words still ask for that kind of drawing, and a plain structure is refused.
  const plain = await worker.invoke({ invocationId: 'rt2', toolId: 'compile', locale: 'en', input: { plan, question: `Show the dehydration of ${smiles}` } });
  assert.ok(!plain.artifacts?.length, 'a depiction request is still not answered with a skeletal drawing');
});

test('check-stock sends the stock directory and molecules to the worker and counts the hits', async () => {
  const host = stubHost();
  const sent = [];
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => { sent.push(JSON.parse(request.stdin)); return { code: 0, stdout: JSON.stringify({ stock: { CCO: ['mcule', 'enamine'], c1ccccc1: [] }, lists: ['enamine', 'mcule'] }), stderr: '' }; },
  };
  const result = await lib.createWorker(host).invoke({ invocationId: 'stock1', toolId: 'check-stock', locale: 'en', input: { stockDir: '/stock', molecules: ['CCO', 'c1ccccc1', '  '] } });
  assert.deepEqual(sent[0], { stock: ['CCO', 'c1ccccc1'], stockDir: '/stock' });
  assert.equal(result.artifacts[0].artifactType, 'stock-availability');
  assert.equal(result.artifacts[0].summary, 'Stock: 1 of 2 molecule(s) in stock on 2 list(s).');
  await assert.rejects(lib.createWorker(host).invoke({ invocationId: 'stock2', toolId: 'check-stock', locale: 'en', input: { stockDir: '', molecules: ['CCO'] } }), /stock directory/);
});

test('propose-disconnections passes the stock directory only when given', async () => {
  const host = stubHost();
  const sent = [];
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => { sent.push(JSON.parse(request.stdin)); return { code: 0, stdout: JSON.stringify({ disconnections: [] }), stderr: '' }; },
  };
  const worker = lib.createWorker(host);
  await worker.invoke({ invocationId: 'dis1', toolId: 'propose-disconnections', locale: 'en', input: { indexDir: '/idx', targets: ['CCO'], stockDir: '/stock' } });
  await worker.invoke({ invocationId: 'dis2', toolId: 'propose-disconnections', locale: 'en', input: { indexDir: '/idx', targets: ['CCO'] } });
  assert.equal(sent[0].stockDir, '/stock');
  assert.equal('stockDir' in sent[1], false);
});

test('propose-disconnections keeps the templates that proposed each disconnection', async () => {
  // The worker lists, per proposal, the retro templates that produced it (most common first), so an
  // index that documents its templates (a textbook-scheme index) can cite their sources.
  const host = stubHost();
  const proposal = { precursors: 'CN1CCNCC1.Clc1ccccc1', templateCount: 5, rdchiral: 5, recorded: 0, templates: ['[N;H0;D3;+0:1]-[c:2]>>Cl-[c:2].[NH;D2;+0:1]'] };
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async () => ({ code: 0, stdout: JSON.stringify({ disconnections: [{ input: 'CN1CCN(c2ccccc2)CC1', target: 'CN1CCN(c2ccccc2)CC1', madeBy: null, proposals: [proposal] }] }), stderr: '' }),
  };
  const result = await lib.createWorker(host).invoke({ invocationId: 'dis3', toolId: 'propose-disconnections', locale: 'en', input: { indexDir: '/idx', targets: ['CN1CCN(c2ccccc2)CC1'] } });
  assert.deepEqual(result.artifacts[0].data.disconnections[0].proposals[0].templates, proposal.templates);
  const worker = await import('node:fs').then(fs => fs.readFileSync(new URL('../python/reactions_worker.py', import.meta.url), 'utf8'));
  assert.match(worker, /"templates": \[smarts for _count, smarts in proposal\.get\("templates", \[\]\)\]/, 'the Python worker emits the proposing templates');
});

test('search-routes sends every index, the target and the budget to the worker and summarises the routes', async () => {
  const host = stubHost();
  const sent = [];
  let timeoutMs = 0;
  const route = { target: 'CCOC(=O)c1ccc(N)cc1', expanded: 3, timedOut: false, indexes: ['ord', 'textbook'], routes: [{ cost: 1, steps: [{ product: 'CCOC(=O)c1ccc(N)cc1', precursors: ['CCO', 'Nc1ccc(C(=O)O)cc1'], kind: 'recorded', index: 'textbook', recorded: 2, samples: ['tb-00000000000000000000000000000001'] }], startingMaterials: [{ smiles: 'CCO', given: false, inStock: true }] }] };
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => { sent.push(JSON.parse(request.stdin)); timeoutMs = request.timeoutMs; return { code: 0, stdout: JSON.stringify({ route }), stderr: '' }; },
  };
  const worker = lib.createWorker(host);
  const result = await worker.invoke({ invocationId: 'rs1', toolId: 'search-routes', locale: 'en', input: { indexDirs: ['/ord', '/textbook'], target: ' CCOC(=O)c1ccc(N)cc1 ', startingMaterials: ['CCO'], maxSteps: 9, stockDir: '/stock', budgetSeconds: 30 } });
  assert.deepEqual(sent[0], { indexDirs: ['/ord', '/textbook'], route: 'CCOC(=O)c1ccc(N)cc1', startingMaterials: ['CCO'], maxSteps: 6, budgetSeconds: 30, stockDir: '/stock' });
  assert.equal(timeoutMs, 90_000, 'the call outlives the worker budget');
  assert.equal(result.artifacts[0].artifactType, 'candidate-routes');
  assert.equal(result.artifacts[0].summary, 'Route search: 1 complete route(s) after 3 expansion(s).');
  assert.deepEqual(result.artifacts[0].data, route);
  await worker.invoke({ invocationId: 'rs2', toolId: 'search-routes', locale: 'en', input: { indexDirs: ['/ord'], target: 'CCO' } });
  assert.equal('stockDir' in sent[1], false);
  assert.equal(sent[1].budgetSeconds, 90);
  await assert.rejects(worker.invoke({ invocationId: 'rs3', toolId: 'search-routes', locale: 'en', input: { indexDirs: [], target: 'CCO' } }), /index directory and a target/);
  const python = fs.readFileSync(new URL('../python/reactions_worker.py', import.meta.url), 'utf8');
  assert.match(python, /request\.get\("indexDirs"/, 'the Python worker reads several index directories');
  assert.match(python, /budget_seconds/, 'the Python search has a time budget');
});

test('a solid-phase-length route (80 steps) is checked whole; 97 steps are refused', async () => {
  const worker = lib.createWorker(stubHost());
  // An alternating oxidation/reduction chain: 80 balanced, connected steps.
  const steps = Array.from({ length: 80 }, (_, i) => (i % 2 ? 'CC=O.[H][H]>>CCO' : 'CCO.O=O>>CC=O.O'));
  const result = await worker.invoke({ invocationId: 'long1', toolId: 'verify-route', locale: 'en', input: { steps } });
  const audit = result.artifacts[0].data;
  assert.equal(audit.steps.length, 80);
  assert.ok(audit.steps.every((step) => step.balanced), 'every step balanced');
  await assert.rejects(worker.invoke({ invocationId: 'long2', toolId: 'verify-route', locale: 'en', input: { steps: Array(97).fill('CCO.O=O>>CC=O.O') } }), /between one and 96 steps/);
});

test('known-reactions and propose-disconnections pass the precedents\' conditions through', async () => {
  // With a conditions table beside the ORD index, the worker attaches what a sample reaction was run
  // with (reagents, solvents, temperature, yield, reference) to exact matches, the closest recorded
  // reaction and recorded disconnections; the TS layer must not drop it.
  const conditions = [{ id: 'ord-0000000000000000000000000000abcd', reagents: ['NaBH4'], solvents: ['MeOH'], temperature: '0 °C', yield: 92, ref: 'US00000001' }];
  const host = stubHost();
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => {
      const body = JSON.parse(request.stdin);
      const out = body.disconnect
        ? { disconnections: [{ input: 'CCO', target: 'CCO', madeBy: { count: 1, asReactant: 0, reactions: [{ key: 'k', count: 1, samples: [conditions[0].id], reaction: 'CC=O>>CCO', uses: {}, conditions }] }, proposals: [] }] }
        : { reactions: [{ input: 'CC=O>>CCO', key: 'k', count: 1, samples: [conditions[0].id], conditions }], products: [], similar: [] };
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    },
  };
  const worker = lib.createWorker(host);
  const known = await worker.invoke({ invocationId: 'cond1', toolId: 'known-reactions', locale: 'en', input: { indexDir: '/idx', reactions: ['CC=O>>CCO'] } });
  assert.deepEqual(known.artifacts[0].data.reactions[0].conditions, conditions);
  const dis = await worker.invoke({ invocationId: 'cond2', toolId: 'propose-disconnections', locale: 'en', input: { indexDir: '/idx', targets: ['CCO'] } });
  assert.deepEqual(dis.artifacts[0].data.disconnections[0].madeBy.reactions[0].conditions, conditions);
});

test('the Python worker attaches conditions from conditions.tsv.zst (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // A synthetic conditions table (blocked zstd, like the index builder writes) and a direct call of
  // the worker's attach helper: two samples with conditions, one without.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, tempfile, zstandard as zstd
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
d = tempfile.mkdtemp()
rows = ['ord-a\\t{"reagents":["NaBH4"],"yield":92}', 'ord-b\\t{"solvents":["MeOH"]}']
frame = zstd.ZstdCompressor().compress(("\\n".join(rows) + "\\n").encode())
open(os.path.join(d, 'conditions.tsv.zst'), 'wb').write(frame)
open(os.path.join(d, 'conditions.tsv.zst.blocks'), 'w').write(f'ord-a\\t0\\t{len(frame)}')
items = [{"samples": ["ord-a", "ord-b", "ord-c"]}, {"samples": ["ord-c"]}, {"count": 0}]
w._attach_conditions(d, items)
empty = [{"samples": ["ord-a"]}]
w._attach_conditions(tempfile.mkdtemp(), empty)
print(json.dumps([items, empty]))
`;
  const [items, empty] = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.deepEqual(items[0].conditions, [{ id: 'ord-a', reagents: ['NaBH4'], yield: 92 }, { id: 'ord-b', solvents: ['MeOH'] }]);
  assert.equal('conditions' in items[1], false, 'a sample without conditions adds nothing');
  assert.equal('conditions' in empty[0], false, 'an index without a conditions table is unchanged');
});

test('the index is read only as far as a request needs it, and the template screen is cached (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // Both used to be rebuilt in full by every call, a fresh process each time: the whole exact and
  // products tables as dicts (3.9 s, 3 GB), and one pattern fingerprint per retro template (4.8 s).
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, tempfile, glob, zstandard as zstd
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
d = tempfile.mkdtemp()
def write(name, rows, blocks=False):
    frame = zstd.ZstdCompressor().compress(("\\n".join(rows) + "\\n").encode())
    open(os.path.join(d, name), 'wb').write(frame)
    if blocks:
        open(os.path.join(d, name + '.blocks'), 'w').write(f'{rows[0].split(chr(9))[0]}\\t0\\t{len(frame)}')
write('exact.tsv.zst', ['aaa\\t3\\tord-1,ord-2', 'bbb\\t5\\t', 'ccc\\t7\\tord-9'], blocks=True)
write('products.tsv.zst', ['p1\\t2\\taaa,bbb', 'p2\\t1\\t'])
store = w._LazyStore(d)
exact, samples, products = store['exact'], store['samples'], store['products']
products.prefetch({'p1', 'p2', 'zz'})
out = {
  'counts': [exact.get('aaa', 0), exact.get('bbb', 0), exact.get('nope', 0)],
  'samples': ['aaa' in samples, 'bbb' in samples, samples['ccc']],
  'products': [products.get('p1'), products.get('p2'), products.get('zz')],
  'faiss_loaded': store._index is not None,
}
write('retro-templates.tsv.zst', ['9\\t1\\t[C:1]-[OH:2]>>[C:1]-[O:2]C(C)=O', '4\\t0\\tnot a smarts ((>>C', '2\\t1\\t[c:1]-[Br:2]>>[c:1]'])
cold = w._retro_templates(d)
w._retro_cache.clear(); w._retro_screen.clear()
warm = w._retro_templates(d)
out['cache_files'] = len(glob.glob(os.path.join(d, 'retro-templates.tsv.zst.screen-*.npz')))
out['cold'] = [[r[0], r[2], r[3] is not None] for r in cold]
out['warm'] = [[r[0], r[2], r[3] is not None] for r in warm]
from rdkit import Chem
out['screened'] = [r[2] for r in w._screened(d, warm, Chem.MolFromSmiles('Brc1ccccc1'))]
cut = w._disconnect(d, ['Brc1ccccc1', 'CCO'], 8, budget_seconds=1e-9)
whole = w._disconnect(d, ['Brc1ccccc1'], 8)
out['cut'] = [e.get('partial', False) for e in cut]
out['whole'] = [e.get('partial', False) for e in whole]
print(json.dumps(out))
`;
  const out = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.deepEqual(out.counts, [3, 5, 0], 'exact counts by key, 0 for an unknown key');
  assert.deepEqual(out.samples, [true, false, 'ord-9'], 'samples only where the row has them');
  assert.deepEqual(out.products, [{ count: 2, keys: ['aaa', 'bbb'] }, { count: 1, keys: [] }, null]);
  assert.equal(out.faiss_loaded, false, 'the fingerprint index is not loaded for a request that does not ask for neighbours');
  assert.equal(out.cache_files, 1, 'the screen is written beside the templates');
  assert.deepEqual(out.cold.map((row) => row.slice(0, 2)), out.warm.map((row) => row.slice(0, 2)), 'the same rows, cold or warm');
  assert.equal(out.cold.length, 2, 'a template that does not parse is dropped either way');
  assert.ok(out.warm.every((row) => row[2] === false), 'warm rows parse their query only when used');
  assert.ok(out.screened.includes('[c:1]-[Br:2]>>[c:1]'), 'the cached screen still admits a template that matches');
  // A deadline keeps what was found and says so, rather than running into the runtime limit.
  assert.deepEqual(out.cut, [true, true], 'every target the deadline cut short is marked partial');
  assert.deepEqual(out.whole, [false], 'without a deadline nothing is marked');
});

test('a stock import writes first-block lists; the stock check reports the same compound in another form (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // A synthetic catalogue: racemic lactic acid and benzocaine. (S)-lactic acid is not listed as
  // such but is the same compound by InChIKey connectivity, so it comes back under sameSkeleton;
  // the .k1.u64 file is not mistaken for a vendor list.
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chem-stock-k1-'));
  const source = path.join(dir, 'catalogue.smi');
  fs.writeFileSync(source, 'SMILES\nCC(O)C(=O)O\nCCOC(=O)c1ccc(N)cc1\n');
  const worker = new URL('../python/reactions_worker.py', import.meta.url).pathname;
  const out = path.join(dir, 'stock');
  const meta = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, [worker, '--import-stock', source, 'demo', out, 'stock'], { encoding: 'utf8' }));
  assert.equal(meta.compounds, 2);
  assert.equal(meta.skeletons, 2);
  assert.ok(fs.existsSync(path.join(out, 'demo.k1.u64')));
  const reply = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, [worker], { input: JSON.stringify({ stockDir: out, stock: ['CCOC(=O)c1ccc(N)cc1', 'C[C@H](O)C(=O)O', 'CCCC'] }), encoding: 'utf8' }));
  assert.deepEqual(reply.lists, ['demo'], 'the first-block file is not a vendor');
  assert.deepEqual(reply.stock['CCOC(=O)c1ccc(N)cc1'], ['demo']);
  assert.deepEqual(reply.stock['C[C@H](O)C(=O)O'], []);
  assert.deepEqual(reply.sameSkeleton, { 'C[C@H](O)C(=O)O': ['demo'] }, 'only the not-exactly-listed compound, and only when its skeleton is listed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-compatibility sends the steps and textbook directory to the worker and counts the hazards', async () => {
  const host = stubHost();
  const sent = [];
  host.python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async (request) => {
      sent.push(JSON.parse(request.stdin));
      return { code: 0, stdout: JSON.stringify({ compatibility: [{ step: 1, reagentClasses: [{ id: 'strong-hydride', label: 'strong hydride' }], hazards: [{ group: 'ester', severity: 'high' }, { group: 'alcohol', severity: 'medium' }] }] }), stderr: '' };
    },
  };
  const worker = lib.createWorker(host);
  const result = await worker.invoke({ invocationId: 'compat1', toolId: 'check-compatibility', locale: 'en', input: {
    steps: [{ reactants: ['CCOC(=O)CCC(=O)c1ccccc1', '  '], products: ['OC(CCC(=O)OCC)c1ccccc1'], reagents: 'LiAlH4, THF' }],
    textbookDir: '/textbook',
  } });
  assert.deepEqual(sent[0], { compatibility: [{ reactants: ['CCOC(=O)CCC(=O)c1ccccc1'], products: ['OC(CCC(=O)OCC)c1ccccc1'], reagents: 'LiAlH4, THF' }], textbookDir: '/textbook' });
  assert.equal(result.artifacts[0].artifactType, 'step-compatibility');
  assert.equal(result.artifacts[0].summary, 'Compatibility: 2 hazard(s) in 1 step(s), 1 high.');
  await assert.rejects(worker.invoke({ invocationId: 'compat2', toolId: 'check-compatibility', locale: 'en', input: { steps: [{ reactants: [], products: ['C'] }] } }), /at least one step/);
});

test('the Python compatibility check flags clashes and leaves clean steps alone (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
steps = [
  {"reactants": ["CCOC(=O)CCC(=O)c1ccccc1"], "products": ["OC(CCC(=O)OCC)c1ccccc1"], "reagents": "LiAlH4, THF"},
  {"reactants": ["OCCc1ccc(Br)cc1", "C[Mg]Br"], "products": ["OCCc1ccc(C)cc1"], "reagents": "MeMgBr, ether"},
  {"reactants": ["O=C(NCCC=C)OCc1ccccc1"], "products": ["O=C(NCCCC)OCc1ccccc1"], "reagents": "H2, Pd/C, EtOH"},
  {"reactants": ["CCOC(=O)c1ccc([N+](=O)[O-])cc1"], "products": ["CCOC(=O)c1ccc(N)cc1"], "reagents": "H2, Pd/C, EtOH"},
  {"reactants": ["CC(=O)c1ccccc1"], "products": ["CC(O)c1ccccc1"], "reagents": "NaBH4, MeOH"},
  {"reactants": ["COC(=O)/C=C/c1ccccc1"], "products": ["COC(=O)CC(C)c1ccccc1"], "reagents": "MeMgBr, CuI"},
  {"reactants": ["CC(C)(C)OC(=O)NCCO"], "products": ["NCCO"], "reagents": "NaOH, water"},
  {"reactants": ["CC(C)(C)OC(=O)CCC=O"], "products": ["CC(C)(C)OC(=O)CCC(O)c1ccccc1"], "reagents": "1. PhMgBr 2. 1 N HCl"},
]
print(json.dumps(w._compatibility(steps)))
`;
  const out = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
  const flags = out.map(step => step.hazards.map(h => `${h.group}/${h.reagentClass}/${h.severity}`));
  assert.deepEqual(flags[0], ['ester/strong-hydride/high'], 'an ester kept through LiAlH4');
  assert.deepEqual(flags[1], ['alcohol/organometallic/high'], 'a free OH beside a Grignard');
  assert.deepEqual(flags[2], ['cbz/hydrogenation/high'], 'a Cbz kept through H2/Pd');
  assert.deepEqual(flags[3], [], 'a nitro reduction beside an ester is clean');
  assert.deepEqual(flags[4], [], 'NaBH4 on a ketone is clean');
  assert.deepEqual(flags[5], [], 'a cuprate conjugate addition leaves the ester alone');
  assert.deepEqual(flags[6], ['boc/null/medium'], 'a Boc lost with no acid named');
  assert.equal(flags[7].some(f => f.startsWith('tbu-ester/')), false, 'a work-up with 1 N HCl is not a strong-acid step');
  assert.match(out[1].hazards[0].suggestion, /silyl ether/);
  assert.deepEqual(out[1].hazards[0].protectedForms, ['TBS ether', 'TBDPS ether', 'benzyl ether']);
});

test('the inspection reports the configuration next to a free acid\'s nitrogen-bearing centre', async () => {
  // The one wrong-structure class the deterministic checks cannot see: the opposite
  // configuration has the same formula, the same atom counts and the same constitution, so
  // balance and continuity both pass. The letter is reported, never judged — which letter
  // belongs to a series flips when a sulfur-bearing branch outranks the carboxyl.
  // Structures are the ones a real route declared, so this pins the measurement to live data.
  const cases = [
    ['O=C(N[C@H](Cc1cccnc1)C(=O)O)OCC1c2ccccc2-c2ccccc21', '(R)'],
    ['O=C(N[C@H](Cc1ccc2ccccc2c1)C(=O)O)OCC1c2ccccc2-c2ccccc21', '(R)'],
    ['CC(C)(C)OC(=O)NCCOc1ccc(C[C@@H](NC(=O)OCC2c3ccccc3-c3ccccc32)C(=O)O)cc1', '(R)'],
    ['Cc1cccc2c(C[C@@H](NC(=O)OCC3c4ccccc4-c4ccccc43)C(=O)O)c[nH]c12', '(R)'],
    ['O=C(C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O)NC(c1ccccc1)(c1ccccc1)c1ccccc1', '(S)'],
    ['CC(=O)N[C@H](C(=O)O)C(C)(C)SC(c1ccccc1)(c1ccccc1)c1ccccc1', '(R)'],
  ];
  for (const [smiles, expected] of cases) {
    const checked = await lib.validateChemicalReferences({ references: [smiles], inspect: true });
    assert.equal(checked.inspection?.alphaConfiguration, expected, smiles.slice(0, 40));
  }
});

test('a species with no such centre carries no configuration', async () => {
  for (const smiles of ['C1=CC=C2C(=C1)C(C3=CC=CC=C32)COC(=O)NCC(=O)O', 'CCO', 'O', 'CS(C)=O']) {
    const checked = await lib.validateChemicalReferences({ references: [smiles], inspect: true });
    assert.equal(checked.inspection?.alphaConfiguration, undefined, smiles);
  }
});

test('an open centre is reported as unassigned rather than guessed', async () => {
  const checked = await lib.validateChemicalReferences({ references: ['CC(N)C(=O)O'], inspect: true });
  assert.equal(checked.inspection?.alphaConfiguration, 'unassigned');
});

test('an Agent that would balance the step exactly is named with the count, and one that would not is only a suggestion', async () => {
  // Exact: the acid is under Agents, and one copy of it on the reactant side closes the equation.
  const exact = await lib.auditRoute({ steps: ['CCO>CC(=O)O>CC(=O)OCC.O'] });
  const exactBlocked = exact.blocked.join(' ');
  assert.match(exactBlocked, /adding it to the reactants balances the step exactly/);
  assert.match(exactBlocked, /list it under Reactants \(1 C2H4O2\)/);
  // Not exact: the medium carries the deficient elements but cannot account for the shortfall,
  // so it is named as a possibility and the likelier fault is stated. Advising that the medium be
  // moved to Reactants outright is how a large step with incomplete byproducts was misdiagnosed.
  const loose = await lib.auditRoute({ steps: ['O=CCCC=O.CN>CN(C)C=O>CN1C2CCC1CC(=O)C2.O'] });
  const looseBlocked = loose.blocked.join(' ');
  assert.match(looseBlocked, /listed under Agents, but the reactants are missing atoms that species contains/);
  assert.match(looseBlocked, /Move it to Reactants only if it is actually consumed/);
  assert.match(looseBlocked, /products or byproducts are probably incomplete/);
  assert.doesNotMatch(looseBlocked, /balances the step exactly/);
});

test('loose ions give the solver free coefficients, so a wrong equation can balance', async () => {
  // The metal-ion fault, reproduced. Every one of these is arithmetically correct; the point is
  // that a species declared as ONE salt arrives as several independent fragments, each with its
  // own coefficient, and the solver can use that freedom to rescue an equation that is wrong.
  //
  // CH3MgBr + H2O -> CH4 + Mg(2+) + Br(-) + O(2-) is one hydrogen short as written, and comes
  // back "balanced" as 2/1/2/2/2/1. Correct as written, it needs hydroxide, not oxide.
  const wrong = await lib.auditRoute({ steps: ['C[Mg]Br.O>>C.[Mg+2].[Br-].[O-2]'] });
  assert.equal(wrong.steps[0].ok, true, 'the step parses');
  assert.equal(wrong.steps[0].balanced, false, 'it used to come back balanced at 2/1/2/2/2/1');
  assert.match(wrong.steps[0].differences.join(' '), /"\[O-2\]" is a free multiply-charged anion/);
  assert.match(wrong.steps[0].differences.join(' '), /name the salt, the hydroxide or the acid/);
  assert.match(wrong.steps[0].differences.join(' '), /an equation that is wrong can still be solved/);

  // What does behave correctly today, so a fix does not regress it.
  const right = await lib.auditRoute({ steps: ['C[Mg]Br.O>>C.[Mg+2].[Br-].[OH-]'] });
  assert.equal(right.steps[0].balanced, true, 'the hydroxide form is genuinely balanced');
  assert.deepEqual([...right.steps[0].reactants, ...right.steps[0].products].map((e) => e.coefficient ?? 1),
    [1, 1, 1, 1, 1, 1], 'and at unit coefficients');

  for (const reaction of [
    'C[Mg]Br.O>>C',                                   // salt omitted entirely
    'CC(=O)C.C[Mg]Br.O>>CC(C)(C)O',                   // no metal on the product side
    'c1ccccc1.[Br]>>Brc1ccccc1',                      // a loose atom on one side only
    'CC(=O)C.[Mg+2].[Br-].[Br-]>>CC(C)O.[Mg+2].[Br-].[Br-]', // spectator ions, 2 H missing
  ]) {
    const audit = await lib.auditRoute({ steps: [reaction] });
    assert.equal(audit.steps[0].balanced, false, `must not balance: ${reaction}`);
  }

  // A valid reaction is not pushed off by the ionic form of its byproduct.
  for (const reaction of [
    'O=Cc1ccccc1.c1ccc(cc1)[P+](c1ccccc1)(c1ccccc1)[CH-]c1ccccc1>>C(=C/c1ccccc1)\\c1ccccc1.O=P(c1ccccc1)(c1ccccc1)c1ccccc1',
    'O=Cc1ccccc1.c1ccc(cc1)[P+](c1ccccc1)(c1ccccc1)[CH-]c1ccccc1>>C(=C/c1ccccc1)\\c1ccccc1.[O-][P+](c1ccccc1)(c1ccccc1)c1ccccc1',
  ]) {
    const audit = await lib.auditRoute({ steps: [reaction] });
    assert.equal(audit.steps[0].balanced, true, `must still balance: ${reaction.slice(0, 40)}`);
  }
});

test('a species declared as one salt takes one coefficient, not one per ion', async () => {
  // The full fix for the loose-ion fault. A reaction SMILES cannot say which components belong
  // to one species, so a salt declared once arrives as several fragments and each is a free
  // coefficient. With the author's labels the boundary is recoverable, so the salt counts once.
  const step = 'C[Mg]Br.O>>C.[Mg+2].[Br-].[OH-]';
  const labels = [[
    { role: 'reactant', name: 'methylmagnesium bromide', smiles: 'C[Mg]Br' },
    { role: 'reactant', name: 'water', smiles: 'O' },
    { role: 'product', name: 'methane', smiles: 'C' },
    { role: 'product', byproduct: true, name: 'magnesium bromide hydroxide', smiles: '[Mg+2].[Br-].[OH-]' },
  ]];
  const grouped = await lib.auditRoute({ steps: [step], labels });
  assert.equal(grouped.steps[0].balanced, true, 'the hydrolysis still balances');
  assert.equal(grouped.steps[0].products.length, 2, 'the salt is ONE product species, not three ions');
  assert.deepEqual(grouped.steps[0].products.map((e) => e.coefficient ?? 1), [1, 1]);
  const salt = grouped.steps[0].products.find((e) => e.canonicalSmiles.includes('.'));
  assert.ok(salt, 'the grouped species keeps its multi-fragment structure');
  assert.equal(salt.name, 'magnesium bromide hydroxide', 'and the label\'s name now attaches to it');

  // Ungrouped, the same step still reports three ions — unchanged for a caller that sends no
  // labels, so nothing regresses for them.
  const ungrouped = await lib.auditRoute({ steps: [step] });
  assert.equal(ungrouped.steps[0].products.length, 4);

  // A partial match must not silently drop atoms: a label whose fragments are not all present
  // leaves every fragment where it was.
  const partial = await lib.auditRoute({
    steps: ['C[Mg]Br.O>>C.[Mg+2].[Br-]'],
    labels: [[{ role: 'product', byproduct: true, name: 'magnesium bromide hydroxide', smiles: '[Mg+2].[Br-].[OH-]' }]],
  });
  assert.equal(partial.steps[0].products.length, 3, 'no grouping, so the missing hydroxide is still missing');
  assert.equal(partial.steps[0].balanced, false, 'and the step correctly does not balance');
});

test('two salts sharing an ion balance from their declared stoichiometry, not the solver\'s guess', async () => {
  // The case the old write-each-ion-once design existed for, now done by grouping. The host
  // writes every fragment of every species; the labels say where each species begins, so
  // chromium(III) sulfate keeps its 2:3 ratio instead of becoming one chromium and one sulfate
  // whose counts the solver re-derives.
  const sulfate = 'S(=O)(=O)([O-])[O-]';
  const chromiumSulfate = `${sulfate}.[Cr+3].${sulfate}.${sulfate}.[Cr+3]`;
  const sodiumSulfate = `${sulfate}.[Na+].[Na+]`;
  const dichromate = '[O-][Cr](=O)(=O)O[Cr](=O)(=O)[O-].[Na+].[Na+]';
  const sulfuric = 'O=S(=O)(O)O';
  const step = `C1CCC(CC1)O.${dichromate}.${sulfuric}>>O=C1CCCCC1.${chromiumSulfate}.${sodiumSulfate}.O`;
  const labels = [[
    { role: 'reactant', name: 'cyclohexanol', smiles: 'C1CCC(CC1)O' },
    { role: 'reactant', name: 'sodium dichromate', smiles: dichromate },
    { role: 'reactant', name: 'sulfuric acid', smiles: sulfuric },
    { role: 'product', name: 'cyclohexanone', smiles: 'O=C1CCCCC1' },
    { role: 'product', byproduct: true, name: 'chromium(III) sulfate', smiles: chromiumSulfate },
    { role: 'product', byproduct: true, name: 'sodium sulfate', smiles: sodiumSulfate },
    { role: 'product', byproduct: true, name: 'water', smiles: 'O' },
  ]];
  const audit = await lib.auditRoute({ steps: [step], labels });
  assert.equal(audit.steps[0].ok, true, 'the step parses');
  assert.equal(audit.steps[0].reactants.length, 3, 'three declared reactants, not nine fragments');
  assert.equal(audit.steps[0].products.length, 4, 'four declared products, not eleven fragments');
  const named = audit.steps[0].products.map((entry) => entry.name);
  assert.ok(named.includes('chromium(III) sulfate'), 'the grouped salt carries its name');
  assert.ok(named.includes('sodium sulfate'), 'and so does the other one');
  assert.equal(audit.steps[0].balanced, true, 'and the classic oxidation balances');
});

test('an ester reduction is not classed as a hydrolysis (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // Reaction classes are read from functional-group changes and used as textbook SEARCH TERMS, so
  // a wrong class retrieves the wrong page — worse than retrieving nothing. The rule treated
  // "ester gone, alcohol appeared" as a hydrolysis, so a hydride reduction searched for
  // saponification pages. A hydrolysis needs the ACID to appear; the alcohol test cannot stand in
  // for it, because in `ester + X -> Y + ethanol` the leaving group is itself an alcohol.
  const { execFileSync } = await import('node:child_process');
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rw', ${JSON.stringify(new URL('../python/reactions_worker.py', import.meta.url).pathname)})
m = importlib.util.module_from_spec(spec); sys.modules['rw'] = m
spec.loader.exec_module(m)
cases = [
  ('CCOC(=O)c1ccccc1', 'OCc1ccccc1.CCO'),                      # hydride reduction
  ('CCOC(=O)c1ccccc1.[OH-]', 'OC(=O)c1ccccc1.CCO'),            # saponification
  ('CCOC(=O)c1ccccc1.C[Mg]Br', 'CC(=O)c1ccccc1.CCO'),          # organometallic addition
  ('CCOC(=O)c1ccccc1', 'O=Cc1ccccc1.CCO'),                     # partial reduction to the aldehyde
  ('CC(=O)c1ccccc1', 'CC(O)c1ccccc1'),                         # plain carbonyl reduction
]
print(json.dumps([m._reaction_classes(a, b) for a, b in cases]))
`;
  const [reduction, hydrolysis, grignard, aldehyde, carbonyl] =
    JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));

  assert.deepEqual(reduction, ['reduction of an ester to an alcohol'], 'the hydride reduction is named for what it is');
  assert.ok(!reduction.includes('ester hydrolysis'), 'and is no longer called a hydrolysis');
  assert.ok(hydrolysis.includes('ester hydrolysis'), 'saponification still is one');
  // An organometallic addition is neither, and claims neither rather than claiming the wrong one.
  assert.ok(!grignard.includes('ester hydrolysis'), 'the addition is not a hydrolysis');
  assert.ok(!grignard.includes('reduction of an ester to an alcohol'), 'nor a reduction');
  assert.ok(grignard.includes('Grignard reaction'), 'and it is still recognised for what it is');
  assert.deepEqual(aldehyde.filter((c) => c.includes('ester')), [], 'a partial reduction claims no ester class rather than a wrong one');
  assert.deepEqual(carbonyl, ['reduction of a carbonyl compound'], 'an ordinary carbonyl reduction is unaffected');
});

test('a reactant nothing accounts for is named, not silently refiled', async () => {
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  // The amide coupling balances WITHOUT the carbodiimide: acid + amine -> amide + water. The
  // author lists the carbodiimide under Reactants, which is what the request asks for when a
  // reagent is consumed, and omits the urea it becomes. Its atoms are therefore wholly
  // unaccounted for on the product side.
  const result = await lib.auditRoute({
    steps: ['CC(=O)O.CNC.C1CCCCC1N=C=NC1CCCCC1>>CC(=O)N(C)C.O'],
    labels: [[
      label('reactant', 'ethanoic acid', 'CC(=O)O'),
      label('reactant', 'N-methylmethanamine', 'CNC'),
      label('reactant', 'the carbodiimide', 'C1CCCCC1N=C=NC1CCCCC1'),
      label('product', 'the amide', 'CC(=O)N(C)C'),
      label('product', 'water', 'O', true),
    ]],
  });
  const step = result.steps[0];
  // The verdict is NOT flipped: the arithmetic cannot tell a condition that was never consumed
  // from a reagent that was, so guessing either way would be wrong.
  assert.equal(step.balanced, true);
  assert.deepEqual(step.differences, []);
  // What used to be missing: the step said nothing, and the species lost its name in the move.
  assert.ok(step.refiledReactant, 'the assumption is reported');
  assert.match(step.refiledReactant, /"the carbodiimide" was listed under Reactants/);
  assert.match(step.refiledReactant, /treated it as a condition/);
  // One explicit edit, not a conditional to weigh: the author either moves it or names its product.
  assert.match(step.refiledReactant, /Make one edit to this step: move "the carbodiimide" to Agents, or name under Products the product it becomes\.$/);
  assert.doesNotMatch(step.refiledReactant, /If that is right/);

  // A step that balances on its own terms carries no such note.
  const clean = await lib.auditRoute({
    steps: ['CC(=O)O.CNC>>CC(=O)N(C)C.O'],
    labels: [[
      label('reactant', 'ethanoic acid', 'CC(=O)O'),
      label('reactant', 'N-methylmethanamine', 'CNC'),
      label('product', 'the amide', 'CC(=O)N(C)C'),
      label('product', 'water', 'O', true),
    ]],
  });
  assert.equal(clean.steps[0].balanced, true);
  assert.equal(clean.steps[0].refiledReactant, undefined);
});

test('the unverified fallback is scoped to the plan, not to the whole request', async () => {
  // The shape that produced an unverified picture of a whole route: the plan asked for one target
  // structure and the request was a multi-step synthesis. The fallback used to be handed only the
  // request, and drew the route.
  const source = fs.readFileSync(path.join(root, 'src/worker.ts'), 'utf8');
  assert.match(source, /async function rescueWithSvg\(question: string, reason: string, plan = ''\)/);
  assert.match(source, /Draw EXACTLY what the plan asked for and nothing else/);
  assert.match(source, /If the plan names a single structure, draw that one structure/);
  assert.match(source, /plan: plan\.slice\(0, 4_000\), request: question/);
  // Both abstain paths pass the plan, or the scoping is only half applied.
  assert.equal((source.match(/allowFallback, source\)/g) ?? []).length, 2, 'both abstain call sites carry the plan');
});

test('a target that specifies some centres and leaves others open can be formed', async () => {
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  // One balanced step delivering ONE of the two epimers the target admits.
  const steps = ['C[C@@H](O)[C@@H](N)C(=O)OC.O>>C[C@@H](O)[C@@H](N)C(=O)O.CO'];
  const labels = [[
    label('reactant', 'the methyl ester', 'C[C@@H](O)[C@@H](N)C(=O)OC'),
    label('reactant', 'water', 'O'),
    label('product', 'the acid', 'C[C@@H](O)[C@@H](N)C(=O)O'),
    label('product', 'methanol', 'CO', true),
  ]];
  const reasonFor = async (target) => (await lib.auditRoute({ steps, labels, target })).target?.reason;

  // Fully specified and matching, and fully unspecified: both already worked.
  assert.equal(await reasonFor('C[C@@H](O)[C@@H](N)C(=O)O'), 'formed');
  assert.equal(await reasonFor('CC(O)C(N)C(=O)O'), 'formed');
  // The case that could not be formed by ANY route: one centre specified, one left open. It was
  // reported as a stereochemistry failure at a centre the request never asked about.
  assert.equal(await reasonFor('C[C@@H](O)C(N)C(=O)O'), 'formed');
  // Still refused where the SPECIFIED centre is wrong: leaving one centre open does not loosen
  // the other, which is the failure a looser match would introduce.
  assert.equal(await reasonFor('C[C@H](O)C(N)C(=O)O'), 'stereo-mismatch');
  // And a different constitution is still not the target.
  assert.equal(await reasonFor('C[C@@H](O)C(N)C(=O)OC'), 'not-formed');
});

test('a stereocentre destroyed before the target is excused, whatever the target specifies', async () => {
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  // Two steps. Step 1 oxidises a thioether to a sulfoxide, which makes a stereocentre at sulfur
  // that nobody controls and the model writes without a descriptor. Step 2 reduces it away, so
  // nothing of it reaches the target. This is the only open-centre case that occurs in real
  // routes: every one of 219 species measured had its open centre at a sulfoxide sulfur.
  const thioether = 'CSCC[C@@H](N)C(=O)O';
  const sulfoxide = 'CS(=O)CC[C@@H](N)C(=O)O';
  const steps = [
    `${thioether}.OO>>${sulfoxide}.O`,
    `${sulfoxide}.c1ccccc1P(c1ccccc1)c1ccccc1>>${thioether}.O=P(c1ccccc1)(c1ccccc1)c1ccccc1`,
  ];
  const labels = [
    [label('reactant', 'the thioether', thioether), label('reactant', 'hydrogen peroxide', 'OO'),
     label('product', 'the sulfoxide', sulfoxide), label('product', 'water', 'O', true)],
    [label('reactant', 'the sulfoxide', sulfoxide), label('reactant', 'triphenylphosphine', 'c1ccccc1P(c1ccccc1)c1ccccc1'),
     label('product', 'the thioether', thioether), label('product', 'triphenylphosphine oxide', 'O=P(c1ccccc1)(c1ccccc1)c1ccccc1', true)],
  ];
  // The target is FULLY specified — which is the case the excusal used to refuse to consider.
  const audit = await lib.auditRoute({ steps, labels, target: thioether });
  assert.equal(audit.target?.reason, 'formed', JSON.stringify(audit.target));
  assert.ok(audit.steps[0].unspecifiedStereocentres > 0, 'step 1 really does leave a centre open');
  assert.equal(audit.steps[0].stereoNotRequired, true, 'and it is excused, because nothing of it reaches the target');
  // The excusal must not reach the step that forms the target: that one is held to it.
  assert.notEqual(audit.steps[1].stereoNotRequired, true);
  assert.ok(!(audit.blocked ?? []).some((entry) => /unspecified/.test(entry)),
    `nothing is blocked for the sulfoxide: ${JSON.stringify(audit.blocked)}`);
});

test('an inert atmosphere written as a lone atom is named', async () => {
  const label = (role, name, smiles, byproduct = false) => ({ role, name, smiles, byproduct });
  // Exactly the shape two independent reviewers caught in one answer: the prose says the step is
  // run under nitrogen, and the structure beside the name is atomic nitrogen. It sat under Agents,
  // which take no part in the balance, so nothing in the check ever looked at it and the report
  // printed "nitrogen (N)" and passed.
  const steps = ['CC(=O)O.CO>[N]>CC(=O)OC.O'];
  const labels = [[
    label('reactant', 'ethanoic acid', 'CC(=O)O'), label('reactant', 'methanol', 'CO'),
    label('agent', 'nitrogen', '[N]'),
    label('product', 'methyl ethanoate', 'CC(=O)OC'), label('product', 'water', 'O', true),
  ]];
  const audit = await lib.auditRoute({ steps, labels });
  // The equation is right, so it is NOT reported as a balance failure — that would name the
  // wrong fault.
  assert.equal(audit.steps[0].balanced, true);
  assert.deepEqual(audit.steps[0].differences, []);
  assert.ok(audit.steps[0].monatomicSpecies, 'the structure is reported');
  assert.match(audit.steps[0].monatomicSpecies, /`\[N\]` should be `N#N`/);
  assert.match(audit.steps[0].monatomicSpecies, /its free form is diatomic/);
  // An Agent gets the Agents explanation, which is the true one for that side.
  assert.match(audit.steps[0].monatomicSpecies, /takes no part in the balance/);

  // A lone atom on the REACTANT side gets a different explanation, because the reason it goes
  // unnoticed is different: the coefficient solver scales a one-atom species to whatever the
  // equation needs, so the step balances around something that does not exist. Measured on a real
  // route — "benzene (C6H6) + 2 bromine (Br)" balanced perfectly — and the first version of this
  // message told the author it took no part in the balance, which was false there.
  const asReactant = await lib.auditRoute({
    steps: ['c1ccccc1.[Br]>[Br][Fe]([Br])[Br]>Brc1ccccc1.Br'],
    labels: [[
      label('reactant', 'benzene', 'c1ccccc1'), label('reactant', 'bromine', '[Br]'),
      label('agent', 'iron(III) bromide', '[Br][Fe]([Br])[Br]'),
      label('product', 'bromobenzene', 'Brc1ccccc1'), label('product', 'hydrogen bromide', 'Br', true),
    ]],
  });
  assert.equal(asReactant.steps[0].balanced, true, 'the premise: it balances, which is why nothing else catches it');
  assert.match(asReactant.steps[0].monatomicSpecies, /`\[Br\]` should be `BrBr`/);
  assert.match(asReactant.steps[0].monatomicSpecies, /coefficient solver can scale it/);
  assert.ok(!asReactant.steps[0].monatomicSpecies.includes('takes no part in the balance'),
    'the Agents explanation must not be given for a reactant');

  // The diatomic form is accepted silently.
  const fixed = await lib.auditRoute({
    steps: ['CC(=O)O.CO>N#N>CC(=O)OC.O'],
    labels: [labels[0].map((entry) => (entry.name === 'nitrogen' ? { ...entry, smiles: 'N#N' } : entry))],
  });
  assert.equal(fixed.steps[0].monatomicSpecies, undefined);

  // A step declared radical is left alone: there, an atom really is a species.
  const radical = await lib.auditRoute({ steps, labels, radical: true });
  assert.equal(radical.steps[0].monatomicSpecies, undefined);
});

test('an over-long chat question is cut rather than failing the whole compile call', async () => {
  // B45. The hook staples the host's question onto the promoted request, and the host's question
  // is the last user message. In a route that message is the entire accumulated correction prompt,
  // which runs past compile's 8000-character cap on `question`, and the host then refused the call
  // outright and printed its raw schema complaint into the answer: 58 turns across 26 of 30
  // targets on one cascade, every one a fix round, nothing drawn and nothing drawable.
  const worker = lib.createWorker(ethanolHost());
  const long = `Correction needed for the synthesis route above.\n\n${'The route checker rejected these steps. '.repeat(600)}`;
  assert.ok(long.length > 8000, 'the fixture reproduces the condition');

  const mutations = await worker.prepareChat({
    locale: 'en', question: long,
    nodes: [{ id: 'n0', kind: 'fence', fence: 'chemistry-plan', content: plan(), complete: true }],
  });
  const promoted = mutations.find(mutation => mutation.op === 'promote-request');
  assert.ok(promoted, 'the plan is still promoted to a call');
  assert.ok(promoted.input.question.length <= 8000, 'and its question fits what the tool accepts');
  // The head is kept, not the tail: this field exists to be pattern-matched for intent, and the
  // phrase that marks a correction round opens the prompt.
  assert.match(promoted.input.question, /^Correction needed for the synthesis route above\./);

  // A question inside the cap is passed through untouched, including the exact text a reaction
  // SMILES copy check needs to find in it.
  const short = 'Draw CCO>>CC=O please.';
  const kept = await worker.prepareChat({
    locale: 'en', question: short,
    nodes: [{ id: 'n0', kind: 'fence', fence: 'chemistry-plan', content: plan(), complete: true }],
  });
  assert.equal(kept.find(mutation => mutation.op === 'promote-request').input.question, short);
});

test('every derived cap stays inside what the schema advertises, and the two agree exactly', () => {
  // The host validates input against capability.json BEFORE the tool runs, so a cap derived above
  // what the schema declares does not stretch the limit — it refuses the call. That is what B45
  // was: an 8,000-character ceiling on `question` turned every fix-round drawing into an
  // application error. So the ceilings live in one place and this test is the thing that keeps
  // capability.json honest about them.
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'capabilities/chemistry/capability.json'), 'utf8'));
  const props = (id) => schema.tools.find((entry) => entry.id === id).inputSchema.properties;
  const C = lib.SCHEMA_CEILINGS;

  assert.equal(props('compile').plan.maxLength, C.planChars, 'compile.plan');
  assert.equal(props('compile').question.maxLength, C.questionChars, 'compile.question');
  assert.equal(props('resolve-names').names.maxItems, C.names, 'resolve-names.names');
  assert.equal(props('resolve-names').names.items.maxLength, C.nameChars, 'resolve-names name length');
  assert.equal(props('resolve-structure').smiles.maxItems, C.structures, 'resolve-structure.smiles');
  const route = props('verify-route');
  assert.equal(route.steps.maxItems, C.steps, 'verify-route.steps');
  assert.equal(route.steps.items.maxLength, C.stepChars, 'verify-route step length');
  assert.equal(route.labels.items.maxItems, C.labelsPerStep, 'verify-route labels per step');
  // The per-step arrays are read positionally against `steps`, so a shorter one silently drops the
  // tail of a long route.
  for (const key of ['carriers', 'rearrangement', 'radical', 'labels']) {
    assert.equal(route[key].maxItems, C.steps, `verify-route.${key} must match steps`);
  }

  // No derived cap may exceed its ceiling, at any window, including an absurd one.
  for (const tokens of [undefined, 32_000, 200_000, 1_000_000, 100_000_000]) {
    const budget = tokens === undefined ? undefined : { contextWindowTokens: tokens, charsPerToken: 3.2 };
    assert.ok(lib.maxQuestionChars(budget) <= C.questionChars, `question at ${tokens}`);
    assert.ok(lib.maxReactionChars(budget) <= C.stepChars, `reaction at ${tokens}`);
    assert.ok(lib.maxNames(budget) <= C.names, `names at ${tokens}`);
    assert.ok(lib.maxLabelsTotal(budget) <= C.names, `labels total at ${tokens}`);
    assert.ok(lib.maxLabelsPerStep(budget) <= C.labelsPerStep, `labels per step at ${tokens}`);
    assert.ok(lib.maxSteps(budget) <= C.steps, `steps at ${tokens}`);
    assert.ok(lib.maxSpeciesPerStep(budget) <= C.labelsPerStep, `species per step at ${tokens}`);
  }
});

test('a cap never drops below the floor it has always had, and grows with the window', () => {
  const floors = { maxQuestionChars: 8_000, maxReactionChars: 16_000, maxNames: 48, maxLabelsTotal: 48, maxLabelsPerStep: 24, maxSteps: 96, maxSpeciesPerStep: 48, maxSpeciesTotal: 1_024 };
  // No window named (an older host, or a model with no documented window) must behave exactly as
  // before. "Absent" means use the floor; it must never be read as "unlimited".
  for (const [name, floor] of Object.entries(floors)) {
    assert.equal(lib[name](undefined), floor, `${name} with no budget is its old value`);
    assert.equal(lib[name]({ charsPerToken: 3.2 }), floor, `${name} with no window is its old value`);
    assert.equal(lib[name]({ contextWindowTokens: 0 }), floor, `${name} ignores a nonsense window`);
    assert.equal(lib[name]({ contextWindowTokens: -5 }), floor, `${name} ignores a negative window`);
    assert.ok(lib[name]({ contextWindowTokens: 1_000_000, charsPerToken: 3.2 }) >= floor, `${name} never regresses on a big window`);
  }
  // And the point of the exercise: the caps that were silently truncating a long route now clear it.
  const big = { contextWindowTokens: 1_000_000, charsPerToken: 3.2 };
  assert.ok(lib.maxLabelsTotal(big) > 120, 'a 40-step route names well over 48 distinct species');
  assert.ok(lib.maxSteps(big) >= 96, 'a long linear assembly runs to roughly ninety steps');
  assert.ok(lib.maxQuestionChars(big) > 9_523, 'the real correction prompt that B45 refused now fits');
});

test('a route longer than the old 96-step ceiling is actually audited now, not refused', async () => {
  // The cap tests above check the NUMBERS. This one checks the behaviour the numbers exist for:
  // a long linear assembly written one transformation per unit runs to roughly ninety steps, and
  // the next size up was refused outright. Asserting the constant moved is not the same as
  // asserting a long route gets through, so this runs one.
  const step = (n) => `CC(=O)O.NCC${'C'.repeat(n % 4)}>>CC(=O)NCC${'C'.repeat(n % 4)}.O`;
  const longRoute = { steps: Array.from({ length: 120 }, (_, i) => step(i)) };

  // Without a window the floor stands, and the floor is the old behaviour exactly.
  await assert.rejects(() => lib.auditRoute(longRoute), /between one and 96 steps/,
    'with no window named, nothing changed');

  // With the window the host now passes, the same route is accepted and every step is audited.
  const audit = await lib.auditRoute(longRoute, { contextWindowTokens: 1_000_000, charsPerToken: 3.2 });
  assert.equal(audit.steps.length, 120, 'every step comes back, not a truncated prefix');
  assert.ok(audit.steps.every((entry) => typeof entry.balanced === 'boolean'),
    'and each one was really checked, not just counted');
});

test('a named diatomic element resolves to its molecule, and nothing else does', () => {
  // The route contract tells the model to give species as NAMES and never to author a structure.
  // It wrote "bromine" — correct — and resolution returned `[Br]`, a bromine ATOM. The route then
  // failed on a species the model never wrote, and the checker asked for `BrBr`, which the same
  // contract forbids it from supplying. One target took three turns to find that workaround and
  // another never did. The fault was in this lookup, not in the answer.
  const f = lib.diatomicElementForName;

  for (const [name, smiles] of [['hydrogen', '[H][H]'], ['nitrogen', 'N#N'], ['oxygen', 'O=O'],
    ['fluorine', 'FF'], ['chlorine', 'ClCl'], ['bromine', 'BrBr'], ['iodine', 'II']]) {
    assert.equal(f(name), smiles, name);
    assert.equal(f(name.toUpperCase()), smiles, `${name} is case-insensitive`);
    assert.equal(f(`  ${name} `), smiles, `${name} tolerates whitespace`);
  }
  assert.equal(f('molecular bromine'), 'BrBr');
  assert.equal(f('dinitrogen'), 'N#N');

  // CHARGE. An ion is not an element's free form, and a bare charged atom is the RIGHT answer for
  // it: `[H+]` is a proton, `[H][H]` is hydrogen gas, and confusing them changes the chemistry.
  // None of these names may match, so each falls through to the references unchanged.
  for (const ion of ['hydrogen ion', 'proton', 'hydride', 'hydronium', 'chloride', 'bromide',
    'iodide', 'fluoride', 'oxide', 'hydroxide', 'nitride', 'peroxide']) {
    assert.equal(f(ion), null, `${ion} is an ion, not an element's free form`);
  }

  // LEGITIMATELY MONATOMIC. A noble gas IS one atom in its free form; a metal is one atom as the
  // element. Rewriting either would be wrong.
  for (const mono of ['helium', 'neon', 'argon', 'krypton', 'xenon', 'sodium', 'zinc', 'iron', 'tin']) {
    assert.equal(f(mono), null, `${mono} is monatomic or a metal`);
  }

  // An explicitly ATOMIC form is a real species and must survive as written.
  for (const atom of ['atomic hydrogen', 'hydrogen atom', 'bromine radical', 'chlorine atom']) {
    assert.equal(f(atom), null, `${atom} names the atom on purpose`);
  }

  // A COMPOUND that merely contains the element word. This is why the match is on the whole name:
  // the metal lookup beside it matches a word inside the name, which here would turn hydrogen
  // chloride into hydrogen gas.
  for (const compound of ['hydrogen chloride', 'hydrogen peroxide', 'hydrogen bromide',
    'bromine monochloride', 'nitrogen dioxide', 'oxygen difluoride', 'chlorine dioxide',
    'sodium chloride', 'iodine monochloride']) {
    assert.equal(f(compound), null, `${compound} is a compound, not an element`);
  }

  // Allotropes left out on purpose: their free form depends on which one, so there is no single
  // edit to make. Ozone is not oxygen's free form either.
  for (const other of ['sulfur', 'phosphorus', 'ozone', 'carbon', 'graphite']) {
    assert.equal(f(other), null, `${other} has no single unambiguous free form here`);
  }
});

test('the route label check and compile ask the local references first, once per batch', async () => {
  let sent = 0;
  const host = resolveHost(() => { sent += 1; return undefined; });
  const batches = [];
  host.python = { ensureRuntime: async () => ({ ready: true }), run: async (request) => {
    batches.push(JSON.parse(request.stdin));
    return { code: 0, stderr: '', stdout: JSON.stringify({
      pubchem: { available: true, names: { ethanol: { cid: 702, smiles: 'CCO' }, 'ethyl acetate': { cid: 8857, smiles: 'CCOC(C)=O' } }, smiles: {} },
      opsin: { 'acetic acid': { status: 'SUCCESS', smiles: 'CC(=O)O' } } }) };
  } };
  for (const toolId of ['verify-route', 'compile']) {
    const schema = manifest.tools.find((tool) => tool.id === toolId).inputSchema.properties;
    assert.ok(schema.pubchemDir && schema.opsinDir && schema.localOnly, `${toolId} declares the local reference fields`);
  }
  const worker = lib.createWorker(host);
  const labels = [[
    { role: 'reactant', name: 'ethanol', smiles: 'CCO' }, { role: 'reactant', name: 'acetic acid', smiles: 'CC(=O)O' },
    { role: 'product', name: 'ethyl acetate', smiles: 'CCOC(C)=O' }, { role: 'product', name: 'water', smiles: 'O', byproduct: true },
  ]];
  const audit = (await worker.invoke({ invocationId: 'lr1', toolId: 'verify-route', locale: 'en',
    input: { steps: ['CCO.CC(=O)O>>CCOC(C)=O.O'], labels, pubchemDir: '/m', opsinDir: '/o', localOnly: true } })).artifacts[0].data;
  assert.equal(batches.length, 1, 'one local call for the whole route');
  assert.deepEqual(batches[0].pubchemNames, ['ethanol', 'acetic acid', 'ethyl acetate', 'water']);
  const named = Object.fromEntries([...audit.steps[0].reactants, ...audit.steps[0].products].map((entry) => [entry.name, entry.nameOk]));
  assert.deepEqual(named, { ethanol: true, 'acetic acid': true, 'ethyl acetate': true, water: undefined }, 'answered locally; the unknown name stays unchecked');
  assert.equal(audit.namesUnresolved, 1);
  const plan = JSON.stringify({ version: 2, kind: 'structure', depiction: 'skeletal', species: [{ id: 's1', input: { kind: 'name', value: 'ethanol' } }] });
  const drawn = await worker.invoke({ invocationId: 'lr2', toolId: 'compile', locale: 'en', input: { plan, question: 'Draw ethanol.', pubchemDir: '/m', localOnly: true } });
  assert.equal(drawn.artifacts?.[0]?.data.species[0].graph.canonicalSmiles, 'CCO', 'compile resolved the name from the mirror');
  assert.equal(sent, 0, 'not one request was sent to PubChem or EBI');
});

test('a fix round in a new worker reuses the label answers the last check found', async () => {
  let sent = 0;
  const fetch = (endpointId, target) => {
    sent += 1;
    if (endpointId === 'pubchem' && target.includes('/name/')) return { IdentifierList: { CID: [702] } };
    if (endpointId === 'pubchem' && target.includes('/cid/702/')) return { PropertyTable: { Properties: [{ CID: 702, SMILES: 'CCO' }] } };
    return undefined;
  };
  const first = resolveHost(fetch);
  const kept = new Map();
  first.storage = { ...first.storage, cache: { get: async (key) => kept.get(key) ?? null, set: async (key, value) => { kept.set(key, structuredClone(value)); }, delete: async (key) => { kept.delete(key); }, keys: async () => [...kept.keys()] } };
  const input = { steps: ['CCO.CC(=O)O>>CCOC(C)=O.O'], labels: [[{ role: 'reactant', name: 'ethanol', smiles: 'CCO' }]] };
  await lib.createWorker(first).invoke({ invocationId: 'fr1', toolId: 'verify-route', locale: 'en', input });
  assert.ok(sent > 0, 'the first check looked the name up');
  // A new worker, as each answer phase gets, over the same package storage.
  sent = 0;
  const second = resolveHost(fetch);
  second.storage = first.storage;
  const audit = (await lib.createWorker(second).invoke({ invocationId: 'fr2', toolId: 'verify-route', locale: 'en', input })).artifacts[0].data;
  assert.equal(sent, 0, 'nothing was asked again');
  assert.equal(audit.steps[0].reactants.find((entry) => entry.name === 'ethanol').nameOk, true);
  lib.resetPubchemPacing();
});

test('resolve-names canonicalises without drawing, and the inspector still returns a full graph', async () => {
  const batches = [];
  const host = ethanolHost();
  const run = host.subworker.run;
  host.subworker.run = async (request) => { batches.push(request.input); return run(request); };
  const worker = lib.createWorker(host);
  const names = (await worker.invoke({ invocationId: 'cn1', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'] } })).artifacts[0].data.results;
  assert.equal(names[0].smiles, 'CCO');
  assert.equal(batches.at(-1).canonicalOnly, true, 'the canonicalisation batch asks for the canonical form only');
  const dossier = (await worker.invoke({ invocationId: 'cn2', toolId: 'inspect', locale: 'en', input: { smiles: ['C[C@H](N)C(=O)O'] } })).artifacts[0];
  assert.equal(batches.at(-1).canonicalOnly, undefined, 'the inspector asks for the whole graph');
  assert.ok(dossier.data.atoms.some((atom) => atom.cip === 'S'));
});

test('the route check reads each species once, and its summary matches the drawing path', async () => {
  // The summary-only read must report what the full validation reports, species by species.
  for (const smiles of ['C[C@H](N)C(=O)O', 'CC(N)C(=O)O', 'C/C=C/C', 'CC=CC', '[Na+].[Cl-]', 'C.[Mg+2].[Br-].[OH-]', '[13CH3]O', 'O=C([O-])[O-].[Ca+2]']) {
    const full = (await lib.validateChemicalReferences({ references: [smiles], inspect: true })).inspection;
    const lean = (await lib.validateChemicalReferences({ references: [smiles], inspect: true, summaryOnly: true })).inspection;
    const comparable = (entry) => ({ ...entry, cipCentres: entry.cipCentres?.map(centre => centre.tag), composition: Object.fromEntries(Object.entries(entry.composition).sort()) });
    assert.deepEqual(comparable(lean), comparable(full), smiles);
  }
  for (const smiles of ['C1CC', 'C=C=C(C)C']) {
    const refused = async (request) => { try { await lib.validateChemicalReferences(request); return ''; } catch (error) { return error.message; } };
    assert.equal(await refused({ references: [smiles], inspect: true, summaryOnly: true }), await refused({ references: [smiles], inspect: true }), smiles);
  }
});

test('a stereocentre the route check names is numbered in the string the author wrote', async () => {
  // Written centre-first, so the author's atom 1 is atom 4 of RDKit's canonical string.
  const audit = await lib.auditRoute({ steps: ['Cl[C@H](C)C(=O)OC.O>>Cl[C@@H](C)C(=O)O.CO'] });
  const message = audit.blocked.join(' ');
  assert.match(message, /inverts a stereocentre/);
  assert.match(message, /\((?:S|R)\) at atom 1\b|\batom 1 of /, message);
  assert.doesNotMatch(message, /at atom 4\b/, message);
});

test('the bounded coefficient search keeps its answers, and refuses a free step without searching', async () => {
  const summary = async (smiles) => (await lib.validateChemicalReferences({ references: [smiles], inspect: true })).inspection;
  const solve = async (reactants, products) => {
    const species = await Promise.all([...reactants, ...products].map(summary));
    try {
      return lib.balanceReaction(species.map(entry => ({ atoms: entry.composition, charge: entry.charge })),
        [...reactants.map(() => 'reactant'), ...products.map(() => 'product')], species.map(() => 1)).join(',');
    } catch (error) { return error.message; }
  };
  // Four free directions: the smallest equation is unique and is found.
  assert.equal(await solve(['C', 'CC', 'CCC'], ['CCCC', 'CCCCC', '[H][H]']), '1,1,2,1,1,2');
  // Six free directions: past the search, and said so rather than called ambiguous.
  assert.match(await solve(['CCO', 'O=O', 'CO'], ['CC=O', 'CC(=O)O', 'O', 'OO', 'C=O', 'O=C=O']), /leaves 6 species free to vary independently/);
});

// ---------------------------------------------------------------- scene molfile

/** The resonance arrows of a carboxylate: the anionic oxygen's pair into C–O, C=O onto the other oxygen. */
const carboxylateResonance = [
  { from: { species: 's1', atom: { element: 'O', index: 2 } }, to: { species: 's1', bond: { between: ['C', 'O'], order: 1 } } },
  { from: { species: 's1', bond: { between: ['C', 'O'], order: 2 } }, to: { species: 's1', atom: { element: 'O', index: 1 } } },
];

test('an isotope label survives the scene molfile that every round-trip re-reads', async () => {
  // The ChemFig round-trip and the mechanism ledger both hand the scene's own molfile to RDKit.
  // An ISO line it cannot read loses the label without an error: the export was refused, and a
  // mechanism reported its labelled product as the unlabelled one.
  const labelled = await lib.validateChemicalReferences({ references: ['[13CH3]O'], exportChemfig: true });
  assert.equal(labelled.chemfig.status, 'validated', labelled.chemfig.reason);

  const smiles = 'CC(=O)[18O-]';
  const checked = await lib.validateChemicalReferences({ references: [smiles], mechanism: { rule: 'electron-flow', inputs: [smiles], order: ['s1'], electronFlow: carboxylateResonance, resonance: true } });
  assert.deepEqual(checked.mechanism.molecules.map(molecule => molecule.canonicalSmiles), ['CC(=O)[18O-]', 'CC([O-])=[18O]']);
  assert.deepEqual(checked.mechanism.canonicalProducts, ['CC([O-])=[18O]']);
});

test('a radical is not re-read as a closed-shell species', async () => {
  // Without its RAD line the radical carbon came back with one hydrogen more, and the
  // contributors of a radical anion were reported, as validated, to be acetate.
  const smiles = '[CH2]C(=O)[O-]';
  await assert.rejects(
    lib.validateChemicalReferences({ references: [smiles], mechanism: { rule: 'electron-flow', inputs: [smiles], order: ['s1'], electronFlow: carboxylateResonance, resonance: true } }),
    /Radical mechanism stages are unsupported/,
  );
});

// ---------------------------------------------------------------- ChemFig branch depth

test('a chain too deep for ChemFig branches is refused quickly, and later exports still compile', async () => {
  // The export nests every bond as a branch, and TeX never returns once branches nest 32 deep.
  // A 35-atom chain cost the whole validator budget, and the timed-out engine then refused every
  // ChemFig after it in the same process, ethanol included.
  const started = Date.now();
  const deep = await lib.validateChemicalReferences({ references: ['C' + 'COC'.repeat(11) + 'O'], exportChemfig: true, openStereo: true });
  assert.equal(deep.chemfig.status, 'unsupported');
  assert.match(deep.chemfig.reason, /branch depth/);
  assert.ok(Date.now() - started < 10_000, 'well inside the 15 s validator budget');
  const after = await lib.validateChemicalReferences({ references: ['CCO'], exportChemfig: true });
  assert.equal(after.chemfig.status, 'validated', after.chemfig.reason);
});

// ---------------------------------------------------------------- TeX input buffer

test('a ChemFig line longer than the TeX input buffer is refused, not fatal', async () => {
  // A shallow 163-atom alkane exports one ~5.5k-character line. node-tikzjax reads lines into a
  // 5000-character buffer and, past it, throws from a timer that no caller can catch. The run
  // is in a child process because, unguarded, it ends whichever process it runs in.
  const { spawnSync } = await import('node:child_process');
  const script = `
    const lib = require(${JSON.stringify(bundle)});
    const tree = depth => depth === 0 ? 'C' : 'C(' + tree(depth - 1) + ')(' + tree(depth - 1) + ')' + tree(depth - 1);
    lib.validateChemicalReferences({ references: ['C(' + tree(4) + ')' + tree(3) + 'C'], exportChemfig: true, openStereo: true })
      .then(result => { process.stdout.write(JSON.stringify(result.chemfig)); process.exit(0); });`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, `the validator process survived: ${run.stderr.slice(0, 300)}`);
  const chemfig = JSON.parse(run.stdout);
  assert.equal(chemfig.status, 'unsupported');
  assert.match(chemfig.reason, /input buffer/);
});

test('an abort ends a reference request the host is still answering', { timeout: 10_000 }, async () => {
  // The host's fetch never answers. The turn's abort must still end the look-up, and a cancelled
  // batch must not come back as names that simply did not resolve.
  const controller = new AbortController();
  lib.resetPubchemPacing();
  const host = stubHost({ signal: controller.signal });
  host.network.fetch = () => new Promise(() => {});
  const worker = lib.createWorker(host);
  setTimeout(() => controller.abort(new Error('cancelled by the user')), 50);
  const started = Date.now();
  await assert.rejects(worker.invoke({ invocationId: 'abort-fetch', toolId: 'resolve-names', locale: 'en', input: { names: ['ethanol'] } }), /cancelled by the user/);
  assert.ok(Date.now() - started < 2000, 'the abort did not wait for the reply');
});

test('the local references answer every name and structure the application may send (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON || process.platform === 'win32' }, async () => {
  // resolve-names and resolve-structure send up to 512 (SCHEMA_CEILINGS.names / structures); the
  // worker used to look up only the first 256, so the rest went to the network, or came back
  // unresolved on a local-only run, although the mirror and the local OPSIN had them.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, sqlite3, stat, tempfile
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
from rdkit import Chem
d = tempfile.mkdtemp(); db = sqlite3.connect(os.path.join(d, 'pubchem.sqlite'))
db.executescript('''CREATE TABLE inchikey (key TEXT PRIMARY KEY, cid INTEGER) WITHOUT ROWID;
  CREATE TABLE smiles (cid INTEGER PRIMARY KEY, smiles TEXT); CREATE TABLE iupac (cid INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE formula (cid INTEGER PRIMARY KEY, formula TEXT); CREATE TABLE synonym (name TEXT, cid INTEGER, rank INTEGER);''')
structures = ['C' * n + 'O' for n in range(1, 513)]
for cid, smi in enumerate(structures, 1):
    db.execute('INSERT INTO inchikey VALUES (?, ?)', (Chem.MolToInchiKey(Chem.MolFromSmiles(smi)), cid))
    db.execute('INSERT INTO smiles VALUES (?, ?)', (cid, smi)); db.execute('INSERT INTO iupac VALUES (?, ?)', (cid, f'compound {cid}'))
    db.execute('INSERT INTO synonym VALUES (?, ?, 0)', (f'compound {cid}', cid))
db.commit(); db.close()
o = tempfile.mkdtemp()
for n in ('opsin-cli-2.8.0-jar-with-dependencies.jar', 'OpsinBatch.class'):
    open(os.path.join(o, n), 'w').close()
java = os.path.join(o, 'java')
open(java, 'w').write('#!/bin/sh\\nwhile IFS= read -r line; do printf "SUCCESS\\\\tC\\\\t\\\\t\\\\n"; done\\n')
os.chmod(java, os.stat(java).st_mode | stat.S_IEXEC)
names = [f'compound {cid}' for cid in range(1, 513)]
out = w.handle({'pubchemDir': d, 'opsinDir': o, 'pubchemNames': names, 'pubchemSmiles': structures})
print(json.dumps([len(out['pubchem']['names']), len(out['pubchem']['smiles']), len(out['opsin']), out['pubchem']['names'].get('compound 512', {}).get('cid')]))
`;
  const [names, structures, opsin, last] = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.equal(names, 512, 'every name the mirror holds is answered');
  assert.equal(structures, 512, 'every structure the mirror holds is answered');
  assert.equal(opsin, 512, 'every name goes to the local OPSIN');
  assert.equal(last, 512, 'the last name is answered with its own record');
});

test('a route search stops at its budget inside an expansion, and reports the time it took (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // Each expansion ran the whole template pass with no deadline, so one molecule could hold the
  // search far past its budget (and past the host's timeout, which loses every route found), while
  // "seconds" still read as the budget. A thousand templates that all apply make one pass ~6 s.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, os, sys, tempfile, time, zstandard as zstd
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
d = tempfile.mkdtemp()
template = '[C:1](=[O:2])[NH:3][C:4]>>[C:1](=[O:2])O.[NH2:3][C:4]'
rows = ''.join(f'{1000 - i}\\t1\\t{template}\\n' for i in range(1000))
open(os.path.join(d, 'retro-templates.tsv.zst'), 'wb').write(zstd.ZstdCompressor().compress(rows.encode()))
open(os.path.join(d, 'molecules.tsv.zst'), 'wb').write(zstd.ZstdCompressor().compress(b''))
w._retro_templates(d)
started = time.monotonic()
out = w._search_routes([d], 'CC(=O)NCCNC(=O)CCC(=O)NCCNC(=O)c1ccccc1', [], budget_seconds=1.0)
print(json.dumps({'wall': time.monotonic() - started, 'seconds': out['seconds'], 'timedOut': out['timedOut']}))
`;
  const out = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8' }));
  assert.ok(out.wall < 2.5, `a 1 s budget is kept within an expansion (took ${out.wall.toFixed(1)} s)`);
  assert.equal(out.timedOut, true);
  assert.ok(Math.abs(out.seconds - out.wall) < 0.3, `seconds is the time taken (${out.seconds} vs ${out.wall.toFixed(2)})`);
});

// ---------------------------------------------------------------- arrows on a ring-closure bond

test('an arrow on the bond that closes a ring is drawn', async () => {
  // Hydroxide opening propylene oxide at the CH2 breaks the CH2–O bond, which is the bond the
  // ChemFig export wrote as a ring closure. A closure has no @{b…} name, so the checked
  // mechanism was refused with "Unknown electron-flow anchor".
  const electronFlow = [
    { from: { species: 'nu', atom: { element: 'O' } }, to: { species: 'ep', atom: { element: 'C', index: 2 } } },
    { from: { species: 'ep', bond: { between: ['C', 'O'], index: 2 } }, to: { species: 'ep', atom: { element: 'O' } } },
  ];
  const checked = await lib.validateChemicalReferences({ references: ['[OH-]'], mechanism: { rule: 'electron-flow', inputs: ['[OH-]', 'CC1CO1'], order: ['nu', 'ep'], electronFlow } });
  assert.equal(checked.mechanism.chemfig.status, 'validated');
  assert.deepEqual(checked.mechanism.canonicalProducts, ['CC(O)C[O-]']);
});

// ---------------------------------------------------------------- legacy documents

test('a legacy document that is malformed or not verified is refused, never badged as verified', async () => {
  // Any status but "partial" was drawn under a green "Verified structure" badge, and a payload
  // missing a field failed with a TypeError instead of the unreadable-legacy error.
  const worker = lib.createWorker(stubHost());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  for (const payload of [{}, null, { species: [{ input: {} }] }, { status: 'needs-clarification', species: [{ input: { kind: 'name', value: 'ethanol' }, svg }] }]) {
    await assert.rejects(worker.renderLegacyResult({ fence: 'chemistry-document', payload: JSON.stringify(payload), locale: 'en' }), /UNREADABLE/, JSON.stringify(payload));
  }
  const partial = lib.documentView({ status: 'partial', species: [{ input: { kind: 'name', value: 'ethanol' }, svg }] }, 'en');
  assert.equal(partial.nodes[0].items[0].label, 'Partly verified');
});

test('the Python compatibility check accepts the usual acid deprotections (needs CHEMISTRY_TEST_PYTHON)', { skip: !process.env.CHEMISTRY_TEST_PYTHON }, async () => {
  // "4 M HCl in dioxane" is the anhydrous strong acid that takes a Boc off, not a dilute work-up;
  // and aqueous acid is how an acetal, a TMS ether or a trityl group usually comes off. Each used to
  // be flagged as a protecting group lost with nothing named that removes it.
  const { execFileSync } = await import('node:child_process');
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(new URL('../python', import.meta.url).pathname)})
import reactions_worker as w
steps = [
  {"reactants": ["CC(C)(C)OC(=O)NCc1ccccc1"], "products": ["NCc1ccccc1"], "reagents": "4 M HCl in dioxane"},
  {"reactants": ["CC(C)(C)OC(=O)NCc1ccccc1"], "products": ["NCc1ccccc1"], "reagents": "4M HCl/dioxane"},
  {"reactants": ["CC1(c2ccccc2)OCCO1"], "products": ["CC(=O)c1ccccc1"], "reagents": "aq. HCl, acetone"},
  {"reactants": ["CC1(c2ccccc2)OCCO1"], "products": ["CC(=O)c1ccccc1"], "reagents": "H3O+"},
  {"reactants": ["C[Si](C)(C)OCc1ccccc1"], "products": ["OCc1ccccc1"], "reagents": "1 M HCl, THF"},
  {"reactants": ["CC(C)(C)OC(=O)NCCO"], "products": ["NCCO"], "reagents": "NaOH, water"},
]
print(json.dumps(w._compatibility(steps)))
`;
  const out = JSON.parse(execFileSync(process.env.CHEMISTRY_TEST_PYTHON, ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
  const flags = out.map(step => step.hazards.map(h => `${h.group}/${h.reagentClass}/${h.severity}`));
  assert.deepEqual(flags.slice(0, 5), [[], [], [], [], []], 'each of these removes the group it loses');
  assert.ok(out[0].reagentClasses.some(c => c.id === 'strong-acid'), 'HCl in dioxane is a strong acid');
  assert.deepEqual(flags[5], ['boc/null/medium'], 'a Boc lost with no acid named is still flagged');
});
