import type { ChemistryReactionArtifact, ChemistryValidationRequest, ChemistryValidationResult, ReactionSpecies } from './chemistryDocument';
import { compileChemfig } from './chemistry';
import { formulaOf } from './chemistryElements';

type Validate = (request: ChemistryValidationRequest) => Promise<ChemistryValidationResult>;

/** A carbon-free species as upright formula text for the scheme, subscripts and charge
 *  included. A reagent such as sulfuric acid is written H2SO4, not drawn as a stick figure
 *  that hides which reagent it is. Built from the checked element inventory, never the
 *  model's own formula string. */
function formulaTex(composition: Composition): string {
  const body = formulaOf(composition.atoms).replace(/(\d+)/g, '_{$1}');
  const charge = composition.charge === 0 ? '' : composition.charge > 0
    ? `^{${composition.charge > 1 ? composition.charge : ''}+}`
    : `^{${composition.charge < -1 ? -composition.charge : ''}-}`;
  return `$\\mathrm{${body}}${charge}$`;
}

/** Step conditions as text for a ChemFig arrow label. The model's prose carries Unicode
 *  subscripts, degree signs and dashes TeX will not typeset, so map the common ones to ASCII,
 *  keep only characters that are safe in text mode, and set the degree sign in math. Falls
 *  back to no annotation rather than an all-or-nothing drawing. */
function latexArrowText(value: string): string {
  const subscripts: Record<string, string> = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-',
  };
  const degree = '\u0000';
  const text = String(value ?? '')
    .replace(/[₀-₉⁰-⁹⁺⁻]/g, character => subscripts[character] ?? character)
    .replace(/[–—]/g, '-')
    .replace(/°/g, degree)
    // Text mode: letters, digits, spaces and a few safe marks. Everything TeX treats as a
    // control character (% & # _ { } $ ^ \ …) is dropped.
    .replace(/[^A-Za-z0-9 ()+.,\-\/~\u0000]/g, ' ')
    .split(degree).join('$^\\circ$')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 160).trim();
}

/** Break an arrow annotation into at most `maxRows` lines of about `length / maxRows`
 *  characters, on word boundaries. A long phrase becomes a short centred block instead of one
 *  wide line that would outgrow the arrow. */
function wrapArrowText(text: string, maxRows = 4): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const perRow = Math.min(28, Math.max(14, Math.ceil(text.length / maxRows)));
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= perRow || !line) { line = candidate; continue; }
    lines.push(line);
    line = word;
    if (lines.length === maxRows) { line = ''; break; }
  }
  if (line && lines.length < maxRows) lines.push(line);
  return lines.slice(0, maxRows);
}

/** Chemfig's arrow is a fixed `arrow coeff × 5em`, so a wider label needs a bigger coeff.
 *  ~0.5em per character gives coeff ≈ longest line / 10, clamped to a sane range. */
function arrowCoefficient(lines: string[]): number {
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (!longest) return 1;
  return Math.max(1, Math.min(4, Math.round((longest / 10) * 10) / 10));
}

/** Each complete species and each disconnected component goes through the same
 *  independent graph/stereo checks as a standalone drawing. A balanced equation
 *  is not a prediction of chemical feasibility or a verified mechanism. */
