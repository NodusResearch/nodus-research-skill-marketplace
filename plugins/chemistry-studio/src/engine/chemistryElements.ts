/** Element symbols by atomic number, and the two derived labels the chemistry engine
 *  writes: a formula for a species and an element label for a balance shortfall. Kept in
 *  one place so a route audit and a reaction artifact describe the same element the same way. */
export const ELEMENT_SYMBOLS: readonly string[] = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'];

/** A solid support — a resin with its linker, in a solid-phase synthesis — is written as one `*`
 *  (atomic number 0) at its attachment atom. It is conserved like an element: a loading step
 *  consumes a support species and a cleavage step releases one. */
export const SUPPORT = 0;

export const elementSymbol = (atomicNumber: number): string => atomicNumber === SUPPORT ? '(support)' : ELEMENT_SYMBOLS[atomicNumber] ?? `E${atomicNumber}`;

const parseKey = (key: string): { z: number; isotope: number } => {
  const [z, isotope] = key.split(':').map(Number);
  return { z, isotope: isotope || 0 };
};

/** Hydrogen, the noble gases, the metalloids and the other non-metals: every element that is not a
 *  metal. Defined by exclusion so a metal nobody thought to list is still a metal. */
const NON_METALS = new Set([1, 2, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 32, 33, 34, 35, 36, 51, 52, 53, 54, 85, 86, 117, 118]);

/** Whether a composition key (`11:0`) is a metal. The support pseudo-element is not. */
export const isMetalKey = (key: string): boolean => {
  const { z } = parseKey(key);
  return z !== SUPPORT && Number.isInteger(z) && z > 0 && !NON_METALS.has(z);
};

/** `12C`, `C`, `15N` — an isotope is spelled before its symbol when it is not the natural one. */
export const elementLabel = (key: string): string => {
  const { z, isotope } = parseKey(key);
  const symbol = elementSymbol(z);
  return isotope ? `${isotope}${symbol}` : symbol;
};

/**
 * Common inorganic reagents in the formula a chemist writes rather than the Hill order an
 * algorithm would. Hill is correct but makes familiar species unrecognisable: sulfuric acid
 * is H2O4S and sodium hydroxide is HNaO. Keyed by the Hill string formulaOf would otherwise
 * return. Organic species are never remapped, so benzene stays C6H6. Display only — balance
 * and identity are computed from the element inventory, never from this string.
 */
const CONVENTIONAL_FORMULAS: Record<string, string> = {
  // acids and bases
  H2O4S: 'H2SO4', H2O3S: 'H2SO3', H3O4P: 'H3PO4', H3O3P: 'H3PO3',
  H3N: 'NH3', H4N: 'NH4', H2N: 'NH2', HO: 'OH', H4N2: 'N2H4',
  HNaO: 'NaOH', HKO: 'KOH', HNa: 'NaH', H2NNa: 'NaNH2', H4BNa: 'NaBH4', H4AlLi: 'LiAlH4',
  // oxides and sulfur/silicon halides
  O2S: 'SO2', O3S: 'SO3', O4S: 'SO4', HO4S: 'HSO4', O2Si: 'SiO2',
  Cl2OS: 'SOCl2', Cl2O2S: 'SO2Cl2',
  // oxoanion salts
  NNaO3: 'NaNO3', NNaO2: 'NaNO2', N3Na: 'NaN3',
  Na2O4S: 'Na2SO4', K2O4S: 'K2SO4', MgO4S: 'MgSO4', CuO4S: 'CuSO4', O4SZn: 'ZnSO4',
  CNa2O3: 'Na2CO3', CHNaO3: 'NaHCO3', CK2O3: 'K2CO3', CCaO3: 'CaCO3', CH2O3: 'H2CO3', CHO3: 'HCO3',
  // metal halides and hydrides
  ClNa: 'NaCl', BrNa: 'NaBr', INa: 'NaI', FNa: 'NaF', ClK: 'KCl', BrK: 'KBr',
  Cl2Mg: 'MgCl2', Cl2Zn: 'ZnCl2', Cl2Cu: 'CuCl2', Cl2Fe: 'FeCl2', Cl3Fe: 'FeCl3',
  Br2Fe: 'FeBr2', Br3Fe: 'FeBr3', Cl2Sn: 'SnCl2', Cl4Sn: 'SnCl4', Cl4Ti: 'TiCl4',
  Cl3Al: 'AlCl3', Br3Al: 'AlBr3', Br3P: 'PBr3', Cl3P: 'PCl3', Cl5P: 'PCl5', F4Si: 'SiF4',
};

/** Hill order — carbon, then hydrogen, then everything else alphabetically — with isotope
 *  labels and no charge suffix (charge is reported separately). Common inorganic reagents
 *  are returned in the conventional formula a reader recognises. */
export function formulaOf(composition: Record<string, number>): string {
  const rank = (key: string): number => { const { z } = parseKey(key); return z === 6 ? 0 : z === 1 ? 1 : 2; };
  const supports = Object.entries(composition).filter(([key, count]) => count > 0 && parseKey(key).z === SUPPORT).reduce((n, [, count]) => n + count, 0);
  const hill = Object.entries(composition)
    .filter(([key, count]) => count > 0 && parseKey(key).z !== SUPPORT)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || elementLabel(a[0]).localeCompare(elementLabel(b[0])))
    .map(([key, count]) => `${elementLabel(key)}${count > 1 ? count : ''}`)
    .join('');
  const formula = CONVENTIONAL_FORMULAS[hill] ?? hill;
  return supports ? `${formula}–(support)${supports > 1 ? `×${supports}` : ''}` : formula;
}
