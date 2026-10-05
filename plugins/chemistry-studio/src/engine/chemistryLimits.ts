// The input limits the capability schema advertises. Kept in one place so a schema that accepts
// an input and an engine that rejects it cannot drift apart: every raise here must be matched in
// capabilities/chemistry/capability.json, and a step with ~40 reactants needs all of them.
export const MAX_REACTION_CHARS = 16000;
/** One species' structure, and a label's structure: the same bound in both places. */
export const MAX_SPECIES_CHARS = 4000;
/** A species label. A species given as its own structure carries that structure as its name. */
export const MAX_LABEL_NAME_CHARS = 4000;
