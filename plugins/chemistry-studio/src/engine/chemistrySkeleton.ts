import { moleculeGraph, type MoleculeGraph } from './chemistryValidationCore';
import { elementSymbol } from './chemistryElements';

/** The bond-edit check: which bonds at carbon a step forms and breaks, and whether each new
 *  bond could form at all. Atom balance cannot see this — an equation balances just as well
 *  when a ring closes onto the wrong carbon, when a bromine lands on a carbon no mechanism
 *  reaches, or when the ethyl of an ethoxide is counted into the product's backbone — so the
 *  route checker reads each balanced step as a graph edit.
 *
 *  Each side's carbons form a graph (every C–C bond, order ignored; a species appears once per
 *  coefficient, after dividing the carbon species' coefficients by their common factor). Carbon
 *  fragments that pass through unchanged (a tert-butoxide that leaves as tert-butanol,
 *  triphenylphosphine as its oxide) are set aside. The fewest reactant C–C bonds (none, one or
 *  two) are removed until the rest embeds in the product skeleton; the product bonds left over
 *  are the C–C bonds formed. Among embeddings that explain the step equally well, the one that
 *  changes the fewest heteroatom attachments is taken — a substitution at one carbon (Br out,
 *  O in) counting as one change — which is the mapping a chemist would draw. Under that
 *  mapping, a carbon that gains a heteroatom has formed a C–X bond.
 *
 *  Three findings refuse a step unless its prose declares it:
 *  - a 1,2-shift: a carbon leaves one carbon and bonds to that carbon's neighbour (pinacol,
 *    Wagner–Meerwein, benzilic acid, Wolff…) — cleared by naming a rearrangement;
 *  - a new C–C bond at a carbon nothing activates: no charge, radical, multiple bond,
 *    heteroatom, leaving group or metal on it, and not next to a carbonyl, alkene or arene;
 *  - a new C–heteroatom bond at such a carbon (bromination of a β-CH2).
 *  The last two are cleared by naming a rearrangement or a radical / C–H functionalisation.
 *  A step the search cannot settle within its budget is reported as unchecked, never refused. */

export interface SkeletonSpecies { smiles: string; coefficient?: number }

export interface SkeletonReport {
  change: 'none' | 'formed' | 'cleaved' | 'formed+cleaved' | 'unchecked';
  /** C–C bonds formed and broken. */
  formed: number;
  cleaved: number;
  /** Ring size closed by each formed C–C bond whose two carbons were already connected. */
  ringSizes: number[];
  /** A carbon left one carbon and bonded to that carbon's neighbour. */
  migration: boolean;
  /** A C–C bond was broken but its two carbons remain joined in the product (not a 1,2-shift). */
  reorganised: boolean;
  /** Formed C–C bonds with an end at a carbon nothing activates. */
  unactivated: number;
  /** Carbons nothing activates that gain a bond to a heteroatom, and the elements they gain. */
  unactivatedHetero: number;
  heteroElements: string[];
  /** Carbons that left as unlisted by-products (only with `omittedByproducts`). */
  departed?: number;
  /** Why the step is unchecked. */
  reason?: string;
}

export interface SkeletonOptions {
  /** A recorded reaction usually lists only its main product: let whole carbon fragments of the
   *  left side leave as unlisted by-products (a Boc group, an ester's alkoxy carbon, CO2). Off for a
   *  checked route, whose steps are balanced, so a missing carbon there is still reported. */
  omittedByproducts?: boolean;
}

/** The vertex sets left after dropping whole components of `query` totalling `excess` carbons —
 *  the fragments that departed. With no excess, every vertex in order (the plain search). */
