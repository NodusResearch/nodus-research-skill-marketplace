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
