import { MAX_LABEL_NAME_CHARS, MAX_SPECIES_CHARS, maxLabelsPerStep, maxLabelsTotal, maxNames, maxQuestionChars, type ChemistryCapBudget } from './engine/chemistryLimits';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindHost, completeText, host, type CapabilityHost } from './engine/host';
import { nameStructureBySmiles, resolveChemistryIntent, resolveNameReferences, resolveSpeciesName, type SpeciesNameResolution, type SpeciesStructureName, type ChemistryIdentityDependencies, MAX_CHEMICAL_NAME} from './engine/chemistryIdentity';
import { chemistryDependencies } from './deps';
import type { RouteLabelInput } from './engine/chemistryRouteAudit';
import { splitFences } from './engine/fences';
import { chemistrySvgAuditSystem, chemistrySvgMode, isChemistrySvgRequest } from './engine/chatChemistrySvg';
import { CHEMISTRY_INSTRUCTIONS } from './engine/instructions';
import { documentView, noticeView, summarize, unverifiedSvgView, type ChemistryAttachments } from './view';
import { text } from './messages';
import type { ChemistryDocument, ChemistryGraph, ChemistryInspectionResult } from './engine/chemistryDocument';

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

/** The chat question, cut to what `compile` will accept.
 *
 *  The hook staples the host's question onto the promoted request, and the host's question is the
 *  last user message. In a synthesis route that message is the whole accumulated correction prompt
 *  — the route check, every failing step and its advice — which ran past the cap `compile`
 *  declares for `question` (8,000 characters then, derived from the window now, and the real
 *  prompt that broke it measured 9,523). The whole call was then refused before it ran, and the host
 *  printed its raw schema complaint into the answer the author reads: measured on a 30-target
 *  cascade, 58 turns across 26 targets, every one of them a fix round and not one a first answer.
 *  Nothing was drawn by that path and nothing could be, so the only product was the error.
 *
 *  The head is what is kept, not the tail: `question` exists here to be pattern-matched for
 *  intent, and both the phrases that matter — "Correction needed for" and the route keywords —
 *  open the prompt. A request short enough to carry a reaction SMILES for the copy check is
 *  thousands of characters inside the cap and is never cut at all. */
const clampQuestion = (question?: string, budget?: ChemistryCapBudget): string => (question ?? '').slice(0, maxQuestionChars(budget));

const DATA_VERSION = 1;
/** Structural rejections name a JSON field and are worth one more attempt; chemical ones
 *  are not, because no amount of re-prompting makes a reference say something else. */
const REPAIR_ATTEMPTS = 2;

/** The shared Python runtime the reaction lookup runs in, and the adapter it runs. The runtime
 *  is app-managed and shared by lock digest; the adapter is this package's own. */
/** The template pass of one disconnection call, inside its 240 s runtime limit. */
const DISCONNECT_BUDGET_SECONDS = 180;
const REACTIONS_RUNTIME_ID = 'chemistry';
const REACTIONS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'reactions_worker.py');
// Every call asks for a persistent interpreter: the script answers requests in a loop when the host
// sets NODUS_PYTHON_SERVE=1, so RDKit and the index tables load once per process instead of once
// per call. A host that does not know the flag ignores it and runs the script once per call.

/** What a failed Python call says about itself: its exit code and the interpreter's last line of
 *  stderr (the exception). A failure used to reach the author as "The reaction lookup failed." with
 *  the traceback thrown away, and the two calls that fall back silently said nothing at all. */
function pythonFailure(what: string, run: { code: number; stderr: string }): string {
  const last = run.stderr.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300);
  return `${what} (exit ${run.code}${last ? `: ${last}` : ''}).`;
}

interface ChatNode { id: string; kind: 'prose' | 'fence'; fence?: string; content: string; complete: boolean }

export default function createWorker(capabilityHost: CapabilityHost) {
  bindHost(capabilityHost);
  // One cache per worker: the resolve pass populates it and the route audit reuses it, so a
  // name is looked up over the network once. The host may keep a worker for a whole conversation
  // (its answers and their correction rounds), so only answers are kept, never a failed lookup.
  const referenceCache: ReferenceCache = new Map();
  const resolvedNames: ResolvedNames = new Map();

  return {
    async health() { return { status: 'ready' as const, dataVersion: DATA_VERSION }; },

    /** Adopts a drawing intent the model expressed as plain JSON, and takes the drawing
     *  lane so the core stops second-guessing it. */
    async prepareChat({ nodes, question, locale, budget }: { nodes: ChatNode[]; question?: string; locale: string; budget?: ChemistryCapBudget }) {
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
          mutations.push({ op: 'promote-request', nodeId: node.id, toolId: 'compile', input: { plan: node.content, question: clampQuestion(question, budget) } });
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
        mutations.push({ op: 'promote-request', nodeId: candidates[0].id, toolId: 'compile', input: { plan: candidates[0].content, question: clampQuestion(question, budget) } });
        for (const extra of candidates.slice(1)) mutations.push({ op: 'remove', nodeId: extra.id });
        mutations.push({ op: 'claim', suppressSvgRefinement: true });
      }
      return mutations;
    },

    async invoke({ toolId, input, locale, chat }: { toolId: string; input: { plan?: string; question?: string; smiles?: string[]; names?: string[]; steps?: string[]; carriers?: Array<string | null>; racemic?: boolean | Array<boolean | null>; rearrangement?: boolean | Array<boolean | null>; radical?: boolean | Array<boolean | null>; target?: string; labels?: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null>; indexDir?: string; reactions?: string[]; products?: string[]; similar?: string[]; targets?: string[]; startingMaterials?: string[]; limit?: number; stockDir?: string; molecules?: string[]; indexDirs?: string[]; maxSteps?: number; budgetSeconds?: number; pubchemDir?: string; opsinDir?: string; localOnly?: boolean }; locale: string; chat?: { question?: string; nodeId?: string; budget?: ChemistryCapBudget } }) {
      // Sized against what this turn's model can hold; absent on an older host, which falls back
      // to the floors each cap has always had.
      const budget = chat?.budget;
      // A request that came out of a chat reply carries the reply's node. The local folders (a
      // PubChem mirror, an OPSIN install this package RUNS, indexes, stock lists) are the
      // application's to choose on its own calls; a reply that names one is ignored, so a
      // prompt-injected `"opsinDir": "~/Downloads/kit"` cannot have a program run from there.
      if (chat?.nodeId) input = withoutHostFolders(input);
      if (toolId === 'resolve-names') return resolveNames(input, referenceCache, resolvedNames, budget);
      if (toolId === 'resolve-structure') return nameStructures(input, budget);
      if (toolId === 'inspect') return inspectMolecule(input);
      if (toolId === 'verify-route') return verifySynthesisRoute(input, referenceCache, budget);
      if (toolId === 'known-reactions') return knownReactions(input);
      if (toolId === 'propose-disconnections') return proposeDisconnections(input);
      if (toolId === 'check-stock') return checkStock(input);
      if (toolId === 'search-routes') return searchRoutes(input);
      // Its `steps` are objects (reactants, products, reagents), not verify-route's equation strings.
      if (toolId === 'check-compatibility') return checkCompatibility(input as unknown as { steps?: CompatibilityStepInput[]; textbookDir?: string });
      if (toolId !== 'compile') throw new Error(`Unknown tool: ${toolId}`);
      const question = input.question ?? '';
      const notices: Array<Record<string, unknown>> = [];
      const deps = await referenceDependencies(input, planNames(input.plan), []);
      // The model-SVG fallback is a chat feature: it draws something for the reply when the
      // verified lane abstains. A direct application call (a route-step scheme, no chat node)
      // reports the refusal instead of paying for a drawing the application will not use.
      const allowFallback = Boolean(chat?.nodeId);

      let source = input.plan ?? '';
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
          return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices, allowFallback, source);
        }
        const { repairChemistryIntent } = await import('./engine/chemistryRepair');
        const repaired = await repairChemistryIntent({
          question, rejected: source, problem: document.reason ?? '',
          instructions: CHEMISTRY_INSTRUCTIONS, final: attempt === REPAIR_ATTEMPTS - 1,
          signal: host().signal,
        });
        if (!repaired) return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices, allowFallback, source);
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
      && ['skeletal', 'wedge-dash', 'lone-pairs', 'fischer', 'haworth', 'newman'].includes(candidate.depiction)
      && ['structure', 'comparison', 'mechanism', 'reaction', 'resonance'].includes(candidate.kind)
      && (Array.isArray(candidate.species) || candidate.kind === 'reaction' && typeof candidate.reactionSmiles === 'string');
  } catch { return false; }
}