export async function renderBalancedReaction(species: ReactionSpecies[], validate: Validate, notes?: string, conditions?: string, racemic?: boolean): Promise<ChemistryReactionArtifact> {
  if (!Array.isArray(species) || species.length < 2 || species.length > 12) throw new Error('A scheme needs two to twelve species.');
  const ids = new Set<string>();
  const totals = { reactant: { atoms: {} as Record<string, number>, charge: 0 }, product: { atoms: {} as Record<string, number>, charge: 0 } };
  const fragments: string[] = [];
  const canonical: ReactionSpecies[] = [];
  // The composition of each species and its drawing, gathered before any coefficient is
  // decided: the equation is assembled once the numbers are known, not as it goes.
  const compositions: Composition[] = [];
  const drawings: string[] = [];
  for (const item of species) {
    if (!item || !/^[a-z][a-z0-9-]{0,39}$/.test(item.id) || ids.has(item.id)
      || !['reactant', 'product', 'agent'].includes(item.role) || !Number.isInteger(item.coefficient) || item.coefficient < 1 || item.coefficient > 12
      || typeof item.smiles !== 'string' || !item.smiles || item.smiles.length > 2000) throw new Error('Invalid reaction species or coefficient.');
    ids.add(item.id);
    const checked = await validate({ references: [item.smiles], ...(racemic ? { racemic: true } : {}) });
    canonical.push({ ...item, smiles: checked.graph.canonicalSmiles });
    const composition: Composition = { atoms: {}, charge: 0 };
    for (const atom of checked.graph.atoms) {
      const key = `${atom.atomicNumber}:${atom.isotope}`;
      composition.atoms[key] = (composition.atoms[key] ?? 0) + 1;
      if (atom.hydrogens) composition.atoms['1:0'] = (composition.atoms['1:0'] ?? 0) + atom.hydrogens;
      composition.charge += atom.charge;
    }
    compositions.push(composition);
    if (!Object.keys(composition.atoms).some((key) => key.startsWith('6:'))) {
      // Carbon-free species are reagents, not skeletons: write the formula.
      drawings.push(formulaTex(composition));
    } else {
      // Preserve every counterion/disconnected fragment. Never silently export
      // only the first spanning tree, as single-component SMILES converters can.
      const components = checked.graph.canonicalSmiles.split('.');
      if (components.length > 8) throw new Error('Too many disconnected components in a species.');
      const sources: string[] = [];
      for (const [index, component] of components.entries()) {
        const result = await validate({ references: [component], exportChemfig: true, ...(racemic ? { racemic: true } : {}) });
        if (result.chemfig?.status !== 'validated' || !result.chemfig.source) throw new Error(`Reaction component export failed: ${result.chemfig?.reason ?? 'missing checked export'}`);
        sources.push(result.chemfig.source.replace(/@\{([ab]\d+)\}/g, `@{${item.id}c${index}$1}`));
      }
      // A salt's coefficient multiplies every ion, so a multi-component species is
      // parenthesised before the coefficient is applied.
      drawings.push(sources.length > 1 ? `(${sources.join(' \\quad ')})` : sources.join(' \\quad '));
    }
  }
  if (!species.some(s => s.role === 'reactant') || !species.some(s => s.role === 'product')) throw new Error('Both reaction sides are required.');

  // Solved, not believed. Coefficients the request already carried are kept when they
  // balance, so a user who wrote their own equation gets their own equation back.
  const coefficients = balanceReaction(compositions, species.map(item => item.role), species.map(item => item.coefficient));
  species.forEach((item, index) => {
    canonical[index] = { ...canonical[index], coefficient: coefficients[index] };
    fragments.push(`{${coefficients[index] > 1 ? `${coefficients[index]}\\,` : ''}${drawings[index]}}`);
    if (item.role === 'agent') return;
    const total = totals[item.role];
    for (const [key, count] of Object.entries(compositions[index].atoms)) total.atoms[key] = (total.atoms[key] ?? 0) + count * coefficients[index];
    total.charge += compositions[index].charge * coefficients[index];
  });
  const group = (role: ReactionSpecies['role']) => species.flatMap((s, i) => s.role === role ? [fragments[i]] : []).join(' \\+ ');
  // Catalysts and solvents are drawn above the arrow, where a reader looks for the reagents,
  // and the step's conditions beneath it, where a reader looks for the temperature and workup.
  const agents = group('agent');
  const arrowConditions = conditions ? latexArrowText(conditions) : '';
  const conditionLines = arrowConditions ? wrapArrowText(arrowConditions, 4) : [];
  // Stacked lines keep a long phrase narrow; the arrow is then sized to the longest line.
  const conditionLabel = conditionLines.length > 1
    ? `\\shortstack{${conditionLines.join(' \\\\ ')}}`
    : conditionLines[0] ?? '';
  const conditionCoeff = arrowCoefficient(conditionLines);
  const buildSource = (withConditions: string, coeff: number): string => {
    const arrow = agents || withConditions
      ? `\\arrow{->[${agents}]${withConditions ? `[${withConditions}]` : ''}}${withConditions ? `[,${coeff}]` : ''}`
      : '\\arrow{->}';
    return `\\schemestart ${group('reactant')} ${arrow} ${group('product')} \\schemestop`;
  };
  let source = buildSource(conditionLabel, conditionCoeff);
  let svg: string;
  let conditionsRendered = Boolean(conditionLabel);
  try {
    svg = await compileChemfig(source);
  } catch (error) {
    // The scheme and its balance are the deliverable. Conditions are model prose that can
    // still defeat TeX after sanitizing, so drop the annotation rather than the drawing.
    if (!conditionLabel) throw error;
    source = buildSource('', 1);
    svg = await compileChemfig(source);
    conditionsRendered = false;
  }
  return { scope: 'balanced-scheme-not-mechanism', svg, species: canonical, balance: totals.reactant, ...(notes ? { notes } : {}), ...(conditionsRendered && conditions ? { conditions } : {}),
    chemfig: { status: 'validated', source, checks: ['Every species/component independently graph- and stereo-checked', 'Coefficients solved here from the element, isotope and charge matrix, not taken on trust; all atoms, isotopes and net charge conserved', 'Every drawn species export round-tripped and the combined ChemFig compiled; carbon-free species are written as formula text', 'Catalysts and solvents are drawn above the arrow and excluded from the equation', 'Model-written conditions are sanitized and written beneath the arrow, unchecked'] },
    limitations: [...(notes ? ['The conditions and electron pushing written beneath the scheme come from the model. Nothing checks them: the balance below is about the equation, not about what the notes claim happens.'] : []),
      ...(conditionsRendered ? ['The conditions written beneath the arrow come from the model. Nothing checks them: the balance is about the equation, not about whether those conditions are right or sufficient.'] : []),
      'This is a balanced scheme, not a verified mechanism or prediction of feasibility, conditions, yield or major product.', 'Balance checks the declared species, coefficients and roles; it does not prove the interpretation of a prose request is complete. Catalysts and solvents are drawn above the arrow and excluded from stoichiometric balance.'] };
}

