// The input limits the capability schema advertises. Kept in one place so a schema that accepts
// an input and an engine that rejects it cannot drift apart: every CEILING here must be matched in
// capabilities/chemistry/capability.json, and a step with ~40 reactants needs all of them.
//
// WHY THESE ARE DERIVED AND NOT WRITTEN DOWN. Every number below was once a constant, chosen when
// a large context window was 32,000 tokens. The models in use hold 1,000,000. The old constants do
// not fail loudly on a big model — they truncate the exact thing the big model was bought for:
//
//   - MAX_LABELS_TOTAL of 48 stopped RESOLVING NAMES past the 48th distinct one, and the code
//     treats an unresolved name as "unchecked, never a disagreement". So a long route silently
//     stopped being name-checked. One measured chain had 50 distinct species.
//   - the 8,000-character ceiling on the chat question refused the WHOLE compile call once a
//     correction prompt grew past it: 58 refusals across 26 of 30 targets on one sweep (B45).
//
// HOW A CAP IS DERIVED. Not an arbitrary fraction each: a cap is what the thing it bounds may
// cost inside the window. A text cap is a share of the window measured in characters. A count cap
// is that same share divided by what one item costs. The shares are small on purpose — these are
// the parts of one request, not the request.
//
// WHAT IS DELIBERATELY *NOT* DERIVED, so nobody "finishes the job" later. A context window says
// nothing about chemistry or about RDKit's cost. These stay fixed:
//   MAX_COEFFICIENT (what a balanced equation looks like), MAX_CUT (a chemical claim about bond
//   edits), MAX_EMBEDDINGS / MAX_DEPARTURE_CHOICES / TARGET_MATCH_LIMIT (search and match cost),
//   MAX_CACHE_ENTRIES (memory), MAX_SMILES_SOURCE and MAX_SPECIES_CHARS / MAX_LABEL_NAME_CHARS
//   (no systematic name or SMILES gets longer because the model got roomier — 4,000 characters is
//   already far past the longest real one).

/** What the host says this turn's model can hold. Both fields optional: an older host sends
 *  neither, and a model with no documented window sends no window rather than a guess. Absent
 *  means "use the floor", never "unlimited". */
export interface ChemistryCapBudget {
  contextWindowTokens?: number;
  charsPerToken?: number;
}

/** The host's ratio when it did not say. Only used to convert an explicit window. */
const FALLBACK_CHARS_PER_TOKEN = 3.2;

/** Characters the window holds, or null when the host named no window. */
function windowChars(budget?: ChemistryCapBudget): number | null {
  const tokens = budget?.contextWindowTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
  const ratio = typeof budget?.charsPerToken === 'number' && budget.charsPerToken > 0 ? budget.charsPerToken : FALLBACK_CHARS_PER_TOKEN;
  return Math.floor(tokens * ratio);
}

/** One derived cap: never below the floor it has always had, never above the ceiling the schema
 *  advertises. The ceiling is not advice — a value past what `capability.json` declares is refused
 *  by the host before the tool runs, which is precisely how B45 behaved. */
function derive(budget: ChemistryCapBudget | undefined, floor: number, share: number, ceiling: number, costPerItem = 1): number {
  const chars = windowChars(budget);
  if (chars == null) return floor;
  return Math.max(floor, Math.min(ceiling, Math.floor((chars * share) / costPerItem)));
}

// ---- ceilings, which are the contract with capability.json ----------------------------------

/** THE SINGLE SOURCE for every ceiling the schema also declares. `capability.json` must agree with
 *  this object exactly, and `test/chemistry.test.mjs` asserts that it does — because the host
 *  validates the input against the SCHEMA before the tool runs, so a derived cap above what the
 *  schema allows does not stretch the limit, it refuses the call. That is not hypothetical: it is
 *  what B45 was.
 *
 *  These were raised together on 2026-10-08 for a 1,000,000-token window. Two of them were smaller
 *  than the engine behind them, which is the same drift in the other direction:
 *    - `names.items.maxLength` was 200 while the engine slices names at 4,000, and the engine's own
 *      comment says an assembled chain's systematic name "runs to several hundred characters" and
 *      that a cut one resolves to nothing. A long chain was refused before it was looked up.
 *    - `steps.maxItems` was 96 and `labels.items.maxItems` 24, against long linear routes written
 *      one transformation per unit, which is the shape the project is aiming at. */
