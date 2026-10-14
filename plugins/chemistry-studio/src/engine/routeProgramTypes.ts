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

/** Where an operation acts.
 *
 *  A phrase is enough for a small molecule, and useless for a growing one: a phrase cannot pick
 *  one of several identical groups, and a molecule that has been through many steps carries many
 *  copies of the same group. Measured by building it -- a structure with three of one group
 *  returns `ambiguous-site` for all three, which is the shape a long route is made of.
 *
 *  So a line may instead point at the place an earlier line acted. The toolkit already follows
 *  which product atoms came from which reactant, so it can mark the atoms an operation created or
 *  exposed and find them again later. A route that grows at one end then says "where the last
 *  line acted" rather than naming a group that now appears everywhere. */
export type SiteRef =
  | { kind: 'phrase'; phrase: string }
  /** `last` is the line before this one; a MolRef is the line that produced that molecule. */
  | { kind: 'handle'; ref: MolRef | 'last' };

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
  /** Which part of the carried molecule the operation acts on. Never an atom index: an index into
   *  a structure the model never sees is exactly the fragile coupling this design removes. An
   *  unresolvable or ambiguous site is an error on the line, not a guess. */
  site?: SiteRef;
  /** Which fragment continues the route when the step cuts the molecule in two.
   *
   *  Only the line knows. Both sides of an ester hydrolysis are made of the atoms that went in, so
   *  the toolkit cannot read the answer off the chemistry, and sizes get it backwards: Boc leaves
   *  isobutylene at 4 heavy atoms while Fmoc leaves dibenzofulvene at 14 and Cbz leaves toluene at
   *  7, against alanine's 6. A curated deprotection declares its own answer and needs nothing here;
   *  everything else says `carry="largest"` or names the fragment as a structure. */
  carry?: { kind: 'largest' | 'smallest' } | { kind: 'smiles'; smiles: string };
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
  /** Canonical, and clean: no site marks. This is what the bridge writes into an equation, so it
   *  must stay the structure and nothing else. */
  smiles: string;
  /** The toolkit's own form of the same molecule, carrying whatever marks it needs to find a site
   *  again on a later line. OPAQUE: no layer above the adapter reads or edits it, and it is passed
   *  back unchanged on the next operation. Absent when the toolkit needs no such form. */
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
  /** Molecules actually consumed by reaction slots, including toolkit-declared defaults. */
  coReactants?: Molecule[];
  /** Supplied conditions not consumed by those slots. Absent on older adapters. */
  agents?: Molecule[];
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
  apply(request: ApplyRequest): Promise<OpOutcome | OpError>;
  /** Which operations apply to this molecule with this reagent; for interactive mode later. */
  offer?(molecule: Molecule, reagent: SpeciesRef): Promise<TemplateOffer[]>;
  describe?(molecule: Molecule): Promise<{ formula: string; sites: string[]; summary: string }>;
}

/** One operation, as the interpreter hands it to the toolkit.
 *
 *  An options object rather than positional arguments for two reasons that both came from
 *  building it. `assigns` is needed because the toolkit records a site mark per line and has to
 *  file it under the ref the line actually binds -- an adapter that instead counted operations
 *  and assumed the Nth produced `M(N+1)` would hand back the wrong mark for any program that
 *  numbers its refs differently, which is silent and wrong rather than loud and wrong.
 *
 *  And `sites` is a LIST because an intramolecular operation -- a ring closure -- joins two
 *  places on one molecule, so it needs two sites in one call. A toolkit that does not yet support
 *  more than one says so plainly; it is not the caller's job to guess the limit. */
export interface ApplyRequest {
  molecule: Molecule;
  op: Operation;
  reagents: SpeciesRef[];
  /** Empty or absent when the operation applies in only one place anyway. */
  sites?: SiteRef[];
  /** Which fragment continues the route, when the operation splits the molecule. Absent for the
   *  ordinary case and for a curated deprotection, which declares its own. */
  carry?: ApplyLine['carry'];
  /** The ref this line binds, so a mark made here can be found again by that name. */
  assigns?: MolRef;
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