function* keptSets(query: Array<Set<number>>, excess: number): Generator<number[]> {
  const all = query.map((_set, index) => index);
  if (!excess) { yield all; return; }
  const components = connectedComponents(query).filter(c => c.length <= excess).sort((a, b) => a.length - b.length);
  // reach[i][s]: some subset of components i.. totals s carbons. Following only branches that can
  // still total the excess keeps the choice linear per answer; without it, an excess no subset can
  // make (an odd count from two-carbon fragments) explored every subset before giving up.
  const reach: Uint8Array[] = new Array(components.length + 1);
  reach[components.length] = new Uint8Array(excess + 1);
  reach[components.length][0] = 1;
  for (let i = components.length - 1; i >= 0; i -= 1) {
    const next = reach[i + 1], size = components[i].length, here = next.slice();
    for (let total = excess; total >= size; total -= 1) if (next[total - size]) here[total] = 1;
    reach[i] = here;
  }
  if (!reach[0][excess]) return;
  let yielded = 0;
  const chosen: number[][] = [];
  function* pick(from: number, left: number): Generator<number[]> {
    if (left === 0) {
      const gone = new Set(chosen.flat());
      yield all.filter(v => !gone.has(v));
      return;
    }
    for (let i = from; i < components.length && components[i].length <= left; i += 1) {
      if (!reach[i + 1][left - components[i].length]) continue;
      chosen.push(components[i]);
      yield* pick(i + 1, left - components[i].length);
      chosen.pop();
    }
  }
  for (const keep of pick(0, excess)) {
    yield keep;
    if (++yielded >= MAX_DEPARTURE_CHOICES) return;
  }
}

interface SideGraph {
  /** Carbon neighbours of each carbon (carbon numbering, not atom numbering). */
  adjacency: Array<Set<number>>;
  /** Sorted heteroatom neighbours (atomic numbers) of each carbon. */
  hetero: number[][];
  activated: boolean[];
  edges: Array<[number, number]>;
}

interface LoadedSpecies { graph: MoleculeGraph; copies: number }

// Two C–C cleavages cover every rearrangement in the verified-route corpus; more is reported
// unchecked rather than searched. The budget bounds a symmetric cage that matches nowhere.
const MAX_CUT = 2;
const MAX_EMBEDDINGS = 300;
const SEARCH_BUDGET = 400_000;
// Ways to choose the departing fragments that are tried per cut (a recorded reaction's by-products).
const MAX_DEPARTURE_CHOICES = 64;

/** Only carbon-bearing species enter (a bond edit at carbon and a carbon's activation are both
 *  within one molecule). Their coefficients are divided by their common factor: 3 camphene →
 *  3 alcohol is one transformation done three times, and is read as one. */
async function loadSides(reactants: SkeletonSpecies[], products: SkeletonSpecies[]): Promise<[LoadedSpecies[], LoadedSpecies[]]> {
  const load = async (side: SkeletonSpecies[]) => {
    const out: LoadedSpecies[] = [];
    for (const entry of side) {
      const graph = await moleculeGraph(entry.smiles);
      if (graph.elements.includes(6)) out.push({ graph, copies: Math.max(1, Math.round(entry.coefficient ?? 1)) });
    }
    return out;
  };
  const left = await load(reactants), right = await load(products);
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = [...left, ...right].reduce((value, entry) => gcd(value, entry.copies), 0) || 1;
  for (const entry of [...left, ...right]) entry.copies /= divisor;
  return [left, right];
}

function buildSide(species: LoadedSpecies[]): Omit<SideGraph, 'edges'> {
  const elements: number[] = [], charges: number[] = [], radicals: number[] = [];
  const bonds: Array<[number, number, number]> = [];
  for (const { graph, copies } of species) {
    for (let copy = 0; copy < copies; copy += 1) {
      const offset = elements.length;
      elements.push(...graph.elements);
      charges.push(...graph.charges);
      radicals.push(...graph.radicals);
      for (const [a, b, order] of graph.bonds) bonds.push([a + offset, b + offset, order]);
    }
  }
  const neighbours = elements.map(() => [] as number[]);
  const pi = elements.map(() => false);
  for (const [a, b, order] of bonds) {
    neighbours[a].push(b);
    neighbours[b].push(a);
    if (order !== 1) { pi[a] = true; pi[b] = true; }
  }
  const carbons = elements.flatMap((element, atom) => element === 6 ? [atom] : []);
  const carbonOf = new Map(carbons.map((atom, index) => [atom, index]));
  const isHetero = (atom: number) => elements[atom] !== 6 && elements[atom] !== 1;
  return {
    adjacency: carbons.map(atom => new Set(neighbours[atom].filter(n => elements[n] === 6).map(n => carbonOf.get(n)!))),
    hetero: carbons.map(atom => neighbours[atom].filter(isHetero).map(n => elements[n]).sort((x, y) => x - y)),
    activated: carbons.map(atom => charges[atom] !== 0 || radicals[atom] > 0 || pi[atom]
      || neighbours[atom].some(isHetero)
      || neighbours[atom].some(n => elements[n] === 6 && pi[n])),
  };
}