export const SCHEMA_CEILINGS = {
  /** compile */
  planChars: 64_000,
  questionChars: 64_000,
  /** resolve-names, resolve-structure */
  names: 512,
  nameChars: 4_000,
  structures: 512,
  /** verify-route: steps, and the per-step arrays that must match it one for one */
  steps: 512,
  stepChars: 64_000,
  labelsPerStep: 128,
} as const;

export const REACTION_CHARS_CEILING = SCHEMA_CEILINGS.stepChars;
export const QUESTION_CHARS_CEILING = SCHEMA_CEILINGS.questionChars;

// ---- the derived caps ------------------------------------------------------------------------

/** A whole reaction as text. Floor is what it has always been. */
export const maxReactionChars = (budget?: ChemistryCapBudget): number =>
  derive(budget, 16_000, 0.01, REACTION_CHARS_CEILING);

/** The chat question, which the engine only pattern-matches for intent. It is carried for free by
 *  a short request and is enormous on a route fix round, so it gets a small share and a real
 *  ceiling rather than the whole prompt. */
export const maxQuestionChars = (budget?: ChemistryCapBudget): number =>
  derive(budget, 8_000, 0.02, QUESTION_CHARS_CEILING);

/** Distinct chemical names one request may ask to resolve. ~20 characters each is a generous
 *  systematic name, and 1% of the window is what a route's species list may cost. */
export const maxNames = (budget?: ChemistryCapBudget): number =>
  derive(budget, 48, 0.01, SCHEMA_CEILINGS.names, 20);

/** Names resolved across a whole route. THE ONE THAT WAS SILENTLY TRUNCATING: past this, a name
 *  is left unresolved and reported as unchecked, so the ceiling has to clear a long route. */
export const maxLabelsTotal = (budget?: ChemistryCapBudget): number =>
  derive(budget, 48, 0.02, SCHEMA_CEILINGS.names, 20);

/** Species labels on a single step; a step with ~40 reactants is a real shape. */
export const maxLabelsPerStep = (budget?: ChemistryCapBudget): number =>
  derive(budget, 24, 0.002, SCHEMA_CEILINGS.labelsPerStep, 20);

/** Steps in one route. A long linear assembly, one transformation per unit, runs to dozens. */
export const maxSteps = (budget?: ChemistryCapBudget): number =>
  derive(budget, 96, 0.01, SCHEMA_CEILINGS.steps, 200);

/** Species on one step, and across the route. */
export const maxSpeciesPerStep = (budget?: ChemistryCapBudget): number =>
  derive(budget, 48, 0.002, SCHEMA_CEILINGS.labelsPerStep, 20);
export const maxSpeciesTotal = (budget?: ChemistryCapBudget): number =>
  derive(budget, 1_024, 0.05, SCHEMA_CEILINGS.steps * SCHEMA_CEILINGS.labelsPerStep, 20);

// ---- fixed, and fixed on purpose: see the header ---------------------------------------------

/** One species' structure, and a label's structure: the same bound in both places. Not derived —
 *  no real SMILES or systematic name approaches this, whatever the window. */
export const MAX_SPECIES_CHARS = 4000;
/** A species label. A species given as its own structure carries that structure as its name. */
export const MAX_LABEL_NAME_CHARS = 4000;

/** Kept so existing callers and the schema docs keep a single name for the floor. Prefer
 *  `maxReactionChars(budget)`; this is the value with no window named. */
export const MAX_REACTION_CHARS = 16000;
