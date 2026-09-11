import { COUNTRIES, normalize } from './countries.js';

/** Parses a chat request block and holds it to the grounding rule. */
export function parsePlan(source, question) {
  if (typeof source !== 'string' || source.length > 2000) throw new Error('LEGALIZE_REQUEST_TOO_LONG');
  let plan;
  try { plan = JSON.parse(source); } catch { throw new Error('LEGALIZE_INVALID_JSON'); }
  return groundPlan(plan, question ?? '');
}

/** Shape only: a plan names a catalogued country, a plausible law and, optionally, a
 *  plausible article. This is what a direct tool invocation is held to. */
export function validatePlanShape(plan) {
  const country = COUNTRIES.find(entry => entry.code === plan?.country);
  if (!plan || plan.version !== 1 || !country
    || Object.keys(plan).some(key => !['version', 'country', 'query', 'article'].includes(key))
    || typeof plan.query !== 'string' || plan.query.trim().length < 2 || plan.query.length > 180
    || /[\n\r<>`]/.test(plan.query)
    || (plan.article !== undefined && (typeof plan.article !== 'string' || !/^[\p{L}\p{N}. -]{1,40}$/u.test(plan.article)))) {
    throw new Error('LEGALIZE_INVALID_PLAN');
  }
  return { version: 1, country: plan.country, query: plan.query, ...(plan.article ? { article: plan.article } : {}) };
}

/** Shape, plus the rule that matters in a conversation: the country, the law and the
 *  article each have to appear in the message the user just sent.
 *
 *  This is the whole anti-fabrication guarantee of the skill. It belongs here, where the
 *  question exists — not on the tool, which can also be invoked with no conversation at
 *  all, and where a synthesised question would only be checking itself. */
export function groundPlan(plan, question) {
  const grounded = validatePlanShape(plan);
  const country = COUNTRIES.find(entry => entry.code === grounded.country);
  const haystack = ` ${normalize(question)} `;
  const namedCountry = country.aliases.some(alias => haystack.includes(` ${normalize(alias)} `))
    || new RegExp(`(?:pa[ií]s|country)\\s*[:=]\\s*${country.code}\\b`, 'i').test(question);
  const namedArticle = !grounded.article
    || new RegExp(`(?:art[ií]culo|article|art\\.?|section|§)\\s*${grounded.article.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(question);
  if (!namedCountry || !haystack.includes(` ${normalize(grounded.query)} `) || !namedArticle) throw new Error('LEGALIZE_NOT_IN_MESSAGE');
  return grounded;
}
