/** Copy the package owns. Notices used to travel as codes the application translated;
 *  a package carries its own strings and picks by the locale the host passes in. */
const STRINGS: Record<string, Record<string, string>> = {
  en: {
    studio: 'Chemistry Studio',
    verified: 'Verified structure',
    partial: 'Partly verified',
    unverified: 'Unverified drawing',
    references: 'Reference sources',
    limitations: 'What this drawing does not establish',
    downloadDocument: 'Download the verified document',
    downloadChemfig: 'Download the ChemFig source',
    reactionScope: 'Balanced scheme; the mechanism is not verified.',
    mechanismScope: 'Rule and balance checked.',
    'notice.conflicting-intents': 'The reply described more than one drawing, so none was adopted. Ask for one structure at a time.',
    'notice.unverified-svg': 'This drawing was produced without the verified chemistry lane. Treat it as an illustration, not as a checked structure.',
    'notice.legacy-format': 'A chemical format from an older version was ignored. Ask for the structure again.',
    'notice.partial-validation': 'Part of the validation could not be completed, so this is shown as partly verified.',
    'notice.not-drawn': 'No verified identity, projection or mechanism could be produced.',
    'notice.one-plan-per-reply': 'Only one chemistry plan is drawn per reply.',
    'notice.assumed-identity': 'An identity had to be assumed to draw this. Check it against the sources listed.',
    'error.CHEMISTRY_INTERRUPTED': 'The chemistry plan was interrupted. Retry the response.',
    'error.CHEMISTRY_NOT_DRAWN': 'No verified structure could be produced for that request.',
  },
  es: {
    studio: 'Chemistry Studio',
    verified: 'Estructura verificada',
    partial: 'Verificación parcial',
    unverified: 'Dibujo sin verificar',
    references: 'Fuentes de referencia',
    limitations: 'Lo que este dibujo no acredita',
    downloadDocument: 'Descargar el documento verificado',
    downloadChemfig: 'Descargar el código ChemFig',
    reactionScope: 'Esquema balanceado; el mecanismo no está verificado.',
    mechanismScope: 'Regla y balance contrastados.',
    'notice.conflicting-intents': 'La respuesta describía más de un dibujo, así que no se adoptó ninguno. Pide una estructura cada vez.',
    'notice.unverified-svg': 'Este dibujo se hizo sin el carril de química verificada. Trátalo como una ilustración, no como una estructura contrastada.',
    'notice.legacy-format': 'Se ha ignorado un formato químico de una versión anterior. Vuelve a pedir la estructura.',
    'notice.partial-validation': 'Parte de la validación no pudo completarse, así que esto se muestra como verificación parcial.',
    'notice.not-drawn': 'No se ha podido producir una identidad, proyección o mecanismo verificados.',
    'notice.one-plan-per-reply': 'Solo se dibuja un plan de química por respuesta.',
    'notice.assumed-identity': 'Ha habido que asumir una identidad para dibujar esto. Contrástala con las fuentes indicadas.',
    'error.CHEMISTRY_INTERRUPTED': 'El plan de química se interrumpió. Vuelve a intentar la respuesta.',
    'error.CHEMISTRY_NOT_DRAWN': 'No se ha podido producir una estructura verificada para esa petición.',
  },
};

export function text(key: string, locale = 'en'): string {
  const table = STRINGS[locale] ?? STRINGS[String(locale).split('-')[0]] ?? STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

export const localizedText = (key: string) => ({ en: text(key, 'en'), es: text(key, 'es') });
