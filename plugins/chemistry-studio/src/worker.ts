import { bindHost, completeText, host, type CapabilityHost } from './engine/host';
import { nameStructureBySmiles, resolveChemistryIntent, resolveNameReferences, resolveSpeciesName, type SpeciesNameResolution, type SpeciesStructureName } from './engine/chemistryIdentity';
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

const DATA_VERSION = 1;
/** Structural rejections name a JSON field and are worth one more attempt; chemical ones
 *  are not, because no amount of re-prompting makes a reference say something else. */
const REPAIR_ATTEMPTS = 2;

interface ChatNode { id: string; kind: 'prose' | 'fence'; fence?: string; content: string; complete: boolean }

export default function createWorker(capabilityHost: CapabilityHost) {
  bindHost(capabilityHost);
  // One cache per worker: the resolve pass populates it and the route audit reuses it, so a
  // name is looked up over the network once per turn.
  const referenceCache: ReferenceCache = new Map();

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

    async invoke({ toolId, input, locale, chat }: { toolId: string; input: { plan?: string; question?: string; smiles?: string[]; names?: string[]; steps?: string[]; carriers?: Array<string | null>; racemic?: boolean | Array<boolean | null>; target?: string; labels?: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null> }; locale: string; chat?: { question?: string; nodeId?: string } }) {
      if (toolId === 'resolve-names') return resolveNames(input, referenceCache);
      if (toolId === 'resolve-structure') return nameStructures(input);
      if (toolId === 'inspect') return inspectMolecule(input);
      if (toolId === 'verify-route') return verifySynthesisRoute(input, referenceCache);
      if (toolId !== 'compile') throw new Error(`Unknown tool: ${toolId}`);
      const question = input.question ?? '';
      const notices: Array<Record<string, unknown>> = [];
      const deps = chemistryDependencies();
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
          return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices, allowFallback);
        }
        const { repairChemistryIntent } = await import('./engine/chemistryRepair');
        const repaired = await repairChemistryIntent({
          question, rejected: source, problem: document.reason ?? '',
          instructions: CHEMISTRY_INSTRUCTIONS, final: attempt === REPAIR_ATTEMPTS - 1,
          signal: host().signal,
        });
        if (!repaired) return abstain(document.reason ?? text('error.CHEMISTRY_NOT_DRAWN', locale), question, locale, notices, allowFallback);
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
async function abstain(reason: string, question: string, locale: string, notices: Array<Record<string, unknown>>, allowFallback = true) {
  if (!allowFallback) return { notices: [...notices, noticeView('not-drawn', locale, reason)] };
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
  const cleaned = [...new Set(list.filter(entry => typeof entry === 'string' && entry.trim() && entry.length <= 2000).map(entry => entry.trim()))].slice(0, 24);
  if (!cleaned.length) throw new Error('Provide at least one SMILES string (max 2000 characters each).');
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
const MAX_NAMES = 48;
/** A few reference lookups at once: a long route resolves in a fraction of the time without
 *  hammering two public services. */
const NAME_CONCURRENCY = 4;

/** Names resolved in this worker, so the route label check reuses the first pass instead of
 *  paying for a second network round trip. It is scoped to one worker instance — one turn —
 *  so a later turn can never read a stale reference. */
type ReferenceCache = Map<string, string[]>;

const PUBCHEM_ORIGIN = 'https://pubchem.ncbi.nlm.nih.gov';

/** A per-run circuit breaker around the reference fetch: once PubChem fails as a service,
 *  stop asking it and fall through to the OPSIN fallback. A 404 is a missing name, not an
 *  outage, so only a thrown request or a 5xx opens the breaker. */
function breakerFetch(base: typeof fetch): typeof fetch {
  let open = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(raw).origin;
    if (open && origin === PUBCHEM_ORIGIN) throw new Error('PubChem is unavailable; using the fallback reference.');
    let response: Response;
    try { response = await base(input, init); }
    catch (error) { if (origin === PUBCHEM_ORIGIN) open = true; throw error; }
    if (origin === PUBCHEM_ORIGIN && response.status >= 500) open = true;
    return response;
  }) as typeof fetch;
}

/** Canonicalise the resolved structures once and seed the shared cache, so every downstream
 *  surface — the labels, the annotation, the derived equation, the drawing and the route
 *  review — shows one canonical isomeric SMILES per compound. Identical compounds then read
 *  identically, and a checker or reviewer cannot call them different connectivity. */
async function canonicalizeResolutions(resolutions: SpeciesNameResolution[], cache: ReferenceCache, signal: AbortSignal): Promise<void> {
  const inputs = [...new Set(resolutions
    .filter((entry) => entry.status === 'resolved' && entry.smiles)
    .map((entry) => entry.smiles!))];
  const canonical = new Map<string, string>();
  if (inputs.length) {
    try {
      const checked = await chemistryDependencies().inspectBatch(inputs, signal);
      for (const entry of checked) {
        if (entry.ok && entry.graph?.canonicalSmiles) canonical.set(entry.smiles, entry.graph.canonicalSmiles);
      }
    } catch { /* the raw writing still resolves; the route audit canonicalises it again */ }
  }
  for (const entry of resolutions) {
    if (entry.status !== 'resolved' || !entry.smiles) continue;
    entry.smiles = canonical.get(entry.smiles) ?? entry.smiles;
    cache.set(entry.name, [entry.smiles]);
  }
}

