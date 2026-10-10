// The route-program language, as data. Shared by the parser, the interpreter and the bridge so
// that none of them owns the shape, and so a fake interpreter in a test speaks the same language
// as the real one.
//
// Nothing here imports the host, RDKit or the filesystem. That is deliberate: the language and
// its execution are testable in milliseconds, and only the adapter that implements MoleculeOps
// pays for a chemistry toolkit.
//
// Why this exists at all: the names-first contract makes the model spell out every carried
// structure, so its output, the checking and the chance of a one-character error all grow with
// the square of the route's length (measured: DESIGN-ROUTE-STATE.md). Here the model writes
// references and operations, the toolkit holds the structures, and nothing grows but the number
// of lines.

/** A reference to a molecule the program has built: `M1`, `M2`, … Never a structure. */
export type MolRef = string;

export const MOL_REF = /^M([1-9][0-9]{0,2})$/;

/** A species the model names: a name to resolve, or a structure given directly. One or the other;
 *  a name is preferred, because a purchasable input's name is short and stays short. */
export interface SpeciesRef {
  name?: string;
  smiles?: string;
}

/** What a step does to the carried molecule.
 *
 *  Tried in this order (DESIGN-ROUTE-STATE.md): a template out of our own reaction index, which
 *  carries a precedent by construction; then a curated transformation for the routine operations
 *  the index records poorly; then free SMARTS, which the balancer still checks but which the
 *  report flags as having no precedent. */
export type Operation =
  | { kind: 'template'; id: string }
  | { kind: 'named'; id: string }
  | { kind: 'smarts'; smarts: string };

/** `M1 = start("<name>")` — the route's first molecule, a purchasable input. */
export interface StartLine {
  kind: 'start';
  /** 1-based line number in the program text, for diagnostics and for the fix prompt. */
  line: number;
  ref: MolRef;
  input: SpeciesRef;
}

/** `M2 = apply(M1, template=…, reagents=[…], site="…")` — one operation on a carried molecule. */
export interface ApplyLine {
  kind: 'apply';
  line: number;
  ref: MolRef;
  from: MolRef;
  op: Operation;
  reagents: SpeciesRef[];
  /** Which part of the carried molecule the operation acts on, as a phrase the application
   *  resolves ("the free amine"). Never an atom index: an index into a structure the model never
   *  sees is exactly the fragile coupling this design removes. An unresolvable or ambiguous site
   *  is an error on the line, not a guess. */
  site?: string;
  /** The step's prose, which stays per step as it is today. */
  note?: string;
}

/** `target = M7` — which molecule the route claims to have made. */
export interface TargetLine {
  kind: 'target';
  line: number;
  ref: MolRef;
}

export type ProgramLine = StartLine | ApplyLine | TargetLine;

export interface RouteProgram {
  lines: ProgramLine[];
  /** The ref named by the `target` line, when the program has one. */
  target?: MolRef;
}

export type DiagnosticCode =
  | 'syntax'
  | 'unknown-ref'
  | 'forward-ref'
  | 'duplicate-ref'
  | 'self-ref'
  | 'no-start'
  | 'no-target'
  | 'unknown-op'
  | 'bad-species'
  | 'bad-site'
  | 'too-many-lines';

/** A refusal the parser can state without any chemistry: it is about the shape of the program. */
export interface ProgramDiagnostic {
  line: number;
  code: DiagnosticCode;
  message: string;
}

export interface ParseResult {
  program: RouteProgram;
  diagnostics: ProgramDiagnostic[];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** A molecule as the interpreter carries it. `smiles` is canonical, and is what the bridge writes
 *  into an equation; `handle` is the toolkit's own identifier, so an adapter that keeps a parsed
 *  object alive between lines does not have to re-parse the structure every time. */
export interface Molecule {
  smiles: string;
  handle?: string;
  formula?: string;
}

export type OpErrorCode =
  | 'unresolved-name'
  | 'unknown-template'
  | 'no-match'
  | 'ambiguous-site'
  | 'absent-site'
  | 'unparsable'
  | 'unavailable'
  | 'budget';

export interface OpError {
  error: OpErrorCode;
  message: string;
}

export function isOpError(value: unknown): value is OpError {
  return typeof value === 'object' && value !== null && typeof (value as OpError).error === 'string';
}

/** What an operation produced: the carried molecule, plus whatever else the transformation makes.
 *  The co-products are carried so the bridge can write a balanced equation; the audit, not this
 *  layer, decides whether it balances. */
export interface OpOutcome {
  product: Molecule;
  coProducts: Molecule[];
  /** Reagent structures as the adapter resolved them, in the order the line gave them. */
  reagents: Molecule[];
  /** Where the operation came from, for the report: a template id, a curated id, or free SMARTS. */
  provenance: Operation;
}

/** One candidate the application offers when the model asks what applies here. The model cannot
 *  pick an id out of thousands, so it is offered a shortlist and picks from it. */
export interface TemplateOffer {
  id: string;
  /** How many recorded reactions back this template. */
  count: number;
  summary: string;
}

/** The chemistry the interpreter needs, and all of it. A test passes a deterministic fake; the
 *  adapter (routeProgramOps.ts) is the only implementation that reaches the toolkit. */
export interface MoleculeOps {
  /** Resolve a named or directly given species to a structure. */
  resolve(species: SpeciesRef): Promise<Molecule | OpError>;
  apply(molecule: Molecule, op: Operation, reagents: SpeciesRef[], site?: string): Promise<OpOutcome | OpError>;
  /** Which operations apply to this molecule with this reagent; for interactive mode later. */
  offer?(molecule: Molecule, reagent: SpeciesRef): Promise<TemplateOffer[]>;
  describe?(molecule: Molecule): Promise<{ formula: string; sites: string[]; summary: string }>;
}

/** What one line did. A line after the first failure is present but unexecuted, so a report can
 *  say "line 13 failed; lines 14-28 were not run" instead of listing them as failures of their
 *  own — the noise the names-first path produced (12 of 13 reported problems on chain-20). */
export interface TraceLine {
  line: number;
  ref: MolRef;
  from: MolRef | null;
  reactants: string[];
  reagents: string[];
  products: string[];
  /** The reaction SMILES this line amounts to, which is what the existing audit takes. */
  equation: string | null;
  provenance: Operation | null;
  note?: string;
  failure: OpError | null;
  executed: boolean;
  /** Names for the species on this line that the model actually NAMED: the purchasable inputs and
   *  the reagents, which stay short whatever the route's length. Keyed by the SMILES this line
   *  lists for them.
   *
   *  The carried molecule is deliberately absent. It has no name in this mode, which is the whole
   *  point: a name for a structure the model never sees is the thing that grew with the square of
   *  the route. So the audit name-checks the short species that still carry names and leaves the
   *  carried molecule to the toolkit that derived it. */
  names?: Record<string, string>;
}

export interface RouteProgramTrace {
  lines: TraceLine[];
  /** The line number of the first failure, or null when the whole program ran. */
  firstFailure: number | null;
  /** The molecule as it stood going into the failing line: what a fix round needs to be told. */
  stateBeforeFailure: Molecule | null;
  /** The structure the program ended on, when it ran to completion. */
  product: Molecule | null;
}
