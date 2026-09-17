import type { ChemistryIntent } from './chemistryDocument';

/** Split a reaction SMILES into its three fields, tolerating one empty extra field.
 *
 *  `A>B>>C` is a frequent typo for `A>B>C`: the empty field carries no species and the
 *  intent is unambiguous, so it is collapsed rather than refused. A string with any other
 *  field count is still rejected. */
export function splitReactionSmiles(source: string): { reactants: string; agents: string; products: string } {
  if (!source || source.length > 4000 || /\s/.test(source)) throw new Error('Provide one complete reaction SMILES without whitespace.');
  let fields = source.split('>');
  if (fields.length === 4 && fields[2] === '') fields = [fields[0], fields[1], fields[3]];
  // `A>B` (one separator) is the common shorthand for `A>>B`: no agents field.
  if (fields.length === 2 && fields[0] && fields[1]) fields = [fields[0], '', fields[1]];
  if (fields.length !== 3 || !fields[0] || !fields[2]) throw new Error('Reaction SMILES must be reactants>agents>products or reactants>>products.');
  return { reactants: fields[0], agents: fields[1], products: fields[2] };
}

/** Split only an explicit, complete reaction SMILES. No guessing from prose,
 *  automatic balancing, omitted agents, or empty dot-components. */
export function reactionSmilesSpecies(source: string): ChemistryIntent['species'] {
  const { reactants, agents, products } = splitReactionSmiles(source);
  const fields = [reactants, agents, products];
  const roles = ['reactant', 'agent', 'product'] as const;
  const species = fields.flatMap((field, i) => {
    if (!field && i === 1) return [];
    return field.split('.').map((value, j) => {
      if (!value) throw new Error('Empty species in reaction SMILES.');
      return { id: `${roles[i]}-${j}`, input: { kind: 'smiles' as const, value }, role: roles[i], coefficient: 1 };
    });
  });
  if (species.length > 12) throw new Error('A reaction scheme supports at most twelve species.');
  return species;
}
