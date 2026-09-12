/** Decoder for results written by the built-in.
 *
 *  A `.genomics` asset from 5.3.1 holds the same record this package produces, so an old
 *  conversation keeps rendering after the discipline moved out of the application. The
 *  only difference worth handling is that the built-in wrote `termsVersion` as a date
 *  string; nothing else about the shape changed. */
export function decodeLegacyGenomics(data) {
  if (!data || typeof data !== 'object') return data;
  if (typeof data.termsVersion === 'string') {
    const { termsVersion, ...rest } = data;
    return rest;
  }
  return data;
}