function connectedComponents(adjacency: Array<Set<number>>): number[][] {
  const seen = new Uint8Array(adjacency.length);
  const out: number[][] = [];
  for (let start = 0; start < adjacency.length; start += 1) {
    if (seen[start]) continue;
    seen[start] = 1;
    const component = [start];
    for (let head = 0; head < component.length; head += 1) {
      for (const next of adjacency[component[head]]) if (!seen[next]) { seen[next] = 1; component.push(next); }
    }
    out.push(component);
  }
  return out;
}

/** A short string hash (FNV-1a), to keep colour refinement's labels from growing. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

/** Colour refinement over a component, carbons labelled by their heteroatom neighbours. Equal
 *  hashes are only candidates for "the same fragment"; an exact embedding confirms them. */
function componentHash(side: Omit<SideGraph, 'edges'>, component: number[]): string {
  let colour = new Map(component.map(vertex => [vertex, side.hetero[vertex].join(',')]));
  for (let round = 0; round < 4; round += 1) {
    colour = new Map(component.map(vertex => [vertex, digest(`${colour.get(vertex)}|${[...side.adjacency[vertex]].map(n => colour.get(n)).sort().join(';')}`)]));
  }
  return `${component.length}:${[...colour.values()].sort().join(',')}`;
}

function induced(side: Omit<SideGraph, 'edges'>, keep: number[]): SideGraph {
  const index = new Map(keep.map((vertex, position) => [vertex, position]));
  const adjacency = keep.map(vertex => new Set([...side.adjacency[vertex]].filter(n => index.has(n)).map(n => index.get(n)!)));
  const edges: Array<[number, number]> = [];
  adjacency.forEach((set, a) => set.forEach(b => { if (a < b) edges.push([a, b]); }));
  return { adjacency, hetero: keep.map(vertex => side.hetero[vertex]), activated: keep.map(vertex => side.activated[vertex]), edges };
}

const sameHetero = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Pair off carbon fragments that appear unchanged on both sides — same skeleton, same
 *  heteroatoms on every carbon — and return both sides without them. */
function withoutSpectators(left: Omit<SideGraph, 'edges'>, right: Omit<SideGraph, 'edges'>, budget: { left: number }): [SideGraph, SideGraph] {
  const leftComponents = connectedComponents(left.adjacency), rightComponents = connectedComponents(right.adjacency);
  const rightHashes = rightComponents.map(component => componentHash(right, component));
  const usedRight = new Set<number>();
  const dropLeft = new Set<number>(), dropRight = new Set<number>();
  for (const component of leftComponents) {
    const hash = componentHash(left, component);
    for (let candidate = 0; candidate < rightComponents.length; candidate += 1) {
      if (usedRight.has(candidate) || rightHashes[candidate] !== hash) continue;
      const a = induced(left, component), b = induced(right, rightComponents[candidate]);
      if (a.edges.length !== b.edges.length) continue;
      const exact = (q: number, t: number) => sameHetero(a.hetero[q], b.hetero[t]);
      const match = embeddings(a.adjacency, b.adjacency, budget, exact, exact).next();
      if (match.done) continue;
      usedRight.add(candidate);
      component.forEach(vertex => dropLeft.add(vertex));
      rightComponents[candidate].forEach(vertex => dropRight.add(vertex));
      break;
    }
  }
  return [
    induced(left, [...left.adjacency.keys()].filter(vertex => !dropLeft.has(vertex))),
    induced(right, [...right.adjacency.keys()].filter(vertex => !dropRight.has(vertex))),
  ];
}

