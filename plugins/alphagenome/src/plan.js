export const REVISION = 'aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d';
export const TERMS_VERSION = 2;
export const TERMS = 'https://deepmind.google.com/science/alphagenome/terms';
export const OUTPUT_TERMS = 'https://deepmind.google.com/science/alphagenome/output-terms';
export const NOTICE = `By using this information, you agree to AlphaGenome Output Terms of Use found at ${OUTPUT_TERMS}`;
export const CITATION = 'Avsec et al. (2026). Advancing regulatory variant effect prediction with AlphaGenome. Nature 649, 1206–1218. https://doi.org/10.1038/s41586-025-10014-0';

/** Shape only. A plan names a GRCh38 single-nucleotide substitution, a tissue ontology
 *  identifier and one supported output. */
export function validatePlanShape(plan) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'assembly,output,tissue,variant,version'
    || plan.version !== 1 || plan.assembly !== 'GRCh38'
    || typeof plan.variant !== 'string' || !/^chr(?:[1-9]|1\d|2[0-2]|X|Y):[1-9]\d{0,8}:[ACGT]:[ACGT]$/.test(plan.variant)
    || typeof plan.tissue !== 'string' || !/^(?:UBERON|CL):\d{7}$/.test(plan.tissue)
    || !['RNA_SEQ', 'ATAC', 'DNASE', 'CAGE'].includes(plan.output)) throw new Error('GENOMICS_INVALID_PLAN');
  const [, position, ref, alt] = plan.variant.split(':');
  if (ref === alt || Number(position) < 8193) throw new Error('GENOMICS_INTERVAL_IMPOSSIBLE');
  return { version: 1, assembly: 'GRCh38', variant: plan.variant, tissue: plan.tissue, output: plan.output };
}

/** Shape, plus the rule that matters in a conversation: every field was copied from what
 *  the user wrote. Genome coordinates, reference alleles and ontology identifiers cannot
 *  be inferred from a gene name or from memory, and a prediction run on an inferred
 *  variant would be a confident answer about the wrong position. */
export function groundPlan(plan, question) {
  const grounded = validatePlanShape(plan);
  for (const value of [grounded.assembly, grounded.variant, grounded.tissue, grounded.output]) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?<![A-Za-z0-9_:])${escaped}(?![A-Za-z0-9_:])`).test(question ?? '')) throw new Error('GENOMICS_NOT_IN_MESSAGE');
  }
  return grounded;
}

export function parsePlan(source, question) {
  if (typeof source !== 'string' || source.length > 2000) throw new Error('GENOMICS_REQUEST_TOO_LONG');
  let plan;
  try { plan = JSON.parse(source); } catch { throw new Error('GENOMICS_INVALID_JSON'); }
  return groundPlan(plan, question);
}

export function validateResult(value) {
  const result = value;
  if (!result || result.version !== 1 || result.provider !== 'Google DeepMind AlphaGenome'
    || result.sdkRevision !== REVISION || result.model !== 'ALL_FOLDS'
    || result.notice !== NOTICE || result.citation !== CITATION
    || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))
    || typeof result.modifications !== 'string' || result.modifications.length > 1000
    || !Array.isArray(result.tracks) || !result.tracks.length || result.tracks.length > 8
    || !Number.isInteger(result.totalTracks) || result.totalTracks < result.tracks.length) throw new Error('GENOMICS_INVALID_RESULT');
  validatePlanShape(result.plan);
  const [chromosome, position] = result.plan.variant.split(':');
  const start = Number(position) - 1 - 8192;
  if (result.interval?.chromosome !== chromosome || result.interval.start !== start || result.interval.end !== start + 16384) throw new Error('GENOMICS_UNEXPECTED_INTERVAL');
  for (const track of result.tracks) {
    if (!track || typeof track.name !== 'string' || track.name.length > 300
      || typeof track.strand !== 'string' || !['+', '-', '.'].includes(track.strand)
      || !Number.isInteger(track.resolution) || track.resolution < 1 || 16384 % track.resolution !== 0
      || !Array.isArray(track.reference) || !Array.isArray(track.alternate)
      || track.reference.length !== Math.min(256, 16384 / track.resolution)
      || track.reference.length !== track.alternate.length
      || [...track.reference, ...track.alternate].some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('GENOMICS_INVALID_TRACKS');
  }
  return result;
}
