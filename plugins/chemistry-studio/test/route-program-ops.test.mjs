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
  define: { 'import.meta.url': JSON.stringify(new URL('../src/engine/routeProgramOps.ts', import.meta.url).href) },
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
/** The old positional shape, kept so the cases read the same; `assigns` is the ref the line binds. */
const applyOn = (o, molecule, op, reagents = [], site, assigns) =>
  o.apply({ molecule, op, reagents, ...(site ? { sites: Array.isArray(site) ? site : [site] } : {}), ...(assigns ? { assigns } : {}) });

// ---------------------------------------------------------------- apply

test('a successful apply becomes an OpOutcome with the reagents in the order given', async () => {
  const python = fakePython({ ok: true, product: 'CC=O', coProducts: ['O'], formula: 'C2H4O', site: { phrase: 'the alcohol', atoms: [2] } });
  const op = { kind: 'named', id: 'oxidise' };
  const out = await applyOn(ops(python), M, op, [{ smiles: 'zzz' }, { smiles: 'aaa' }, { smiles: 'mmm' }], { kind: 'phrase', phrase: 'the alcohol' });
  assert.deepEqual(out.product, { smiles: 'CC=O', formula: 'C2H4O' });
  assert.deepEqual(out.coProducts, [{ smiles: 'O' }]);
  assert.deepEqual(out.reagents.map(r => r.smiles), ['ZZZ', 'AAA', 'MMM']);
  assert.equal(out.provenance, op);
  const sent = python.requests[0].body;
  assert.equal(sent.op, 'apply');
  assert.equal(sent.molecule, 'CCO');
  assert.deepEqual(sent.reagents, ['ZZZ', 'AAA', 'MMM']);
  assert.deepEqual(sent.sites, [{ kind: 'phrase', phrase: 'the alcohol' }]);
  assert.equal(sent.markAs, 900);
  assert.equal('moleculeHandle' in sent, false);
  assert.deepEqual(sent.operation, { kind: 'named', id: 'oxidise' });
  assert.equal(typeof sent.budgetSeconds, 'number');
  assert.deepEqual(python.requests[0].args.slice(0, 1), ['-I']);
});

test('smarts and template operations are marshalled; a template carries the index directory', async () => {
  const python = fakePython({ ok: true, product: 'C', coProducts: [] });
  await applyOn(ops(python, { indexDir: '/idx' }), M, { kind: 'template', id: 't1' }, []);
  await applyOn(ops(python), M, { kind: 'smarts', smarts: '[OH]>>[O-]' }, []);
  assert.deepEqual(python.requests[0].body.operation, { kind: 'template', id: 't1', indexDir: '/idx' });
  assert.deepEqual(python.requests[1].body.operation, { kind: 'smarts', smarts: '[OH]>>[O-]' });
  assert.equal('sites' in python.requests[1].body, false);
});

test('a template without an index directory is unavailable and makes no call', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  const out = await applyOn(ops(python), M, { kind: 'template', id: 't1' }, []);
  assert.equal(out.error, 'unavailable');
  assert.equal(python.requests.length, 0);
});

test('a reagent that will not resolve fails the call with its own error, before any Python call', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  const bad = await applyOn(ops(python), M, { kind: 'named', id: 'x' }, [{ smiles: 'fine' }, { smiles: 'BAD' }], undefined);
  assert.equal(bad.error, 'unparsable');
  const named = await applyOn(ops(python), M, { kind: 'named', id: 'x' }, [{ name: 'water' }]);
  assert.equal(named.error, 'unresolved-name');
  assert.equal(python.requests.length, 0);
});

for (const code of ['unresolved-name', 'unknown-template', 'no-match', 'ambiguous-site', 'absent-site', 'unparsable', 'unavailable', 'budget']) {
  test(`error code ${code} from Python is mapped verbatim`, async () => {
    const python = fakePython({ ok: false, error: code, message: `Exact words for ${code}.` });
    const out = await applyOn(ops(python), M, { kind: 'named', id: 'x' }, []);
    assert.deepEqual(out, { error: code, message: `Exact words for ${code}.` });
  });
}

test('an unknown error code becomes unavailable', async () => {
  const out = await applyOn(ops(fakePython({ ok: false, error: 'exploded', message: 'x' })), M, { kind: 'named', id: 'x' }, []);
  assert.equal(out.error, 'unavailable');
});