/** Embeddings of `query` in `target`, both on the same number of vertices: bijections that carry
 *  every query edge onto a target edge (the target may have more). Query vertices are taken in
 *  breadth-first order so each, after the first of its component, extends an already-mapped
 *  neighbour; candidates the `prefer` test accepts are tried first, and `allow`, when given,
 *  forbids the rest. `budget.left` counts candidate tests and stops the search when it runs out. */
function* embeddings(query: Array<Set<number>>, target: Array<Set<number>>, budget: { left: number },
  prefer?: (q: number, t: number) => boolean, allow?: (q: number, t: number) => boolean): Generator<Int32Array> {
  const n = query.length;
  const order: number[] = [];
  const seen = new Uint8Array(n);
  const byDegree = [...query.keys()].sort((a, b) => query[b].size - query[a].size);
  for (const start of byDegree) {
    if (seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const vertex = queue[head];
      order.push(vertex);
      for (const next of [...query[vertex]].sort((a, b) => query[b].size - query[a].size)) {
        if (!seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
  }
  const anchor = order.map((vertex, position) => order.slice(0, position).find(earlier => query[vertex].has(earlier)) ?? -1);
  const everyTarget = [...target.keys()];
  const map = new Int32Array(n).fill(-1);
  const used = new Uint8Array(n);
  function* extend(position: number): Generator<Int32Array> {
    if (position === n) { yield map.slice(); return; }
    const vertex = order[position];
    let candidates = anchor[position] >= 0 ? [...target[map[anchor[position]]]] : everyTarget;
    if (prefer) candidates = [...candidates.filter(t => prefer(vertex, t)), ...candidates.filter(t => !prefer(vertex, t))];
    for (const candidate of candidates) {
      if (used[candidate]) continue;
      if (--budget.left < 0) return;
      if (target[candidate].size < query[vertex].size) continue;
      if (allow && !allow(vertex, candidate)) continue;
      let fits = true;
      for (const neighbour of query[vertex]) {
        const image = map[neighbour];
        if (image >= 0 && !target[candidate].has(image)) { fits = false; break; }
      }
      if (!fits) continue;
      map[vertex] = candidate; used[candidate] = 1;
      yield* extend(position + 1);
      map[vertex] = -1; used[candidate] = 0;
      if (budget.left < 0) return;
    }
  }
  yield* extend(0);
}

/** A bijection can only exist when, degree for degree, the target is at least as connected. */
function degreesAllow(query: Array<Set<number>>, target: Array<Set<number>>): boolean {
  const q = query.map(set => set.size).sort((a, b) => b - a);
  const t = target.map(set => set.size).sort((a, b) => b - a);
  return q.every((degree, index) => degree <= t[index]);
}

/** Heteroatoms in `after` that are not in `before` (both sorted), as a multiset. */
function gained(before: number[], after: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  for (const element of after) {
    while (i < before.length && before[i] < element) i += 1;
    if (i < before.length && before[i] === element) i += 1;
    else out.push(element);
  }
  return out;
}

function connected(adjacency: Array<Set<number>>, from: number, to: number): boolean {
  return ringSize(adjacency, from, to) !== null;
}

function ringSize(adjacency: Array<Set<number>>, from: number, to: number): number | null {
  const distance = new Map([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const vertex = queue[head];
    if (vertex === to) return distance.get(vertex)! + 1;
    for (const next of adjacency[vertex]) if (!distance.has(next)) { distance.set(next, distance.get(vertex)! + 1); queue.push(next); }
  }
  return null;
}

function* cuts(count: number, size: number): Generator<number[]> {
  if (size === 0) { yield []; return; }
  if (size === 1) { for (let i = 0; i < count; i += 1) yield [i]; return; }
  for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) yield [i, j];
}

const blank = (change: SkeletonReport['change'], reason?: string): SkeletonReport =>
  ({ change, formed: 0, cleaved: 0, ringSizes: [], migration: false, reorganised: false, unactivated: 0, unactivatedHetero: 0, heteroElements: [], ...(reason ? { reason } : {}) });

const better = (a: number[], b: number[]) => {
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};

/** The net bonds a balanced step makes (positive) and breaks (negative), by element pair, over
 *  every species and coefficient — N–O, O–O, C–metal as much as C–C. Bond order is not counted
 *  (C=O → C–OH is no change), and bonds to hydrogen are left out. Coefficients are divided by
 *  their common factor so the ledger describes one transformation. A pair both made and broken
 *  in the same step nets out; the carbon mapping above reports C–C in full. */
export async function bondLedger(reactants: SkeletonSpecies[], products: SkeletonSpecies[]): Promise<Record<string, number>> {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const copies = (entry: SkeletonSpecies) => Math.max(1, Math.round(entry.coefficient ?? 1));
  const divisor = [...reactants, ...products].reduce((value, entry) => gcd(value, copies(entry)), 0) || 1;
  const tally = new Map<string, number>();
  const pair = (a: number, b: number) => [elementSymbol(a), elementSymbol(b)]
    .sort((x, y) => x === 'C' ? -1 : y === 'C' ? 1 : x.localeCompare(y)).join('–');
  for (const [side, sign] of [[reactants, -1], [products, 1]] as const) {
    for (const entry of side) {
      const graph = await moleculeGraph(entry.smiles);
      const weight = (sign * copies(entry)) / divisor;
      for (const [a, b] of graph.bonds) {
        if (graph.elements[a] === 1 || graph.elements[b] === 1) continue;
        const key = pair(graph.elements[a], graph.elements[b]);
        tally.set(key, (tally.get(key) ?? 0) + weight);
      }
    }
  }
  const order = (key: string) => key === 'C–C' ? '0' : key.startsWith('C–') ? `1${key}` : `2${key}`;
  return Object.fromEntries([...tally].filter(([, net]) => net !== 0).sort(([a], [b]) => order(a).localeCompare(order(b))));
}

export async function skeletonChange(reactants: SkeletonSpecies[], products: SkeletonSpecies[], options: SkeletonOptions = {}): Promise<SkeletonReport> {
  const [left, right] = await loadSides(reactants, products);
  const budget = { left: SEARCH_BUDGET };
  const [r, p] = withoutSpectators(buildSide(left), buildSide(right), budget);
  // Carbons can leave as an unlisted by-product (only when the caller says by-products are
  // omitted); they cannot arrive from nowhere.
  const excess = r.adjacency.length - p.adjacency.length;
  if (excess < 0 || (excess > 0 && !options.omittedByproducts)) return blank('unchecked', `${r.adjacency.length} carbons on the left, ${p.adjacency.length} on the right`);
  // Every product carbon was an unchanged spectator; what is left on the left departed.
  if (!p.adjacency.length) return excess ? { ...blank('none'), departed: excess } : blank('none');
  const prefer = (q: number, t: number) => sameHetero(r.hetero[q], p.hetero[t]);
  // Dropped fragments take their own C–C bonds with them, so the edge-count bound only holds
  // when nothing departs.
  const fewest = excess ? 0 : Math.max(0, r.edges.length - p.edges.length);
  // With fragments departing, how many bonds change is no longer fixed by the cut size: dropping
  // the real starting material and stitching the product from solvent fragments needs no cut but
  // many new bonds. So the reading with the fewest bond changes wins, searched past the first cut
  // size until no larger cut could do better. (Nothing departing: the first size found, as before.)
  let overall: { score: number[]; report: SkeletonReport } | null = null;
  for (let size = fewest; size <= MAX_CUT; size += 1) {
    let best: { score: number[]; report: SkeletonReport } | null = null;
    for (const cut of cuts(r.edges.length, size)) {
      const query = r.adjacency.map(set => new Set(set));
      for (const index of cut) { const [a, b] = r.edges[index]; query[a].delete(b); query[b].delete(a); }
      for (const keep of keptSets(query, excess)) {
        // Choosing what departs is search work too: charged to the budget, so a large molecule's
        // many cut-and-drop combinations end as "unchecked" instead of running for minutes. (With
        // nothing departing there is one choice per cut and the accounting is unchanged.)
        if (excess) {
          budget.left -= keep.length;
          if (budget.left < 0) return blank('unchecked', 'the skeleton search ran out of budget');
        }
        // The kept carbons, renumbered 0..n-1 for the search (identity when nothing departs).
        const local = new Int32Array(r.adjacency.length).fill(-1);
        keep.forEach((vertex, index) => { local[vertex] = index; });
        const kept = excess ? keep.map(v => new Set([...query[v]].filter(u => local[u] >= 0).map(u => local[u]))) : query;
        if (!degreesAllow(kept, p.adjacency)) continue;
        let seen = 0;
        for (const found of embeddings(kept, p.adjacency, budget, excess ? (q, t) => prefer(keep[q], t) : prefer)) {
          // map: left carbon -> product carbon (-1 for a departed carbon); inverse: the reverse.
          const map = new Int32Array(r.adjacency.length).fill(-1);
          const inverse = new Int32Array(p.adjacency.length);
          found.forEach((image, index) => { map[keep[index]] = image; inverse[image] = keep[index]; });
          const formed = p.edges.map(([x, y]) => [inverse[x], inverse[y]] as [number, number]).filter(([a, b]) => !query[a].has(b));
          const cleaved = cut.map(index => r.edges[index]);
          // A bond cut to let a fragment depart (decarboxylation's CO2) is not a skeletal shift.
          const within = cleaved.filter(([a, b]) => map[a] >= 0 && map[b] >= 0);
          // A substitution at one carbon (Br out, O in) is one change: count the larger of what
          // the carbon loses and what it gains.
          let heteroEdits = 0;
          const heteroAtUnactivated: number[] = [];
          for (const vertex of keep) {
            const image = map[vertex];
            const gain = gained(r.hetero[vertex], p.hetero[image]);
            const loss = gained(p.hetero[image], r.hetero[vertex]);
            heteroEdits += Math.max(gain.length, loss.length);
            if (gain.length && !r.activated[vertex]) heteroAtUnactivated.push(...gain);
          }
          const migration = formed.some(bond => within.some(broken => bond.some(shared => {
            if (!broken.includes(shared)) return false;
            const arrives = bond[0] === shared ? bond[1] : bond[0];
            const leaves = broken[0] === shared ? broken[1] : broken[0];
            return r.adjacency[arrives].has(leaves);
          })));
          const unactivated = formed.filter(([a, b]) => !(r.activated[a] && r.activated[b])).length;
          // A broken C–C bond whose two carbons are still joined in the product: the skeleton is
          // reorganised, not cut (a decarboxylation's CO2 carbon leaves the molecule; a Cope or a
          // ring expansion stays). Only a rearrangement explains it.
          const reorganised = !migration && formed.length > 0 && within.some(([a, b]) => connected(p.adjacency, map[a], map[b]));
          const unactivatedHetero = heteroAtUnactivated.length;
          const score = excess
            ? [formed.length + cleaved.length, heteroEdits, migration || reorganised ? 1 : 0, unactivated, unactivatedHetero]
            : [heteroEdits, migration || reorganised ? 1 : 0, unactivated, unactivatedHetero];
          if (!best || better(score, best.score)) {
            const ringSizes = formed.map(([a, b]) => ringSize(r.adjacency, a, b)).filter((value): value is number => value !== null);
            const change = !formed.length && !cleaved.length ? 'none' : !cleaved.length ? 'formed' : !formed.length ? 'cleaved' : 'formed+cleaved';
            best = { score, report: { change, formed: formed.length, cleaved: cleaved.length, ringSizes, migration, reorganised, unactivated, unactivatedHetero,
              heteroElements: [...new Set(heteroAtUnactivated)].sort((x, y) => x - y).map(elementSymbol), ...(excess ? { departed: excess } : {}) } };
          }
          if (++seen >= MAX_EMBEDDINGS) break;
        }
        if (budget.left < 0) return blank('unchecked', 'the skeleton search ran out of budget');
      }
    }
    if (best && !excess) return best.report;
    if (best && (!overall || better(best.score, overall.score))) overall = best;
    // A larger cut changes at least size + 1 bonds, so once nothing larger can do strictly better
    // the search stops (a tie keeps the smaller cut, as when nothing departs).
    if (overall && overall.score[0] <= size + 1) return overall.report;
  }
  if (overall) return overall.report;
  return blank('unchecked', `the step breaks more than ${MAX_CUT} C–C bonds`);
}
