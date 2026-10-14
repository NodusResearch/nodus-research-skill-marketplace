// The route-program interpreter. It walks a parsed program once, hands every piece of chemistry to
// the injected MoleculeOps, and records what each line did.
//
// It imports only the types module, so it runs in milliseconds against a fake. The toolkit is
// reached through the adapter alone.
//
// The one rule that matters: the first failure stops execution. Every later line is still in the
// trace, marked unexecuted, because those lines were never tried and so cannot be wrong. The names-
// first path reported each of them as a problem of its own (12 of 13 on one measured route), and a
// report built on this trace can instead say "line N failed; N+1..M were not run".
import {
  isOpError,
  type ApplyRequest,
  type ApplyLine,
  type Molecule,
  type MolRef,
  type MoleculeOps,
  type OpError,
  type ProgramLine,
  type RouteProgram,
  type RouteProgramTrace,
  type SpeciesRef,
  type StartLine,
  type TargetLine,
  type TraceLine,
} from './routeProgramTypes';

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Bounds a pathological program; lines past the cap are left unexecuted, not failed. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 256;

/** A line that was never tried. `failure` stays null so it is not mistaken for a problem. */
function skipped(line: ProgramLine): TraceLine {
  return {
    line: line.line,
    ref: line.ref,
    from: line.kind === 'apply' ? line.from : null,
    reactants: [],
    reagents: [],
    products: [],
    equation: null,
    provenance: null,
    ...(line.kind === 'apply' && line.note !== undefined ? { note: line.note } : {}),
    failure: null,
    executed: false,
  };
}

function failed(line: ProgramLine, failure: OpError, reactants: string[]): TraceLine {
  return { ...skipped(line), reactants, failure, executed: true };
}

// The audit name-checks only labels that carry a name, and the carried molecule has none by design.
// The inputs and reagents do, so their names travel with the structures they resolved to. Pairing
// is by index and only where both exist, so a short reagents array cannot shift a name onto the
// wrong species. The first name for a structure wins.
function nameMap(pairs: Array<[SpeciesRef | undefined, Molecule | undefined]>): { names?: Record<string, string> } {
  const names: Record<string, string> = {};
  for (const [ref, molecule] of pairs) {
    if (ref?.name && molecule && !(molecule.smiles in names)) names[molecule.smiles] = ref.name;
  }
  return Object.keys(names).length > 0 ? { names } : {};
}

// A reaction SMILES takes '.' between species on a side; an empty side is left empty.
const side = (species: string[]): string => species.join('.');

async function runStart(line: StartLine, ops: MoleculeOps, bound: Map<MolRef, Molecule>): Promise<TraceLine> {
  const result = await ops.resolve(line.input);
  if (isOpError(result)) return failed(line, result, []);
  bound.set(line.ref, result);
  return { ...skipped(line), products: [result.smiles], ...nameMap([[line.input, result]]), executed: true };
}

async function runApply(line: ApplyLine, ops: MoleculeOps, bound: Map<MolRef, Molecule>): Promise<{ trace: TraceLine; input: Molecule | null }> {
  const input = bound.get(line.from);
  if (!input) {
    // The parser rejects an unknown ref, so this means a caller built the program by hand.
    const missing: OpError = { error: 'unavailable', message: `${line.from} is not bound to a molecule at line ${line.line}` };
    return { trace: failed(line, missing, []), input: null };
  }
  // `assigns` is the ref this line binds: the adapter keys its site marks by it, and only the
  // interpreter knows it. Counting applies instead would be silently wrong for any program that
  // does not number its refs in order. The site list is today zero or one entry, passed untouched.
  const request: ApplyRequest = { molecule: input, op: line.op, reagents: line.reagents, assigns: line.ref };
  if (line.site) request.sites = [line.site];
  if (line.carry) request.carry = line.carry;
  const outcome = await ops.apply(request);
  if (isOpError(outcome)) return { trace: failed(line, outcome, [input.smiles]), input };
  bound.set(line.ref, outcome.product);
  const reactants = [input.smiles, ...(outcome.coReactants ?? []).map(m => m.smiles)];
  const reagents = (outcome.agents ?? outcome.reagents).map((m) => m.smiles);
  const products = [outcome.product.smiles, ...outcome.coProducts.map((m) => m.smiles)];
  return {
    trace: {
      ...skipped(line),
      reactants,
      reagents,
      products,
      equation: `${side(reactants)}>${side(reagents)}>${side(products)}`,
      provenance: outcome.provenance,
      ...nameMap(line.reagents.map((r, i): [SpeciesRef, Molecule | undefined] => [r, outcome.reagents[i]])),
      executed: true,
    },
    input,
  };
}

function runTarget(line: TargetLine, bound: Map<MolRef, Molecule>): TraceLine {
  const molecule = bound.get(line.ref);
  if (!molecule) {
    const missing: OpError = { error: 'unavailable', message: `target ${line.ref} is not bound to a molecule at line ${line.line}` };
    return failed(line, missing, []);
  }
  return { ...skipped(line), products: [molecule.smiles], executed: true };
}

export async function executeRouteProgram(
  program: RouteProgram,
  ops: MoleculeOps,
  options: ExecuteOptions = {},
): Promise<RouteProgramTrace> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const bound = new Map<MolRef, Molecule>();
  const lines: TraceLine[] = [];
  let firstFailure: number | null = null;
  let stateBeforeFailure: Molecule | null = null;
  let claimed: MolRef | undefined = program.target;

  for (let i = 0; i < program.lines.length; i++) {
    const line = program.lines[i];
    if (line.kind === 'target') claimed = line.ref;
    // Past the first failure or the cap, a line is recorded and nothing more. Abort is checked only
    // when a line would really run, so an abort never hides behind a program that already stopped.
    if (firstFailure !== null || i >= maxLines) {
      lines.push(skipped(line));
      continue;
    }
    options.signal?.throwIfAborted();

    let trace: TraceLine;
    let input: Molecule | null = null;
    if (line.kind === 'start') trace = await runStart(line, ops, bound);
    else if (line.kind === 'apply') ({ trace, input } = await runApply(line, ops, bound));
    else trace = runTarget(line, bound);

    lines.push(trace);
    if (trace.failure) {
      firstFailure = line.line;
      stateBeforeFailure = input;
    }
  }

  const ranToCompletion = firstFailure === null && lines.every((t) => t.executed);
  const product = ranToCompletion && claimed !== undefined ? (bound.get(claimed) ?? null) : null;
  return { lines, firstFailure, stateBeforeFailure, product };
}
