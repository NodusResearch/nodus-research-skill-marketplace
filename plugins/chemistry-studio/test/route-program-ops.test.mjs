// The adapter is the only module in the feature that reaches a chemistry toolkit, so these tests
// give it a fake Python runtime and a fake structure checker and assert on what it sends and what
// it makes of the reply. No RDKit and no interpreter process is involved.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'route-program-ops-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const bundle = path.join(scratch, 'ops.cjs');
await build({
  entryPoints: [path.join(root, 'src/engine/routeProgramOps.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
  // import.meta.url is read for the script path only; the fake never runs it.
  define: { 'import.meta.url': JSON.stringify('file:///plugins/chemistry-studio/src/engine/routeProgramOps.ts') },
});
const { createMoleculeOps, listTransforms, OFFER_MAX_HEAVY_ATOMS } = createRequire(import.meta.url)(bundle);

// ---------------------------------------------------------------- fakes

/** `reply` is a function of the parsed request returning a stdout string, or an object to wrap. */
function fakePython(reply, { code = 0, stderr = '', ready = { ready: true }, throws = null } = {}) {
  const requests = [];
  return {
    requests,
    ensureRuntime: async () => ready,
    run: async (request) => {
      requests.push({ ...request, body: JSON.parse(request.stdin).routeProgram });
      if (throws) throw throws;
      const value = typeof reply === 'function' ? reply(JSON.parse(request.stdin).routeProgram) : reply;
      return { code, stderr, stdout: typeof value === 'string' ? value : JSON.stringify({ routeProgram: value }) };
    },
  };
}

/** A structure checker that accepts anything without the word BAD and upper-cases it. */
const inspect = async (smiles) => smiles.map(s => s.includes('BAD')
  ? { smiles: s, ok: false, error: 'parse failure' }
  : { smiles: s, ok: true, graph: { canonicalSmiles: s.toUpperCase() } });

const ops = (python, extra = {}) => createMoleculeOps({ python, inspect, signal: new AbortController().signal, ...extra });
const M = { smiles: 'CCO' };

// ---------------------------------------------------------------- apply

test('a successful apply becomes an OpOutcome with the reagents in the order given', async () => {
  const python = fakePython({ ok: true, product: 'CC=O', coProducts: ['O'], formula: 'C2H4O', site: { phrase: 'the alcohol', atoms: [2] } });
  const op = { kind: 'named', id: 'oxidise' };
  const out = await ops(python).apply(M, op, [{ smiles: 'zzz' }, { smiles: 'aaa' }, { smiles: 'mmm' }], 'the alcohol');
  assert.deepEqual(out.product, { smiles: 'CC=O', formula: 'C2H4O' });
  assert.deepEqual(out.coProducts, [{ smiles: 'O' }]);
  assert.deepEqual(out.reagents.map(r => r.smiles), ['ZZZ', 'AAA', 'MMM']);
  assert.equal(out.provenance, op);
  const sent = python.requests[0].body;
  assert.equal(sent.op, 'apply');
  assert.equal(sent.molecule, 'CCO');
  assert.deepEqual(sent.reagents, ['ZZZ', 'AAA', 'MMM']);
  assert.equal(sent.site, 'the alcohol');
  assert.deepEqual(sent.operation, { kind: 'named', id: 'oxidise' });
  assert.equal(typeof sent.budgetSeconds, 'number');
  assert.deepEqual(python.requests[0].args.slice(0, 1), ['-I']);
});

test('smarts and template operations are marshalled; a template carries the index directory', async () => {
  const python = fakePython({ ok: true, product: 'C', coProducts: [] });
  await ops(python, { indexDir: '/idx' }).apply(M, { kind: 'template', id: 't1' }, []);
  await ops(python).apply(M, { kind: 'smarts', smarts: '[OH]>>[O-]' }, []);
  assert.deepEqual(python.requests[0].body.operation, { kind: 'template', id: 't1', indexDir: '/idx' });
  assert.deepEqual(python.requests[1].body.operation, { kind: 'smarts', smarts: '[OH]>>[O-]' });
  assert.equal('site' in python.requests[1].body, false);
});

test('a template without an index directory is unavailable and makes no call', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  const out = await ops(python).apply(M, { kind: 'template', id: 't1' }, []);
  assert.equal(out.error, 'unavailable');
  assert.equal(python.requests.length, 0);
});

test('a reagent that will not resolve fails the call with its own error, before any Python call', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  const bad = await ops(python).apply(M, { kind: 'named', id: 'x' }, [{ smiles: 'fine' }, { smiles: 'BAD' }], undefined);
  assert.equal(bad.error, 'unparsable');
  const named = await ops(python).apply(M, { kind: 'named', id: 'x' }, [{ name: 'water' }]);
  assert.equal(named.error, 'unresolved-name');
  assert.equal(python.requests.length, 0);
});

for (const code of ['unresolved-name', 'unknown-template', 'no-match', 'ambiguous-site', 'absent-site', 'unparsable', 'unavailable', 'budget']) {
  test(`error code ${code} from Python is mapped verbatim`, async () => {
    const python = fakePython({ ok: false, error: code, message: `Exact words for ${code}.` });
    const out = await ops(python).apply(M, { kind: 'named', id: 'x' }, []);
    assert.deepEqual(out, { error: code, message: `Exact words for ${code}.` });
  });
}

