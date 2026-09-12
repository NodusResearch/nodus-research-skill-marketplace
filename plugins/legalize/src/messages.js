/** Copy the package owns, in every language Nodus ships.
 *
 *  The built-in used to throw its messages in Spanish from the main process, where the
 *  translation layer could not reach them: a Turkish user got Spanish. A package carries
 *  its own strings instead, and picks by the locale the host passes in. */

const STRINGS = {
  en: {
    article: 'article', snapshot: 'snapshot', identifier: 'Identifier', title: 'Title',
    officialSource: 'Official source', repository: 'Repository in the snapshot',
    attribution: 'Sources, licence and attribution',
    truncated: 'The text is shown truncated. Download the full result or ask for a specific article.',
    moreMatches: '{total} laws matched. Refine the title or give an exact identifier.',
    'notOfficial.title': 'Unofficial reproduction',
    'notOfficial.body': 'This is an automated reproduction of an official source. The repository date and status do not establish that this text is currently in force; check the official source before relying on it.',
    'candidates.title': 'Candidate laws',
    'candidates.body': 'These are candidates, not a confirmed answer. Ask again with an exact title or identifier to retrieve one.',
    'noMatch.title': 'No match in this snapshot',
    'noMatch.body': 'The snapshot has no law matching that title or identifier. Coverage is partial, so this does not establish that the law does not exist.',
    'error.LEGALIZE_REQUEST_TOO_LONG': 'The request is too long.',
    'error.LEGALIZE_INVALID_JSON': 'The request was not valid JSON.',
    'error.LEGALIZE_INVALID_PLAN': 'Name a country from the catalogue and the title or identifier of the law.',
    'error.LEGALIZE_NOT_IN_MESSAGE': 'The country, the law and the article have to appear in your current message; they cannot be inferred.',
    'error.LEGALIZE_COUNTRY_UNSUPPORTED': 'That country is pending a licence review.',
    'error.LEGALIZE_ALREADY_RUNNING': 'A query for this country is already running.',
    'error.LEGALIZE_RATE_LIMITED': 'GitHub rate limit reached. Try again later.',
    'error.LEGALIZE_NO_REVISION': 'The repository version could not be pinned.',
    'error.LEGALIZE_NOTICES_CHANGED': 'The repository notices have changed. Its licence has to be reviewed before this version can be consulted.',
    'error.LEGALIZE_NO_METADATA': 'The document has no compatible metadata.',
    'error.LEGALIZE_DOCUMENT_MISMATCH': 'The document country or identifier does not match.',
    'error.LEGALIZE_NO_SOURCE': 'The document declares no official source.',
    'error.LEGALIZE_INVALID_SOURCE': 'The document declares an invalid source.',
    'error.LEGALIZE_ARTICLE_NOT_UNIQUE': 'No single heading for that article was found. Ask for the whole law by its identifier.',
    'error.LEGALIZE_TOO_LONG': 'The law is too long for one message. Ask for a specific article, or open the repository link.',
    'error.LEGALIZE_CATALOGUE_UNAVAILABLE': 'The country catalogue could not be downloaded.',
    'error.LEGALIZE_CATALOGUE_TOO_LARGE': 'The catalogue exceeds the limits of this version. Use an exact identifier.',
    'error.LEGALIZE_CATALOGUE_INCOMPLETE': 'The catalogue is incompatible or incomplete, so a "not found" answer would not be trustworthy. Use an exact identifier.',
    'error.LEGALIZE_DOCUMENT_ABSENT': 'The document is absent from the version consulted.',
    'error.LEGALIZE_INVALID_CATALOGUE_PATH': 'The catalogue declares an invalid path.',
    'error.LEGALIZE_NOT_FOUND': 'The repository returned nothing for that request.',
    'error.LEGALIZE_UNAVAILABLE': 'GitHub is unavailable right now.',
    'error.LEGALIZE_INVALID_REFERENCE': 'Invalid repository reference.',
  },
  es: {
    article: 'artículo', snapshot: 'versión', identifier: 'Identificador', title: 'Título',
    officialSource: 'Fuente oficial', repository: 'Repositorio en esta versión',
    attribution: 'Fuentes, licencia y atribución',
    truncated: 'El texto se muestra recortado. Descarga el resultado completo o pide un artículo concreto.',
    moreMatches: 'Coinciden {total} normas. Afina el título o indica un identificador exacto.',
    'notOfficial.title': 'Reproducción no oficial',
    'notOfficial.body': 'Es una reproducción automatizada de una fuente oficial. La fecha y el estado del repositorio no acreditan que este texto esté vigente; consulta la fuente oficial antes de confiar en él.',
    'candidates.title': 'Normas candidatas',
    'candidates.body': 'Son candidatas, no una respuesta confirmada. Vuelve a preguntar con el título exacto o el identificador para recuperar una.',
    'noMatch.title': 'Sin coincidencias en esta versión',
    'noMatch.body': 'Esta versión no contiene ninguna norma con ese título o identificador. La cobertura es parcial, así que esto no demuestra que la norma no exista.',
    'error.LEGALIZE_REQUEST_TOO_LONG': 'La solicitud es demasiado larga.',
    'error.LEGALIZE_INVALID_JSON': 'La solicitud no era JSON válido.',
    'error.LEGALIZE_INVALID_PLAN': 'Indica un país del catálogo y el título o identificador de la norma.',
    'error.LEGALIZE_NOT_IN_MESSAGE': 'El país, la norma y el artículo tienen que aparecer en tu mensaje actual; no se pueden inferir.',
    'error.LEGALIZE_COUNTRY_UNSUPPORTED': 'Ese país está pendiente de revisión de licencia.',
    'error.LEGALIZE_ALREADY_RUNNING': 'Ya hay una consulta de este país en curso.',
    'error.LEGALIZE_RATE_LIMITED': 'Límite de GitHub alcanzado. Inténtalo más tarde.',
    'error.LEGALIZE_NO_REVISION': 'No se pudo fijar la versión del repositorio.',
    'error.LEGALIZE_NOTICES_CHANGED': 'Los avisos del repositorio han cambiado. Es necesario revisar su licencia antes de consultar esta versión.',
    'error.LEGALIZE_NO_METADATA': 'El documento no tiene metadatos compatibles.',
    'error.LEGALIZE_DOCUMENT_MISMATCH': 'El país o el identificador del documento no coinciden.',
    'error.LEGALIZE_NO_SOURCE': 'El documento no declara fuente oficial.',
    'error.LEGALIZE_INVALID_SOURCE': 'El documento declara una fuente inválida.',
    'error.LEGALIZE_ARTICLE_NOT_UNIQUE': 'No se encontró un único encabezado de ese artículo. Consulta la norma completa por su identificador.',
    'error.LEGALIZE_TOO_LONG': 'La norma es demasiado larga para un mensaje. Solicita un artículo concreto o abre el enlace al repositorio.',
    'error.LEGALIZE_CATALOGUE_UNAVAILABLE': 'No se pudo descargar el catálogo del país.',
    'error.LEGALIZE_CATALOGUE_TOO_LARGE': 'El catálogo supera los límites de esta versión. Usa un identificador exacto.',
    'error.LEGALIZE_CATALOGUE_INCOMPLETE': 'El catálogo es incompatible o incompleto, así que un «no encontrado» no sería fiable. Usa un identificador exacto.',
    'error.LEGALIZE_DOCUMENT_ABSENT': 'El documento no está en la versión consultada.',
    'error.LEGALIZE_INVALID_CATALOGUE_PATH': 'El catálogo declara una ruta inválida.',
    'error.LEGALIZE_NOT_FOUND': 'El repositorio no devolvió nada para esa petición.',
    'error.LEGALIZE_UNAVAILABLE': 'GitHub no está disponible en este momento.',
    'error.LEGALIZE_INVALID_REFERENCE': 'Referencia del repositorio inválida.',
  },
};

export function text(key, locale = 'en') {
  const table = STRINGS[locale] ?? STRINGS[String(locale).split('-')[0]] ?? STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

/** Turns a thrown code back into copy, keeping any detail the code carried. */
export function errorText(error, locale) {
  const raw = error instanceof Error ? error.message : String(error);
  const [code] = raw.split(':');
  return text(`error.${code}`, locale) === `error.${code}` ? raw : text(`error.${code}`, locale);
}