/** The verified lane produced nothing. In a chat reply, rather than leave the user with only
 *  a notice, ask once for a drawing in plain SVG — and label it, everywhere, as unverified.
 *  A direct application call passes `allowFallback: false`: it wants the refusal, not a
 *  drawing it will discard, so no model call is spent. */
async function abstain(reason: string, question: string, locale: string, notices: Array<Record<string, unknown>>, allowFallback = true, plan = '') {
  if (!allowFallback) return { notices: [...notices, noticeView('not-drawn', locale, reason)] };
  const rescued = await rescueWithSvg(question, reason, plan);
  if (!rescued) return { notices: [...notices, noticeView('not-drawn', locale, reason)] };
  return { notices, view: unverifiedSvgView(rescued, locale, reason) };
}

/** The unverified fallback, scoped to what the plan asked for.
 *
 *  It used to be given the whole request and told to "draw the chemistry the request actually asks
 *  for", which is a different question from the one the plan asked. Measured in a real reply: the
 *  plan asked for one target structure, the request was a multi-step route, and the rescue drew the
 *  entire route as a four-panel scheme with reagents and conditions — an unverified picture of a
 *  route nothing had checked, in an answer whose author had asked for the pictures to stop. The
 *  request still travels, because it names the species, but the plan is what sets the subject. */
