// The adapter that gives the route-program interpreter its chemistry. It is the only host-aware
// module in this feature: the parser, the interpreter and the bridge import types and nothing
// else. Everything here is marshalling. A request goes to the shared Python runtime, a reply comes
// back, and it is mapped onto the types the interpreter already speaks. No chemistry is decided in
// this file, so a wrong answer is always the toolkit's and never this layer's.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { host, type CapabilityHost } from './host';
import { chemistryDependencies } from '../deps';
import type { ChemistryInspectionResult } from './chemistryDocument';
import type { Molecule, MoleculeOps, OpError, OpErrorCode, OpOutcome, Operation, SpeciesRef, TemplateOffer } from './routeProgramTypes';

const REACTIONS_RUNTIME_ID = 'chemistry';
const REACTIONS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'reactions_worker.py');

/** One operation is one SMARTS or template application on one molecule, which the toolkit does in
 *  well under a second; the Python side stops itself at `APPLY_BUDGET_SECONDS`. The host limit sits
 *  at the low end of the existing call sites (60 s, as the stock check) rather than their 240 s: a
 *  step that has not answered by then is not going to, and a route program makes one such call per
 *  line, so a long limit would multiply across the program. The margin over the budget covers
 *  interpreter start-up on the first call. */
const OP_TIMEOUT_MS = 60_000;
const APPLY_BUDGET_SECONDS = 20;

/** Stage 0 measured screening the template index at about 45 s per step above roughly 100 heavy
 *  atoms, and it returned nothing useful there. Offering is for the interactive mode, which has a
 *  person waiting, so the size gate sits at the measured edge instead of paying for a guaranteed
 *  miss. */
export const OFFER_MAX_HEAVY_ATOMS = 100;

const ERROR_CODES: ReadonlySet<string> = new Set<OpErrorCode>([
  'unresolved-name', 'unknown-template', 'no-match', 'ambiguous-site', 'absent-site', 'unparsable', 'unavailable', 'budget',
]);

export interface MoleculeOpsOptions {
  /** Where the reaction index lives; a `template` operation cannot run without it. */
  indexDir?: string;
  /** Cancels every call. Defaults to the host's own signal. */
  signal?: AbortSignal;
  /** The Python runtime. Defaults to the bound host, so a test can pass a fake without binding one. */
  python?: CapabilityHost['python'];
  /** Canonicalises SMILES in the killable subworker. Defaults to the engine's own `inspectBatch`. */
  inspect?: (smiles: string[], signal?: AbortSignal, options?: { canonicalOnly?: boolean }) => Promise<ChemistryInspectionResult[]>;
  /** Turns a name into a structure. Not wired by default; see `resolve`. */
  resolveName?: (name: string, signal?: AbortSignal) => Promise<Molecule | OpError>;
}

const unavailable = (message: string): OpError => ({ error: 'unavailable', message });

/** A cancellation is the only thing that may throw out of this module; everything else a call can
 *  go wrong with is a chemistry or availability outcome the interpreter reports against a line. */
function rethrowIfAborted(signal: AbortSignal | undefined, error?: unknown): void {
  if (signal?.aborted) throw signal.reason ?? error ?? new Error('The operation was aborted.');
  if (error instanceof Error && error.name === 'AbortError') throw error;
}

type Reply = { ok: true; body: Record<string, unknown> } | { ok: false; error: OpError };

