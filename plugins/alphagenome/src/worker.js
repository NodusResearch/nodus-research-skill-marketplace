import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundPlan, validatePlanShape, validateResult, parsePlan, CITATION, NOTICE, REVISION, TERMS_VERSION } from './plan.js';
import { resultView, summarize, noticeView } from './view.js';
import { errorText, text } from './messages.js';
import { decodeLegacyGenomics } from './legacy.js';

/** AlphaGenome as a trusted capability worker.
 *
 *  Two things about this package are not conveniences. The key never reaches the worker:
 *  the host holds it and writes it into the interpreter's stdin, so it is not in an
 *  argument list, an environment variable or a log line. And the result declares
 *  `modelVisibility: "none"`, which the core enforces — a prediction is rendered on this
 *  device and is never part of what is sent back to the model. */

const DATA_VERSION = 1;
const RUNTIME_ID = 'alphagenome';
// The adapter ships inside the package, two levels up from the capability's worker. The
// source is ESM so its own tests can import it; the published bundle is CJS, and this is
// the one expression that reads the same in both.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'alphagenome_worker.py');

export default function createWorker(host) {
  let busy = false;

  const stored = async () => ({
    hasKey: await host.secrets.has('api-key'),
    terms: (await host.storage.state.get('terms')) === TERMS_VERSION,
    runtime: (await host.storage.state.get('runtime')) === REVISION,
  });

  const settingsState = async (locale = 'en') => {
    const state = await stored();
    const ready = state.hasKey && state.terms && state.runtime;
    return {
      fields: { 'api-key': { configured: state.hasKey }, terms: { value: state.terms } },
      status: {
        state: ready ? 'ok' : 'pending',
        label: ready
          ? { en: text('ready', 'en'), es: text('ready', 'es') }
          : !state.hasKey ? { en: text('keyMissing', 'en'), es: text('keyMissing', 'es') }
            : !state.terms ? { en: text('termsPending', 'en'), es: text('termsPending', 'es') }
              : { en: text('runtimeMissing', 'en'), es: text('runtimeMissing', 'es') },
      },
      ...(state.hasKey && state.terms ? {} : {
        // Building a several-hundred-megabyte environment before the user can use it is
        // wasted work and a confusing order of operations.
        disabledActions: { 'install-runtime': { en: 'Add your key and accept the terms first.', es: 'Añade tu clave y acepta los términos primero.' } },
      }),
    };
  };

  return {
    async health() {
      const state = await stored();
      return {
        status: state.hasKey && state.terms && state.runtime ? 'ready' : 'needs-setup',
        dataVersion: DATA_VERSION,
      };
    },

    async prepareChat({ nodes, question, locale }) {
      const mutations = [];
      let promoted = false;
      for (const node of nodes) {
        if (node.kind !== 'fence' || node.fence !== 'genomics-plan') continue;
        if (promoted || !node.complete) {
          mutations.push({ op: 'remove', nodeId: node.id });
          if (!node.complete) mutations.push({ op: 'notice', position: 'after', view: noticeView('GENOMICS_INVALID_JSON', locale) });
          continue;
        }
        try {
          const plan = parsePlan(node.content, question);
          mutations.push({ op: 'promote-request', nodeId: node.id, toolId: 'predict', input: plan });
          promoted = true;
        } catch (error) {
          mutations.push({ op: 'remove', nodeId: node.id });
          mutations.push({ op: 'notice', position: 'after', view: noticeView(String(error.message).split(':')[0], locale) });
        }
      }
      if (promoted) mutations.push({ op: 'claim', exclusive: true });
      return mutations;
    },

    async invoke({ toolId, input, locale }) {
      if (toolId !== 'predict') throw new Error(`Unknown tool: ${toolId}`);
      const plan = validatePlanShape(input);
      const state = await stored();
      if (!state.hasKey) throw new Error(errorText(new Error('GENOMICS_NO_KEY'), locale));
      if (!state.terms) throw new Error(errorText(new Error('GENOMICS_TERMS'), locale));
      if (!state.runtime) throw new Error(errorText(new Error('GENOMICS_RUNTIME_MISSING'), locale));
      if (busy) throw new Error(errorText(new Error('GENOMICS_BUSY'), locale));
      busy = true;
      try {
        // The key is named, not passed: the host reads it from the credential store and
        // writes it to the interpreter's stdin itself.
        const run = await host.python.run({
          runtimeId: RUNTIME_ID,
          args: ['-I', SCRIPT],
          stdin: JSON.stringify({ plan }),
          secretId: 'api-key',
          timeoutMs: 180_000,
        });
        // The SDK's diagnostics can carry private data, so stderr is never surfaced.
        if (run.code !== 0) throw new Error('GENOMICS_RUNTIME_FAILED');
        if (run.stdout.length > 1_000_000) throw new Error('GENOMICS_TOO_LARGE');
        const data = JSON.parse(run.stdout);
        const result = validateResult({
          ...data, version: 1, provider: 'Google DeepMind AlphaGenome', plan,
          createdAt: new Date().toISOString(), sdkRevision: REVISION, model: 'ALL_FOLDS',
          notice: NOTICE, citation: CITATION,
        });
        return {
          artifacts: [{
            artifactType: 'genomics-result', artifactVersion: 1,
            summary: summarize(result, locale), data: result, view: resultView(result, locale),
          }],
        };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        host.log('warn', 'alphagenome prediction failed', { code: String(error?.message ?? '').split(':')[0] });
        throw new Error(errorText(error, locale));
      } finally { busy = false; }
    },

    async renderArtifact({ artifactType, data, locale }) {
      if (artifactType !== 'genomics-result') throw new Error(`Unknown artifact type: ${artifactType}`);
      return resultView(validateResult(decodeLegacyGenomics(data)), locale);
    },

    // Deliberately absent: projectArtifactForModel. The artifact declares
    // modelVisibility "none", and a worker that could produce a projection for it would
    // have misunderstood its own privacy declaration.

    async getSettings() { return settingsState(); },

    async applySettings({ fields }) {
      // The secret itself never arrives here; the host has already stored it. What does
      // arrive is the consent, which is versioned so a change of terms asks again.
      if ('terms' in fields) await host.storage.state.set('terms', fields.terms === true ? TERMS_VERSION : 0);
      return settingsState();
    },

    async runAction({ actionId }) {
      if (actionId === 'forget-key') {
        await host.secrets.delete('api-key');
        return settingsState();
      }
      if (actionId !== 'install-runtime') throw new Error(`Unknown action: ${actionId}`);
      const state = await stored();
      if (!state.hasKey || !state.terms) throw new Error('GENOMICS_TERMS');
      const outcome = await host.python.ensureRuntime(RUNTIME_ID);
      if (!outcome.ready) {
        await host.storage.state.delete('runtime');
        const current = await settingsState();
        return { ...current, status: { state: 'failed', label: { en: outcome.detail ?? 'Runtime installation failed.', es: outcome.detail ?? 'La instalación del runtime ha fallado.' } } };
      }
      // A runtime is only recorded as ready once the adapter itself answers.
      const check = await host.python.run({ runtimeId: RUNTIME_ID, args: ['-I', SCRIPT, '--check'], timeoutMs: 120_000 });
      if (check.code !== 0) {
        await host.storage.state.delete('runtime');
        throw new Error('GENOMICS_RUNTIME_FAILED');
      }
      await host.storage.state.set('runtime', REVISION);
      return settingsState();
    },

    /** A prediction saved by the built-in, rendered from the file it left beside the chat.
     *
     *  5.3.1 wrote the block as nothing but a `nodus-genomics://` reference; the host
     *  resolves it and hands over the bytes, because the artifact type declares it decodes
     *  that format. The record itself is the same one this package produces. */
    async renderLegacyResult({ fence, payload, asset, locale }) {
      if (fence !== 'genomics-result') throw new Error(`Unknown legacy fence: ${fence}`);
      const raw = asset ?? payload;
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error('GENOMICS_LEGACY_UNREADABLE'); }
      return resultView(validateResult(decodeLegacyGenomics(data)), locale);
    },

    async shutdown() {},
  };
}

export { groundPlan };
