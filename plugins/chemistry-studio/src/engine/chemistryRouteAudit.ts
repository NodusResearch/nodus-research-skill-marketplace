import type { RouteAudit, RouteLinkAudit, RouteSpeciesSummary, RouteStepAudit, RouteTargetAudit } from './chemistryDocument';
import { balanceReaction } from './chemistryReaction';
import { splitReactionSmiles } from './chemistryReactionShared';
import { validateChemicalReferences } from './chemistryValidationCore';

/** The read-only route checker. It never draws: it parses each step with RDKit and answers
 *  two questions the model cannot be trusted to answer about its own plan — is every
 *  equation balanced, and is the intermediate leaving one step the same molecule as the
 *  one entering the next. Identity is RDKit's canonical isomeric SMILES, so it is a string
 *  comparison, not a judgement about whether two drawings look alike. */

const MAX_STEPS = 16;
const MAX_SPECIES_PER_STEP = 12;
const MAX_SPECIES_TOTAL = 160;
const MAX_REACTION_CHARS = 4000;

async function summarize(input: string): Promise<RouteSpeciesSummary> {
  try {
    const checked = await validateChemicalReferences({ references: [input], inspect: true });
    if (!checked.inspection) throw new Error('RDKit produced no inspection summary.');
    return { input, ...checked.inspection };
  } catch (error) {
    // Name the species: "Step 2: RDKit rejected the molecular graph" leaves the author
    // guessing which of up to twelve strings was wrong.
    const detail = error instanceof Error ? error.message : 'Chemical validation failed.';
    throw new Error(`"${input}" — ${detail}`);
  }
}

/** Small species a route routinely makes in one step and uses in another without them being
 *  the route's intermediate: CO2, CO, and the C1/C2 alcohols, alkoxides, acetic acid and
 *  acetate. Canonical isomeric SMILES, as RDKit writes them. */
const COMMODITY_CARBON = new Set(['O=C=O', '[C-]#[O+]', 'CO', 'CCO', 'C[O-]', 'CC[O-]', 'CC(=O)O', 'CC(=O)[O-]']);

/** Whether a species can carry the route from one step to another. Water, hydrogen halides,
 *  ammonia and the ions of a salt appear on both sides of many steps; linking steps through
 *  them made a route with a missing step look connected ("carried H2O", "carried Na"). A
 *  carrier therefore contains carbon and is not a commodity solvent or byproduct. */
const canCarry = (species: RouteSpeciesSummary): boolean =>
  Object.keys(species.composition).some(key => key.startsWith('6:')) && !COMMODITY_CARBON.has(species.canonicalSmiles);

const splitField = (field: string): string[] => field.split('.').map(entry => entry.trim()).filter(Boolean);

async function summarizeField(field: string): Promise<RouteSpeciesSummary[]> {
  const out: RouteSpeciesSummary[] = [];
  for (const smiles of splitField(field)) out.push(await summarize(smiles));
  return out;
}

/** Sum a side's composition and charge. Agents are never passed here: a catalyst is
 *  recovered and a solvent is not consumed, so neither belongs in a balance. */
function sumSide(species: RouteSpeciesSummary[]): { composition: Record<string, number>; charge: number } {
  const composition: Record<string, number> = {};
  let charge = 0;
  for (const entry of species) {
    for (const [key, count] of Object.entries(entry.composition)) composition[key] = (composition[key] ?? 0) + count;
    charge += entry.charge;
  }
  return { composition, charge };
}

/** Whether the declared species admit a balanced equation, solved exactly as the drawing
 *  path solves it. Coefficients cannot be written inside a reaction SMILES, so a species
 *  list that balances only at 2:3:2:2 is balanced, not refused. Agents take no part. */
function stepBalance(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): { balanced: boolean; chargeBalanced: boolean; differences: string[] } {
  const chargeBalanced = sumSide(reactants).charge === sumSide(products).charge;
  const ordered = [...reactants, ...agents, ...products];
  const roles = [
    ...reactants.map(() => 'reactant' as const),
    ...agents.map(() => 'agent' as const),
    ...products.map(() => 'product' as const),
  ];
  const compositions = ordered.map(entry => ({ atoms: entry.composition, charge: entry.charge }));
  try {
    balanceReaction(compositions, roles, ordered.map(() => 1));
    return { balanced: true, chargeBalanced, differences: [] };
  } catch (error) {
    return { balanced: false, chargeBalanced, differences: [error instanceof Error ? error.message : 'The species cannot be balanced.'] };
  }
}

export interface RouteAuditInput {
  steps: string[];
  carriers?: Array<string | null | undefined>;
  /** A declared racemate, per step or for the whole route: open stereocentres on those steps
   *  are reported, not refused. */
  racemic?: boolean | Array<boolean | null | undefined>;
  /** The requested target as SMILES. When given, the route must form it. */
  target?: string | null;
}

