import countries from './countries.json' with { type: 'json' };

export const COUNTRIES = countries;

export const normalize = (text) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Repository paths are data from an untrusted snapshot, so they are checked before use. */
export function safePath(file) {
  return typeof file === 'string'
    && file.length > 0 && file.length <= 512
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').some(part => !part || part === '.' || part === '..');
}

/** Latin ordinal suffixes that make a separate article: "Artículo 31 bis" is not Article 31.
 *  Spanish, French, Italian and Portuguese codes insert articles this way, and an article
 *  number followed by one of these is a different heading, never a continuation. */
export const ARTICLE_SUFFIX = '(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|novies|decies)';