async function call(options: MoleculeOpsOptions, request: Record<string, unknown>): Promise<Reply> {
  const signal = options.signal ?? safeHostSignal();
  rethrowIfAborted(signal);
  let stdout: string;
  try {
    const python = options.python ?? host().python;
    const ready = await python.ensureRuntime(REACTIONS_RUNTIME_ID);
    rethrowIfAborted(signal);
    if (!ready.ready) return { ok: false, error: unavailable(ready.detail ?? 'The chemistry runtime could not be installed.') };
    const run = await python.run({
      runtimeId: REACTIONS_RUNTIME_ID,
      args: ['-I', REACTIONS_SCRIPT], persistent: true,
      stdin: JSON.stringify({ routeProgram: request }),
      timeoutMs: OP_TIMEOUT_MS,
    });
    rethrowIfAborted(signal);
    if (run.code !== 0) {
      const last = run.stderr.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300);
      return { ok: false, error: unavailable(`The chemistry runtime failed (exit ${run.code}${last ? `: ${last}` : ''}).`) };
    }
    stdout = run.stdout;
  } catch (error) {
    rethrowIfAborted(signal, error);
    return { ok: false, error: unavailable(`The chemistry runtime did not answer: ${error instanceof Error ? error.message : String(error)}`) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { ok: false, error: unavailable('The chemistry runtime returned a reply that is not JSON.') }; }
  const body = (parsed as { routeProgram?: unknown } | null)?.routeProgram;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: unavailable('The chemistry runtime returned a reply without a routeProgram result.') };
  const reply = body as Record<string, unknown>;
  if (reply.ok === true) return { ok: true, body: reply };
  if (reply.ok === false) {
    if (typeof reply.error === 'string' && ERROR_CODES.has(reply.error) && typeof reply.message === 'string') {
      return { ok: false, error: { error: reply.error as OpErrorCode, message: reply.message } };
    }
    return { ok: false, error: unavailable(`The chemistry runtime reported an error this layer does not know: ${String(reply.error).slice(0, 80)}.`) };
  }
  return { ok: false, error: unavailable('The chemistry runtime returned a reply that says neither ok nor failed.') };
}

/** The host may not be bound (a unit test, a caller outside a worker); a missing signal then just
 *  means nothing can cancel, and the injected `python` is what the call uses. */
function safeHostSignal(): AbortSignal | undefined {
  try { return host().signal; } catch { return undefined; }
}

function asMolecule(smiles: unknown, formula?: unknown): Molecule | null {
  if (typeof smiles !== 'string' || !smiles) return null;
  return typeof formula === 'string' && formula ? { smiles, formula } : { smiles };
}

/** Crude on purpose: the gate only needs to know "much larger than 100", and parsing the structure
 *  to count atoms exactly would be chemistry this layer does not do. Counts bracket atoms and
 *  organic-subset symbols, aromatic ones included. */
function approximateHeavyAtoms(smiles: string): number {
  return smiles.match(/\[[^\]]+\]|Cl|Br|[BCNOSPFI]|[cnosp]/g)?.length ?? 0;
}

