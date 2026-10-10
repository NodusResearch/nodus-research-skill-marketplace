// The bridge from an executed route program to the input the existing route checker takes.
//
// The program path must not reimplement balance, continuity, stereo or label checking. It runs the
// program into a trace, and this module reshapes that trace into a RouteAuditInput, so the old
// audit, the old report and the old drawings keep working unchanged.
//
// Pure: it imports types only. No host, no RDKit, no filesystem.

import type { RouteAuditInput, RouteLabelInput } from './chemistryRouteAudit';
import type { RouteProgramTrace, TraceLine } from './routeProgramTypes';

/** A label as this module writes it. `name` is optional here though the audit declares it
 *  required: the carried molecule is derived by the toolkit, not written by the model, so it has
 *  none, and inventing one would be checked against the structure and refused. The cast at the
 *  return is needed only for those nameless labels; the audit does no name comparison for them. */
type BridgeLabel = Omit<RouteLabelInput, 'name'> & { name?: string };

/** Only an apply line is a step. A start line has no source molecule and contributes no
 *  transformation; target lines never reach the trace. */
function isStep(line: TraceLine): boolean {
  return line.from !== null;
}

/** How many audit steps the trace amounts to, counting lines that did not run: the audit reads
 *  an empty entry as "step N was not written", which is the true account of a skipped line. */
export function programStepCount(trace: RouteProgramTrace): number {
  return trace.lines.filter(isStep).length;
}

function labelsFor(line: TraceLine): BridgeLabel[] {
  // Order mirrors the equation (reactants, reagents, products): the audit matches a label to a
  // species by canonical SMILES and falls back to the raw input string, so the two must agree.
  // The first product is the carried molecule; any further product is a co-product, flagged
  // whether or not it is named because the audit's stereo logic reads an unflagged organic
  // co-product as a main product.
  const named = (role: BridgeLabel['role'], smiles: string, extra: Partial<BridgeLabel> = {}): BridgeLabel => {
    const name = line.names?.[smiles];
    return { role, ...extra, smiles, ...(name ? { name } : {}) };
  };
  return [
    ...line.reactants.map(smiles => named('reactant', smiles)),
    ...line.reagents.map(smiles => named('agent', smiles)),
    ...line.products.map((smiles, index) => named('product', smiles, index === 0 ? {} : { byproduct: true })),
  ];
}

export function routeProgramToAuditInput(trace: RouteProgramTrace, options: { target?: string | null } = {}): RouteAuditInput {
  // Every array below is indexed by step. A line that did not run keeps its slot, empty, because
  // dropping it would shift every later label and carrier onto the wrong step.
  const steps: string[] = [];
  const carriers: Array<string | null> = [];
  const labels: Array<RouteLabelInput[]> = [];
  for (const line of trace.lines) {
    if (!isStep(line)) continue;
    const ran = line.executed && !line.failure && typeof line.equation === 'string' && line.equation.length > 0;
    steps.push(ran ? line.equation! : '');
    carriers.push(ran ? (line.reactants[0] ?? null) : null);
    labels.push(ran ? (labelsFor(line) as RouteLabelInput[]) : []);
  }
  const target = options.target ?? (trace.firstFailure === null ? trace.product?.smiles : undefined) ?? undefined;
  // racemic, rearrangement, radical and stereoChoices are deliberately absent: they are
  // declarations the author makes from the prose, and nothing in an executed trace says them.
  return { steps, carriers, labels, ...(target ? { target } : {}) };
}
