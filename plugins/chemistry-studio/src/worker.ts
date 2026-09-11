import { bindHost, completeText, host, type CapabilityHost } from './engine/host';
import { resolveChemistryIntent } from './engine/chemistryIdentity';
import { chemistryDependencies } from './deps';
import { splitFences } from './engine/fences';
import { chemistrySvgAuditSystem, chemistrySvgMode, isChemistrySvgRequest } from './engine/chatChemistrySvg';
import { CHEMISTRY_INSTRUCTIONS } from './engine/instructions';
import { documentView, noticeView, summarize, unverifiedSvgView, type ChemistryAttachments } from './view';
import { text } from './messages';
import type { ChemistryDocument } from './engine/chemistryDocument';

/** The notice codes the built-in could write. A code outside this list is shown as the
 *  generic "older format" warning rather than looked up blindly. */
const NOTICE_CODES = [
  'conflicting-intents', 'unverified-svg', 'legacy-format', 'partial-validation',
  'not-drawn', 'one-plan-per-reply', 'assumed-identity',
];

/** Chemistry Studio as a trusted capability worker.
 *
 *  The whole cascade lives here now: adopt a drawing intent, resolve identities against
 *  references, validate the structure in a killable subworker, repair a structurally
 *  wrong plan, and — only when the verified lane has abstained — ask for a plainly
 *  labelled unverified drawing rather than leave the user with nothing. The application
 *  contributes the network permission, the model and the SVG sanitizer, and knows nothing
 *  about chemistry. */

const DATA_VERSION = 1;
/** Structural rejections name a JSON field and are worth one more attempt; chemical ones
 *  are not, because no amount of re-prompting makes a reference say something else. */
const REPAIR_ATTEMPTS = 2;

interface ChatNode { id: string; kind: 'prose' | 'fence'; fence?: string; content: string; complete: boolean }

export default function createWorker(capabilityHost: CapabilityHost) {
  bindHost(capabilityHost);

  return {
    async health() { return { status: 'ready' as const, dataVersion: DATA_VERSION }; },

    /** Adopts a drawing intent the model expressed as plain JSON, and takes the drawing
     *  lane so the core stops second-guessing it. */
    async prepareChat({ nodes, question, locale }: { nodes: ChatNode[]; question?: string; locale: string }) {
      const mutations: Array<Record<string, unknown>> = [];
      const plans = nodes.filter(node => node.kind === 'fence' && node.fence === 'chemistry-plan');

      if (plans.length) {
        let promoted = false;
        for (const node of plans) {
          if (promoted) {
            mutations.push({ op: 'remove', nodeId: node.id });
            mutations.push({ op: 'notice', position: 'after', view: noticeView('one-plan-per-reply', locale) });
            continue;
          }
          if (!node.complete) {
            mutations.push({ op: 'remove', nodeId: node.id });
            mutations.push({ op: 'notice', position: 'after', view: noticeView('not-drawn', locale, text('error.CHEMISTRY_INTERRUPTED', locale)) });
            continue;
          }
          mutations.push({ op: 'promote-request', nodeId: node.id, toolId: 'compile', input: { plan: node.content, question: question ?? '' } });
          promoted = true;
        }
        if (promoted) mutations.push({ op: 'claim', suppressSvgRefinement: true });
        return mutations;
      }

      // No fenced plan, but the model may have described one as ordinary JSON. Adopting it
      // is better than letting an unverified picture stand in for a checked structure.
      const candidates = nodes.filter(node => node.kind === 'fence' && node.fence === 'json' && node.complete && looksLikeIntent(node.content));
      const distinct = new Set(candidates.map(node => JSON.stringify(JSON.parse(node.content))));
      if (distinct.size > 1) {
        // Ambiguity is reported, never used as a reason to discard the reply.
        return [{ op: 'notice', position: 'after', view: noticeView('conflicting-intents', locale) }];
      }
      if (distinct.size === 1) {
        mutations.push({ op: 'promote-request', nodeId: candidates[0].id, toolId: 'compile', input: { plan: candidates[0].content, question: question ?? '' } });
        for (const extra of candidates.slice(1)) mutations.push({ op: 'remove', nodeId: extra.id });
        mutations.push({ op: 'claim', suppressSvgRefinement: true });
      }
      return mutations;
    },

    async invoke({ toolId, input, locale }: { toolId: string; input: { plan: string; question?: string }; locale: string }) {
      if (toolId !== 'compile') throw new Error(`Unknown tool: ${toolId}`);
      const question = input.question ?? '';
      const notices: Array<Record<string, unknown>> = [];
      const deps = chemistryDependencies();

      let source = input.plan;
      for (let attempt = 0; ; attempt++) {
        host().signal.throwIfAborted();
        const document = await resolveChemistryIntent(source, question, deps, host().signal);

        if (document.status === 'verified' || document.status === 'partial') {
          const attachments = await storeAttachments(document);
          return {
            artifacts: [{
              artifactType: 'chemistry-document', artifactVersion: 2,
              summary: summarize(document, locale), data: document,
              view: documentView(document, locale, attachments),
            }],
            notices,
          };
        }

        // `unsupported` means the intent's shape was wrong and the error names the field.
        // `needs-clarification` means the chemistry itself is underdetermined.
        if (document.status !== 'unsupported' || attempt >= REPAIR_ATTEMPTS) {
          return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices);
        }
        const { repairChemistryIntent } = await import('./engine/chemistryRepair');
        const repaired = await repairChemistryIntent({
          question, rejected: source, problem: document.reason ?? '',
          instructions: CHEMISTRY_INSTRUCTIONS, final: attempt === REPAIR_ATTEMPTS - 1,
          signal: host().signal,
        });
        if (!repaired) return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices);
        source = repaired;
      }
    },

    async renderArtifact({ artifactType, data, locale }: { artifactType: string; data: unknown; locale: string }) {
      if (artifactType !== 'chemistry-document') throw new Error(`Unknown artifact type: ${artifactType}`);
      return documentView(data as ChemistryDocument, locale);
    },

    /** A drawing or a notice saved by the built-in.
     *
     *  5.3.1 wrote the whole document into the block, so an old conversation needs nothing
     *  fetched and nothing converted: it is parsed and drawn with today's view. The notice
     *  codes it used are the same keys this package still carries, so a warning from then
     *  reads as a warning now rather than as raw JSON. */
    async renderLegacyResult({ fence, payload, locale }: { fence: string; payload: string; locale: string }) {
      let data: unknown;
      try { data = JSON.parse(payload); }
      catch { throw new Error('CHEMISTRY_LEGACY_UNREADABLE'); }
      if (fence === 'chemistry-notice') {
        const notice = data as { code?: string; detail?: string };
        const code = typeof notice?.code === 'string' && NOTICE_CODES.includes(notice.code) ? notice.code : 'legacy-format';
        return noticeView(code, locale, typeof notice?.detail === 'string' ? notice.detail : undefined);
      }
      if (fence !== 'chemistry-document') throw new Error(`Unknown legacy fence: ${fence}`);
      return documentView(data as ChemistryDocument, locale);
    },

    /** What a later turn may know about a drawing: the identities, what was verified and
     *  against which sources. Never the SVG, which is a picture, and never anything the
     *  model could read back as a new instruction. */
    async projectArtifactForModel({ data }: { data: unknown }) {
      const document = data as ChemistryDocument;
      const lines = [
        `Chemistry Studio document (${document.status}, scope: ${document.scope}).`,
        ...document.species.map(species => {
          const references = (species.references ?? []).map(reference => `${reference.provider}:${reference.smiles}`).join(' ');
          return `- ${species.input.value}: ${species.graph?.canonicalSmiles ?? 'unresolved'}${references ? ` [${references}]` : ''}`;
        }),
        ...(document.reaction ? [`Reaction scope: ${document.reaction.scope}.`] : []),
        ...(document.mechanism ? [`Mechanism rule: ${document.mechanism.rule}.`] : []),
        ...[...(document.reaction?.limitations ?? []), ...(document.mechanism?.limitations ?? [])].map(entry => `Limitation: ${entry}`),
      ];
      return lines.join('\n');
    },

    async shutdown() {},
  };
}