async function resolveNames(input: { names?: string[] }, cache: ReferenceCache) {
  const list = Array.isArray(input?.names) ? input.names : [];
  const cleaned = [...new Set(list
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 200)))].slice(0, MAX_NAMES);
  if (!cleaned.length) throw new Error(`Provide between one and ${MAX_NAMES} chemical names.`);
  const base = chemistryDependencies();
  const deps = { ...base, fetch: breakerFetch(base.fetch) };
  const signal = host().signal;
  const results: Array<SpeciesNameResolution | undefined> = new Array(cleaned.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= cleaned.length) return;
      signal.throwIfAborted();
      results[index] = await resolveSpeciesName(cleaned[index], deps, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, cleaned.length) }, run));
  const resolved = results.filter((entry): entry is SpeciesNameResolution => entry !== undefined);
  await canonicalizeResolutions(resolved, cache, signal);
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
async function nameStructures(input: { smiles?: string[] }) {
  const list = Array.isArray(input?.smiles) ? input.smiles : [];
  const cleaned = [...new Set(list
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 2000)))].slice(0, MAX_NAMES);
  if (!cleaned.length) throw new Error(`Provide between one and ${MAX_NAMES} structures.`);
  const base = chemistryDependencies();
  const deps = { ...base, fetch: breakerFetch(base.fetch) };
  const signal = host().signal;
  const results: Array<SpeciesStructureName | undefined> = new Array(cleaned.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= cleaned.length) return;
      signal.throwIfAborted();
      results[index] = await nameStructureBySmiles(cleaned[index], deps, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, cleaned.length) }, run));
  const named = results.filter((entry): entry is SpeciesStructureName => entry !== undefined);
  await attachCanonical(named, signal);
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
    const checked = await chemistryDependencies().inspectBatch(smiles, signal);
    const byInput = new Map(checked.filter((entry) => entry.ok && entry.graph).map((entry) => [entry.smiles, entry.graph!]));
    for (const entry of entries) {
      const graph = byInput.get(entry.smiles);
      if (graph) entry.canonicalSmiles = graph.canonicalSmiles;
    }
  } catch { /* canonicalisation is best effort; the raw SMILES still stands */ }
}

const MAX_LABELS_PER_STEP = 24;
/** Bound the reference lookups a single route can trigger; a name is resolved once and the
 *  answer is reused for the same name on every step. */
const MAX_LABELS_TOTAL = 48;

/** Resolve the names the author wrote beside each species. Resolution needs the network, so
 *  it happens here in the worker; the subworker receives the pre-resolved SMILES and only
 *  compares canonical graphs. A name that resolves to nothing is left with an empty list and
 *  is reported as unchecked, never as a disagreement. */
async function resolveRouteLabels(
  raw: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null> | undefined,
  stepCount: number,
  cache: ReferenceCache,
  signal?: AbortSignal,
): Promise<RouteLabelInput[][]> {
  const out: RouteLabelInput[][] = Array.from({ length: stepCount }, () => []);
  if (!Array.isArray(raw)) return out;
  const deps = chemistryDependencies();
  let resolved = 0;
  for (let index = 0; index < Math.min(stepCount, raw.length); index += 1) {
    const list = Array.isArray(raw[index]) ? raw[index]! : [];
    for (const entry of list.slice(0, MAX_LABELS_PER_STEP)) {
      if (!entry || typeof entry !== 'object') continue;
      const role = entry.role === 'reactant' || entry.role === 'product' || entry.role === 'agent' ? entry.role : null;
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 200) : '';
      const smiles = typeof entry.smiles === 'string' ? entry.smiles.trim() : '';
      if (!role || !name || !smiles) continue;
      // A name the resolve pass already looked up is reused here: the reference is the same
      // network answer, and the label check only needs to compare canonical graphs.
      let nameSmiles = cache.get(name);
      if (nameSmiles === undefined) {
        nameSmiles = resolved < MAX_LABELS_TOTAL ? await resolveNameReferences(name, deps, signal) : [];
        resolved += 1;
        cache.set(name, nameSmiles);
      }
      out[index].push({ role, byproduct: entry.byproduct === true, name, smiles, nameSmiles });
    }
  }
  return out;
}

/** Verify a whole synthesis route without drawing it: every step parsed, every equation
 *  balanced, every intermediate leaving one step the same molecule as the one entering the
 *  next, and every supplied IUPAC name denoting the structure it was written beside. The
 *  result is a `route-audit` artifact the application renders deterministically. */
async function verifySynthesisRoute(input: { steps?: string[]; carriers?: Array<string | null>; racemic?: boolean | Array<boolean | null>; target?: string; labels?: Array<Array<{ role?: string; byproduct?: boolean; name?: string; smiles?: string } | null> | null> }, cache: ReferenceCache) {
  const steps = (Array.isArray(input?.steps) ? input.steps : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim())
    .slice(0, 16);
  if (!steps.length) throw new Error('Provide between one and sixteen reaction SMILES steps.');
  const carriers = Array.isArray(input?.carriers) ? input.carriers.slice(0, steps.length) : undefined;
  const racemic = typeof input?.racemic === 'boolean'
    ? input.racemic
    : Array.isArray(input?.racemic) ? input.racemic.slice(0, steps.length) : undefined;
  const target = typeof input?.target === 'string' && input.target.trim() ? input.target.trim().slice(0, 2000) : undefined;
  const labels = await resolveRouteLabels(input?.labels, steps.length, cache, host().signal);
  const audit = await chemistryDependencies().verifyRoute({ steps, carriers, racemic, target, ...(labels.some(step => step.length) ? { labels } : {}) }, host().signal);
  if (!audit) throw new Error('The route could not be verified.');
  const summary = audit.continuous
    ? `Route verified: ${audit.steps.length} step(s), every intermediate carried over unchanged`
    : `Route has ${audit.blocked.length} problem(s)`;
  return { artifacts: [{ artifactType: 'route-audit', artifactVersion: 1, summary, data: audit }], notices: [] };
}

export { isChemistrySvgRequest };