test('malformed JSON, a missing result, a non-zero exit, a missing runtime and a timeout are all unavailable', async () => {
  const op = { kind: 'named', id: 'x' };
  assert.equal((await applyOn(ops(fakePython('not json {')), M, op, [])).error, 'unavailable');
  assert.equal((await applyOn(ops(fakePython('{"other":1}')), M, op, [])).error, 'unavailable');
  assert.equal((await applyOn(ops(fakePython({ ok: true })), M, op, [])).error, 'unavailable');
  const crashed = await applyOn(ops(fakePython('', { code: 1, stderr: 'Traceback\nValueError: boom' })), M, op, []);
  assert.equal(crashed.error, 'unavailable');
  assert.match(crashed.message, /boom/);
  const missing = await applyOn(ops(fakePython({}, { ready: { ready: false, detail: 'no runtime' } })), M, op, []);
  assert.deepEqual(missing, { error: 'unavailable', message: 'no runtime' });
  const timedOut = await applyOn(ops(fakePython({}, { throws: new Error('timed out after 60000 ms') })), M, op, []);
  assert.equal(timedOut.error, 'unavailable');
});

test('the host call is bounded by a timeout in the range the other call sites use', async () => {
  const python = fakePython({ ok: true, product: 'C' });
  await applyOn(ops(python), M, { kind: 'named', id: 'x' }, []);
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
  await assert.rejects(applyOn(o, M, { kind: 'named', id: 'x' }, []), /cancelled/);
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
  await assert.rejects(applyOn(createMoleculeOps({ python, inspect, signal: controller.signal }), M, { kind: 'named', id: 'x' }, []), /stopped mid-run/);
});

// ---------------------------------------------------------------- provenance handles

const reply = (n, extra = {}) => ({ ok: true, product: `P${n}`, coProducts: [], productHandle: `H${n}`, marks: [900 + n - 1], ...extra });
const NAMED = { kind: 'named', id: 'x' };

test('a handle site becomes a mark, markAs is issued per apply, and productHandle is carried and sent back', async () => {
  let n = 0;
  const python = fakePython(() => reply(++n, { marks: n === 1 ? [900] : [900, 901] }));
  const o = ops(python);
  const first = await applyOn(o, { smiles: 'A' }, NAMED, [], undefined, 'M2');
  assert.equal(first.product.handle, 'H1');
  assert.equal(python.requests[0].body.markAs, 900);
  const second = await applyOn(o, first.product, NAMED, [], { kind: 'handle', ref: 'last' });
  assert.equal(python.requests[1].body.moleculeHandle, 'H1');
  assert.equal(python.requests[1].body.molecule, 'P1');
  assert.deepEqual(python.requests[1].body.sites, [{ kind: 'handle', mark: 900, label: '@last' }]);
  assert.equal(python.requests[1].body.markAs, 901);
  await applyOn(o, second.product, NAMED, [], { kind: 'handle', ref: 'M2' });
  assert.deepEqual(python.requests[2].body.sites, [{ kind: 'handle', mark: 900, label: '@M2' }]);
});

test('a mark never appears in Molecule.smiles', async () => {
  const python = fakePython(reply(1));
  const out = await applyOn(ops(python), { smiles: 'A' }, NAMED, []);
  assert.equal(out.product.smiles, 'P1');
  assert.doesNotMatch(out.product.smiles, /900|:\d/);
});

test('an unknown reference is absent-site and makes no Python call', async () => {
  const python = fakePython(reply(1));
  const o = ops(python);
  for (const ref of ['last', 'M9']) {
    const out = await applyOn(o, { smiles: 'A', handle: 'H0' }, NAMED, [], { kind: 'handle', ref });
    assert.equal(out.error, 'absent-site');
    assert.match(out.message, ref === 'last' ? /previous line/ : /M9/);
  }
  assert.equal(python.requests.length, 0);
});

test('a reference the reply says did not survive is absent-site', async () => {
  let n = 0;
  const python = fakePython(() => reply(++n, { marks: [] }));
  const o = ops(python);
  const first = await applyOn(o, { smiles: 'A' }, NAMED, [], undefined, 'M2');
  const out = await applyOn(o, first.product, NAMED, [], { kind: 'handle', ref: 'M2' });
  assert.equal(out.error, 'absent-site');
  assert.equal(python.requests.length, 1);
});

