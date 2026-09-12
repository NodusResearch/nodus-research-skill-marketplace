import { COUNTRIES, safePath } from './countries.js';

/** Attribution is the part of this package that is not a convenience.
 *
 *  A retrieved law is redistributed under someone else's licence, so every result carries
 *  its repository, its maintainers, the official source, the declared update date and
 *  status, the data licence, the country's own required notice, and a statement of what
 *  Nodus changed. The wording is reproduced exactly as the built-in emitted it: this is a
 *  legal notice, not copy to be improved. */

export function repositoryUrl(country, revision, file) {
  if (!COUNTRIES.some(entry => entry.code === country)) throw new Error('LEGALIZE_COUNTRY_UNSUPPORTED');
  const root = `https://github.com/legalize-dev/legalize-${country}`;
  if (!revision) return root;
  if (!/^[a-f0-9]{40}$/.test(revision) || (file && file !== 'LICENSE' && !safePath(file))) throw new Error('LEGALIZE_INVALID_REFERENCE');
  return `${root}/${file ? 'blob' : 'tree'}/${revision}${file ? '/' + file.split('/').map(encodeURIComponent).join('/') : ''}`;
}

export function attribution(result) {
  const country = COUNTRIES.find(entry => entry.code === result.country);
  return [
    `Legalize — ${country.name}. ${country.authors.map(author => `${author.name} (${author.url})`).join('; ')}`,
    `Repositorio: ${repositoryUrl(country.code, result.revision, result.document?.path)}`,
    `Fuente: ${country.sourceName} (${country.sourceUrl})`,
    ...(result.document ? [`Documento oficial: ${result.document.source}`, `Última actualización declarada: ${result.document.lastUpdated}. Estado declarado: ${result.document.status}.`] : []),
    `Consulta: ${result.fetchedAt}. Versión del repositorio: ${result.revision}.`,
    `Licencia de los datos: ${country.license}\n${country.termsUrl}`,
    `Avisos del repositorio: ${repositoryUrl(country.code, country.revision, 'LICENSE')}`,
    country.attribution,
    'Reproducción automatizada no oficial. La fecha y el estado del repositorio no acreditan vigencia actual. Consulta la fuente oficial. Sin aval de los organismos citados.',
    result.document?.article
      ? `Modificación por Nodus: extracción del artículo ${result.document.article}; texto y metadatos conservados, presentación adaptada. No es la norma completa.`
      : 'Modificación por Nodus: presentación adaptada; texto y metadatos de Legalize conservados. Legalize convierte las fuentes oficiales a Markdown y puede omitir imágenes.',
    country.code === 'us' ? 'Cobertura: United States Code; no incluye legislación estatal, jurisprudencia ni Code of Federal Regulations.' : '',
  ].filter(Boolean).join('\n\n');
}

/** The plain-text export, unchanged from the built-in so a saved copy reads the same. */
export function exportText(result) {
  return `${attribution(result)}\n\n${result.document
    ? `--- METADATOS ORIGINALES ---\n${result.document.metadata}\n\n--- TEXTO RECUPERADO ---\n${result.document.text}`
    : result.matches.map(match => `${match.id}: ${match.title}\n${repositoryUrl(result.country, result.revision, match.path)}`).join('\n\n')}`;
}
