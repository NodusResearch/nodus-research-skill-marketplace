import { MAX_REACTION_CHARS } from './chemistryLimits';
import { MAX_CHEMICAL_NAME } from './chemistryIdentity';
import type { RouteAudit, RouteLinkAudit, RouteSpeciesSummary, RouteStepAudit, RouteTargetAudit } from './chemistryDocument';
import { balanceReaction } from './chemistryReaction';
import { splitReactionSmiles } from './chemistryReactionShared';
import { deliveredAtOpenCentres, productMatchesTarget, validateChemicalReferences } from './chemistryValidationCore';
import { bondLedger, skeletonChange, type SkeletonReport } from './chemistrySkeleton';

/** The read-only route checker. It never draws: it parses each step with RDKit and answers
 *  two questions the model cannot be trusted to answer about its own plan — is every
 *  equation balanced, and is the intermediate leaving one step the same molecule as the
 *  one entering the next. Identity is RDKit's canonical isomeric SMILES, so it is a string
 *  comparison, not a judgement about whether two drawings look alike. */

// Solid-phase peptide syntheses run to ~80 steps (a coupling and a deprotection per residue,
// e.g. tirzepatide's 39 residues, then cleavage); 96 keeps them checkable. Not a chemistry rule.
const MAX_STEPS = 96;
// A backstop against pathological input, not a chemistry constraint. A named salt expands to
// its ions in the equation (`sodium dichromate` is three components), so a legitimate redox
// step can exceed a tight per-step limit; the application caps the author's labels per step
// and the whole route separately, and the subworker is killable and time-bounded.
const MAX_SPECIES_PER_STEP = 48;
const MAX_SPECIES_TOTAL = 1024;


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

/** One side's species, grouped as the AUTHOR declared them rather than as the reaction string
 *  happens to be punctuated.
 *
 *  A reaction SMILES separates components with `.` and cannot say which of them belong to one
 *  species, so a salt the author declared once — `[Mg+2].[Br-].[OH-]` — arrives as three
 *  independent species, and each one is a free coefficient for the solver. That freedom lets a
 *  wrong equation balance: a hydrolysis one hydrogen short came back balanced by taking two of
 *  the organometallic and one water, at 2/1/2/2/2/1, when the author's own equation was 1:1 and
 *  simply had oxide where it needed hydroxide. The arithmetic was right and the chemistry was
 *  not, which is the worst way for a check to be wrong.
 *
 *  The boundary is not lost, only absent from the string: `labels` carries each declared species
 *  with its own SMILES. So each label claims its fragments from the side's pool and becomes ONE
 *  species with ONE coefficient. A fragment no label claims stays a species of its own, which is
 *  what happens for every route that sends no labels, so nothing changes for them. */
async function summarizeFieldGrouped(field: string, declared: string[]): Promise<RouteSpeciesSummary[]> {
  const tokens = splitField(field);
  if (!declared.length) return summarizeField(field);
  const unclaimed = tokens.map((token) => ({ token, taken: false }));
  const claim = (fragment: string): boolean => {
    const slot = unclaimed.find((entry) => !entry.taken && entry.token === fragment);
    if (!slot) return false;
    slot.taken = true;
    return true;
  };
  const grouped: Array<{ position: number; smiles: string }> = [];
  for (const smiles of declared) {
    const fragments = smiles.split('.').map((part) => part.trim()).filter(Boolean);
    if (fragments.length < 2) continue;        // a single-fragment species is already one species
    const first = unclaimed.findIndex((entry) => !entry.taken && entry.token === fragments[0]);
    if (first < 0) continue;
    // All of a declared species' fragments must be present, or the grouping would silently drop
    // atoms. A partial match leaves every fragment where it was.
    const snapshot = unclaimed.map((entry) => entry.taken);
    if (fragments.every((fragment) => claim(fragment))) grouped.push({ position: first, smiles });
    else unclaimed.forEach((entry, index) => { entry.taken = snapshot[index]; });
  }
  if (!grouped.length) return summarizeField(field);
  // Keep document order: a grouped species sits where its first fragment was.
  const entries = [
    ...grouped.map((entry) => ({ position: entry.position, smiles: entry.smiles })),
    ...unclaimed.map((entry, index) => (entry.taken ? null : { position: index, smiles: entry.token }))
      .filter((entry): entry is { position: number; smiles: string } => entry !== null),
  ].sort((a, b) => a.position - b.position);
  const out: RouteSpeciesSummary[] = [];
  for (const entry of entries) out.push(await summarize(entry.smiles));
  return out;
}

/** The SMILES of every species the author declared for one role on one step, in order. */
/** The names the author gave each species of one role, in the same order `declaredFor` hands the
 *  structures over, so a summary can be matched back to the name the author wrote. */
function namesFor(labels: Array<RouteLabelInput | null | undefined>, role: 'reactant' | 'agent' | 'product'): string[] {
  return labels
    .filter((label): label is RouteLabelInput => Boolean(label) && label!.role === role && typeof label!.smiles === 'string' && label!.smiles.trim().length > 0)
    .map((label) => label.name);
}