test('an unknown error code becomes unavailable', async () => {
  const out = await ops(fakePython({ ok: false, error: 'exploded', message: 'x' })).apply(M, { kind: 'named', id: 'x' }, []);
  assert.equal(out.error, 'unavailable');
});

test('malformed JSON, a missing result, a non-zero exit, a missing runtime and a timeout are all unavailable', async () => {
  const op = { kind: 'named', id: 'x' };
  assert.equal((await ops(fakePython('not json {')).apply(M, op, [])).error, 'unavailable');
  assert.equal((await ops(fakePython('{"other":1}')).apply(M, op, [])).error, 'unavailable');
  assert.equal((await ops(fakePython({ ok: true })).apply(M, op, [])).error, 'unavailable');
  const crashed = await ops(fakePython('', { code: 1, stderr: 'Traceback\nValueError: boom' })).apply(M, op, []);
  assert.equal(crashed.error, 'unavailable');
  assert.match(crashed.message, /boom/);
  const missing = await ops(fakePython({}, { ready: { ready: false, detail: 'no runtime' } })).apply(M, op, []);
  assert.deepEqual(missing, { error: 'unavailable', message: 'no runtime' });
  const timedOut = await ops(fakePython({}, { throws: new Error('timed out after 60000 ms') })).apply(M, op, []);
  assert.equal(timedOut.error, 'unavailable');
});

test('the host call is bounded by a timeout in the range the other call sites use', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  await ops(python).apply(M, { kind: 'named', id: 'x' }, []);
  assert.ok(python.requests[0].timeoutMs >= 60_000 && python.requests[0].timeoutMs <= 240_000);
});

// ---------------------------------------------------------------- resolve

test('resolve canonicalises a valid SMILES and refuses an invalid one', async () => {
  const o = ops(fakePython({}));
  assert.deepEqual(await o.resolve({ smiles: 'cco' }), { smiles: 'CCO' });
  const bad = await o.resolve({ smiles: 'BAD' });
  assert.equal(bad.error, 'unparsable');
});

test('resolve of a name is unresolved unless a resolver is injected', async () => {
  const none = await ops(fakePython({})).resolve({ name: 'ethanol' });
  assert.equal(none.error, 'unresolved-name');
  const injected = await ops(fakePython({}), { resolveName: async (n) => ({ smiles: `from-${n}` }) }).resolve({ name: 'ethanol' });
  assert.deepEqual(injected, { smiles: 'from-ethanol' });
});

test('a structure checker that throws is unavailable, not a throw', async () => {
  const o = createMoleculeOps({ python: fakePython({}), inspect: async () => { throw new Error('worker died'); }, signal: new AbortController().signal });
  assert.equal((await o.resolve({ smiles: 'C' })).error, 'unavailable');
});

// ---------------------------------------------------------------- describe, transforms, offer

test('describe maps the reply onto formula, sites and summary', async () => {
  const python = fakePython({ ok: true, formula: 'C2H6O', sites: ['the hydroxyl', 'the methyl'], summary: 'a primary alcohol' });
  const out = await ops(python).describe(M);
  assert.deepEqual(out, { formula: 'C2H6O', sites: ['the hydroxyl', 'the methyl'], summary: 'a primary alcohol' });
  assert.deepEqual(python.requests[0].body, { op: 'describe', molecule: 'CCO' });
});

test('the transform listing returns ids, whether strings or objects, and maps failures', async () => {
  const python = fakePython({ ok: true, transforms: ['oxidise', { id: 'reduce' }] });
  assert.deepEqual(await listTransforms({ python, signal: new AbortController().signal }), ['oxidise', 'reduce']);
  assert.deepEqual(python.requests[0].body, { op: 'transforms' });
  const failed = await listTransforms({ python: fakePython('nope'), signal: new AbortController().signal });
  assert.equal(failed.error, 'unavailable');
});

test('offer above the size gate returns empty without any Python call', async () => {
  const python = fakePython({ ok: true });
  const big = { smiles: 'C'.repeat(OFFER_MAX_HEAVY_ATOMS + 20) };
  assert.deepEqual(await ops(python).offer(big, { smiles: 'O' }), []);
  assert.equal(python.requests.length, 0);
  assert.deepEqual(await ops(python).offer(M, { smiles: 'O' }), []);
  assert.equal(python.requests.length, 0);
});

// ---------------------------------------------------------------- abort

test('an abort propagates as a throw, not an OpError', async () => {
  const controller = new AbortController();
  const python = fakePython({ ok: true, product: 'C' });
  const o = createMoleculeOps({ python, inspect, signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(o.apply(M, { kind: 'named', id: 'x' }, []), /cancelled/);
  await assert.rejects(o.resolve({ smiles: 'C' }), /cancelled/);
  await assert.rejects(o.describe(M), /cancelled/);
  assert.equal(python.requests.length, 0);
});

test('an abort that lands while Python is running throws instead of reporting unavailable', async () => {
  const controller = new AbortController();
  const python = {
    ensureRuntime: async () => ({ ready: true }),
    run: async () => { controller.abort(new Error('stopped mid-run')); throw new Error('killed'); },
  };
  await assert.rejects(createMoleculeOps({ python, inspect, signal: controller.signal }).apply(M, { kind: 'named', id: 'x' }, []), /stopped mid-run/);
});
