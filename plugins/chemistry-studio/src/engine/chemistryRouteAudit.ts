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
// A backstop against pathological input, not a chemistry constraint. A named salt expands to
// its ions in the equation (`sodium dichromate` is three components), so a legitimate redox
// step can exceed a tight per-step limit; the application caps the author's labels per step
// and the whole route separately, and the subworker is killable and time-bounded.
const MAX_SPECIES_PER_STEP = 48;
const MAX_SPECIES_TOTAL = 256;
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
function stepBalance(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): { balanced: boolean; chargeBalanced: boolean; differences: string[]; coefficients: number[] | null } {
  const chargeBalanced = sumSide(reactants).charge === sumSide(products).charge;
  const ordered = [...reactants, ...agents, ...products];
  const roles = [
    ...reactants.map(() => 'reactant' as const),
    ...agents.map(() => 'agent' as const),
    ...products.map(() => 'product' as const),
  ];
  const compositions = ordered.map(entry => ({ atoms: entry.composition, charge: entry.charge }));
  try {
    const coefficients = balanceReaction(compositions, roles, ordered.map(() => 1));
    return { balanced: true, chargeBalanced, differences: [], coefficients };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The species cannot be balanced.';
    return { balanced: false, chargeBalanced, differences: [message + agentMisplacementHint(reactants, agents, products)], coefficients: null };
  }
}

/** When a step will not balance and a species is listed under Agents that carries atoms the
 *  reactants are short of, the usual cause is a consumed species mislabelled as a catalyst: a
 *  "citric acid catalyst" that is really decarboxylated and consumed. Name it. Only fires when
 *  an Agent actually contains a deficient element, so a plain solvent on an unrelated imbalance
 *  is left alone. */
function agentMisplacementHint(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): string {
  if (!agents.length) return '';
  const keys = new Set<string>();
  for (const entry of [...reactants, ...products]) for (const key of Object.keys(entry.composition)) keys.add(key);
  const total = (list: RouteSpeciesSummary[], key: string): number => list.reduce((sum, entry) => sum + (entry.composition[key] ?? 0), 0);
  const deficient = [...keys].filter((key) => total(products, key) > total(reactants, key));
  if (!deficient.length) return '';
  const culprits = agents.filter((agent) => deficient.some((key) => (agent.composition[key] ?? 0) > 0));
  if (!culprits.length) return '';
  const labels = culprits.map((agent) => agent.formula || agent.canonicalSmiles).join(', ');
  return ` ${labels} ${culprits.length > 1 ? 'are' : 'is'} listed under Agents, but the reactants are missing atoms that species contains: an Agent takes no part in the balance, so move it to Reactants if it is actually consumed.`;
}

/** A bound on the packing search and on the copies it will consider, so a pathological step
 *  degrades to "unchecked" rather than stalling the killable subworker. */
const PACKING_BUDGET = 20000;

const speciesLabel = (entry: RouteSpeciesSummary): string => entry.formula || entry.canonicalSmiles;

/** The per-molecule capacity a simple necessary condition exposes: for the largest product
 *  size that is short, how many such molecules are needed and how many substrate molecules can
 *  each supply one. This localises the refusal to the over-produced product. */
function packingBottleneck(bins: number[], items: number[]): { size: number; needed: number; capacity: number } | null {
  for (const size of [...new Set(items)].sort((a, b) => b - a)) {
    const needed = items.filter((item) => item === size).length;
    const capacity = bins.reduce((sum, bin) => sum + Math.floor(bin / size), 0);
    if (needed > capacity) return { size, needed, capacity };
  }
  return null;
}

/** A fraction `n/d` reduced, or the whole number. */
function formatFraction(numerator: number, denominator: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(numerator, denominator) || 1;
  const n = numerator / divisor, d = denominator / divisor;
  return d === 1 ? `${n}` : `${n}/${d}`;
}

/** A molecule cannot be assembled from fragments of more than one substrate: every product
 *  molecule's carbons come from a single substrate molecule. Carbon packing tests that
 *  directly — bins are the substrate molecules (capacity = their carbon count), items are the
 *  product molecules (size = their carbon count, each item wholly in one bin), and a substrate
 *  may host several products, which is fragmentation. A product larger than every substrate is
 *  a multi-component coupling, which this does not model, so the step is left unchecked rather
 *  than refused; and the test is symmetry-blind, so any assignment of equal carbons is fine. */
