import { parsePlan, validatePlanShape } from './plan.js';
import { retrieve } from './retrieve.js';
import { exportText } from './attribution.js';
import { resultView, summarize, noticeView } from './view.js';
import { errorText } from './messages.js';

/** Legalize as a trusted capability worker.
 *
 *  The package owns the whole discipline now: the country catalogue, the licence hashes,
 *  the retrieval, the attribution and the view. Nodus contributes the network permission,
 *  the cache quota and the deadline, and knows nothing about legislation. */

const DATA_VERSION = 1;

export default function createWorker(host) {
  return {
    async health() {
      return { status: 'ready', dataVersion: DATA_VERSION };
    },

    /** The plan block is only promoted to a request once it is grounded in what the user
     *  actually wrote. A fabricated citation is refused here, before anything is fetched
     *  and dressed in an official source. */
    async prepareChat({ nodes, question, locale }) {
      const mutations = [];
      let promoted = false;
      for (const node of nodes) {
        if (node.kind !== 'fence' || node.fence !== 'legal-plan') continue;
        if (promoted) { mutations.push({ op: 'remove', nodeId: node.id }); continue; }
        if (!node.complete) {
          mutations.push({ op: 'remove', nodeId: node.id });
          mutations.push({ op: 'notice', position: 'after', view: noticeView('LEGALIZE_INVALID_JSON', locale) });
          continue;
        }
        try {
          const plan = parsePlan(node.content, question);
          mutations.push({ op: 'promote-request', nodeId: node.id, toolId: 'retrieve', input: plan });
          promoted = true;
        } catch (error) {
          mutations.push({ op: 'remove', nodeId: node.id });
          mutations.push({ op: 'notice', position: 'after', view: noticeView(String(error.message).split(':')[0], locale) });
        }
      }
      // Legalize answers the whole message when it answers at all, so it takes the reply.
      if (promoted) mutations.push({ op: 'claim', exclusive: true });
      return mutations;
    },

    async invoke({ toolId, input, locale }) {
      if (toolId !== 'retrieve') throw new Error(`Unknown tool: ${toolId}`);
      const plan = validatePlanShape(input);
      try {
        const result = await retrieve(host, plan);
        return {
          artifacts: [{
            artifactType: 'legal-result',
            artifactVersion: 1,
            summary: summarize(result, locale),
            data: result,
            view: resultView(result, locale),
          }],
        };
      } catch (error) {
        host.log('warn', 'legalize retrieval failed', { code: String(error?.message ?? '').split(':')[0] });
        throw new Error(errorText(error, locale));
      }
    },

    async renderArtifact({ artifactType, data, locale }) {
      if (artifactType !== 'legal-result') throw new Error(`Unknown artifact type: ${artifactType}`);
      return resultView(data, locale);
    },

    /** A retrieval saved by the built-in. 5.3.1 wrote the whole record into the block, so
     *  there is nothing to fetch: it is parsed and drawn with today's view, attribution
     *  and licence notices included. */
    async renderLegacyResult({ fence, payload, locale }) {
      if (fence !== 'legal-result') throw new Error(`Unknown legacy fence: ${fence}`);
      let data;
      try { data = JSON.parse(payload); }
      catch { throw new Error('LEGAL_LEGACY_UNREADABLE'); }
      return resultView(data, locale);
    },

    /** What the model may see later: the same export a user would download, so a follow-up
     *  question is answered from the retrieved text and its attribution, not from memory. */
    async projectArtifactForModel({ data }) {
      return exportText(data);
    },

    async shutdown() {},
  };
}