function looksLikeIntent(content: string): boolean {
  try {
    const candidate = JSON.parse(content);
    return candidate?.version === 2
      && ['skeletal', 'fischer', 'haworth', 'newman'].includes(candidate.depiction)
      && ['structure', 'comparison', 'mechanism', 'reaction', 'resonance'].includes(candidate.kind)
      && (Array.isArray(candidate.species) || candidate.kind === 'reaction' && typeof candidate.reactionSmiles === 'string');
  } catch { return false; }
}

/** The verified lane produced nothing. Rather than leave the user with only a notice, ask
 *  once for a drawing in plain SVG — and label it, everywhere, as unverified. */
async function abstain(reason: string, question: string, locale: string, notices: Array<Record<string, unknown>>) {
  const rescued = await rescueWithSvg(question, reason);
  if (!rescued) return { notices: [...notices, noticeView('not-drawn', locale, reason)] };
  return { notices, view: unverifiedSvgView(rescued, locale, reason) };
}

async function rescueWithSvg(question: string, reason: string): Promise<string | null> {
  try {
    const answer = await completeText({
      system: `${chemistrySvgAuditSystem(CHEMISTRY_INSTRUCTIONS, chemistrySvgMode(question))}

Chemistry Studio could not produce a verified drawing for this request. Draw it yourself as one complete, self-contained SVG, using classical textbook notation with labelled atoms, explicit formal charges, and curved arrows where the request involves electron movement. Accompany nothing: return only the fenced svg block. Draw the chemistry the request actually asks for; do not narrow it to a simpler example, and do not refuse because a verified rule was unavailable.`,
      user: JSON.stringify({ request: question, verifiedLaneReported: reason.slice(0, 700) }),
      maxTokens: 12_000,
    });
    const part = splitFences(answer).find(entry => entry.kind === 'svg' && entry.complete);
    if (!part) return null;
    const checked = await host().svg.validate(part.content);
    return checked.ok ? part.content : null;
  } catch { return null; }
}

/** The document and its ChemFig export travel as attachments, so the reply carries a
 *  reference instead of megabytes of inline text. */
async function storeAttachments(document: ChemistryDocument): Promise<ChemistryAttachments> {
  const attachments: ChemistryAttachments = {};
  try {
    attachments.document = await host().attachments.store({
      bytes: Buffer.from(JSON.stringify(document, null, 2)),
      name: 'chemistry-document-v2.json', mimeType: 'application/json',
    });
    const chemfig = document.reaction?.chemfig?.source
      ?? document.species.find(species => species.chemfig?.status === 'validated')?.chemfig?.source;
    if (chemfig) {
      attachments.chemfig = await host().attachments.store({
        bytes: Buffer.from(chemfig), name: 'structure.chemfig.tex', mimeType: 'text/x-tex',
      });
    }
  } catch {
    // Attachments need a saved conversation. Without one the drawing still renders; only
    // the downloads are missing, which is better than failing the whole result.
  }
  return attachments;
}

export { isChemistrySvgRequest };