function checkPerMoleculePacking(step: RouteStepAudit): { ok: true } | { ok: false; reason: string } | 'unchecked' {
  const carbonOf = (entry: RouteSpeciesSummary): number => entry.composition['6:0'] ?? 0;
  const substrates = step.reactants.filter((entry) => carbonOf(entry) > 0);
  const products = step.products.filter((entry) => carbonOf(entry) > 0);
  const maxBin = substrates.reduce((max, entry) => Math.max(max, carbonOf(entry)), 0);
  if (!maxBin || !products.length) return 'unchecked';
  for (const product of products) if (carbonOf(product) > maxBin) return 'unchecked'; // a coupling
  const bins: number[] = [];
  for (const reactant of substrates) for (let i = 0; i < (reactant.coefficient ?? 1); i += 1) bins.push(carbonOf(reactant));
  const items: number[] = [];
  for (const product of products) for (let i = 0; i < (product.coefficient ?? 1); i += 1) items.push(carbonOf(product));
  if (!bins.length || !items.length) return 'unchecked';
  if (bins.length + items.length > PACKING_BUDGET) return 'unchecked';
  items.sort((a, b) => b - a);
  let visited = 0;
  const fit = (index: number): boolean => {
    if (index >= items.length) return true;
    if ((visited += 1) > PACKING_BUDGET) throw new Error('packing budget');
    const size = items[index];
    const tried = new Set<number>();
    for (let bin = 0; bin < bins.length; bin += 1) {
      if (bins[bin] < size || tried.has(bins[bin])) continue;
      tried.add(bins[bin]);
      bins[bin] -= size;
      if (fit(index + 1)) return true;
      bins[bin] += size;
    }
    return false;
  };
  let packed: boolean;
  try { packed = fit(0); } catch { return 'unchecked'; }
  if (packed) return { ok: true };

  const bottleneck = packingBottleneck(bins, items);
  const culprit = bottleneck ? products.find((entry) => carbonOf(entry) === bottleneck.size) : undefined;
  const detail = bottleneck && culprit
    ? `${bottleneck.needed} × ${speciesLabel(culprit)} need ${bottleneck.needed} substrate molecules, but only ${bottleneck.capacity} can each supply one`
    : `${products.map((entry) => `${entry.coefficient ?? 1} × ${speciesLabel(entry)}`).join(' + ')} from ${substrates.map((entry) => `${entry.coefficient ?? 1} × ${speciesLabel(entry)}`).join(' + ')}`;
  // The cheap version of the same test, and the most communicative: scale to one main substrate
  // and show the coefficients that are not whole numbers.
  const main = substrates.reduce((a, b) => (carbonOf(b) > carbonOf(a) ? b : a));
  const mainCoefficient = main.coefficient ?? 1;
  const fractions = [...step.reactants, ...step.products]
    .map((entry) => ({ label: speciesLabel(entry), coefficient: entry.coefficient ?? 1 }))
    .filter(({ coefficient }) => (coefficient / mainCoefficient) % 1 !== 0)
    .map(({ label, coefficient }) => `${formatFraction(coefficient, mainCoefficient)} ${label}`);
  const fractionNote = fractions.length ? ` At one ${speciesLabel(main)} the coefficients are ${fractions.join(', ')}.` : '';
  return { ok: false, reason: `the equation can only balance by taking more product molecules than the substrate molecules can form: ${detail}. A product's carbons come from a single substrate molecule.${fractionNote}` };
}

/** A species the author named in the step prose: the systematic name, the isomeric SMILES
 *  written beside it, and the SMILES its name resolved to (resolved by the worker, which has
 *  the network; the subworker only compares). An empty `nameSmiles` means the name could not
 *  be resolved and is reported as unchecked, never as a disagreement. */
export interface RouteLabelInput {
  role: 'reactant' | 'product' | 'agent';
  byproduct?: boolean;
  name: string;
  smiles: string;
  nameSmiles?: string[];
}