function declaredFor(labels: Array<RouteLabelInput | null | undefined>, role: 'reactant' | 'agent' | 'product'): string[] {
  return labels
    .filter((label): label is RouteLabelInput => Boolean(label) && label!.role === role && typeof label!.smiles === 'string' && label!.smiles.trim().length > 0)
    .map((label) => label.smiles!.trim());
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

/** A stereocentre a step neither makes nor breaks must come out the way it went in.
 *
 *  Compare the multiset of specified CIP descriptors on each side. When both sides carry the SAME
 *  NUMBER of specified centres but a different mix, a centre was inverted — which an amide
 *  coupling, a deprotection or a cleavage does not do. Differing counts mean a centre was created
 *  or destroyed, which is ordinary chemistry, so that case is left alone.
 *
 *  This is the one error class atom balance cannot reach. An epimer has identical atom counts, so
 *  the equation balances; it carries over as the same declared structure, so continuity holds; and
 *  the right bonds form, so the skeleton ledger is satisfied. A route can therefore be balanced,
 *  continuous, skeleton-clean and end on an exact match to the requested target while passing
 *  through a compound that cannot give it.
 *
 *  Descriptors, not geometry, because a CIP label is what the toolkit reports here — sound for
 *  this comparison since the ranking at such a centre does not change when a neighbouring acid
 *  becomes an amide, which is the change these steps make. */
function invertedConfiguration(reactants: RouteSpeciesSummary[], products: RouteSpeciesSummary[], names: { reactants: string[]; products: string[] } = { reactants: [], products: [] }): string {
  const tags = (list: RouteSpeciesSummary[]): string[] => list.flatMap(entry => entry.cipTags ?? []).sort();
  const left = tags(reactants);
  const right = tags(products);
  if (left.length !== right.length || left.join(',') === right.join(',')) return '';
  // The toolkit reports descriptors parenthesised — "(S)", "(R)" — as the "(?)" filter beside
  // stereocentres shows, so match that form rather than a bare letter.
  const count = (list: string[], tag: string) => list.filter(entry => entry.replace(/[()]/g, '') === tag).length;
  const describe = (list: string[]) => `${count(list, 'S')} (S) and ${count(list, 'R')} (R)`;
  // Counts alone are not actionable. "Give the product the configuration its reactant carries" is
  // advice a reader can follow with two centres in play and cannot follow with a dozen: nothing in
  // the sentence says which one moved. So each side is also listed species by species, in the
  // molecule's own atom order, with the atom index of every specified centre — the index locates
  // it in the very string the author wrote, which is the only handle they have on it.
  const perSpecies = (list: RouteSpeciesSummary[], labelled: string[]) => list
    .map((entry, position) => ({ entry, name: entry.name ?? labelled[position] ?? entry.formula }))
    .filter(({ entry }) => (entry.cipCentres ?? entry.cipTags ?? []).length)
    .map(({ entry, name }) => {
      const centres = entry.cipCentres?.length
        ? entry.cipCentres.map(centre => `${centre.tag} at atom ${centre.atom}`).join(', ')
        : (entry.cipTags ?? []).join(', ');
      return `${name}: ${centres}`;
    })
    .join(' · ');
  const sides = [perSpecies(reactants, names.reactants), perSpecies(products, names.products)];
  const where = sides.every(Boolean)
    ? ` In: ${sides[0]}. Out: ${sides[1]}. Atom indices count from zero in the structure as the application parsed it.`
    : '';
  return `This step inverts a stereocentre: its reactants carry ${describe(left)} specified centres and its products ${describe(right)}, the same number on each side.${where} A coupling, a deprotection or a cleavage does not change configuration, so either a declared structure has the wrong descriptor at one centre — give the product the configuration its reactant carries — or, if an inversion is genuinely intended, say in this step's own prose which centre inverts and why.`;
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

/** The sentence naming a single species listed on the wrong side, when moving it across
 *  balances the step; empty otherwise. A species on both sides is left alone. */
function sideFlipThatBalances(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): string {
  const same = (a: RouteSpeciesSummary, b: RouteSpeciesSummary) => a.canonicalSmiles === b.canonicalSmiles;
  const tryMove = (from: RouteSpeciesSummary[], to: RouteSpeciesSummary[], position: number, toProducts: boolean): string => {
    const species = from[position];
    if (to.some(entry => same(entry, species)) || from.length < 2) return '';
    const nextFrom = from.filter((_, i) => i !== position);
    const nextTo = [...to, species];
    const result = toProducts ? stepBalance(nextFrom, agents, nextTo) : stepBalance(nextTo, agents, nextFrom);
    if (!result.balanced || !result.coefficients) return '';
    const ordered = toProducts ? [...nextFrom, ...agents, ...nextTo] : [...nextTo, ...agents, ...nextFrom];
    const count = result.coefficients[ordered.indexOf(species)];
    const label = speciesLabel(species);
    return toProducts
      ? `"${label}" is listed as a reactant, but the step forms it: list it under Byproducts (${count} ${label}).`
      : `"${label}" is listed on the product side, but the step consumes it: list it under Reactants (${count} ${label}).`;
  };
  for (let i = 0; i < reactants.length; i++) { const hint = tryMove(reactants, products, i, true); if (hint) return hint; }
  for (let i = 0; i < products.length; i++) { const hint = tryMove(products, reactants, i, false); if (hint) return hint; }
  return '';
}

/** The sentence naming an Agent that the step also forms or also consumes, when listing it on
 *  that side too balances the step: a solvent the reaction makes (ethanol from sodium ethoxide in
 *  ethanol, water in an aqueous oxidation) or a "catalyst" that is really used up. The agent keeps
 *  its place as the solvent; the step only lacks it as a byproduct or reactant. Empty otherwise. */
function agentRoleThatBalances(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): string {
  for (let i = 0; i < agents.length; i++) {
    const species = agents[i];
    const others = agents.filter((_, position) => position !== i);
    const label = speciesLabel(species);
    const formed = stepBalance(reactants, others, [...products, species]);
    if (formed.balanced && formed.coefficients) {
      const count = formed.coefficients[reactants.length + others.length + products.length];
      return `"${label}" is listed under Agents, and the step also forms it: keep it under Agents if it is the solvent, and also list it under Byproducts (${count} ${label}).`;
    }
    const consumed = stepBalance([...reactants, species], others, products);
    if (consumed.balanced && consumed.coefficients) {
      const count = consumed.coefficients[reactants.length];
      return `"${label}" is listed under Agents, but the step consumes it: list it under Reactants (${count} ${label}).`;
    }
  }
  return '';
}

/** The reactant-side species (one, else a pair) that, filed as agents, let the step balance.
 *  Only an idle species can go: at least one reactant must remain. */
function agentsThatBalance(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): number[] | null {
  const tries: number[][] = reactants.map((_, position) => [position]);
  for (let a = 0; a < reactants.length; a++) for (let b = a + 1; b < reactants.length; b++) tries.push([a, b]);
  for (const moved of tries) {
    if (moved.length >= reactants.length) continue;
    const kept = reactants.filter((_, position) => !moved.includes(position));
    if (stepBalance(kept, [...agents, ...moved.map(position => reactants[position])], products).balanced) return moved;
  }
  return null;
}

/** When a step will not balance, whether a species listed under Agents is the cause. The usual
 *  case is a consumed species mislabelled as a catalyst: a "citric acid catalyst" that is really
 *  decarboxylated and consumed. Name it only when adding whole copies of it to the reactant side
 *  balances the step EXACTLY.
 *
 *  The old test was "this Agent contains some element the reactants are short of", which named
 *  the wrong species on any large step: a solvent contains C, H, N and O, so it was blamed for a
 *  shortfall it could not explain, and the advice to move it to Reactants was wrong chemistry.
 *  When no Agent can account for the shortfall, that is itself the finding — the declared
 *  products or byproducts are incomplete — so say that instead of implicating a condition. */
function agentMisplacementHint(reactants: RouteSpeciesSummary[], agents: RouteSpeciesSummary[], products: RouteSpeciesSummary[]): string {
  if (!agents.length) return '';
  const keys = new Set<string>();
  for (const entry of [...reactants, ...products, ...agents]) for (const key of Object.keys(entry.composition)) keys.add(key);
  const total = (list: RouteSpeciesSummary[], key: string): number => list.reduce((sum, entry) => sum + (entry.composition[key] ?? 0), 0);
  const deficit = new Map<string, number>();
  for (const key of keys) {
    const diff = total(products, key) - total(reactants, key);
    if (diff !== 0) deficit.set(key, diff);
  }
  if (![...deficit.values()].some((value) => value > 0)) return '';
  const closesExactly = (agent: RouteSpeciesSummary, copies: number): boolean =>
    [...keys].every((key) => total(reactants, key) + copies * (agent.composition[key] ?? 0) === total(products, key));
  for (const agent of agents) {
    // The copy count is fixed by any one deficient element the agent carries; the rest must agree.
    const anchor = [...deficit].find(([key, diff]) => diff > 0 && (agent.composition[key] ?? 0) > 0);
    if (!anchor) continue;
    const copies = anchor[1] / (agent.composition[anchor[0]] ?? 1);
    if (!Number.isInteger(copies) || copies < 1 || !closesExactly(agent, copies)) continue;
    const label = agent.formula || agent.canonicalSmiles;
    return ` "${label}" is listed under Agents, and adding ${copies === 1 ? 'it' : `${copies} copies of it`} to the reactants balances the step exactly: an Agent takes no part in the balance, so list it under Reactants (${copies} ${label}) if it is actually consumed.`;
  }
  // No Agent closes the balance. One may still be a consumed species, so it is still named —
  // but the instruction is conditional now, and the likelier fault is said out loud. Blaming a
  // solvent outright is how a large step with incomplete byproducts came back advising that the
  // reaction medium be moved to Reactants.
  const carriers = agents.filter((agent) => [...deficit].some(([key, diff]) => diff > 0 && (agent.composition[key] ?? 0) > 0));
  if (!carriers.length) return '';
  const labels = carriers.map((agent) => agent.formula || agent.canonicalSmiles).join(', ');
  return ` ${labels} ${carriers.length > 1 ? 'are' : 'is'} listed under Agents, but the reactants are missing atoms that species contains. Move it to Reactants only if it is actually consumed: adding it does not balance the step either, so the declared products or byproducts are probably incomplete.`;
}

/** A bare multiply-charged monatomic anion: free oxide, nitride, sulfide. These are not species a
 *  solution-phase route consumes or releases — the author means the salt, the hydroxide or the
 *  acid — and each one that reaches the equation is a free coefficient for the solver, because a
 *  species declared as one salt arrives as several independent fragments.
 *
 *  That freedom lets a wrong equation balance. CH3MgBr + H2O -> CH4 + Mg(2+) + Br(-) + O(2-) is
 *  one hydrogen short as written, and the solver rescues it at 2:1 by taking two of the metal
 *  species and one water. The hydroxide form of the same step balances at unit coefficients,
 *  which is the answer the author wanted. Naming the species is the fix; the solver cannot tell
 *  which of several arithmetic answers is the chemistry. */
function freeMultiplyChargedAnion(species: RouteSpeciesSummary): string | null {
  const smiles = species.canonicalSmiles.trim();
  const match = /^\[([A-Z][a-z]?)(?:H0)?((?:-{2,})|(?:-[2-9]))\]$/.exec(smiles);
  if (!match) return null;
  // Only the non-metals a route would otherwise have named as part of a salt or an acid.
  return ['O', 'N', 'S', 'P', 'C'].includes(match[1]) ? smiles : null;
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
/** Three outcomes, not two, and the distinction matters. 'n/a' means the shape is outside what
 *  packing models — most of all a convergent coupling, where a product legitimately carries more
 *  carbon than any single substrate. That is every coupling in a stepwise assembly, so saying
 *  "unchecked" for it would bury the real case in noise. `unchecked` means the search GAVE UP,
 *  which the author should hear about. */
function checkPerMoleculePacking(step: RouteStepAudit): { ok: true } | { ok: false; reason: string } | 'n/a' | { unchecked: string } {
  const carbonOf = (entry: RouteSpeciesSummary): number => entry.composition['6:0'] ?? 0;
  const substrates = step.reactants.filter((entry) => carbonOf(entry) > 0);
  const products = step.products.filter((entry) => carbonOf(entry) > 0);
  const maxBin = substrates.reduce((max, entry) => Math.max(max, carbonOf(entry)), 0);
  if (!maxBin || !products.length) return 'n/a';
  for (const product of products) if (carbonOf(product) > maxBin) return 'n/a'; // a convergent coupling: not modelled
  const bins: number[] = [];
  for (const reactant of substrates) for (let i = 0; i < (reactant.coefficient ?? 1); i += 1) bins.push(carbonOf(reactant));
  const items: number[] = [];
  for (const product of products) for (let i = 0; i < (product.coefficient ?? 1); i += 1) items.push(carbonOf(product));
  if (!bins.length || !items.length) return 'n/a';
  if (bins.length + items.length > PACKING_BUDGET) return { unchecked: `too many fragments to pack (${bins.length + items.length} against a budget of ${PACKING_BUDGET})` };
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
  try { packed = fit(0); } catch { return { unchecked: `the packing search exceeded its budget of ${PACKING_BUDGET} candidate tests` }; }
  if (packed) return { ok: true };

  // Packing assigns each product to one substrate, which is only valid for a fragmentation of a
  // SINGLE molecule. With two or more substrate molecules the step may be a convergent coupling
  // whose product draws carbon from more than one substrate — a Wittig forms stilbene from the
  // phosphonium's benzyl and the aldehyde while the phosphonium also sheds triphenylphosphine
  // oxide; an aldol, a Claisen or a Grignard addition are the same shape. The single-substrate
  // model cannot represent that, so it must not refuse it; atom and charge balance still apply.
  // Two or more distinct carbon-bearing substrates, not the coefficient count: a single substrate
  // taken several times (8 citric acid -> 9 acetonedicarboxylic) is a redistribution of one molecule
  // and is still a real impossibility to refuse.
  if (substrates.length >= 2) return 'n/a';   // convergent: outside the single-substrate model

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
  /** A declared rearrangement, per step or for the whole route: a 1,2-shift or a new bond at an
   *  unactivated carbon on those steps is reported, not refused. */
  rearrangement?: boolean | Array<boolean | null | undefined>;
  /** A declared radical or C–H functionalisation, per step or for the whole route: a new bond at
   *  an unactivated carbon on those steps is reported, not refused. */
  radical?: boolean | Array<boolean | null | undefined>;
  /** The requested target as SMILES. When given, the route must form it. */
  target?: string | null;
  /** Per-step species labels. Each label's name is checked against the structure its SMILES
   *  denotes, so a name for a different compound is refused alongside an unbalanced step. */
  labels?: Array<Array<RouteLabelInput | null | undefined> | null | undefined>;
  /** For a product SMILES as written in a step: the stereo choices it really leaves open, when
   *  the full RDKit could enumerate them (0: only one stereoisomer can exist, as for tropinone's
   *  fixed, meso bridgeheads; 1: only a choice between mirror images). Caps the product's
   *  unspecified count; a product not listed keeps the labeller's count. */
  stereoChoices?: Record<string, StereoChoice | number | null | undefined>;
}

/** What the full RDKit says a species written without stereo really leaves open. */
export interface StereoChoice { open: number; mirrorOnly: boolean }

/** A stereoChoices entry as given: the current object, or a bare count from an older runtime
 *  (where 1 meant an enantiomer pair). */
/** Read a balanced step as a C–C graph edit (chemistrySkeleton.ts) and keep the facts on the
 *  step. Returns the refusal, or null when the skeleton change is explained or declared. A step
 *  the search cannot settle is never refused for it. */
async function checkSkeleton(step: RouteStepAudit, declared: { rearrangement: boolean; radical: boolean }): Promise<string | null> {
  const species = (side: RouteSpeciesSummary[]) => side.map(entry => ({ smiles: entry.canonicalSmiles, coefficient: entry.coefficient }));
  let report: SkeletonReport;
  try {
    report = await skeletonChange(species(step.reactants), species(step.products));
    const bonds = await bondLedger(species(step.reactants), species(step.products));
    if (Object.keys(bonds).length) step.bonds = bonds;
  } catch (error) {
    // Record that the check did not run, rather than returning as though it had passed. Without
    // this the step carries no skeleton report at all, so it is not even counted as unchecked and
    // the report reads exactly like a step whose bonds were examined and found sound.
    step.skeleton = {
      change: 'unchecked', formed: 0, cleaved: 0, ringSizes: [], migration: false,
      reorganised: false, unactivated: 0, unactivatedHetero: 0, heteroElements: [],
      reason: `the bond-edit check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    return null;
  }
  step.skeleton = report;
  if (declared.rearrangement) step.rearrangement = true;
  if (declared.radical) step.radical = true;
  if (report.change === 'unchecked') return null;
  const unactivatedNote = 'a carbon nothing activates — no leaving group, metal, heteroatom or multiple bond on it, and not next to a carbonyl, alkene or arene';
  // A rearrangement is the only thing that explains a 1,2-shift; an unactivated carbon reacting
  // is also explained by a radical or C–H functionalisation.
  if (report.migration && !declared.rearrangement) {
    return 'the carbon skeleton is rearranged: a carbon leaves one carbon and bonds to its neighbour (a 1,2-shift), so a C–C bond breaks and another forms. '
      + 'If this step is a rearrangement (Wagner–Meerwein, pinacol, benzilic acid, Favorskii, Wolff…), name it in this step\'s prose; if not, the product does not follow from the reactants';
  }
  if (report.reorganised && !declared.rearrangement) {
    return 'the carbon skeleton is reorganised: a C–C bond is broken while its two carbons stay joined in the product, and new C–C bonds form elsewhere, so the starting skeleton cannot simply close to the product. '
      + 'Check that the precursor\'s carbons are where the product needs them (a cyclisation forms bonds, it does not move branches); if this step is a rearrangement (Cope, ring expansion…), name it in this step\'s prose';
  }
  if (declared.rearrangement || declared.radical) return null;
  if (report.unactivated > 0) {
    const ring = report.ringSizes.length ? ` (closing a ${report.ringSizes.join('-, ')}-membered ring)` : '';
    return `a new C–C bond${ring} forms at ${unactivatedNote}, so the product does not follow from the reactants as written. `
      + 'Check which carbon reacts (the regiochemistry) and the amounts of each reactant; if a rearrangement or a radical or C–H functionalisation is intended, name it in this step\'s prose';
  }
  if (report.unactivatedHetero > 0) {
    const bonds = report.heteroElements.map(element => `C–${element}`).join(', ');
    return `a new ${bonds} bond forms at ${unactivatedNote}, so the product does not follow from the reactants as written. `
      + 'Check which carbon reacts (the regiochemistry: an enol or enolate reacts only at the α-carbon); if a radical or C–H functionalisation is intended (light, NBS, a peroxide initiator…), name it in this step\'s prose';
  }
  return null;
}

function stereoChoiceOf(value: StereoChoice | number | null | undefined): StereoChoice | null {
  if (typeof value === 'number') return value >= 0 ? { open: value, mirrorOnly: value === 1 } : null;
  if (value && typeof value === 'object' && typeof value.open === 'number' && value.open >= 0) return { open: value.open, mirrorOnly: value.mirrorOnly === true };
  return null;
}

export async function auditRoute(input: RouteAuditInput): Promise<RouteAudit> {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new Error(`A route needs between one and ${MAX_STEPS} steps.`);
  const carriers = Array.isArray(input?.carriers) ? input.carriers : [];
  const racemicInput = input?.racemic;
  const declaredRacemic = (index: number): boolean => Array.isArray(racemicInput)
    ? Boolean(racemicInput[index])
    : racemicInput === true;
  const rearrangementInput = input?.rearrangement;
  const declaredRearrangement = (index: number): boolean => Array.isArray(rearrangementInput)
    ? Boolean(rearrangementInput[index])
    : rearrangementInput === true;
  const radicalInput = input?.radical;
  const declaredRadical = (index: number): boolean => Array.isArray(radicalInput)
    ? Boolean(radicalInput[index])
    : radicalInput === true;
  const audited: RouteStepAudit[] = [];
  let totalSpecies = 0;
  const labelInput: Array<Array<RouteLabelInput | null | undefined> | null | undefined> =
    Array.isArray(input?.labels) ? input.labels : [];

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
      // Group each side's fragments back into the species the author declared, so a salt counts
      // once and takes one coefficient. Without labels this is exactly the old behaviour.
      const stepLabels = Array.isArray(labelInput[index]) ? labelInput[index]!.filter(Boolean) : [];
      const reactants = await summarizeFieldGrouped(reactantField, declaredFor(stepLabels, 'reactant'));
      const agents = await summarizeFieldGrouped(agentField, declaredFor(stepLabels, 'agent'));
      const products = await summarizeFieldGrouped(productField, declaredFor(stepLabels, 'product'));
      if (!reactants.length || !products.length) throw new Error('A step needs at least one reactant and one product.');
      const count = reactants.length + agents.length + products.length;
      if (count > MAX_SPECIES_PER_STEP) throw new Error(`A step may name at most ${MAX_SPECIES_PER_STEP} species.`);
      totalSpecies += count;
      if (totalSpecies > MAX_SPECIES_TOTAL) throw new Error(`A route may name at most ${MAX_SPECIES_TOTAL} species.`);
      let balance = stepBalance(reactants, agents, products);
      // A free oxide or nitride is never the species the author meant, and it hands the solver a
      // degree of freedom that can make a wrong equation balance. Refuse the balance and name it,
      // rather than reporting a verdict the arithmetic supports and the chemistry does not.
      const freeAnions = [...reactants, ...products]
        .map(freeMultiplyChargedAnion).filter((value): value is string => value !== null);
      if (freeAnions.length) {
        const names = [...new Set(freeAnions)].map(value => `"${value}"`).join(', ');
        balance = { ...balance, balanced: false, differences: [
          `${names} ${freeAnions.length > 1 ? 'are' : 'is'} a free multiply-charged anion, which is not a species a route consumes or releases: name the salt, the hydroxide or the acid that carries it. As written it also leaves the balance underdetermined, so an equation that is wrong can still be solved.`,
        ] };
      }
      // An inverted stereocentre balances perfectly, so it has to be refused separately.
      const inverted = balance.balanced
        ? invertedConfiguration(reactants, products, { reactants: namesFor(stepLabels, 'reactant'), products: namesFor(stepLabels, 'product') })
        : '';
      if (inverted) balance = { ...balance, balanced: false, differences: [inverted] };
      // A reactant-side species that takes no part in the only balance is a reagent or a
      // condition (a catalyst, a solvent) the author listed with the reactants: file it under
      // agents and check again, rather than refusing an otherwise balanced step. Products are
      // never moved — a product that takes no part is a real error.
      if (!balance.balanced && reactants.length > 1) {
        const moved = agentsThatBalance(reactants, agents, products);
        if (moved) {
          const kept = reactants.filter((_, position) => !moved.includes(position));
          const asAgents = [...agents, ...moved.map(position => reactants[position])];
          const retried = stepBalance(kept, asAgents, products);
          if (retried.balanced) {
            // Say what was assumed. The arithmetic is the same whether the species is a condition
            // that was never consumed or a reagent that was consumed and whose product the author
            // forgot — so moving it in silence reported a balanced step for the exact mistake the
            // request warns about ("if a reagent is used up, list it as a reactant and name what it
            // becomes"). Measured: a coupling reagent listed under Reactants with its co-product
            // omitted came back balanced, no differences, and refiled under Agents under a bare
            // formula. The verdict is not flipped on a guess; the reading is named instead.
            const names = namesFor(stepLabels, 'reactant');
            const refiled = moved.map(position => reactants[position].name ?? names[position] ?? reactants[position].formula ?? reactants[position].canonicalSmiles);
            const list = refiled.map(name => `"${name}"`).join(' and ');
            step.refiledReactant = `${list} ${refiled.length > 1 ? 'were' : 'was'} listed under Reactants, and the step balances only if ${refiled.length > 1 ? 'they take' : 'it takes'} no part, so the check treated ${refiled.length > 1 ? 'them' : 'it'} as ${refiled.length > 1 ? 'conditions' : 'a condition'}. If that is right, list ${refiled.length > 1 ? 'them' : 'it'} under Agents. If ${refiled.length > 1 ? 'they are' : 'it is'} genuinely consumed, then the product ${refiled.length > 1 ? 'they become' : 'it becomes'} is missing from this step, and naming it is what makes the equation close.`;
            reactants.splice(0, reactants.length, ...kept);
            agents.splice(0, agents.length, ...asAgents);
            balance = retried;
          }
        }
      }
      // Still refused: when moving one species to the other side makes the step balance (water
      // written as a reactant in an oxidation that forms it), say so — the totals alone did not
      // tell the author which species or which way.
      if (!balance.balanced) {
        const flip = agentRoleThatBalances(reactants, agents, products) || sideFlipThatBalances(reactants, agents, products);
        if (flip) balance.differences = balance.differences.map(entry => `${entry} ${flip}`);
      }
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
      // RDKit's labeller counts every unassigned centre, including bridgeheads a small cage fixes
      // (tropinone's two, which make it meso) — a question the author cannot answer. Where the
      // enumeration says fewer real choices remain, use that.
      // A reactant that is itself stereo-open (α-pinene given without descriptors) is racemic, so a
      // product whose only open choice is its mirror image is racemic too: racemic in, racemic out.
      const racemicReactant = reactants.some((entry) => (stereoChoiceOf(input.stereoChoices?.[entry.input])?.open ?? 0) >= 1);
      for (const entry of products) {
        const choice = stereoChoiceOf(input.stereoChoices?.[entry.input]);
        if (!choice) continue;
        const effective = choice.mirrorOnly && racemicReactant ? 0 : choice.open;
        if (effective < entry.unspecifiedStereocentres) entry.unspecifiedStereocentres = effective;
      }
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
      // A structure carrying a dummy atom is an ABSTRACTION: the author has deliberately left
      // part of it unspecified, an attachment to something not drawn, which is what the engine
      // itself asks them to do. No catalogue record can match such a structure, so resolving the
      // name and comparing would report a disagreement that is really just the abstraction —
      // and the only way to satisfy it would be to write a VAGUER name, one the references
      // cannot resolve at all. Leave the name unchecked rather than wrong. A dummy atom survives
      // canonicalisation as `*` and no real species contains one, so the test is exact.
      const abstracted = declared.canonicalSmiles.includes('*');
      let nameOk: boolean | undefined;
      if (abstracted) {
        // Not checked, and deliberately not counted as unresolved: the name resolved fine, it is
        // the structure that is partly undrawn.
      } else if (candidates.length) {
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
        target.name = raw.name.trim().slice(0, MAX_CHEMICAL_NAME);
        if (raw.byproduct === true) target.byproduct = true;
        if (typeof nameOk === 'boolean') target.nameOk = nameOk;
      }
      if (nameOk === false) {
        const problem = `the name "${raw.name.trim().slice(0, 200)}" denotes a different structure than \`${declared.canonicalSmiles}\`${declared.formula ? ` (${declared.formula})` : ''}`;
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
  let requestedWithoutStereo = false;
  /** How many centres the request itself left open, so a step is held only to what was asked. */
  let openInTarget = 0;
  const requested = typeof input?.target === 'string' ? input.target.trim() : '';
  if (requested) {
    target = { input: requested, canonicalSmiles: null, formula: null, formedAt: null, reason: 'unparsed' };
    try {
      const wanted = await summarize(requested);
      const formedBy = (match: (product: RouteSpeciesSummary) => boolean): number[] =>
        audited.filter(step => step.ok && step.products.some(match)).map(step => step.index);
      const exact = formedBy(product => product.canonicalSmiles === wanted.canonicalSmiles);
      const skeleton = formedBy(product => product.skeletonSmiles === wanted.skeletonSmiles);
      // Whether the request left ANY centre open, which is not the same as leaving them all open.
      // This used to be `stereocentres === 0` — no stereochemistry anywhere — so a target that
      // specified one centre and left another open counted as fully specified, and every step was
      // held to stereochemistry the request had not asked for.
      openInTarget = wanted.unspecifiedStereocentres;
      requestedWithoutStereo = openInTarget > 0;
      // Three ways to have formed it, in falling order of confidence: the same molecule; the same
      // molecule up to the centres the request left open; or, when the request specified nothing,
      // the same constitution. The middle one is new and is the case the author's own targets land
      // in — without it they could not be reported as formed by any route at all.
      const admitted = openInTarget > 0 && wanted.stereocentres > 0
        ? (await Promise.all(audited.map(async (step) => {
          if (!step.ok) return null;
          for (const product of step.products) {
            if (await productMatchesTarget(requested, product.input)) return step.index;
          }
          return null;
        }))).filter((index): index is number => index !== null)
        : [];
      const formed = exact.length ? exact
        : admitted.length ? admitted
        : wanted.stereocentres === 0 ? skeleton : [];
      const formedAt = formed.length ? Math.max(...formed) : null;
      // What the route actually chose where the request left the choice open. Measured from the
      // product, not read out of the answer's prose: the request accepts either configuration, so
      // choosing one is not an error, but which one it chose is the author's to accept and before
      // this nothing reported it.
      const openCentres = formedAt !== null && openInTarget > 0
        ? await (async () => {
          for (const product of audited[formedAt].products) {
            const delivered = await deliveredAtOpenCentres(requested, product.input);
            if (delivered.length) return delivered;
          }
          return [];
        })()
        : [];
      target = {
        input: requested, canonicalSmiles: wanted.canonicalSmiles, formula: wanted.formula,
        formedAt,
        reason: formed.length ? 'formed' : skeleton.length ? 'stereo-mismatch' : 'not-formed',
        ...(openCentres.length ? { openCentres } : {}),
      };
    } catch {
      // Left as `unparsed`: a target that cannot be read says nothing about the route.
    }
  }

  const links = [...linkByKey.values()].sort((a, b) => a.to - b.to || a.from - b.from);

  // Stereochemistry only has to be stated where it can reach the target. When the target was
  // requested without stereo, an intermediate whose configuration is lost before the target —
  // the step consuming it makes a product with nothing open (tropinone-2,4-dicarboxylic acid →
  // tropinone, meso), or makes the target whose only open choice is its mirror image (the
  // aldol adduct → the Wieland–Miescher ketone), or makes an intermediate that is itself lost
  // (isobornyl acetate → isoborneol → camphor) — need not be specified or declared racemic.
  // A target requested with stereo keeps every step held to it.
  // Runs whenever the target was formed, which is the change. It used to require the target to
  // have been requested WITHOUT stereochemistry, on the reasoning that a specified target should
  // hold every step to it. That conflates two different things: a centre that REACHES the target,
  // which must match it, and a centre DESTROYED before the target, which cannot affect it however
  // the target was written. Measured on real routes, every open centre in 219 species was a
  // sulfoxide sulfur — made by an oxidation, removed by the reduction after it, reaching nothing —
  // and because those routes have fully specified targets the excusal never ran and each one
  // blocked its step. The enumeration is no longer required either: the zero case is counted
  // below without it.
  if (target?.reason === 'formed' && target.formedAt !== null) {
    const organicMains = (step: RouteStepAudit) => step.products.filter(product => !product.byproduct && /C/.test(product.formula ?? ''));
    const lost = new Map<number, boolean>();
    for (let index = audited.length - 1; index >= 0; index -= 1) {
      const step = audited[index];
      if (!step.ok) continue;
      const mains = organicMains(step);
      const settled = mains.length > 0 && mains.every((product) => {
        // Nothing unspecified is settled by construction, and the toolkit has already counted
        // that for every species at any size. Asking the enumeration instead answered "unknown"
        // past 60 heavy atoms, so on a route whose intermediates run to 106 atoms nothing was
        // ever settled and no centre downstream of them could be excused.
        if (product.unspecifiedStereocentres === 0) return true;
        const choice = stereoChoiceOf(input.stereoChoices?.[product.input]);
        if (!choice) return false;
        // The mirror clause is only sound where the request left the choice open: delivering the
        // enantiomer of a target that specified its centres is wrong, not moot.
        return choice.open === 0 || (index === target!.formedAt && choice.mirrorOnly && requestedWithoutStereo);
      });
      const consumers = links.filter(item => item.from === index && item.to > index && item.ok).map(item => item.to);
      lost.set(index, settled || (consumers.length > 0 && consumers.every(to => lost.get(to) === true)));
    }
    for (const step of audited) {
      if (!step.ok || step.index === target.formedAt || step.unspecifiedStereocentres === 0 || step.racemic) continue;
      const consumers = links.filter(item => item.from === step.index && item.to > step.index && item.ok).map(item => item.to);
      if (consumers.length && consumers.every(to => lost.get(to) === true)) step.stereoNotRequired = true;
    }
  }

  const blocked: string[] = [];
  for (const step of audited) {
    if (!step.ok) { blocked.push(`Step ${step.index + 1}: ${step.error ?? 'could not be parsed.'}`); continue; }
    for (const problem of step.nameProblems ?? []) blocked.push(`Step ${step.index + 1}: ${problem}.`);
    if (!step.balanced) { blocked.push(`Step ${step.index + 1} is not balanced: ${step.differences.join('; ')}.`); continue; }
    const packing = checkPerMoleculePacking(step);
    if (packing !== 'n/a' && 'unchecked' in packing) {
      step.assemblyUnchecked = packing.unchecked;
    } else if (packing !== 'n/a' && !packing.ok) {
      step.assemblyProblem = packing.reason;
      blocked.push(`Step ${step.index + 1}: ${packing.reason}.`);
      continue;
    }
    const skeletonProblem = await checkSkeleton(step, { rearrangement: declaredRearrangement(step.index), radical: declaredRadical(step.index) });
    if (skeletonProblem) {
      step.skeletonProblem = skeletonProblem;
      blocked.push(`Step ${step.index + 1}: ${skeletonProblem}.`);
      continue;
    }
    if (step.unspecifiedStereocentres > 0 && !step.racemic && !step.stereoNotRequired) blocked.push(`Step ${step.index + 1} leaves ${step.unspecifiedStereocentres} stereocentre(s) or double bond(s) unspecified.`);
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
