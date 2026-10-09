import { MAX_REACTION_CHARS } from './chemistryLimits';
import type { ChemistryIntent } from './chemistryDocument';

/** Split a reaction SMILES into its three fields, tolerating one empty extra field.
 *
 *  `A>B>>C` is a frequent typo for `A>B>C`: the empty field carries no species and the
 *  intent is unambiguous, so it is collapsed rather than refused. A string with any other
 *  field count is still rejected. */
export function splitReactionSmiles(source: string): { reactants: string; agents: string; products: string } {
  if (!source || source.length > MAX_REACTION_CHARS || /\s/.test(source)) throw new Error('Provide one complete reaction SMILES without whitespace.');
  let fields = source.split('>');
  if (fields.length === 4 && fields[2] === '') fields = [fields[0], fields[1], fields[3]];
  // `A>B` (one separator) is the common shorthand for `A>>B`: no agents field.
  if (fields.length === 2 && fields[0] && fields[1]) fields = [fields[0], '', fields[1]];
  if (fields.length !== 3 || !fields[0] || !fields[2]) throw new Error('Reaction SMILES must be reactants>agents>products or reactants>>products.');
  return { reactants: fields[0], agents: fields[1], products: fields[2] };
}

/** Split only an explicit, complete reaction SMILES. No guessing from prose,
 *  automatic balancing, omitted agents, or empty dot-components. */
/** Net formal charge of one dot-free SMILES component, read from its bracket atoms: `[O-]`,
 *  `[Na+]`, `[Fe+3]`, `[O--]`. Outside a bracket `-` is a bond and `+` cannot occur. */
function componentCharge(smiles: string): number {
  let charge = 0;
  for (const [, inside] of smiles.matchAll(/\[([^\]]*)\]/g)) {
    const sign = /([+-]+)(\d*)$/.exec(inside.replace(/:\d+$/, ''));
    if (sign) charge += (sign[1][0] === '+' ? 1 : -1) * (sign[2] ? Number(sign[2]) : sign[1].length);
  }
  return charge;
}

/** One side's components grouped into species. A salt is written as its ions, consecutively
 *  (`O=N[O-].[Na+]`): consecutive charged components whose charges sum to zero are one species,
 *  which is how the route check reads them from the author's names. Split on every dot instead, the
 *  sodium of sodium sulfate became two loose [Na+], one cancelled against another salt's and the
 *  other "took no part", so a step that passed its check could not be drawn. Anything that does not
 *  close to zero — a lone ion, or one a neutral species interrupts — stays as separate species. */
function groupSalts(components: string[]): string[] {
  const out: string[] = [];
  let open: string[] = [], charge = 0;
  const flush = () => { out.push(...open); open = []; charge = 0; };
  for (const component of components) {
    const own = componentCharge(component);
    if (!open.length && own === 0) { out.push(component); continue; }
    if (own === 0) { flush(); out.push(component); continue; }
    open.push(component); charge += own;
    if (charge === 0) { out.push(open.join('.')); open = []; }
  }
  flush();
  return out;
}

export function reactionSmilesSpecies(source: string): ChemistryIntent['species'] {
  const { reactants, agents, products } = splitReactionSmiles(source);
  const fields = [reactants, agents, products];
  const roles = ['reactant', 'agent', 'product'] as const;
  const species = fields.flatMap((field, i) => {
    if (!field && i === 1) return [];
    const components = field.split('.');
    if (components.some(value => !value)) throw new Error('Empty species in reaction SMILES.');
    return groupSalts(components).map((value, j) => ({ id: `${roles[i]}-${j}`, input: { kind: 'smiles' as const, value }, role: roles[i], coefficient: 1 }));
  });
  if (species.length > 12) throw new Error('A reaction scheme supports at most twelve species.');
  return species;
}