async function rescueWithSvg(question: string, reason: string, plan = ''): Promise<string | null> {
  try {
    const answer = await completeText({
      system: `${chemistrySvgAuditSystem(CHEMISTRY_INSTRUCTIONS, chemistrySvgMode(question))}

Chemistry Studio could not produce a verified drawing for this request. Draw it yourself as one complete, self-contained SVG, using classical textbook notation with labelled atoms, explicit formal charges, and curved arrows where the request involves electron movement. Accompany nothing: return only the fenced svg block.

Draw EXACTLY what the plan asked for and nothing else. The plan is in \`plan\`; the request is in \`request\` only so you can tell which species the plan names. If the plan names a single structure, draw that one structure: not the route that makes it, not its starting materials, not a reaction scheme, and no reagents, conditions, step numbers or commentary. Add a panel only where the plan itself asks for one. Do not narrow the plan to a simpler example, and do not refuse because a verified rule was unavailable.`,
      user: JSON.stringify({ plan: plan.slice(0, 4_000), request: question, verifiedLaneReported: reason.slice(0, 700) }),
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

const ATOMIC_SYMBOLS: Record<number, string> = { 1: 'H', 3: 'Li', 5: 'B', 6: 'C', 7: 'N', 8: 'O', 9: 'F', 11: 'Na', 12: 'Mg', 13: 'Al', 14: 'Si', 15: 'P', 16: 'S', 17: 'Cl', 19: 'K', 35: 'Br', 53: 'I' };
const atomIndex = (id: string) => Number(id.replace(/^a/, ''));

/** The verified graph as a compact dossier the model can reason over. No SVG, no network,
 *  no model call: the read-only counterpart to `compile`. */
function dossierArtifact(graph: ChemistryGraph, smiles: string) {
  const caveats: string[] = [];
  const atoms = graph.atoms.map(atom => {
    const index = atomIndex(atom.id);
    const cip = typeof atom.cip === 'string' ? atom.cip : '';
    if (cip === '?') caveats.push(`stereocentre at atom ${index} is unspecified`);
    return {
      index,
      element: ATOMIC_SYMBOLS[atom.atomicNumber] ?? String(atom.atomicNumber),
      ...(atom.charge ? { charge: atom.charge } : {}),
      ...(atom.isotope ? { isotope: atom.isotope } : {}),
      ...(typeof atom.hydrogens === 'number' ? { hydrogens: atom.hydrogens } : {}),
      ...(cip && cip !== '?' ? { cip } : {}),
    };
  });
  const bonds = graph.bonds.map(bond => ({
    a: atomIndex(bond.atoms[0]),
    b: atomIndex(bond.atoms[1]),
    order: bond.order ?? 1,
    ...(bond.cip ? { stereo: bond.cip } : {}),
  }));
  const uniqueCaveats = [...new Set(caveats)];
  return {
    artifactType: 'molecule-dossier', artifactVersion: 1,
    summary: `${atoms.length} atoms, ${bonds.length} bonds`,
    data: {
      canonicalSmiles: graph.canonicalSmiles, inputSmiles: smiles,
      atomCount: atoms.length, bondCount: bonds.length, atoms, bonds,
      ...(uniqueCaveats.length ? { caveats: uniqueCaveats.slice(0, 12) } : {}),
    },
  };
}

async function inspectMolecule(input: { smiles?: string[] }) {
  const list = Array.isArray(input?.smiles) ? input.smiles : [];
  const cleaned = [...new Set(list.filter(entry => typeof entry === 'string' && entry.trim() && entry.length <= MAX_SPECIES_CHARS).map(entry => entry.trim()))].slice(0, 24);
  if (!cleaned.length) throw new Error(`Provide at least one SMILES string (max ${MAX_SPECIES_CHARS} characters each).`);
  const results = await chemistryDependencies().inspectBatch(cleaned, host().signal);
  const artifacts = results
    .filter((entry): entry is ChemistryInspectionResult & { graph: ChemistryGraph } => Boolean(entry.ok && entry.graph && Array.isArray(entry.graph.atoms) && Array.isArray(entry.graph.bonds)))
    .map(entry => dossierArtifact(entry.graph, entry.smiles));
  return { artifacts, notices: [] };
}

/** Resolve a batch of systematic names to structures (PubChem first, OPSIN fallback), each
 *  with a status and, when it fails, a feedback sentence the model can act on. The route
 *  derivation calls this before building any equation, so the SMILES never come from the
 *  model. */
/** A few reference lookups at once: a long route resolves in a fraction of the time without
 *  hammering two public services. */
const NAME_CONCURRENCY = 4;

/** Names resolved in this worker, so the route label check reuses the first pass instead of
 *  paying for a second network round trip. Only structures are kept — a name that resolved to
 *  nothing may have met a refusal or an outage, and must be asked again next time — and the
 *  cache is bounded, because a worker can now serve a conversation rather than one turn. */
type ReferenceCache = Map<string, string[]>;
const REFERENCE_CACHE_CAP = 4096;

function rememberReference(cache: ReferenceCache, name: string, smiles: string[]): void {
  if (!smiles.length) return;
  cache.delete(name);
  cache.set(name, smiles);
  if (cache.size > REFERENCE_CACHE_CAP) cache.delete(cache.keys().next().value!);
}

/** Names `resolve-names` has resolved in this worker, as it answered them. A correction round
 *  sends back most of the names of the round before; each costs PubChem round trips at a pace of
 *  at least 200 ms a request, and longer under throttling. Only resolutions are kept, never an
 *  "unresolved" (which also covers a network failure); bounded, oldest first out. */
type ResolvedNames = Map<string, SpeciesNameResolution>;
const RESOLVED_NAMES_CAP = 4096;

const PUBCHEM_ORIGIN = 'https://pubchem.ncbi.nlm.nih.gov';

/** A per-run circuit breaker around the reference fetch: once PubChem fails as a service,
 *  stop asking it and fall through to the OPSIN fallback. A 404 is a missing name, not an
 *  outage, so only a thrown request or a 5xx opens the breaker. */
/** PubChem's dynamic request throttling, obeyed for the life of this worker
 *  (https://pubchem.ncbi.nlm.nih.gov/docs/dynamic-request-throttling).
 *
 *  Every reply grades the caller in X-Throttling-Control — request count, request time and service
 *  load, each Green / Yellow / Red / Black — and requests are load-balanced, so PubChem asks callers
 *  to pace by the WORST feedback seen. A refusal is 503 (it sent this machine 429), and a block GROWS
 *  if requests continue. Measured 2026-10-09: four look-ups at a time with no shared pace, and a
 *  breaker that ignored 429 and reset on every tool call, kept sending to a server that had already
 *  blocked this machine. So: one pace for all requests, at most five a second; slower as soon as any
 *  indicator turns; and after a refusal, NOTHING is sent until a growing back-off has passed — a
 *  look-up then fails fast to its fallback without touching PubChem. */
const PUBCHEM_PACE_MS: Record<string, number> = { Green: 200, Yellow: 1000, Red: 5000, Black: 60_000 };
const PUBCHEM_HOLD_MS = 5 * 60_000;
const pubchemPace = { delay: 200, until: 0, nextAt: 0, blockedUntil: 0, backoff: 60_000, lastSent: 0 };

export function resetPubchemPacing(): void {
  Object.assign(pubchemPace, { delay: 200, until: 0, nextAt: 0, blockedUntil: 0, backoff: 60_000, lastSent: 0 });
}

function notePubchemFeedback(control: string | null, now: number): void {
  const colours = Object.keys(PUBCHEM_PACE_MS).filter((colour) => control?.includes(colour));
  const worst = colours.reduce((a, b) => (PUBCHEM_PACE_MS[b] > PUBCHEM_PACE_MS[a] ? b : a), 'Green');
  if (PUBCHEM_PACE_MS[worst] >= pubchemPace.delay || now > pubchemPace.until) {
    pubchemPace.delay = PUBCHEM_PACE_MS[worst];
    pubchemPace.until = now + PUBCHEM_HOLD_MS;
  }
}

/** The longest a look-up waits for its PubChem turn. Past it, the fallback answers now: after a
 *  refusal the pace is a minute a request for five minutes, so a queued look-up used to sleep out
 *  most of the route check's own timeout and then send to a server that had just refused us. */
const PUBCHEM_MAX_WAIT_MS = 8_000;

const PUBCHEM_TOO_SLOW = 'PubChem is pacing requests too slowly to wait for; using the fallback reference.';

/** A pause that ends early, with the signal's reason, when the turn is cancelled. */
function pubchemPause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function takePubchemTurn(signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  const now = Date.now();
  if (now < pubchemPace.blockedUntil) throw new Error('PubChem asked this machine to back off; using the fallback reference.');
  const delay = now < pubchemPace.until ? pubchemPace.delay : 200;
  const at = Math.max(now, pubchemPace.nextAt);
  // Too far off: fall back without reserving, so the turns behind this one do not move back.
  if (at - now > PUBCHEM_MAX_WAIT_MS) throw new Error(PUBCHEM_TOO_SLOW);
  pubchemPace.nextAt = at + delay;
  if (at > now) await pubchemPause(at - now, signal);
  // A turn reserved before the latest grade arrived still keeps the CURRENT pace from the last
  // request actually sent — a Yellow that came back meanwhile slows the queued ones too.
  for (;;) {
    // Blocked meanwhile: give up now and let the fallback answer, rather than wait out the pace.
    if (Date.now() < pubchemPace.blockedUntil) throw new Error('PubChem asked this machine to back off; using the fallback reference.');
    const pace = Date.now() < pubchemPace.until ? pubchemPace.delay : 200;
    const wait = pubchemPace.lastSent + pace - Date.now();
    if (wait <= 0) break;
    if (wait > PUBCHEM_MAX_WAIT_MS) throw new Error(PUBCHEM_TOO_SLOW);
    await pubchemPause(wait, signal);
  }
  pubchemPace.lastSent = Date.now();
}

/** A Retry-After header, in milliseconds from now: seconds, or an HTTP date. */
function retryAfterMs(value: string | null | undefined, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

function breakerFetch(base: typeof fetch): typeof fetch {
  let open = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(raw).origin;
    if (origin !== PUBCHEM_ORIGIN) return base(input, init);
    if (open) throw new Error('PubChem is unavailable; using the fallback reference.');
    // The caller's signal carries both the turn's abort and the reference's own timeout. A wait it
    // cuts short throws here, before the request, and is not counted as an outage.
    await takePubchemTurn(init?.signal);
    // Checked again AFTER the wait: a look-up that queued for a turn before a refusal arrived must
    // not send once its turn comes.
    if (open || Date.now() < pubchemPace.blockedUntil) throw new Error('PubChem asked this machine to back off; using the fallback reference.');
    let response: Response;
    try { response = await base(input, init); }
    catch (error) { open = true; throw error; }
    const now = Date.now();
    // Defensive: a response without headers must never turn a PubChem answer into a fallback.
    notePubchemFeedback(typeof response.headers?.get === 'function' ? response.headers.get('x-throttling-control') : null, now);
    if (response.status === 429 || response.status === 503) {
      // Refused: stop sending entirely, and wait longer each time it happens again.
      // PubChem's own Retry-After, when it sends one, is the authority; otherwise a growing back-off.
      const told = retryAfterMs(typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null, now);
      pubchemPace.blockedUntil = now + Math.max(told, pubchemPace.backoff);
      pubchemPace.backoff = Math.min(pubchemPace.backoff * 2, 30 * 60_000);
      notePubchemFeedback('Black', now);
      open = true;
    } else if (response.status >= 500) {
      open = true;
    } else {
      pubchemPace.backoff = 60_000;
    }
    return response;
  }) as typeof fetch;
}

/** Canonicalise the resolved structures once and seed the shared cache, so every downstream
 *  surface — the labels, the annotation, the derived equation, the drawing and the route
 *  review — shows one canonical isomeric SMILES per compound. Identical compounds then read
 *  identically, and a checker or reviewer cannot call them different connectivity. */
/** The net formal charge a SMILES writes: the sum of its bracket-atom charges (`[Na+]`, `[O-]`,
 *  `[Cr+3]`, `[Fe++]`). */
export function smilesNetCharge(smiles: string): number {
  let total = 0;
  for (const match of smiles.matchAll(/\[[^\]]*?([+-])(\d+|[+-]*)\]/g)) {
    const sign = match[1] === '+' ? 1 : -1;
    const tail = match[2];
    total += sign * (/^\d+$/.test(tail) ? Number(tail) : 1 + tail.length);
  }
  return total;
}

/** A salt — a structure of several parts — whose charges do not sum to zero is not a compound:
 *  a name such as "sodium diethyl propanedioate" can resolve to the neutral diester beside a
 *  sodium ion. Refused with feedback, so the author gives the structure instead of a route
 *  step that can never balance. A single charged species (an ion named as one) is left alone. */
function refuseUnbalancedSalts(resolutions: SpeciesNameResolution[]): void {
  for (const entry of resolutions) {
    if (entry.status !== 'resolved' || !entry.smiles || !entry.smiles.includes('.')) continue;
    const charge = smilesNetCharge(entry.smiles);
    if (charge === 0) continue;
    entry.status = 'unresolved';
    entry.feedback = `The name resolved to ${entry.smiles}, a salt whose charges do not balance (net ${charge > 0 ? '+' : ''}${charge}), so it is not the compound meant. Give the salt's isomeric SMILES with the charged atom written explicitly (for an enolate or carbanion, the deprotonated carbon as [CH-] or [C-]).`;
    delete entry.smiles;
    delete entry.formula;
  }
}

/** "hydrogen" as a reagent is dihydrogen, but a reference can return the hydrogen atom `[H]`, a
 *  radical no step uses and the checker cannot even lay out. Only a name that says atom or
 *  radical keeps the atom. */
function dihydrogenForHydrogen(resolutions: SpeciesNameResolution[]): void {
  for (const entry of resolutions) {
    if (entry.status !== 'resolved' || !entry.smiles || !/^\[H\]$/.test(entry.smiles.trim())) continue;
    if (!/\b(?:di)?hydrogen\b/i.test(entry.name) || /\b(?:atom|atomic|radical)\b/i.test(entry.name)) continue;
    entry.smiles = '[H][H]';
    entry.formula = 'H2';
  }
}

/** A covalent metal oxide (chromium trioxide, osmium tetroxide, selenium dioxide…) comes back from
 *  PubChem as bare ions — `[Cr+6].[O-2].[O-2].[O-2]`. The route checker reads each ion as its own
 *  species, so the equation showed "2 Cr + 4 O" and the bond ledger counted loose atoms. When a
 *  name resolves to one high-valent metal cation and exactly the oxide anions that balance it,
 *  write the covalent oxide instead (`O=[Cr](=O)=O`). */
function covalentForIonicOxide(resolutions: SpeciesNameResolution[]): void {
  for (const entry of resolutions) {
    if (entry.status !== 'resolved' || !entry.smiles) continue;
    const parts = entry.smiles.trim().split('.');
    const cation = parts.map((part) => /^\[([A-Z][a-z]?)\+(\d)\]$/.exec(part)).filter(Boolean);
    const oxides = parts.filter((part) => part === '[O-2]').length;
    if (cation.length !== 1 || cation.length + oxides !== parts.length) continue;
    const [, metal, charge] = cation[0]!;
    if (Number(charge) < 3 || Number(charge) !== 2 * oxides) continue;
    entry.smiles = `O=[${metal}]${'(=O)'.repeat(Math.max(0, oxides - 2))}${oxides > 1 ? '=O' : ''}`;
  }
}

/** The label pass's candidates for a name, with the fix-ups resolve-names applies to the same
 *  answer. Without them a salt resolve-names refused, or an oxide it rewrote as covalent, is
 *  compared in its raw form, and the structure the author supplied in its place — as the refusal
 *  asked — is reported as a different compound. A refused candidate is dropped, so a name left
 *  with none is unchecked, not a disagreement. */
function fixedCandidates(name: string, candidates: string[]): string[] {
  const entries: SpeciesNameResolution[] = candidates.map((smiles) => ({ name, status: 'resolved', smiles }));
  refuseUnbalancedSalts(entries);
  dihydrogenForHydrogen(entries);
  covalentForIonicOxide(entries);
  return [...new Set(entries.flatMap((entry) => (entry.status === 'resolved' && entry.smiles ? [entry.smiles] : [])))];
}

async function canonicalizeResolutions(resolutions: SpeciesNameResolution[], cache: ReferenceCache, signal: AbortSignal): Promise<void> {
  refuseUnbalancedSalts(resolutions);
  dihydrogenForHydrogen(resolutions);
  covalentForIonicOxide(resolutions);
  const inputs = [...new Set(resolutions
    .filter((entry) => entry.status === 'resolved' && entry.smiles)
    .map((entry) => entry.smiles!))];
  const canonical = new Map<string, string>();
  if (inputs.length) {
    try {
      // Only the canonical form is read, so the batch draws nothing: 2.1 s → 0.4 s for a route's
      // 32 names at about 50 heavy atoms each.
      const checked = await chemistryDependencies().inspectBatch(inputs, signal, { canonicalOnly: true });
      for (const entry of checked) {
        if (entry.ok && entry.graph?.canonicalSmiles) canonical.set(entry.smiles, entry.graph.canonicalSmiles);
      }
    } catch { /* the raw writing still resolves; the route audit canonicalises it again */ }
  }
  for (const entry of resolutions) {
    if (entry.status !== 'resolved' || !entry.smiles) continue;
    entry.smiles = canonical.get(entry.smiles) ?? entry.smiles;
    rememberReference(cache, entry.name, [entry.smiles]);
  }
}

/** The inputs only the application supplies: directories read (or, for OPSIN, run from) and the
 *  switch that keeps a run off the network. */
const HOST_FOLDER_INPUTS = ['pubchemDir', 'opsinDir', 'indexDir', 'indexDirs', 'stockDir', 'textbookDir', 'localOnly'] as const;

function withoutHostFolders<T extends object>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const copy = { ...input } as Record<string, unknown>;
  for (const key of HOST_FOLDER_INPUTS) delete copy[key];
  return copy as T;
}

/** One Python call answering a batch from the local PubChem mirror and a local OPSIN, whichever
 *  the host passed. Any failure — none there, no runtime, a slow call — is no local answer: the
 *  network is asked exactly as before. */
/** For a run that must stay on this machine — a timing trace, so the network neither adds latency
 *  nor risks another block: every reference request is refused WITHOUT being sent, and the local
 *  sources (the PubChem mirror, a local OPSIN) answer alone. A species they cannot answer is
 *  unresolved or unnamed, exactly as if the network had no answer. */
const localOnlyFetch = (async () => { throw new Error('Local references only: the network is not consulted on this run.'); }) as unknown as typeof fetch;

async function localReferencesFor(input: { pubchemDir?: unknown; opsinDir?: unknown }, names: string[], smiles: string[]): Promise<Pick<ChemistryIdentityDependencies, 'pubchemMirror' | 'opsinLocal'>> {
  const pubchemDir = typeof input?.pubchemDir === 'string' && input.pubchemDir ? input.pubchemDir : undefined;
  const opsinDir = typeof input?.opsinDir === 'string' && input.opsinDir && names.length ? input.opsinDir : undefined;
  if ((!pubchemDir && !opsinDir) || (!names.length && !smiles.length)) return {};
  try {
    const run = await host().python.run({ runtimeId: REACTIONS_RUNTIME_ID, args: ['-I', REACTIONS_SCRIPT], persistent: true,
      stdin: JSON.stringify({ ...(pubchemDir ? { pubchemDir } : {}), ...(opsinDir ? { opsinDir } : {}), pubchemNames: names, pubchemSmiles: smiles }), timeoutMs: 120_000 });
    // Logged, not only dropped: every name then goes to the network, and nothing else says why.
    if (run.code !== 0) {
      host().log('warn', `${pythonFailure('The local references were not consulted', run)} The network answers instead.`, { code: run.code, stderr: run.stderr.slice(-2000) });
      return {};
    }
    const data = JSON.parse(run.stdout) as {
      pubchem?: { available?: boolean; error?: string; names?: Record<string, { cid: number; smiles: string; formula?: string }>; smiles?: Record<string, { cid: number; name?: string; formula?: string }> };
      opsin?: Record<string, { status: string; smiles?: string; warnings?: string[]; message?: string }>;
    };
    if (data.pubchem?.error) host().log('warn', 'The local PubChem mirror could not be read; the network answers instead.', { error: data.pubchem.error });
    return {
      ...(data.pubchem?.available ? { pubchemMirror: { names: new Map(Object.entries(data.pubchem.names ?? {})), smiles: new Map(Object.entries(data.pubchem.smiles ?? {})) } } : {}),
      ...(data.opsin && Object.keys(data.opsin).length ? { opsinLocal: new Map(Object.entries(data.opsin)) } : {}),
    };
  } catch (error) {
    host().log('warn', `The local references were not consulted: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/** What every tool that resolves a name is given: the local mirror and a local OPSIN first, asked
 *  once for the whole batch, and the network only through the PubChem pacer — or not at all on a
 *  local-only run. `compile` and the route's label check used to take the bare dependencies, so
 *  they asked the network for names the mirror held, without the pace PubChem asks for. */
async function referenceDependencies(input: { pubchemDir?: unknown; opsinDir?: unknown; localOnly?: unknown }, names: string[], smiles: string[]) {
  const base = chemistryDependencies();
  const local = await localReferencesFor(input, names, smiles);
  return { ...base, fetch: input?.localOnly === true ? localOnlyFetch : breakerFetch(base.fetch), ...local };
}

/** The names a drawing plan asks to resolve, for the batched local look-up. An unreadable plan
 *  has none; `compile` reports what is wrong with it. */
function planNames(plan?: string): string[] {
  try {
    const species = (JSON.parse(plan ?? '') as { species?: Array<{ input?: { kind?: unknown; value?: unknown } }> })?.species;
    return Array.isArray(species)
      ? [...new Set(species.flatMap((entry) => entry?.input?.kind === 'name' && typeof entry.input.value === 'string' ? [entry.input.value] : []))]
      : [];
  } catch { return []; }
}

async function resolveNames(input: { names?: string[]; pubchemDir?: string; opsinDir?: string; localOnly?: boolean }, cache: ReferenceCache, resolvedNames: ResolvedNames, budget?: ChemistryCapBudget) {
  const limit = maxNames(budget);
  const list = Array.isArray(input?.names) ? input.names : [];
  const cleaned = [...new Set(list
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    // A systematic name for an assembled chain runs to several hundred characters, and a cut
    // name is syntactically incomplete, so it resolves to nothing and the caller is told the
    // NAME is unknown when the fault was the cut.
    .map((entry) => entry.trim().slice(0, MAX_CHEMICAL_NAME)))].slice(0, limit);
  if (!cleaned.length) throw new Error(`Provide between one and ${limit} chemical names.`);
  const results: Array<SpeciesNameResolution | undefined> = new Array(cleaned.length);
  const todo: number[] = [];
  cleaned.forEach((name, index) => {
    const known = resolvedNames.get(name);
    if (known) results[index] = { ...known };
    else todo.push(index);
  });
  const deps = await referenceDependencies(input, todo.map((index) => cleaned[index]), []);
  const signal = host().signal;
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const next = cursor;
      cursor += 1;
      if (next >= todo.length) return;
      signal.throwIfAborted();
      const index = todo[next];
      results[index] = await resolveSpeciesName(cleaned[index], deps, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, todo.length) }, run));
  // resolveSpeciesName reads an aborted look-up as "no answer", so a cancelled batch would come
  // back as names that do not resolve. Cancelled is cancelled.
  signal.throwIfAborted();
  const fresh = todo.map((index) => results[index]).filter((entry): entry is SpeciesNameResolution => entry !== undefined);
  await canonicalizeResolutions(fresh, cache, signal);
  for (const entry of fresh) {
    if (entry.status !== 'resolved') continue;
    resolvedNames.set(entry.name, { ...entry });
    if (resolvedNames.size > RESOLVED_NAMES_CAP) resolvedNames.delete(resolvedNames.keys().next().value!);
  }
  for (const index of cleaned.keys()) {
    const entry = results[index];
    if (entry?.status === 'resolved' && entry.smiles && !todo.includes(index)) rememberReference(cache, entry.name, [entry.smiles]);
  }
  const resolved = results.filter((entry): entry is SpeciesNameResolution => entry !== undefined);
  const unresolved = resolved.filter((entry) => entry.status !== 'resolved').length;
  const summary = unresolved
    ? `${resolved.length - unresolved} of ${resolved.length} name(s) resolved`
    : `${resolved.length} name(s) resolved`;
  return { artifacts: [{ artifactType: 'species-resolution', artifactVersion: 1, summary, data: { results: resolved } }], notices: [] };
}

/** Name a batch of structures (isomeric SMILES): RDKit canonicalises each and gives it a
 *  formula, and PubChem supplies the IUPAC name and CID when it holds the structure. This is
 *  the reverse of `resolve-names`, used to give a name back to a species the author could only
 *  supply as a structure. */
/** Structures PubChem has already named, for the life of this worker. A correction round sends
 *  back most of the same fallback structures, and each costs two PubChem round trips: 45 s on one
 *  long route's first check and 21 s again on its correction (measured 2026-10-09). Only positive
 *  answers are kept — "unnamed" also covers a network failure, which must not stick. Bounded,
 *  oldest first out. */
const namedStructures = new Map<string, SpeciesStructureName>();
const NAMED_STRUCTURES_CAP = 4096;

async function nameStructures(input: { smiles?: string[]; pubchemDir?: string; localOnly?: boolean }, budget?: ChemistryCapBudget) {
  const limit = maxNames(budget);
  const list = Array.isArray(input?.smiles) ? input.smiles : [];
  const cleaned = [...new Set(list
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 2000)))].slice(0, limit);
  if (!cleaned.length) throw new Error(`Provide between one and ${limit} structures.`);
  const uncached = cleaned.filter((smiles) => !namedStructures.has(smiles));
  const deps = await referenceDependencies({ pubchemDir: input?.pubchemDir, localOnly: input?.localOnly }, [], uncached);
  const signal = host().signal;
  const results: Array<SpeciesStructureName | undefined> = new Array(cleaned.length);
  const todo: number[] = [];
  cleaned.forEach((smiles, index) => {
    const known = namedStructures.get(smiles);
    if (known) results[index] = { ...known };
    else todo.push(index);
  });
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const next = cursor;
      cursor += 1;
      if (next >= todo.length) return;
      signal.throwIfAborted();
      const index = todo[next];
      results[index] = await nameStructureBySmiles(cleaned[index], deps, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, todo.length) }, run));
  // Likewise here: an aborted look-up reads as "PubChem does not hold this structure".
  signal.throwIfAborted();
  const fresh = todo.map((index) => results[index]).filter((entry): entry is SpeciesStructureName => entry !== undefined);
  await attachCanonical(fresh, signal);
  for (const entry of fresh) {
    if (entry.status !== 'named') continue;
    namedStructures.set(entry.smiles, { ...entry });
    if (namedStructures.size > NAMED_STRUCTURES_CAP) namedStructures.delete(namedStructures.keys().next().value!);
  }
  const named = results.filter((entry): entry is SpeciesStructureName => entry !== undefined);
  const namedCount = named.filter((entry) => entry.status === 'named').length;
  const summary = namedCount
    ? `${namedCount} of ${named.length} structure(s) named`
    : `${named.length} structure(s) not held by PubChem`;
  return { artifacts: [{ artifactType: 'structure-naming', artifactVersion: 1, summary, data: { results: named } }], notices: [] };
}

/** Parse each structure with RDKit and attach its canonical isomeric SMILES, so a structure
 *  PubChem does not hold still travels with a checked identity. Best effort: the raw SMILES
 *  stands when the subworker is unavailable. */
async function attachCanonical(entries: SpeciesStructureName[], signal: AbortSignal): Promise<void> {
  const smiles = [...new Set(entries.map((entry) => entry.smiles).filter(Boolean))];
  if (!smiles.length) return;
  try {
    const checked = await chemistryDependencies().inspectBatch(smiles, signal, { canonicalOnly: true });
    const byInput = new Map(checked.filter((entry) => entry.ok && entry.graph).map((entry) => [entry.smiles, entry.graph!]));
    for (const entry of entries) {
      const graph = byInput.get(entry.smiles);
      if (graph) entry.canonicalSmiles = graph.canonicalSmiles;
    }
  } catch { /* canonicalisation is best effort; the raw SMILES still stands */ }
}

/** Bound the reference lookups a single route can trigger; a name is resolved once and the answer
 *  is reused for the same name on every step. Both now come from the window: at 48, a route past
 *  its 48th DISTINCT name stopped being name-checked at all, and said nothing — an unresolved name
 *  is reported as unchecked, not as a disagreement. One measured chain had 50 distinct species. */

/** Resolve the names the author wrote beside each species. Resolution needs the network, so
 *  it happens here in the worker; the subworker receives the pre-resolved SMILES and only
 *  compares canonical graphs. A name that resolves to nothing is left with an empty list and
 *  is reported as unchecked, never as a disagreement. */
async function resolveRouteLabels(
  raw: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null> | undefined,
  stepCount: number,
  cache: ReferenceCache,
  references: { pubchemDir?: unknown; opsinDir?: unknown; localOnly?: unknown },
  signal?: AbortSignal,
  budget?: ChemistryCapBudget,
): Promise<RouteLabelInput[][]> {
  const perStep = maxLabelsPerStep(budget);
  const total = maxLabelsTotal(budget);
  const out: RouteLabelInput[][] = Array.from({ length: stepCount }, () => []);
  if (!Array.isArray(raw)) return out;
  const entries: Array<{ index: number; label: RouteLabelInput }> = [];
  for (let index = 0; index < Math.min(stepCount, raw.length); index += 1) {
    const list = Array.isArray(raw[index]) ? raw[index]! : [];
    for (const entry of list.slice(0, perStep)) {
      if (!entry || typeof entry !== 'object') continue;
      const role = entry.role === 'reactant' || entry.role === 'product' || entry.role === 'agent' ? entry.role : null;
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_LABEL_NAME_CHARS) : '';
      const smiles = typeof entry.smiles === 'string' ? entry.smiles.trim() : '';
      if (!role || !name || !smiles) continue;
      entries.push({ index, label: { role, byproduct: entry.byproduct === true, name, smiles } });
    }
  }
  // A name the resolve pass already looked up is reused: the reference is the same answer, and the
  // label check only compares canonical graphs. The rest — the first `total` distinct names, in
  // route order — are looked up together: one local call for the whole batch, then the network
  // for what it could not answer, a few at a time and through the pacer. One at a time, a 20-step
  // route's 31 names took 93 sequential round trips (29 s at 300 ms each).
  await adoptStoredReferences(cache, entries.map(({ label }) => label.name));
  const pending = [...new Set(entries.map(({ label }) => label.name).filter((name) => !cache.has(name)))];
  const lookedUp = pending.slice(0, total);
  // A worker can now serve a whole conversation, so a miss is never remembered in it: names past
  // the cap, and names that found nothing, are unchecked for THIS call and asked again by the next.
  const missed = new Set(pending.slice(total));
  if (lookedUp.length) {
    const deps = await referenceDependencies(references, lookedUp, []);
    let cursor = 0;
    const run = async () => {
      for (;;) {
        const next = cursor;
        cursor += 1;
        if (next >= lookedUp.length) return;
        signal?.throwIfAborted();
        const found = fixedCandidates(lookedUp[next], await resolveNameReferences(lookedUp[next], deps, signal));
        if (found.length) rememberReference(cache, lookedUp[next], found);
        else missed.add(lookedUp[next]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, lookedUp.length) }, run));
    await storeReferences(lookedUp.map((name) => [name, cache.get(name) ?? []]));
  }
  for (const { index, label } of entries) out[index].push({ ...label, nameSmiles: cache.get(label.name) ?? [] });
  return out;
}

/** Label answers kept in the package's cache storage, which outlives the worker. A fix round runs in
 *  a new worker, so the in-worker cache above starts empty and every name of a route was looked up
 *  again: 13.2 s of a 13.5 s re-check on a 20-step route at 300 ms a round trip, against 0.7 s when
 *  the answers were at hand. Only answers that found a structure are kept, and only for a day, so a
 *  failed look-up is retried and a corrected reference is picked up. Best effort: storage that
 *  cannot be read or written costs only the time it would have saved. */
const STORED_REFERENCES_KEY = 'route-label-references-v1';
const STORED_REFERENCE_MS = 24 * 60 * 60_000;
const STORED_REFERENCES_CAP = 2000;
type StoredReferences = Record<string, { smiles: string[]; at: number }>;

async function readStoredReferences(): Promise<StoredReferences> {
  try {
    const value = await host().storage.cache.get(STORED_REFERENCES_KEY);
    return value && typeof value === 'object' ? value as StoredReferences : {};
  } catch { return {}; }
}

async function adoptStoredReferences(cache: ReferenceCache, names: string[]): Promise<void> {
  if (names.every((name) => cache.has(name))) return;
  const stored = await readStoredReferences();
  const now = Date.now();
  for (const name of names) {
    const entry = stored[name];
    if (!cache.has(name) && entry && now - entry.at < STORED_REFERENCE_MS && Array.isArray(entry.smiles) && entry.smiles.every((value) => typeof value === 'string')) cache.set(name, entry.smiles);
  }
}

async function storeReferences(found: Array<[string, string[]]>): Promise<void> {
  const fresh = found.filter(([, smiles]) => smiles.length > 0);
  if (!fresh.length) return;
  try {
    const stored = await readStoredReferences();
    const now = Date.now();
    for (const [name, smiles] of fresh) stored[name] = { smiles, at: now };
    // Oldest first out, so the entry stays inside the package's cache quota.
    const kept = Object.entries(stored).filter(([, entry]) => now - entry.at < STORED_REFERENCE_MS)
      .sort(([, a], [, b]) => b.at - a.at).slice(0, STORED_REFERENCES_CAP);
    await host().storage.cache.set(STORED_REFERENCES_KEY, Object.fromEntries(kept));
  } catch { /* the in-worker cache still holds them for this turn */ }
}

/** Verify a whole synthesis route without drawing it: every step parsed, every equation
 *  balanced, every intermediate leaving one step the same molecule as the one entering the
 *  next, and every supplied IUPAC name denoting the structure it was written beside. The
 *  result is a `route-audit` artifact the application renders deterministically. */
/** The stereo choices each product (and organic reactant) really leaves open, from the full RDKit in the shared
 *  Python runtime (see `_stereo_choices`). Best-effort: an empty map when the runtime is not
 *  installed or the call fails, and the labeller's own counts stand. */
async function productStereoChoices(steps: string[]): Promise<Record<string, { open: number; mirrorOnly: boolean } | number | null>> {
  // Products, and reactants too: a racemic (stereo-open) reactant makes an enantiomer-only
  // product racemic, not an omission of the author's.
  const products = [...new Set(steps.flatMap(step => [...(step.split('>')[2] ?? '').split('.'), ...(step.split('>')[0] ?? '').split('.')]).map(part => part.trim()).filter(part => part && /[Cc]/.test(part)))].slice(0, 48);
  if (!products.length) return {};
  try {
    const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
    if (!ready.ready) return {};
    const run = await host().python.run({ runtimeId: REACTIONS_RUNTIME_ID, args: ['-I', REACTIONS_SCRIPT], persistent: true, stdin: JSON.stringify({ stereoChoices: products }), timeoutMs: 60_000 });
    if (run.code !== 0) { host().log('warn', pythonFailure('Stereo choices were not enumerated', run)); return {}; }
    return (JSON.parse(run.stdout) as { stereoChoices?: Record<string, { open: number; mirrorOnly: boolean } | number | null> }).stereoChoices ?? {};
  } catch (error) {
    host().log('warn', `Stereo choices were not enumerated: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function verifySynthesisRoute(input: { steps?: string[]; carriers?: Array<string | null>; racemic?: boolean | Array<boolean | null>; rearrangement?: boolean | Array<boolean | null>; radical?: boolean | Array<boolean | null>; target?: string; labels?: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null>; enumerateStereo?: boolean; pubchemDir?: string; opsinDir?: string; localOnly?: boolean }, cache: ReferenceCache, budget?: ChemistryCapBudget) {
  // An empty entry is a step the application could not build. It is kept, not dropped, so the
  // labels, carriers, racemic, rearrangement and radical flags — all indexed by step — stay aligned with the steps.
  // Not cut here: the route audit refuses a route over its step limit by name, where a silent
  // cut would check only the first steps and report the rest as never written.
  const steps = (Array.isArray(input?.steps) ? input.steps : [])
    .map(entry => typeof entry === 'string' ? entry.trim() : '');
  if (!steps.some(Boolean)) throw new Error('Provide at least one reaction SMILES step.');
  const carriers = Array.isArray(input?.carriers) ? input.carriers.slice(0, steps.length) : undefined;
  const racemic = typeof input?.racemic === 'boolean'
    ? input.racemic
    : Array.isArray(input?.racemic) ? input.racemic.slice(0, steps.length) : undefined;
  const rearrangement = typeof input?.rearrangement === 'boolean'
    ? input.rearrangement
    : Array.isArray(input?.rearrangement) ? input.rearrangement.slice(0, steps.length) : undefined;
  const radical = typeof input?.radical === 'boolean'
    ? input.radical
    : Array.isArray(input?.radical) ? input.radical.slice(0, steps.length) : undefined;
  const target = typeof input?.target === 'string' && input.target.trim() ? input.target.trim().slice(0, 2000) : undefined;
  // The enumeration needs the shared Python runtime; the application asks for it only where that
  // runtime is already installed (the reaction index is), so a route check never installs it. It
  // reads only the steps, so it runs while the labels are looked up rather than after them.
  const stereoPending = input?.enumerateStereo === true ? productStereoChoices(steps) : Promise.resolve({});
  const labels = await resolveRouteLabels(input?.labels, steps.length, cache, input, host().signal, budget);
  const stereoChoices = await stereoPending;
  const audit = await chemistryDependencies().verifyRoute({ steps, carriers, racemic, ...(rearrangement !== undefined ? { rearrangement } : {}), ...(radical !== undefined ? { radical } : {}), target, ...(labels.some(step => step.length) ? { labels } : {}), ...(Object.keys(stereoChoices).length ? { stereoChoices } : {}) }, host().signal, budget);
  if (!audit) throw new Error('The route could not be verified.');
  const summary = audit.continuous
    ? `Route verified: ${audit.steps.length} step(s), every intermediate carried over unchanged`
    : `Route has ${audit.blocked.length} problem(s)`;
  return { artifacts: [{ artifactType: 'route-audit', artifactVersion: 1, summary, data: audit }], notices: [] };
}

/** Look up proposed reactions and products in the local Open Reaction Database index. The
 *  application supplies the index directory (it owns the downloaded artifact); the lookup
 *  itself runs in the shared chemistry Python runtime. Application-invoked only: there is no
 *  chat fence, so the model never sees the index path. */
async function knownReactions(input: { indexDir?: string; reactions?: string[]; products?: string[]; similar?: string[] }) {
  const indexDir = typeof input?.indexDir === 'string' ? input.indexDir : '';
  if (!indexDir) throw new Error('A reaction lookup needs the index directory.');
  const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
  if (!ready.ready) throw new Error(ready.detail ?? 'The chemistry runtime could not be installed.');
  const run = await host().python.run({
    runtimeId: REACTIONS_RUNTIME_ID,
    args: ['-I', REACTIONS_SCRIPT], persistent: true,
    stdin: JSON.stringify({
      indexDir,
      reactions: Array.isArray(input.reactions) ? input.reactions.slice(0, 32) : [],
      products: Array.isArray(input.products) ? input.products.slice(0, 32) : [],
      similar: Array.isArray(input.similar) ? input.similar.slice(0, 16) : [],
    }),
    timeoutMs: 240_000,
  });
  if (run.code !== 0) throw new Error(pythonFailure('The reaction lookup failed', run));
  const data = JSON.parse(run.stdout) as { reactions?: Array<{ count: number }>; products?: Array<{ count: number }> };
  const exact = data.reactions?.filter(entry => entry.count > 0).length ?? 0;
  const made = data.products?.filter(entry => entry.count > 0).length ?? 0;
  const summary = `Known reactions: ${exact} exact, ${made} with a recorded route to the product.`;
  return { artifacts: [{ artifactType: 'reaction-precedent', artifactVersion: 1, summary, data }], notices: [] };
}

/** Propose one-step disconnections for route targets from the same local index: the recorded
 *  reactions that make each target, then retro templates extracted from the index and applied
 *  with RDChiral, ranked by recorded precedent, precursor availability and (when a route's
 *  starting materials are given) closeness to them. Application-invoked only, like the lookup. */
async function proposeDisconnections(input: { indexDir?: string; targets?: string[]; startingMaterials?: string[]; limit?: number; stockDir?: string }) {
  const indexDir = typeof input?.indexDir === 'string' ? input.indexDir : '';
  if (!indexDir) throw new Error('A disconnection search needs the index directory.');
  const targets = Array.isArray(input.targets) ? input.targets.filter(t => typeof t === 'string' && t.trim()).slice(0, 16) : [];
  if (targets.length === 0) throw new Error('A disconnection search needs at least one target.');
  const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
  if (!ready.ready) throw new Error(ready.detail ?? 'The chemistry runtime could not be installed.');
  const run = await host().python.run({
    runtimeId: REACTIONS_RUNTIME_ID,
    args: ['-I', REACTIONS_SCRIPT], persistent: true,
    stdin: JSON.stringify({
      indexDir,
      disconnect: targets,
      startingMaterials: Array.isArray(input.startingMaterials) ? input.startingMaterials.slice(0, 16) : [],
      limit: typeof input.limit === 'number' ? input.limit : 8,
      ...(typeof input.stockDir === 'string' && input.stockDir ? { stockDir: input.stockDir } : {}),
      // Templates are applied best-ranked first, so stopping at a deadline keeps the best proposals.
      // Without one, a large target ran into the runtime limit below and returned nothing at all:
      // 240 s lost on one call in a nine-turn trace (2026-10-09). The margin covers start-up, the
      // lookups after the template pass, and the output.
      budgetSeconds: DISCONNECT_BUDGET_SECONDS,
    }),
    timeoutMs: 240_000,
  });
  if (run.code !== 0) throw new Error(pythonFailure('The disconnection search failed', run));
  const data = JSON.parse(run.stdout) as { disconnections?: Array<{ madeBy?: unknown[]; proposals?: unknown[] }> };
  const entries = data.disconnections ?? [];
  const recorded = entries.filter(entry => (entry.madeBy?.length ?? 0) > 0).length;
  const proposals = entries.reduce((sum, entry) => sum + (entry.proposals?.length ?? 0), 0);
  const summary = `Disconnections: ${proposals} proposal(s) for ${entries.length} target(s), ${recorded} with a recorded reaction that makes it.`;
  return { artifacts: [{ artifactType: 'reaction-disconnections', artifactVersion: 1, summary, data }], notices: [] };
}

/** Which of the user's imported vendor stock lists hold each molecule (standard InChIKey). The
 *  lists are catalogues the user downloaded and imported (`reactions_worker.py --import-stock`);
 *  the application supplies their directory. Application-invoked only. */
async function checkStock(input: { stockDir?: string; molecules?: string[] }) {
  const stockDir = typeof input?.stockDir === 'string' ? input.stockDir : '';
  const molecules = Array.isArray(input?.molecules) ? input.molecules.filter(m => typeof m === 'string' && m.trim()).slice(0, 64) : [];
  if (!stockDir || molecules.length === 0) throw new Error('A stock check needs the stock directory and at least one molecule.');
  const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
  if (!ready.ready) throw new Error(ready.detail ?? 'The chemistry runtime could not be installed.');
  const run = await host().python.run({
    runtimeId: REACTIONS_RUNTIME_ID,
    args: ['-I', REACTIONS_SCRIPT], persistent: true,
    stdin: JSON.stringify({ stock: molecules, stockDir }),
    timeoutMs: 60_000,
  });
  if (run.code !== 0) throw new Error(pythonFailure('The stock check failed', run));
  const data = JSON.parse(run.stdout) as { stock?: Record<string, string[]>; orderable?: Record<string, string[]>; lists?: string[]; orderLists?: string[] };
  const found = Object.values(data.stock ?? {}).filter(vendors => vendors.length > 0).length;
  const orderable = Object.entries(data.orderable ?? {}).filter(([molecule, vendors]) => vendors.length > 0 && !(data.stock?.[molecule]?.length)).length;
  const summary = `Stock: ${found} of ${molecules.length} molecule(s) in stock on ${(data.lists ?? []).length} list(s)`
    + ((data.orderLists ?? []).length ? `, ${orderable} more orderable (make-on-demand).` : '.');
  return { artifacts: [{ artifactType: 'stock-availability', artifactVersion: 1, summary, data }], notices: [] };
}

export { isChemistrySvgRequest };

/** Multi-step routes searched backwards from the target over one or more local reaction indexes
 *  (ORD, the user's textbook-scheme index): recorded reactions and retro-template disconnections,
 *  each step with its provenance, ending in starting materials, stocked molecules, inorganics or
 *  routine reagents. The worker stops at the time budget and returns the routes found by then.
 *  Application-invoked only, like the lookups. */
async function searchRoutes(input: { indexDirs?: string[]; target?: string; startingMaterials?: string[]; maxSteps?: number; stockDir?: string; budgetSeconds?: number }) {
  const indexDirs = Array.isArray(input?.indexDirs) ? input.indexDirs.filter(d => typeof d === 'string' && d).slice(0, 4) : [];
  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (indexDirs.length === 0 || !target) throw new Error('A route search needs at least one index directory and a target.');
  const budgetSeconds = typeof input.budgetSeconds === 'number' ? Math.max(5, Math.min(240, Math.round(input.budgetSeconds))) : 90;
  const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
  if (!ready.ready) throw new Error(ready.detail ?? 'The chemistry runtime could not be installed.');
  const run = await host().python.run({
    runtimeId: REACTIONS_RUNTIME_ID,
    args: ['-I', REACTIONS_SCRIPT], persistent: true,
    stdin: JSON.stringify({
      indexDirs,
      route: target,
      startingMaterials: Array.isArray(input.startingMaterials) ? input.startingMaterials.slice(0, 16) : [],
      maxSteps: typeof input.maxSteps === 'number' ? Math.max(1, Math.min(6, Math.round(input.maxSteps))) : 4,
      budgetSeconds,
      ...(typeof input.stockDir === 'string' && input.stockDir ? { stockDir: input.stockDir } : {}),
    }),
    // The worker returns at its budget; the margin covers loading the indexes.
    timeoutMs: (budgetSeconds + 60) * 1000,
  });
  if (run.code !== 0) throw new Error(pythonFailure('The route search failed', run));
  const data = JSON.parse(run.stdout) as { route?: { routes?: unknown[]; expanded?: number; timedOut?: boolean } };
  const route = data.route ?? {};
  const summary = `Route search: ${route.routes?.length ?? 0} complete route(s) after ${route.expanded ?? 0} expansion(s)${route.timedOut ? ', stopped at the time budget' : ''}.`;
  return { artifacts: [{ artifactType: 'candidate-routes', artifactVersion: 1, summary, data: route }], notices: [] };
}

interface CompatibilityStepInput { reactants?: string[]; products?: string[]; reagents?: string }

/** Functional-group compatibility per route step: groups that survive into the product although a
 *  reagent named in the step's conditions attacks them, and protecting groups that vanish with no
 *  reagent that removes them, each with how to protect it (and textbook examples of putting that
 *  protecting group on, from a textbook index when one is given). Application-invoked only. */
async function checkCompatibility(input: { steps?: CompatibilityStepInput[]; textbookDir?: string }) {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 12) : []);
  const steps = (Array.isArray(input?.steps) ? input.steps : []).slice(0, 24).map(step => ({
    reactants: strings(step?.reactants),
    products: strings(step?.products),
    reagents: typeof step?.reagents === 'string' ? step.reagents.slice(0, 2000) : '',
  }));
  if (!steps.some(step => step.reactants.length && step.products.length)) throw new Error('A compatibility check needs at least one step with reactants and products.');
  const ready = await host().python.ensureRuntime(REACTIONS_RUNTIME_ID);
  if (!ready.ready) throw new Error(ready.detail ?? 'The chemistry runtime could not be installed.');
  const run = await host().python.run({
    runtimeId: REACTIONS_RUNTIME_ID,
    args: ['-I', REACTIONS_SCRIPT], persistent: true,
    stdin: JSON.stringify({ compatibility: steps, ...(typeof input.textbookDir === 'string' && input.textbookDir ? { textbookDir: input.textbookDir } : {}) }),
    timeoutMs: 90_000,
  });
  if (run.code !== 0) throw new Error(pythonFailure('The compatibility check failed', run));
  const data = JSON.parse(run.stdout) as { compatibility?: Array<{ hazards?: Array<{ severity?: string }> }> };
  const hazards = (data.compatibility ?? []).flatMap(step => step.hazards ?? []);
  const high = hazards.filter(hazard => hazard.severity === 'high').length;
  const summary = `Compatibility: ${hazards.length} hazard(s) in ${steps.length} step(s)${high ? `, ${high} high` : ''}.`;
  return { artifacts: [{ artifactType: 'step-compatibility', artifactVersion: 1, summary, data }], notices: [] };
}