export function createMoleculeOps(options: MoleculeOpsOptions = {}): MoleculeOps {
  const signalOf = () => options.signal ?? safeHostSignal();

  async function resolve(species: SpeciesRef): Promise<Molecule | OpError> {
    const signal = signalOf();
    rethrowIfAborted(signal);
    if (species.smiles) {
      let checked: ChemistryInspectionResult[];
      try {
        checked = await (options.inspect ?? chemistryDependencies().inspectBatch)([species.smiles], signal, { canonicalOnly: true });
      } catch (error) {
        rethrowIfAborted(signal, error);
        return unavailable(`The structure could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      rethrowIfAborted(signal);
      const entry = checked[0];
      if (!entry) return unavailable('The structure check returned nothing.');
      const canonical = entry.ok ? entry.graph?.canonicalSmiles : undefined;
      if (!canonical) return { error: 'unparsable', message: `"${species.smiles.slice(0, 120)}" is not a structure the toolkit can read${entry.error ? ` (${entry.error})` : ''}.` };
      return { smiles: canonical };
    }
    if (species.name) {
      if (options.resolveName) return options.resolveName(species.name, signal);
      // Name resolution is real and lives in worker.ts (`resolveSpeciesName`, then
      // `canonicalizeResolutions`). It is not reachable from here: it is built inside
      // `createWorker`, over per-conversation caches and reference dependencies assembled from the
      // request's own directories (`referenceDependencies`), none of which is exported. Reaching it
      // would mean restructuring the worker, so it is injected through `resolveName` once the
      // first consumer needs names. That consumer supplies structures, so nothing waits on this.
      return { error: 'unresolved-name', message: `The name "${species.name.slice(0, 120)}" could not be resolved to a structure here; give the structure directly.` };
    }
    return { error: 'unresolved-name', message: 'A species needs a name or a structure.' };
  }

  async function apply(molecule: Molecule, op: Operation, reagents: SpeciesRef[], site?: string): Promise<OpOutcome | OpError> {
    // Resolved one after another and before the Python call: a reagent that fails stops the line
    // with its own error, and the order the line gave them is the order the interpreter pairs
    // names to structures by.
    const resolved: Molecule[] = [];
    for (const reagent of reagents) {
      const result = await resolve(reagent);
      if ('error' in result) return result;
      resolved.push(result);
    }
    let operation: Record<string, unknown>;
    if (op.kind === 'named') operation = { kind: 'named', id: op.id };
    else if (op.kind === 'smarts') operation = { kind: 'smarts', smarts: op.smarts };
    else {
      if (!options.indexDir) return unavailable('A template operation needs the reaction index directory, and none was supplied.');
      operation = { kind: 'template', id: op.id, indexDir: options.indexDir };
    }
    const reply = await call(options, {
      op: 'apply', molecule: molecule.smiles, operation,
      reagents: resolved.map(entry => entry.smiles),
      ...(site ? { site } : {}),
      budgetSeconds: APPLY_BUDGET_SECONDS,
    });
    if (!reply.ok) return reply.error;
    const product = asMolecule(reply.body.product, reply.body.formula);
    if (!product) return unavailable('The chemistry runtime reported success without a product.');
    const rawCo = reply.body.coProducts;
    if (rawCo !== undefined && !Array.isArray(rawCo)) return unavailable('The chemistry runtime returned co-products in an unexpected shape.');
    const coProducts: Molecule[] = [];
    for (const entry of rawCo ?? []) {
      const parsed = asMolecule(entry);
      if (!parsed) return unavailable('The chemistry runtime returned a co-product that is not a structure.');
      coProducts.push(parsed);
    }
    return { product, coProducts, reagents: resolved, provenance: op };
  }

  async function offer(molecule: Molecule, _reagent: SpeciesRef): Promise<TemplateOffer[]> {
    rethrowIfAborted(signalOf());
    if (approximateHeavyAtoms(molecule.smiles) > OFFER_MAX_HEAVY_ATOMS) return [];
    // Below the gate the real fill is a bounded template screen against the index for this
    // molecule and reagent, ranked by recorded count. The Python side has no such op in the wire
    // contract yet, and a speculative scan is exactly the cost the gate exists to avoid, so it
    // stays empty until that op exists.
    return [];
  }

  async function describe(molecule: Molecule): Promise<{ formula: string; sites: string[]; summary: string }> {
    const reply = await call(options, { op: 'describe', molecule: molecule.smiles });
    const body = reply.ok ? reply.body : null;
    // `describe` has no error channel in its signature, and a description is advisory, so a
    // failure reads as an empty one that says why instead of throwing into the interpreter.
    if (!body) return { formula: molecule.formula ?? '', sites: [], summary: (reply as { error: OpError }).error.message };
    const sites = Array.isArray(body.sites) ? body.sites.filter((entry): entry is string => typeof entry === 'string') : [];
    return {
      formula: typeof body.formula === 'string' ? body.formula : molecule.formula ?? '',
      sites,
      summary: typeof body.summary === 'string' ? body.summary : '',
    };
  }

  return { resolve, apply, offer, describe };
}

/** The curated transform ids, asked of the toolkit so no caller keeps its own list that drifts. */
export async function listTransforms(options: MoleculeOpsOptions = {}): Promise<string[] | OpError> {
  const reply = await call(options, { op: 'transforms' });
  if (!reply.ok) return reply.error;
  const raw = reply.body.transforms;
  if (!Array.isArray(raw)) return unavailable('The chemistry runtime returned its transforms in an unexpected shape.');
  const ids = raw.map(entry => typeof entry === 'string' ? entry : (entry as { id?: unknown } | null)?.id);
  if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) return unavailable('The chemistry runtime returned a transform without an id.');
  return ids;
}