// ---------------------------------------------------------------- balance

/** What a species contributes to each side: atoms by element and isotope, and charge. */
interface Composition { atoms: Record<string, number>; charge: number }

// Exact rational arithmetic over bigint. Stoichiometric coefficients are integers, and a
// balance decided in floating point would be a balance decided by rounding.
type Frac = [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const t = a % b; a = b; b = t; } return a; };
const norm = (n: bigint, d: bigint): Frac => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return [n / g, d / g]; };
const fSub = (a: Frac, b: Frac): Frac => norm(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const fMul = (a: Frac, b: Frac): Frac => norm(a[0] * b[0], a[1] * b[1]);
const fDiv = (a: Frac, b: Frac): Frac => norm(a[0] * b[1], a[1] * b[0]);
const fZero = (a: Frac): boolean => a[0] === 0n;

/** Gaussian elimination to reduced row echelon form, returning a basis of the null space —
 *  one vector per free column. A balanced equation is exactly a null vector of the
 *  element-and-charge matrix. */
function nullSpace(matrix: bigint[][], columns: number): Frac[][] {
  const rows = matrix.length;
  const m: Frac[][] = matrix.map(row => row.map(value => norm(value, 1n)));
  const pivots: number[] = [];
  let row = 0;
  for (let column = 0; column < columns && row < rows; column++) {
    let pivot = -1;
    for (let i = row; i < rows; i++) if (!fZero(m[i][column])) { pivot = i; break; }
    if (pivot < 0) continue;
    [m[row], m[pivot]] = [m[pivot], m[row]];
    const scale = m[row][column];
    for (let j = 0; j < columns; j++) m[row][j] = fDiv(m[row][j], scale);
    for (let i = 0; i < rows; i++) if (i !== row && !fZero(m[i][column])) {
      const factor = m[i][column];
      for (let j = 0; j < columns; j++) m[i][j] = fSub(m[i][j], fMul(factor, m[row][j]));
    }
    pivots.push(column);
    row++;
  }
  const free: number[] = [];
  for (let column = 0; column < columns; column++) if (!pivots.includes(column)) free.push(column);
  return free.map(freeColumn => {
    const vector: Frac[] = Array.from({ length: columns }, () => [0n, 1n] as Frac);
    vector[freeColumn] = [1n, 1n];
    pivots.forEach((pivotColumn, index) => { vector[pivotColumn] = [-m[index][freeColumn][0], m[index][freeColumn][1]]; });
    return vector;
  });
}

/** The smallest whole-number form of a null vector, or null when it is not a usable
 *  equation: a zero means a species takes no part, and a sign change means one side is
 *  being subtracted from itself. */
function toIntegerCoefficients(vector: Frac[]): number[] | null {
  if (vector.some(fZero)) return null;
  const positive = vector[0][0] > 0n;
  if (vector.some(value => (value[0] > 0n) !== positive)) return null;
  let lcm = 1n;
  for (const value of vector) lcm = (lcm / gcd(lcm, value[1])) * value[1];
  const scaled = vector.map(value => ((value[0] * lcm) / value[1]) * (positive ? 1n : -1n));
  let divisor = 0n;
  for (const value of scaled) divisor = gcd(divisor, value);
  if (divisor === 0n) return null;
  const whole = scaled.map(value => Number(value / divisor));
  return whole.some(value => value > 12) ? null : whole;
}

const ELEMENT_SYMBOLS: Record<number, string> = { 1: 'H', 3: 'Li', 5: 'B', 6: 'C', 7: 'N', 8: 'O', 9: 'F', 11: 'Na', 12: 'Mg', 13: 'Al', 14: 'Si', 15: 'P', 16: 'S', 17: 'Cl', 19: 'K', 35: 'Br', 53: 'I' };
const elementLabel = (key: string): string => {
  const [atomicNumber, isotope] = key.split(':').map(Number);
  const symbol = ELEMENT_SYMBOLS[atomicNumber] ?? `element ${atomicNumber}`;
  return isotope ? `${symbol}-${isotope}` : symbol;
};

/** Which element or charge is actually off, so the answer says what is missing rather than
 *  that something is. */
function imbalanceReason(compositions: Composition[], roles: ReactionSpecies['role'][], supplied: number[]): string {
  const totals = { reactant: {} as Record<string, number>, product: {} as Record<string, number> };
  const charge = { reactant: 0, product: 0 };
  compositions.forEach((composition, index) => {
    const side = roles[index] === 'reactant' ? 'reactant' : roles[index] === 'product' ? 'product' : null;
    if (!side) return;
    const coefficient = Number.isInteger(supplied[index]) && supplied[index] > 0 ? supplied[index] : 1;
    for (const [key, count] of Object.entries(composition.atoms)) totals[side][key] = (totals[side][key] ?? 0) + count * coefficient;
    charge[side] += composition.charge * coefficient;
  });
  const keys = [...new Set([...Object.keys(totals.reactant), ...Object.keys(totals.product)])];
  const differences = keys.filter(key => (totals.reactant[key] ?? 0) !== (totals.product[key] ?? 0))
    .map(key => `${elementLabel(key)}: reactants ${totals.reactant[key] ?? 0}, products ${totals.product[key] ?? 0}`);
  if (charge.reactant !== charge.product) differences.push(`charge: reactants ${charge.reactant}, products ${charge.product}`);
  return differences.length ? differences.join('; ') : 'the element and charge totals cannot be reconciled';
}

/** The species that appear on both sides with the same formula and charge. Such a species
 *  takes no net part — a counterion carried through, Na+ in from sodium amide and Na+ out in
 *  sodium bromide — and cancelling it removes a free coefficient that would otherwise make
 *  an otherwise-unique equation look ambiguous. */
function cancelledSpectators(active: Array<{ composition: Composition; index: number }>, roles: ReactionSpecies['role'][]): Set<number> {
  const signature = (composition: Composition) => `${JSON.stringify(Object.entries(composition.atoms).sort())}|${composition.charge}`;
  const bySide = { reactant: new Map<string, number[]>(), product: new Map<string, number[]>() };
  for (const { composition, index } of active) {
    const role = roles[index];
    if (role !== 'reactant' && role !== 'product') continue;
    const key = signature(composition);
    const list = bySide[role].get(key) ?? [];
    list.push(index);
    bySide[role].set(key, list);
  }
  const removed = new Set<number>();
  for (const [key, reactants] of bySide.reactant) {
    const products = bySide.product.get(key) ?? [];
    const count = Math.min(reactants.length, products.length);
    for (let i = 0; i < count; i++) { removed.add(reactants[i]); removed.add(products[i]); }
  }
  return removed;
}

/** The stoichiometric coefficients, solved rather than believed.
 *
 *  Asking a language model to balance every step of a ten-step route is asking it to do
 *  arithmetic under a deadline, which is where it fails. It lists the species; this decides
 *  the numbers. Coefficients it did supply are kept when they already balance, so a user
 *  who wrote an equation out sees their own equation back. Agents take no part in a balance:
 *  a catalyst is recovered and a solvent is not consumed. A species carried on both sides is
 *  cancelled for the same reason.
 *
 *  A single basis vector is a unique balance. Several means the species admit more than one
 *  equation — ethanol combustion written with both CO and CO2, say — and choosing one would
 *  be inventing a claim about which reaction is meant. */
export function balanceReaction(compositions: Composition[], roles: ReactionSpecies['role'][], supplied: number[]): number[] {
  const active = compositions.map((composition, index) => ({ composition, index })).filter(({ index }) => roles[index] !== 'agent');
  if (!active.some(({ index }) => roles[index] === 'reactant') || !active.some(({ index }) => roles[index] === 'product')) {
    throw new Error('A balanced scheme needs at least one reactant and one product.');
  }
  const sign = (index: number) => roles[index] === 'reactant' ? 1 : -1;
  const matrixFor = (entries: Array<{ composition: Composition; index: number }>): bigint[][] => {
    const keys = new Set<string>();
    for (const { composition } of entries) for (const key of Object.keys(composition.atoms)) keys.add(key);
    const matrix = [...keys].map(key => entries.map(({ composition, index }) => BigInt(sign(index) * (composition.atoms[key] ?? 0))));
    matrix.push(entries.map(({ composition, index }) => BigInt(sign(index) * composition.charge)));
    return matrix;
  };

  const declared = active.map(({ index }) => supplied[index]);
  if (declared.every(value => Number.isInteger(value) && value > 0)
    && matrixFor(active).every(row => row.reduce((sum, value, i) => sum + value * BigInt(declared[i]), 0n) === 0n)) return supplied.slice();

  // Cancel net-zero spectators, then solve what is left. Without this a carried counterion
  // adds a degree of freedom and a correct equation is reported as "more than one balance".
  const removed = cancelledSpectators(active, roles);
  const reduced = active.filter(({ index }) => !removed.has(index));
  if (!reduced.some(({ index }) => roles[index] === 'reactant') || !reduced.some(({ index }) => roles[index] === 'product')) {
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. Add the missing reagent or byproduct — water, a hydrogen halide, ammonia or carbon dioxide are the usual ones — or split this transformation into consecutive balanced steps.`);
  }
  const basis = nullSpace(matrixFor(reduced), reduced.length);
  if (!basis.length) {
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. Add the missing reagent or byproduct — water, a hydrogen halide, ammonia or carbon dioxide are the usual ones — or split this transformation into consecutive balanced steps.`);
  }
  // The dimension of the null space is the question, not whether a particular basis vector
  // happens to come out positive. Two dimensions means infinitely many balanced equations —
  // ethanol burning to a mixture of CO and CO2 is the standard one — and the basis vectors
  // of such a space are combinations, usually with a zero or a negative in them. Judging
  // them one at a time reports "cannot be balanced" for a system with too many answers.
  if (basis.length > 1) {
    throw new Error('The declared species admit more than one balanced equation; name the intended byproducts, or split this transformation into consecutive balanced steps.');
  }
  const solved = toIntegerCoefficients(basis[0]);
  if (!solved) {
    // A zero in the only basis vector means that species takes no part: the equation balances
    // only with it removed. Water or a solvent written into a step that neither consumes nor
    // produces it is the common case, so name the idle molecule rather than the totals.
    const idle = basis[0].map((value, position) => (value[0] === 0n ? position : -1)).filter(position => position >= 0);
    if (idle.length) {
      const names = idle.map(position => `"${formulaOf(reduced[position].composition.atoms)}"`).join(', ');
      throw new Error(`The declared species cannot be balanced: ${names} take(s) no part (coefficient 0), so the equation balances only if ${idle.length > 1 ? 'those molecules are' : 'that molecule is'} removed. Delete the molecule the step neither consumes nor produces — water and a solvent are the usual ones.`);
    }
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. Add the missing reagent or byproduct — water, a hydrogen halide, ammonia or carbon dioxide are the usual ones — or split this transformation into consecutive balanced steps.`);
  }
  const coefficients = supplied.slice();
  reduced.forEach(({ index }, position) => { coefficients[index] = solved[position]; });
  // A cancelled species takes coefficient 1 on each side: equal, so net zero, and the rest
  // of the equation was solved independently of it.
  for (const index of removed) coefficients[index] = 1;
  return coefficients;
}
