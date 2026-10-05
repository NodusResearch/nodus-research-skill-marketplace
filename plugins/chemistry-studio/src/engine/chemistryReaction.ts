import { MAX_SPECIES_CHARS } from './chemistryLimits';
import type { ChemistryReactionArtifact, ChemistryValidationRequest, ChemistryValidationResult, ReactionSpecies } from './chemistryDocument';
import { compileChemfig } from './chemistry';
import { colourChemfigAtoms } from './elementColours';
import { elementSymbol, formulaOf } from './chemistryElements';

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
export async function renderBalancedReaction(species: ReactionSpecies[], validate: Validate, notes?: string, conditions?: string, racemic?: boolean, openStereo?: boolean): Promise<ChemistryReactionArtifact> {
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
      || !['reactant', 'product', 'agent'].includes(item.role) || !Number.isInteger(item.coefficient) || item.coefficient < 1 || item.coefficient > MAX_COEFFICIENT
      || typeof item.smiles !== 'string' || !item.smiles || item.smiles.length > MAX_SPECIES_CHARS) throw new Error('Invalid reaction species or coefficient.');
    ids.add(item.id);
    const checked = await validate({ references: [item.smiles], ...(racemic ? { racemic: true } : {}), ...(openStereo ? { openStereo: true } : {}) });
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
      let drawn = true;
      for (const [index, component] of components.entries()) {
        const result = await validate({ references: [component], exportChemfig: true, ...(racemic ? { racemic: true } : {}), ...(openStereo ? { openStereo: true } : {}) });
        if (result.chemfig?.status !== 'validated' || !result.chemfig.source) { drawn = false; break; }
        sources.push(result.chemfig.source.replace(/@\{([ab]\d+)\}/g, `@{${item.id}c${index}$1}`));
      }
      // A species the ChemFig dialect cannot render — carbon monoxide's zero-hydrogen carbon,
      // a carbene — is written as its formula rather than failing the whole scheme. The
      // equation was already balanced and each graph checked; only the depiction degrades.
      // A salt's coefficient multiplies every ion, so a multi-component species is
      // parenthesised before the coefficient is applied.
      if (!drawn) drawings.push(formulaTex(composition));
      else drawings.push(sources.length > 1 ? `(${sources.join(' \\quad ')})` : sources.join(' \\quad '));
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
    svg = await compileChemfig(colourChemfigAtoms(source));
  } catch (error) {
    // The scheme and its balance are the deliverable. Conditions are model prose that can
    // still defeat TeX after sanitizing, so drop the annotation rather than the drawing.
    if (!conditionLabel) throw error;
    source = buildSource('', 1);
    svg = await compileChemfig(colourChemfigAtoms(source));
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
/** The largest coefficient a solved equation may carry. Redox steps reach the teens: a
 *  permanganate oxidation of a methylarene forms 14 water per 5 substrate. Above this a
 *  balance is more likely a wrong species set than a real equation. The multi-solution search
 *  keeps its own smaller ceiling, since its cost grows with the ceiling to the power of the
 *  solution-space dimension. */
export const MAX_COEFFICIENT = 30;

type Frac = [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const t = a % b; a = b; b = t; } return a; };
const norm = (n: bigint, d: bigint): Frac => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return [n / g, d / g]; };
const fAdd = (a: Frac, b: Frac): Frac => norm(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
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

/** The smallest positive whole-number equation in a multi-dimensional null space, or null when
 *  there is not exactly one.
 *
 *  A null space of dimension > 1 means the declared species admit several balanced equations.
 *  The smallest one — the fewest total moles, every declared species taking part — is almost
 *  always the one intended, and the other basis-vector combinations are scaled-up or
 *  spectator-dropping variants no chemist means. This returns that smallest equation when it is
 *  unique, and null (so the caller asks for a split) when two different equations tie.
 *
 *  The basis is in reduced form, one free column per vector, so the multiplier on each basis
 *  vector is the coefficient of its free column in the result: searching multipliers 1..12 (the
 *  coefficient ceiling) searches every usable equation.
 */
function smallestPositiveEquation(basis: Frac[][]): number[] | null {
  const dimension = Math.min(basis.length, 4); // bounded search; deeper spaces are refused
  const ceiling = 12;
  const best = new Map<string, number[]>();
  let bestSum = Infinity;
  const total = ceiling ** dimension;
  for (let code = 0; code < total; code++) {
    let n = code;
    const vector: Frac[] = basis[0].map(() => [0n, 1n] as Frac);
    for (let b = 0; b < dimension; b++) {
      const multiplier = BigInt((n % ceiling) + 1);
      n = Math.floor(n / ceiling);
      for (let j = 0; j < vector.length; j++) if (!fZero(basis[b][j])) vector[j] = fAdd(vector[j], fMul([multiplier, 1n], basis[b][j]));
    }
    const whole = toIntegerCoefficients(vector);
    if (!whole) continue;
    const sum = whole.reduce((acc, value) => acc + value, 0);
    if (sum > bestSum) continue;
    if (sum < bestSum) { bestSum = sum; best.clear(); }
    best.set(whole.join(','), whole);
  }
  return best.size === 1 ? [...best.values()][0] : null;
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
  return whole.some(value => value > MAX_COEFFICIENT) ? null : whole;
}

// The shared table names every element (a shortfall in Mn or Cr once read "element 25") and the
// solid support, a conserved pseudo-element.
const elementLabel = (key: string): string => {
  const [atomicNumber, isotope] = key.split(':').map(Number);
  const symbol = elementSymbol(atomicNumber);
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

/** Small molecules a step commonly gains or loses, by element counts (keyed "atomic number:isotope",
 *  as compositions are). */
const COMMON_SMALL_MOLECULES: Array<{ name: string; atoms: Record<string, number> }> = [
  { name: 'H2O', atoms: { '1:0': 2, '8:0': 1 } },
  { name: 'CO2', atoms: { '6:0': 1, '8:0': 2 } },
  { name: 'HCl', atoms: { '1:0': 1, '17:0': 1 } },
  { name: 'HBr', atoms: { '1:0': 1, '35:0': 1 } },
  { name: 'HI', atoms: { '1:0': 1, '53:0': 1 } },
  { name: 'NH3', atoms: { '7:0': 1, '1:0': 3 } },
  { name: 'H2', atoms: { '1:0': 2 } },
  { name: 'N2', atoms: { '7:0': 2 } },
  { name: 'O2', atoms: { '8:0': 2 } },
  { name: 'CH3OH', atoms: { '6:0': 1, '1:0': 4, '8:0': 1 } },
  { name: 'C2H5OH', atoms: { '6:0': 2, '1:0': 6, '8:0': 1 } },
  { name: 'CH3COOH', atoms: { '6:0': 2, '1:0': 4, '8:0': 2 } },
];

const GENERIC_ADVICE = 'Add the missing reagent or byproduct — water, a hydrogen halide, ammonia or carbon dioxide are the usual ones — or split this transformation into consecutive balanced steps.';

/** What to do about an unbalanced step, read from the difference at one of each species. When
 *  that difference is exactly one common molecule, name it and its side. When it is a small
 *  remainder no molecule explains (one oxygen: a hydroxy-enone named where the β-hydroxy ketone
 *  was meant) in a step with one organic reactant and one organic product, the named structure
 *  is the likelier fault, and "add water" sent the model round the same step three times. */
function imbalanceAdvice(compositions: Composition[], roles: ReactionSpecies['role'][]): string {
  const difference: Record<string, number> = {};
  let charge = 0;
  compositions.forEach((composition, index) => {
    const sign = roles[index] === 'reactant' ? 1 : roles[index] === 'product' ? -1 : 0;
    if (!sign) return;
    for (const [key, count] of Object.entries(composition.atoms)) difference[key] = (difference[key] ?? 0) + sign * count;
    charge += sign * composition.charge;
  });
  const nonZero = Object.entries(difference).filter(([, count]) => count !== 0);
  if (!nonZero.length || charge !== 0) return GENERIC_ADVICE;
  const matches = (sign: 1 | -1) => COMMON_SMALL_MOLECULES.find(molecule => {
    const keys = new Set([...Object.keys(molecule.atoms), ...nonZero.map(([key]) => key)]);
    return [...keys].every(key => (difference[key] ?? 0) === sign * (molecule.atoms[key] ?? 0));
  });
  const surplus = matches(1);
  if (surplus) return `At one of each species the products lack exactly ${surplus.name}: if the step releases it, list it under Byproducts; otherwise a named structure is wrong.`;
  const deficit = matches(-1);
  if (deficit) return `At one of each species the reactants lack exactly ${deficit.name}: if the step consumes it, list it under Reactants; otherwise a named structure is wrong.`;
  const organic = (role: ReactionSpecies['role']) => compositions.filter((composition, index) => roles[index] === role && (composition.atoms['6:0'] ?? 0) > 0).length;
  const size = nonZero.reduce((sum, [, count]) => sum + Math.abs(count), 0);
  // Only one element off, by one or two atoms, and not hydrogen: no reagent supplies a lone O or
  // C. A mixed difference (O gained and H lost) is usually a missing oxidant or reductant.
  const lone = nonZero.length === 1 && size <= 2 && !nonZero[0][0].startsWith('1:');
  if (lone && organic('reactant') === 1 && organic('product') === 1) {
    const described = nonZero.map(([key, count]) => `${count > 0 ? 'the products lack' : 'the products have an extra'} ${Math.abs(count)} ${elementLabel(key)}`).join(' and ');
    return `No common molecule accounts for the difference (${described}) between this step's one organic reactant and one organic product: the named product (or reactant) is probably not the compound intended. Check its name and structure against what the step forms before adding species.`;
  }
  return GENERIC_ADVICE;
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
/** A species listed on both sides is cancelled as a spectator, which is right when it is one
 *  (a counterion carried through). When the step then cannot balance, the species takes part
 *  after all: the hydrochloride of a product written as `amine.Cl` puts HCl on the product side
 *  while the reaction consumes HCl, and water written as "aqueous" is also formed. Solve again
 *  with each such pair as one net column that may come out consumed or formed; every other
 *  species must still take part. Written back as net + 1 on its side and 1 on the other. */
function netColumnBalance(compositions: Composition[], roles: ReactionSpecies['role'][], active: Array<{ composition: Composition; index: number }>, removed: Set<number>, supplied: number[]): number[] | null {
  const key = (index: number) => JSON.stringify([Object.entries(compositions[index].atoms).sort(), compositions[index].charge]);
  const pairs: Array<[number, number]> = [];
  const used = new Set<number>();
  for (const reactant of [...removed].filter(index => roles[index] === 'reactant')) {
    const product = [...removed].find(index => roles[index] === 'product' && !used.has(index) && key(index) === key(reactant));
    if (product === undefined) continue;
    used.add(product);
    pairs.push([reactant, product]);
  }
  if (!pairs.length) return null;
  const fixed = active.filter(({ index }) => !removed.has(index) || (!pairs.some(([r, p]) => r === index || p === index)));
  const columns = [...fixed.map(({ index }) => ({ index, sign: roles[index] === 'reactant' ? 1 : -1, free: false })),
    ...pairs.map(([reactant]) => ({ index: reactant, sign: 1, free: true }))];
  const keys = new Set<string>();
  for (const { index } of columns) for (const atom of Object.keys(compositions[index].atoms)) keys.add(atom);
  const matrix = [...keys].map(atom => columns.map(({ index, sign }) => BigInt(sign * (compositions[index].atoms[atom] ?? 0))));
  matrix.push(columns.map(({ index, sign }) => BigInt(sign * compositions[index].charge)));
  const basis = nullSpace(matrix, columns.length);
  if (basis.length !== 1) return null;
  const vector = basis[0];
  const fixedValues = vector.filter((_, position) => !columns[position].free);
  if (!fixedValues.length || fixedValues.some(fZero)) return null;
  const positive = fixedValues[0][0] > 0n;
  if (fixedValues.some(value => (value[0] > 0n) !== positive)) return null;
  let lcm = 1n;
  for (const value of vector) lcm = (lcm / gcd(lcm, value[1])) * value[1];
  const scaled = vector.map(value => ((value[0] * lcm) / value[1]) * (positive ? 1n : -1n));
  let divisor = 0n;
  for (const value of scaled) divisor = gcd(divisor, value < 0n ? -value : value);
  if (divisor === 0n) return null;
  const whole = scaled.map(value => Number(value / divisor));
  if (whole.some((value, position) => (columns[position].free ? Math.abs(value) > 2 * MAX_COEFFICIENT : value > MAX_COEFFICIENT))) return null;
  const coefficients = supplied.slice();
  columns.forEach(({ index, free }, position) => {
    if (!free) { coefficients[index] = whole[position]; return; }
    const [reactant, product] = pairs.find(([r]) => r === index)!;
    const net = whole[position];
    coefficients[reactant] = net > 0 ? net + 1 : 1;
    coefficients[product] = net < 0 ? -net + 1 : 1;
  });
  return coefficients;
}

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
  const net = () => (removed.size ? netColumnBalance(compositions, roles, active, removed, supplied) : null);
  if (!reduced.some(({ index }) => roles[index] === 'reactant') || !reduced.some(({ index }) => roles[index] === 'product')) {
    const balancedNet = net();
    if (balancedNet) return balancedNet;
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. ${imbalanceAdvice(compositions, roles)}`);
  }
  const basis = nullSpace(matrixFor(reduced), reduced.length);
  if (!basis.length) {
    const balancedNet = net();
    if (balancedNet) return balancedNet;
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. ${imbalanceAdvice(compositions, roles)}`);
  }
  // The dimension of the null space is the question, not whether a particular basis vector
  // happens to come out positive. Two dimensions means infinitely many balanced equations —
  // ethanol burning to a mixture of CO and CO2 is the standard one — and the basis vectors
  // of such a space are combinations, usually with a zero or a negative in them. Judging
  // them one at a time reports "cannot be balanced" for a system with too many answers.
  if (basis.length > 1) {
    // Several balanced equations: take the smallest one that uses every declared species, and
    // only refuse when two different equations tie for smallest (then the choice would be a
    // guess, so the author splits the step instead).
    const minimal = smallestPositiveEquation(basis);
    if (minimal) {
      const coefficients = supplied.slice();
      reduced.forEach(({ index }, position) => { coefficients[index] = minimal[position]; });
      for (const index of removed) coefficients[index] = 1;
      return coefficients;
    }
    throw new Error('The declared species admit more than one balanced equation; name the intended byproducts, or split this transformation into consecutive balanced steps.');
  }
  const solved = toIntegerCoefficients(basis[0]);
  if (!solved) {
    // A zero in the only basis vector means that species takes no part: the equation balances
    // only with it removed. Water or a solvent written into a step that neither consumes nor
    // produces it is the common case, so name the idle molecule rather than the totals.
    const idle = basis[0].map((value, position) => (value[0] === 0n ? position : -1)).filter(position => position >= 0);
    // ...but only when the idle species are incidental. A spurious byproduct — water, or a
    // phosphine oxide copied in from a different step — is beside the point of the step, and
    // deleting it is the right advice however heavy it happens to be.
    //
    // The case to withhold it for is narrower: when the heaviest species on BOTH sides comes
    // out at zero, the solver has balanced some other equation hiding inside this one, and
    // telling the author to delete the thing the step exists to make sends them in a circle.
    // Seen on a step whose product and its principal precursor were both zeroed while the
    // small leftovers balanced; the real fault was a consumed species declared as an Agent,
    // which the atom totals below name. One side alone is not that: a zeroed product beside a
    // reactant that still carries the step is an ordinary spurious byproduct.
    const heavyAtoms = (position: number) => Object.entries(reduced[position].composition.atoms)
      .filter(([element]) => !element.startsWith('1:')).reduce((sum, [, count]) => sum + count, 0);
    const heaviestOf = (role: ReactionSpecies['role']) => reduced
      .map((_, position) => position).filter(position => roles[reduced[position].index] === role)
      .sort((a, b) => heavyAtoms(b) - heavyAtoms(a))[0];
    const heaviestReactant = heaviestOf('reactant');
    const heaviestProduct = heaviestOf('product');
    const balancedSomethingElse = heaviestReactant !== undefined && heaviestProduct !== undefined
      && idle.includes(heaviestReactant) && idle.includes(heaviestProduct);
    if (idle.length && !balancedSomethingElse) {
      const names = idle.map(position => `"${formulaOf(reduced[position].composition.atoms)}"`).join(', ');
      throw new Error(`The declared species cannot be balanced: ${names} take(s) no part (coefficient 0), so the equation balances only if ${idle.length > 1 ? 'those molecules are' : 'that molecule is'} removed. Delete the molecule the step neither consumes nor produces — water and a solvent are the usual ones.`);
    }
    throw new Error(`The declared species cannot be balanced: ${imbalanceReason(compositions, roles, supplied)}. ${imbalanceAdvice(compositions, roles)}`);
  }
  const coefficients = supplied.slice();
  reduced.forEach(({ index }, position) => { coefficients[index] = solved[position]; });
  // A cancelled species takes coefficient 1 on each side: equal, so net zero, and the rest
  // of the equation was solved independently of it.
  for (const index of removed) coefficients[index] = 1;
  return coefficients;
}
