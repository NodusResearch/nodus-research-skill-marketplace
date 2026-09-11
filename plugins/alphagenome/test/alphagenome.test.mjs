// Contract and behaviour tests for the AlphaGenome capability package. The Python runtime
// and the API are stubbed: what is tested here is the package's own reasoning, including
// the two properties that are not conveniences — the key never reaches the worker, and
// the result never reaches the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { runConformanceSuite, conformanceFailures } from '../../../scripts/contract-v2.mjs';
import createWorker from '../src/worker.js';
import { createRequire } from 'node:module';
import { groundPlan, validatePlanShape, validateResult, CITATION, NOTICE, REVISION, TERMS_VERSION } from '../src/plan.js';
import { trackSvg } from '../src/chart.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../capabilities/genomics/capability.json', import.meta.url), 'utf8'));
const PLAN = { version: 1, assembly: 'GRCh38', variant: 'chr22:36201698:A:C', tissue: 'UBERON:0001157', output: 'RNA_SEQ' };
const QUESTION = 'Run AlphaGenome on GRCh38 chr22:36201698:A:C in UBERON:0001157 for RNA_SEQ.';

const prediction = () => {
  const start = 36201698 - 1 - 8192;
  return {
    interval: { chromosome: 'chr22', start, end: start + 16384 },
    totalTracks: 3,
    modifications: 'Track selection, bin averaging and visualization by Nodus.',
    tracks: [{ name: 'Synthetic QA track', strand: '+', resolution: 64, reference: Array.from({ length: 256 }, (_, i) => i / 100), alternate: Array.from({ length: 256 }, (_, i) => i / 90) }],
  };
};

function stubHost(options = {}) {
  const state = new Map(Object.entries(options.state ?? {}));
  const secrets = new Set(options.secrets ?? []);
  const calls = [];
  return {
    calls, state, secrets,
    signal: new AbortController().signal,
    log: () => {},
    secrets: {
      has: async id => secrets.has(id),
      store: async id => { secrets.add(id); },
      delete: async id => { secrets.delete(id); },
    },
    storage: {
      state: {
        get: async key => state.get(key) ?? null,
        set: async (key, value) => { state.set(key, value); },
        delete: async key => { state.delete(key); },
        keys: async () => [...state.keys()],
      },
      cache: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
      temp: { dir: async () => '/tmp', clear: async () => {} },
    },
    python: {
      ensureRuntime: async id => { calls.push(`ensureRuntime:${id}`); return options.runtime ?? { ready: true }; },
      run: async request => {
        calls.push(`run:${request.args.join(' ')}:${request.secretId ?? 'no-secret'}`);
        // The host injects the credential; a worker that tried to pass one would be
        // passing something it does not have.
        assert.equal(request.stdin === undefined || !request.stdin.includes('secret'), true);
        if (request.args.includes('--check')) return { code: options.checkCode ?? 0, stdout: '', stderr: '' };
        return options.run ?? { code: 0, stdout: JSON.stringify(prediction()), stderr: '' };
      },
    },
  };
}

const configured = (extra = {}) => stubHost({ secrets: ['api-key'], state: { terms: 2, runtime: REVISION }, ...extra });

// ---------------------------------------------------------------- grounding

test('a plan must quote the exact variant, assembly, tissue and output from the message', () => {
  assert.deepEqual(groundPlan(PLAN, QUESTION), PLAN);
  // A coordinate the user never gave is the failure that matters: the prediction would
  // be confident and about the wrong position.
  assert.throws(() => groundPlan(PLAN, 'Run AlphaGenome on the BRCA2 promoter.'), /NOT_IN_MESSAGE/);
  assert.throws(() => groundPlan({ ...PLAN, output: 'ATAC' }, QUESTION), /NOT_IN_MESSAGE/);
  assert.throws(() => validatePlanShape({ ...PLAN, variant: 'chr22:36201698:A:A' }), /INTERVAL_IMPOSSIBLE/);
  assert.throws(() => validatePlanShape({ ...PLAN, variant: 'chr22:100:A:C' }), /INTERVAL_IMPOSSIBLE/);
  assert.throws(() => validatePlanShape({ ...PLAN, tissue: 'brain' }), /INVALID_PLAN/);
  assert.throws(() => validatePlanShape({ ...PLAN, assembly: 'hg19' }), /INVALID_PLAN/);
});

// ---------------------------------------------------------------- prediction