export interface RouteAuditInput {
  steps: string[];
  carriers?: Array<string | null | undefined>;
  /** A declared racemate, per step or for the whole route: open stereocentres on those steps
   *  are reported, not refused. */
  racemic?: boolean | Array<boolean | null | undefined>;
  /** The requested target as SMILES. When given, the route must form it. */
  target?: string | null;
  /** Per-step species labels. Each label's name is checked against the structure its SMILES
   *  denotes, so a name for a different compound is refused alongside an unbalanced step. */
  labels?: Array<Array<RouteLabelInput | null | undefined> | null | undefined>;
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
      // An empty step is one the application could not build: a species on it has no resolved
      // structure. It keeps its place so later steps keep their numbers.
      if (!reaction) throw new Error('This step could not be built: a species it names has no resolved structure.');
      if (reaction.length > MAX_REACTION_CHARS) throw new Error(`A step must be a reaction SMILES under ${MAX_REACTION_CHARS} characters.`);
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
      // The solved coefficients travel with the species so the report can show the equation
      // that actually balanced, not the 1:1:1:1 the author likely meant.
      [...reactants, ...agents, ...products].forEach((entry, position) => {
        const coefficient = balance.coefficients?.[position];
        if (typeof coefficient === 'number' && coefficient > 0) entry.coefficient = coefficient;
      });
      step.reactants = reactants;
      step.agents = agents;
      step.products = products;
      step.balanced = balance.balanced;
      step.chargeBalanced = balance.chargeBalanced;
      step.differences = balance.differences;
      // Only the species the step makes are the route's responsibility to specify. A purchased
      // reagent with stereocentres (a commercial mixture) is not something the author chose, and
      // an intermediate is checked in the step that produces it, so products alone cover every
      // species the route creates. Agents/solvents and starting materials are left out.
      step.unspecifiedStereocentres = products.reduce((sum, entry) => sum + entry.unspecifiedStereocentres, 0);
      if (step.unspecifiedStereocentres > 0 && declaredRacemic(index)) step.racemic = true;
      step.ok = true;
    } catch (error) {
      step.error = error instanceof Error ? error.message : 'The step could not be parsed.';
    }
    audited.push(step);
  }

  // The author's names, checked against the structures they were written beside. This is the
  // deterministic half of the prose/name/structure gate: a name is resolved to a graph
  // outside this subworker, and here two RDKit canonical forms are compared. A name that
  // resolves to a different compound is as much a refusal as an unbalanced equation.
  const labels = Array.isArray(input?.labels) ? input.labels : [];
  let namesUnresolved = 0;
  for (const step of audited) {
    if (!step.ok) continue;
    const supplied = Array.isArray(labels[step.index]) ? labels[step.index]! : [];
    for (const raw of supplied) {
      if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.smiles !== 'string' || !raw.smiles.trim()) continue;
      if (raw.role !== 'reactant' && raw.role !== 'product' && raw.role !== 'agent') continue;
      let declared: RouteSpeciesSummary;
      try { declared = await summarize(raw.smiles); } catch { continue; }
      const candidates = (Array.isArray(raw.nameSmiles) ? raw.nameSmiles : [])
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      let nameOk: boolean | undefined;
      if (candidates.length) {
        nameOk = false;
        for (const candidate of candidates) {
          try {
            const resolved = await summarize(candidate);
            if (resolved.canonicalSmiles === declared.canonicalSmiles) { nameOk = true; break; }
            if (resolved.skeletonSmiles === declared.skeletonSmiles && resolved.charge === declared.charge) {
              // Same constitution: a name that is silent about stereochemistry is not a
              // disagreement, but two explicit, different stereodescriptors are.
              if (!(resolved.stereocentres > 0 && declared.stereocentres > 0)) { nameOk = true; break; }
            }
          } catch {
            // An unparseable candidate is silence, not a disagreement.
          }
        }
      } else {
        namesUnresolved += 1;
      }
      const side = raw.role === 'reactant' ? step.reactants : raw.role === 'agent' ? step.agents : step.products;
      const target = side.find(entry => entry.canonicalSmiles === declared.canonicalSmiles)
        ?? side.find(entry => entry.input === raw.smiles.trim());
      if (target) {
        target.name = raw.name.trim().slice(0, 200);
        if (raw.byproduct === true) target.byproduct = true;
        if (typeof nameOk === 'boolean') target.nameOk = nameOk;
      }
      if (nameOk === false) {
        const problem = `the IUPAC name "${raw.name.trim().slice(0, 200)}" denotes a different structure than \`${declared.canonicalSmiles}\`${declared.formula ? ` (${declared.formula})` : ''}`;
        (step.nameProblems ??= []).push(problem);
      }
    }
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
    if (!step.ok) { blocked.push(`Step ${step.index + 1}: ${step.error ?? 'could not be parsed.'}`); continue; }
    for (const problem of step.nameProblems ?? []) blocked.push(`Step ${step.index + 1}: ${problem}.`);
    if (!step.balanced) { blocked.push(`Step ${step.index + 1} is not balanced: ${step.differences.join('; ')}.`); continue; }
    const packing = checkPerMoleculePacking(step);
    if (packing !== 'unchecked' && !packing.ok) {
      step.assemblyProblem = packing.reason;
      blocked.push(`Step ${step.index + 1}: ${packing.reason}.`);
      continue;
    }
    if (step.unspecifiedStereocentres > 0 && !step.racemic) blocked.push(`Step ${step.index + 1} leaves ${step.unspecifiedStereocentres} stereocentre(s) or double bond(s) unspecified.`);
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

  return { steps: audited, links, continuous: blocked.length === 0, blocked, isolated, ...(target ? { target } : {}), ...(namesUnresolved ? { namesUnresolved } : {}) };
}