test('two instances do not share marks', async () => {
  const python = fakePython(reply(1));
  const a = ops(python);
  const b = ops(python);
  const first = await applyOn(a, { smiles: 'A' }, NAMED, []);
  const out = await applyOn(b, first.product, NAMED, [], { kind: 'handle', ref: 'last' });
  assert.equal(out.error, 'absent-site');
  await applyOn(b, { smiles: 'A' }, NAMED, []);
  assert.equal(python.requests.at(-1).body.markAs, 900);
});

test('a mark is filed under the ref the line assigns, on a program whose refs are not sequential', async () => {
  let n = 0;
  const python = fakePython(() => { n += 1; return reply(n, { marks: [900, 901, 902] }); });
  const o = ops(python);
  const a = await applyOn(o, { smiles: 'A' }, NAMED, [], undefined, 'M5');
  const b = await applyOn(o, a.product, NAMED, [], undefined, 'M2');
  // The third line returns to the first (M5), not to whatever the count would have called M2.
  const c = await applyOn(o, b.product, NAMED, [], { kind: 'handle', ref: 'M5' });
  assert.deepEqual(python.requests[2].body.sites, [{ kind: 'handle', mark: 900, label: '@M5' }]);
  await applyOn(o, c.product, NAMED, [], { kind: 'handle', ref: 'M2' });
  assert.deepEqual(python.requests[3].body.sites, [{ kind: 'handle', mark: 901, label: '@M2' }]);
});

test('a handle ref for a line that declared no assigns is absent-site with no Python call', async () => {
  let n = 0;
  const python = fakePython(() => reply(++n, { marks: [900] }));
  const o = ops(python);
  const a = await applyOn(o, { smiles: 'A' }, NAMED, []);
  const out = await applyOn(o, a.product, NAMED, [], { kind: 'handle', ref: 'M2' });
  assert.equal(out.error, 'absent-site');
  assert.match(out.message, /M2/);
  assert.match(out.message, /assigns/);
  assert.equal(python.requests.length, 1);
  // `last` still works for that line.
  await applyOn(o, a.product, NAMED, [], { kind: 'handle', ref: 'last' });
  assert.deepEqual(python.requests[1].body.sites, [{ kind: 'handle', mark: 900, label: '@last' }]);
});

test('a two-entry sites list reaches the wire in order', async () => {
  let n = 0;
  const python = fakePython(() => reply(++n, { marks: [900, 901] }));
  const o = ops(python);
  const a = await applyOn(o, { smiles: 'A' }, NAMED, [], undefined, 'M2');
  await applyOn(o, a.product, NAMED, [], [{ kind: 'phrase', phrase: 'the acid' }, { kind: 'handle', ref: 'M2' }]);
  assert.deepEqual(python.requests[1].body.sites, [{ kind: 'phrase', phrase: 'the acid' }, { kind: 'handle', mark: 900, label: '@M2' }]);
});

test('one unresolvable handle in a two-entry list fails the whole call with no Python call', async () => {
  let n = 0;
  const python = fakePython(() => reply(++n, { marks: [900] }));
  const o = ops(python);
  const a = await applyOn(o, { smiles: 'A' }, NAMED, [], undefined, 'M2');
  const out = await applyOn(o, a.product, NAMED, [], [{ kind: 'handle', ref: 'M2' }, { kind: 'handle', ref: 'M7' }]);
  assert.equal(out.error, 'absent-site');
  assert.match(out.message, /M7/);
  assert.equal(python.requests.length, 1);
});

test('every handle site carries the reference the author wrote, never only the mark', () => {
  // SPPS-FIXES-2026-10-17 fix 7, the invariant. The mark is this adapter's own integer: not stable
  // between runs and meaningless to the author. The toolkit's failure messages name the reference
  // instead, and they can only do that if this adapter sends it. Measured on
  // harness-runs/spps-10-ladder2-program-mode-thinking-none, where three successive failures said
  // only "the mark 914", then "the mark 913" for the same route.
  //
  // Asserted against the source rather than a call, so that a handle site added on a new path
  // cannot reach the wire without a label.
  const source = fs.readFileSync(path.join(root, 'src/engine/routeProgramOps.ts'), 'utf8');
  // Read to the end of each push statement rather than to the first `}`: the label is written as
  // a template literal, so a brace-counting pattern stops inside `${site.ref}`.
  const pushes = source.split('wireSites.push(').slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('\n')))
    .filter((push) => push.includes("kind: 'handle'"));
  assert.ok(pushes.length, 'the adapter still sends handle sites');
  for (const push of pushes) {
    assert.match(push, /label:/, `a handle site reaches the wire without a label: ${push}`);
  }
});
