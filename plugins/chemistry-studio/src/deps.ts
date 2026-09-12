import type { ChemistryValidationRequest, ChemistryValidationResult } from './engine/chemistryDocument';
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
  void init;
  const response = await host().network.fetch(endpoint.id, { path: `${url.pathname}${url.search}`, method: 'GET' });
  const bytes = Buffer.from(response.body);
  // The engine reads the body as a stream and bounds it as it goes, which is how a
  // hostile reference is stopped before it is held in memory. The adapter has to present
  // the same shape, not a convenience that quietly skips that.
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
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

export const chemistryDependencies = () => ({ fetch: routedFetch, validate });
