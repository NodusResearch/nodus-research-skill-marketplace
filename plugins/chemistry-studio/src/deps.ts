import type { ChemistryInspectionResult, ChemistryValidationRequest, ChemistryValidationResult, RouteAudit } from './engine/chemistryDocument';
import type { RouteAuditInput } from './engine/chemistryRouteAudit';
import type { ChemistryCapBudget } from './engine/chemistryLimits';
import { host } from './engine/host';

/** What the chemistry engine is allowed to reach, expressed as the injection point the
 *  engine already had. The built-in handed it the process's own `fetch` and a utility
 *  process; a package is handed a proxy that answers only for what its manifest declared. */

const ENDPOINTS: Array<{ id: string; origin: string }> = [
  { id: 'opsin', origin: 'https://www.ebi.ac.uk' },
  { id: 'pubchem', origin: 'https://pubchem.ncbi.nlm.nih.gov' },
];

/** Maps an absolute URL the engine built onto the endpoint that permits it. A URL with no
 *  declared endpoint is refused here rather than reaching the host and being refused
 *  there, so the engine sees the same failure it always did: the reference is unavailable. */
const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const endpoint = ENDPOINTS.find(candidate => new URL(candidate.origin).origin === url.origin);
  if (!endpoint) throw new Error(`Chemistry Studio does not declare access to ${url.origin}.`);
  // The host's fetch takes no signal, so the request's own is raced against it. Dropped, as it
  // was, neither readJSON's 10 s timeout nor the turn's abort could end a look-up: with replies
  // taking 14 s a name resolved after 29 s, and an abort was answered only when the reply came.
  const signal = init?.signal ?? undefined;
  signal?.throwIfAborted();
  const pending = host().network.fetch(endpoint.id, { path: `${url.pathname}${url.search}`, method: 'GET' });
  const response = !signal ? await pending : await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Chemical reference request aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
  const bytes = Buffer.from(response.body);
  // The engine reads the body as a stream and bounds it as it goes, which is how a
  // hostile reference is stopped before it is held in memory. The adapter has to present
  // the same shape, not a convenience that quietly skips that.
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    // The host forwards the response headers; PubChem's X-Throttling-Control travels in them.
    headers: new Headers(Object.entries((response as { headers?: Record<string, unknown> }).headers ?? {})
      .filter(([, value]) => typeof value === 'string') as Array<[string, string]>),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.length) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    async json() { return JSON.parse(bytes.toString('utf8')); },
    async text() { return bytes.toString('utf8'); },
  } as unknown as Response;
}) as typeof fetch;

/** Structure validation runs in a subworker the host can kill.
 *
 *  RDKit and OpenChemLib are large, load WebAssembly and can take a pathological molecule
 *  a long way; keeping them out of the capability's own process means a stuck validation
 *  costs one drawing rather than the package. */
const validate = async (request: ChemistryValidationRequest, signal?: AbortSignal): Promise<ChemistryValidationResult> => {
  signal?.throwIfAborted();
  // Multi-panel rules compile each audited panel and the combined export, so the budget
  // is the one the built-in measured rather than the single-diagram default.
  const timeoutMs = request.reaction || request.mechanism && ['e2', 'aldol', 'diels-alder'].includes(request.mechanism.rule) ? 30_000 : 15_000;
  const result = await host().subworker.run({ entry: 'validator.js', input: request, timeoutMs });
  return result as ChemistryValidationResult;
};

/** Read-only batch inspection. One subworker load parses every SMILES, and a species that
 *  cannot be parsed comes back as an error entry instead of failing the whole batch. A caller that
 *  needs only the canonical SMILES says so, and the batch skips the layouts and the drawing. */
const inspectBatch = async (smiles: string[], signal?: AbortSignal, options: { canonicalOnly?: boolean } = {}): Promise<ChemistryInspectionResult[]> => {
  signal?.throwIfAborted();
  const result = await host().subworker.run({ entry: 'validator.js', input: { batch: smiles, ...(options.canonicalOnly ? { canonicalOnly: true } : {}) }, timeoutMs: 120_000 });
  return (result as { results?: ChemistryInspectionResult[] })?.results ?? [];
};

/** Read-only route checking. Same killable subworker, same RDKit: every step is parsed and
 *  every equation and intermediate link is checked before a route is drawn. */
const verifyRoute = async (route: RouteAuditInput, signal?: AbortSignal, budget?: ChemistryCapBudget): Promise<RouteAudit | null> => {
  signal?.throwIfAborted();
  // The budget rides with the route: the audit's step and species ceilings are sized from the
  // turn's context window, and the subworker is a separate process that knows nothing else of it.
  const result = await host().subworker.run({ entry: 'validator.js', input: { route, ...(budget ? { budget } : {}) }, timeoutMs: 180_000 });
  return (result as RouteAudit | null) ?? null;
};

export const chemistryDependencies = () => ({ fetch: routedFetch, validate, inspectBatch, verifyRoute });