export async function auditRoute(input: RouteAuditInput): Promise<RouteAudit> {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new Error(`A route needs between one and ${MAX_STEPS} steps.`);
  const carriers = Array.isArray(input?.carriers) ? input.carriers : [];
  const racemicInput = input?.racemic;
  const declaredRacemic = (index: number): boolean => Array.isArray(racemicInput)
    ? Boolean(racemicInput[index])
    : racemicInput === true;
  const audited: RouteStepAudit[] = [];
  let totalSpecies = 0;

  for (const [index, raw] of steps.entries()) {
    const reaction = typeof raw === 'string' ? raw.trim() : '';
    const step: RouteStepAudit = {
      index, reaction, ok: false, reactants: [], agents: [], products: [],
      balanced: null, chargeBalanced: null, differences: [], unspecifiedStereocentres: 0,
    };
    try {
      if (!reaction || reaction.length > MAX_REACTION_CHARS) throw new Error(`A step must be a reaction SMILES under ${MAX_REACTION_CHARS} characters.`);
      const { reactants: reactantField, agents: agentField, products: productField } = splitReactionSmiles(reaction);
      const reactants = await summarizeField(reactantField);
      const agents = await summarizeField(agentField);
      const products = await summarizeField(productField);
      if (!reactants.length || !products.length) throw new Error('A step needs at least one reactant and one product.');
      const count = reactants.length + agents.length + products.length;
      if (count > MAX_SPECIES_PER_STEP) throw new Error(`A step may name at most ${MAX_SPECIES_PER_STEP} species.`);
      totalSpecies += count;
      if (totalSpecies > MAX_SPECIES_TOTAL) throw new Error(`A route may name at most ${MAX_SPECIES_TOTAL} species.`);
      const balance = stepBalance(reactants, agents, products);
      step.reactants = reactants;
      step.agents = agents;
      step.products = products;
      step.balanced = balance.balanced;
      step.chargeBalanced = balance.chargeBalanced;
      step.differences = balance.differences;
      step.unspecifiedStereocentres = [...reactants, ...agents, ...products].reduce((sum, entry) => sum + entry.unspecifiedStereocentres, 0);
      if (step.unspecifiedStereocentres > 0 && declaredRacemic(index)) step.racemic = true;
      step.ok = true;
    } catch (error) {
      step.error = error instanceof Error ? error.message : 'The step could not be parsed.';
    }
    audited.push(step);
  }

  // Provenance over the whole route rather than from step to step: a route may branch and
  // converge, so an intermediate can be consumed several steps after it is made. What must
  // hold is that it was made before it is consumed, and that no step floats free of the rest.
  const producers = new Map<string, number[]>();
  for (const step of audited) {
    if (!step.ok) continue;
    // A step that makes only inorganic species is preparing a reagent (NaNH2 from Na and
    // NH3, say), so what it makes does carry the route to the step that uses it.
    const preparesReagent = !step.products.some(canCarry);
    for (const product of step.products) {
      if (!preparesReagent && !canCarry(product)) continue;
      const list = producers.get(product.canonicalSmiles) ?? [];
      if (!list.includes(step.index)) list.push(step.index);
      producers.set(product.canonicalSmiles, list);
    }
  }

  const linkByKey = new Map<string, RouteLinkAudit>();
  const link = (from: number, to: number, reason: RouteLinkAudit['reason']): RouteLinkAudit => {
    const key = `${from}:${to}:${reason}`;
    let entry = linkByKey.get(key);
    if (!entry) { entry = { from, to, ok: reason === 'carried', reason, carried: [], skeletonOnly: [] }; linkByKey.set(key, entry); }
    return entry;
  };
  const addEdge = (map: Map<number, Set<number>>, key: number, value: number) => {
    const set = map.get(key) ?? new Set<number>();
    set.add(value);
    map.set(key, set);
  };
  const incoming = new Map<number, Set<number>>();
  const outgoing = new Map<number, Set<number>>();

  for (const step of audited) {
    if (!step.ok) continue;
    for (const reactant of step.reactants) {
      const producerSteps = producers.get(reactant.canonicalSmiles) ?? [];
      const earlier = producerSteps.filter(index => index < step.index);
      if (earlier.length) {
        const from = Math.max(...earlier);
        const entry = link(from, step.index, 'carried');
        if (!entry.carried.some(item => item.canonicalSmiles === reactant.canonicalSmiles)) {
          entry.carried.push({ canonicalSmiles: reactant.canonicalSmiles, formula: reactant.formula, heavyAtoms: reactant.heavyAtoms });
        }
        addEdge(incoming, step.index, from);
        addEdge(outgoing, from, step.index);
      } else {
        // Not produced by an earlier step: a starting material or reagent (possibly one the
        // route also regenerates later). A skeleton match against an earlier product still
        // means the wrong stereoisomer was carried forward.
        if (!canCarry(reactant)) continue;
        for (const producer of audited) {
          if (!producer.ok || producer.index >= step.index) continue;
          const match = producer.products.find(product => product.skeletonSmiles === reactant.skeletonSmiles && product.canonicalSmiles !== reactant.canonicalSmiles);
          if (!match) continue;
          const entry = link(producer.index, step.index, 'constitution-only');
          entry.skeletonOnly.push({ product: match.canonicalSmiles, reactant: reactant.canonicalSmiles, skeletonSmiles: reactant.skeletonSmiles });
          addEdge(incoming, step.index, producer.index);
          addEdge(outgoing, producer.index, step.index);
          break;
        }
      }
    }
  }

  // A declared carrier is checked by identity: it must be a reactant of this step and have
  // been produced by an earlier one.
  for (const step of audited) {
    if (!step.ok) continue;
    const declared = typeof carriers[step.index] === 'string' && carriers[step.index] ? carriers[step.index]!.trim() : '';
    if (!declared) continue;
    let canonical: string | null = null;
    try { canonical = (await summarize(declared)).canonicalSmiles; } catch { canonical = null; }
    const inReactant = canonical ? step.reactants.some(entry => entry.canonicalSmiles === canonical) : false;
    const earlier = canonical ? (producers.get(canonical) ?? []).filter(index => index < step.index) : [];
    const entry = [...linkByKey.values()].find(item => item.to === step.index && item.from < step.index)
      ?? link(step.index, step.index, 'carried');
    entry.declaredCarrier = { input: declared, canonicalSmiles: canonical, inProduct: earlier.length > 0, inReactant };
    if (!(inReactant && earlier.length)) { entry.ok = false; entry.reason = 'declared-mismatch'; }
  }

  // Every step must connect: it consumes an intermediate from an earlier step, or it feeds
  // one to a later step, or it is the last step (the one that forms the target).
  const last = audited.length - 1;
  const isolated: number[] = [];
  for (const step of audited) {
    if (!step.ok || step.index === last) continue;
    if ((incoming.get(step.index)?.size ?? 0) > 0 || (outgoing.get(step.index)?.size ?? 0) > 0) continue;
    isolated.push(step.index);
  }

  // The target, when the request named one, must be a product of some step. Matching the
  // constitution only is a stereochemistry failure unless the target leaves its stereo open.
  let target: RouteTargetAudit | undefined;
  const requested = typeof input?.target === 'string' ? input.target.trim() : '';
  if (requested) {
    target = { input: requested, canonicalSmiles: null, formula: null, formedAt: null, reason: 'unparsed' };
    try {
      const wanted = await summarize(requested);
      const formedBy = (match: (product: RouteSpeciesSummary) => boolean): number[] =>
        audited.filter(step => step.ok && step.products.some(match)).map(step => step.index);
      const exact = formedBy(product => product.canonicalSmiles === wanted.canonicalSmiles);
      const skeleton = formedBy(product => product.skeletonSmiles === wanted.skeletonSmiles);
      const formed = exact.length ? exact : wanted.stereocentres === 0 ? skeleton : [];
      target = {
        input: requested, canonicalSmiles: wanted.canonicalSmiles, formula: wanted.formula,
        formedAt: formed.length ? Math.max(...formed) : null,
        reason: formed.length ? 'formed' : skeleton.length ? 'stereo-mismatch' : 'not-formed',
      };
    } catch {
      // Left as `unparsed`: a target that cannot be read says nothing about the route.
    }
  }

  const links = [...linkByKey.values()].sort((a, b) => a.to - b.to || a.from - b.from);

  const blocked: string[] = [];
  for (const step of audited) {
    if (!step.ok) blocked.push(`Step ${step.index + 1}: ${step.error ?? 'could not be parsed.'}`);
    else if (!step.balanced) blocked.push(`Step ${step.index + 1} is not balanced: ${step.differences.join('; ')}.`);
    else if (step.unspecifiedStereocentres > 0 && !step.racemic) blocked.push(`Step ${step.index + 1} leaves ${step.unspecifiedStereocentres} stereocentre(s) or double bond(s) unspecified.`);
  }
  for (const link of links) {
    if (link.ok) continue;
    if (link.reason === 'declared-mismatch') blocked.push(`The intermediate declared as entering step ${link.to + 1} is not the same structure on both sides.`);
    else if (link.reason === 'constitution-only') blocked.push(`Step ${link.from + 1} → ${link.to + 1}: the intermediate has the same constitution but different stereochemistry or charge.`);
    else if (link.reason === 'no-overlap') blocked.push(`Step ${link.from + 1} → ${link.to + 1}: no intermediate is carried over.`);
    else blocked.push(`Step ${link.from + 1} → ${link.to + 1}: could not be checked because a step failed to parse.`);
  }
  for (const index of isolated) blocked.push(`Step ${index + 1} is disconnected: it neither uses an intermediate from an earlier step nor produces one used later.`);
  // A step that failed to parse cannot be searched for the target, so only a fully parsed
  // route is refused for not forming it.
  if (target && audited.every(step => step.ok)) {
    if (target.reason === 'not-formed') blocked.push(`No step forms the target ${target.canonicalSmiles} (${target.formula}).`);
    else if (target.reason === 'stereo-mismatch') blocked.push(`A step forms the target's constitution but not its stereochemistry (${target.canonicalSmiles}).`);
  }

  return { steps: audited, links, continuous: blocked.length === 0, blocked, isolated, ...(target ? { target } : {}) };
}