test('a prediction runs through the pinned runtime and never carries the key itself', async () => {
  const host = configured();
  const worker = createWorker(host);
  const result = await worker.invoke({ invocationId: 'i1', toolId: 'predict', locale: 'en', input: PLAN });
  const artifact = result.artifacts[0];
  assert.equal(artifact.artifactType, 'genomics-result');
  assert.equal(artifact.data.provider, 'Google DeepMind AlphaGenome');
  assert.equal(artifact.data.notice, NOTICE);
  assert.equal(artifact.data.citation, CITATION);
  // The worker names the credential; it never holds it.
  assert.ok(host.calls.some(call => call.endsWith(':api-key')), 'the run asks the host to inject the key');
  assert.doesNotMatch(JSON.stringify(artifact), /sk-|api[_-]?key["']?\s*:/i, 'no credential appears anywhere in the artifact');
});

test('configuration has to be complete before anything is sent', async () => {
  const missingKey = createWorker(stubHost({ state: { terms: 2, runtime: REVISION } }));
  await assert.rejects(missingKey.invoke({ invocationId: 'i2', toolId: 'predict', locale: 'en', input: PLAN }), /personal AlphaGenome API key/);

  const missingTerms = createWorker(stubHost({ secrets: ['api-key'], state: { runtime: REVISION } }));
  await assert.rejects(missingTerms.invoke({ invocationId: 'i3', toolId: 'predict', locale: 'en', input: PLAN }), /Accept the current AlphaGenome terms/);

  const missingRuntime = createWorker(stubHost({ secrets: ['api-key'], state: { terms: 2 } }));
  await assert.rejects(missingRuntime.invoke({ invocationId: 'i4', toolId: 'predict', locale: 'en', input: PLAN }), /Install the AlphaGenome runtime/);
});

test('a runtime failure says so without surfacing the interpreter diagnostics', async () => {
  const host = configured({ run: { code: 1, stdout: '', stderr: 'Traceback: key sk-live-secret rejected for user@example.org' } });
  const worker = createWorker(host);
  await assert.rejects(
    worker.invoke({ invocationId: 'i5', toolId: 'predict', locale: 'en', input: PLAN }),
    error => {
      assert.match(error.message, /runtime or the API request failed/);
      assert.doesNotMatch(error.message, /sk-live-secret|example\.org/, 'SDK diagnostics can carry private data and are never surfaced');
      return true;
    },
  );
});

// ---------------------------------------------------------------- privacy

test('the result is declared invisible to the model, and the worker offers no projection', () => {
  const declared = manifest.artifacts.find(entry => entry.type === 'genomics-result');
  assert.equal(declared.modelVisibility, 'none');
  const worker = createWorker(configured());
  assert.equal(typeof worker.projectArtifactForModel, 'undefined', 'a "none" artifact must have nothing to project');
});

// ---------------------------------------------------------------- settings

test('settings report what is configured, never a stored value', async () => {
  const worker = createWorker(stubHost({ secrets: ['api-key'] }));
  const state = await worker.getSettings();
  assert.deepEqual(state.fields['api-key'], { configured: true });
  assert.equal(state.status.state, 'pending');
  assert.ok(state.disabledActions?.['install-runtime'], 'the runtime cannot be built before the terms are accepted');

  const accepted = await worker.applySettings({ fields: { terms: true } });
  assert.equal(accepted.fields.terms.value, true);
  assert.equal(accepted.disabledActions, undefined);
});

test('the runtime is recorded as ready only after the adapter itself answers', async () => {
  const host = stubHost({ secrets: ['api-key'], state: { terms: 2 }, checkCode: 1 });
  const worker = createWorker(host);
  await assert.rejects(worker.runAction({ actionId: 'install-runtime' }), /GENOMICS_RUNTIME_FAILED/);
  assert.equal(host.state.get('runtime'), undefined, 'a failed check leaves no runtime recorded');

  const working = stubHost({ secrets: ['api-key'], state: { terms: 2 } });
  const installed = await createWorker(working).runAction({ actionId: 'install-runtime' });
  assert.equal(working.state.get('runtime'), REVISION);
  assert.equal(installed.status.state, 'ok');
});

test('removing the key clears it and puts the package back to needing setup', async () => {
  const host = configured();
  const worker = createWorker(host);
  const state = await worker.runAction({ actionId: 'forget-key' });
  assert.equal(state.fields['api-key'].configured, false);
  assert.equal((await worker.health()).status, 'needs-setup');
});

// ---------------------------------------------------------------- drawing

test('the drawing carries its own notice, citation and provenance', () => {
  const result = validateResult({
    ...prediction(), version: 1, provider: 'Google DeepMind AlphaGenome', plan: PLAN,
    createdAt: '2026-09-11T10:00:00.000Z', sdkRevision: REVISION, model: 'ALL_FOLDS',
    notice: NOTICE, citation: CITATION,
  });
  const svg = trackSvg(result, 0);
  assert.match(svg, /^<svg /);
  assert.match(svg, /AlphaGenome Output Terms of Use/);
  assert.match(svg, /doi:10\.1038\/s41586-025-10014-0/);
  assert.match(svg, /Research only; no clinical use/);
  assert.match(svg, /16 kb context only/);
});

// ---------------------------------------------------------------- contract

test('the worker satisfies the capability contract it declares', async () => {
  const findings = await runConformanceSuite(manifest, createWorker(configured()), {
    invocations: [{ toolId: 'predict', input: PLAN }],
    chatNodes: [
      { id: 'n0', kind: 'prose', content: QUESTION, complete: true },
      { id: 'n1', kind: 'fence', fence: 'genomics-plan', content: JSON.stringify(PLAN), complete: true },
    ],
    artifacts: [{
      artifactType: 'genomics-result', artifactVersion: 1,
      data: {
        ...prediction(), version: 1, provider: 'Google DeepMind AlphaGenome', plan: PLAN,
        createdAt: '2026-09-11T10:00:00.000Z', sdkRevision: REVISION, model: 'ALL_FOLDS',
        notice: NOTICE, citation: CITATION,
      },
    }],
  });
  assert.deepEqual(conformanceFailures(findings), []);
});

// ------------------------------------------------ what 5.3.1 left behind

const migrate = createRequire(import.meta.url)('../migrations/001-adopt-credentials.cjs');
const BUILTIN_TERMS = '2026-09-08';

test('the migration adopts the key and the consent the built-in recorded', async () => {
  const host = stubHost();
  const result = await migrate({ host, legacy: { genomics: { apiKey: 'A'.repeat(32), termsVersion: BUILTIN_TERMS } }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal(result.dataVersion, 1);
  assert.equal(await host.secrets.has('api-key'), true, 'the key moved into the package credential store');
  assert.equal(await host.storage.state.get('terms'), TERMS_VERSION, 'consent to the same terms carries over');
  assert.match(result.notes, /Adopted the stored API key/);
});

test('consent to older terms is not consent to these', async () => {
  const host = stubHost();
  const result = await migrate({ host, legacy: { genomics: { apiKey: 'A'.repeat(32), termsVersion: '2025-01-01' } }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal(await host.secrets.has('api-key'), true);
  assert.equal(await host.storage.state.get('terms'), null, 'the terms have to be accepted again');
  assert.match(result.notes, /older version/);
});

test('the migration leaves a key that is not one, and never overwrites a configured one', async () => {
  const nonsense = stubHost();
  await migrate({ host: nonsense, legacy: { genomics: { apiKey: 'nope' } }, fromDataVersion: 0, toDataVersion: 1 });
  assert.equal(await nonsense.secrets.has('api-key'), false);

  const configuredHost = stubHost({ secrets: ['api-key'] });
  const result = await migrate({ host: configuredHost, legacy: { genomics: { apiKey: 'B'.repeat(32) } }, fromDataVersion: 0, toDataVersion: 1 });
  assert.match(result.notes, /already configured/);
});

test('running the migration twice leaves the profile exactly as running it once did', async () => {
  const host = stubHost();
  const legacy = { genomics: { apiKey: 'C'.repeat(32), termsVersion: BUILTIN_TERMS } };
  await migrate({ host, legacy, fromDataVersion: 0, toDataVersion: 1 });
  const after = [[...host.state.entries()], await host.secrets.has('api-key')];
  await migrate({ host, legacy, fromDataVersion: 0, toDataVersion: 1 });
  assert.deepEqual([[...host.state.entries()], await host.secrets.has('api-key')], after);
});

test('a prediction saved by the built-in still renders from the file beside the chat', async () => {
  const worker = createWorker(configured());
  // Exactly what 5.3.1 wrote into `<id>.genomics`: the whole record, plus the terms
  // version the built-in stamped on it and this package no longer carries.
  const saved = {
    ...prediction(), version: 1, provider: 'Google DeepMind AlphaGenome', plan: PLAN,
    createdAt: '2026-09-11T10:00:00.000Z', sdkRevision: REVISION, model: 'ALL_FOLDS',
    notice: NOTICE, citation: CITATION, termsVersion: BUILTIN_TERMS,
  };
  const view = await worker.renderLegacyResult({
    fence: 'genomics-result',
    payload: 'nodus-genomics://chat/' + 'a'.repeat(64) + '/3f8a1c0e-9b2d-4e77-8a10-5c6d7e8f9a0b',
    asset: JSON.stringify(saved),
    locale: 'en',
  });
  assert.equal(view.schemaVersion, 1);
  assert.ok(view.nodes.length, 'the old record is drawn with the view this package ships');

  await assert.rejects(worker.renderLegacyResult({ fence: 'genomics-result', payload: 'not json', locale: 'en' }), /UNREADABLE/);
  await assert.rejects(worker.renderLegacyResult({ fence: 'chemistry-document', payload: '{}', locale: 'en' }), /Unknown legacy fence/);
});
