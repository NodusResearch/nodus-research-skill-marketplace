/** Copy the package owns. The built-in raised these in English from the main process,
 *  where the translation layer could not reach them. */
const STRINGS = {
  en: {
    prediction: 'AlphaGenome prediction', tracks: 'tracks shown', research: 'Research prediction; not for clinical use.',
    context: '16 kb context. The supplied REF allele is not independently checked against GRCh38.',
    terms: 'Output terms', citation: 'Citation', provenance: 'Provenance and terms',
    localOnly: 'This result stays on this device and is never included in the conversation history sent to the model.',
    runtimeReady: 'Runtime installed', runtimeMissing: 'Runtime not installed', keyMissing: 'Add your personal API key',
    termsPending: 'Accept the AlphaGenome terms', ready: 'Ready',
    'error.GENOMICS_REQUEST_TOO_LONG': 'The request is too long.',
    'error.GENOMICS_INVALID_JSON': 'The request was not valid JSON.',
    'error.GENOMICS_INVALID_PLAN': 'Provide GRCh38, chrN:position:REF:ALT, a tissue ontology identifier and RNA_SEQ, ATAC, DNASE or CAGE.',
    'error.GENOMICS_INTERVAL_IMPOSSIBLE': 'The substitution must change a base and leave room for a centred 16,384-base interval.',
    'error.GENOMICS_NOT_IN_MESSAGE': 'Copy the exact assembly, variant, tissue identifier and output from your current message. Coordinates and alleles cannot be inferred.',
    'error.GENOMICS_NO_KEY': 'Add your personal AlphaGenome API key in this package’s settings.',
    'error.GENOMICS_TERMS': 'Accept the current AlphaGenome terms in this package’s settings.',
    'error.GENOMICS_RUNTIME_MISSING': 'Install the AlphaGenome runtime from this package’s settings.',
    'error.GENOMICS_BUSY': 'Another AlphaGenome operation is running. Retry when it finishes.',
    'error.GENOMICS_RUNTIME_FAILED': 'The runtime or the API request failed. Check the runtime, the personal key, your access and your query quota.',
    'error.GENOMICS_INVALID_RESULT': 'The prediction came back in a shape this package does not accept.',
    'error.GENOMICS_UNEXPECTED_INTERVAL': 'The prediction covers a different interval than the one requested.',
    'error.GENOMICS_INVALID_TRACKS': 'The prediction tracks are not in the expected shape.',
    'error.GENOMICS_TOO_LARGE': 'The response exceeds the size limit.',
  },
  es: {
    prediction: 'Predicción de AlphaGenome', tracks: 'señales mostradas', research: 'Predicción de investigación; no apta para uso clínico.',
    context: 'Contexto de 16 kb. El alelo REF aportado no se contrasta de forma independiente con GRCh38.',
    terms: 'Términos de los resultados', citation: 'Cita', provenance: 'Procedencia y términos',
    localOnly: 'Este resultado se queda en este dispositivo y nunca se incluye en el historial que se envía al modelo.',
    runtimeReady: 'Runtime instalado', runtimeMissing: 'Runtime sin instalar', keyMissing: 'Añade tu clave personal',
    termsPending: 'Acepta los términos de AlphaGenome', ready: 'Preparado',
    'error.GENOMICS_REQUEST_TOO_LONG': 'La solicitud es demasiado larga.',
    'error.GENOMICS_INVALID_JSON': 'La solicitud no era JSON válido.',
    'error.GENOMICS_INVALID_PLAN': 'Indica GRCh38, chrN:posición:REF:ALT, un identificador de tejido y RNA_SEQ, ATAC, DNASE o CAGE.',
    'error.GENOMICS_INTERVAL_IMPOSSIBLE': 'La sustitución debe cambiar una base y dejar sitio para un intervalo centrado de 16.384 bases.',
    'error.GENOMICS_NOT_IN_MESSAGE': 'Copia el ensamblaje, la variante, el identificador de tejido y la salida exactos de tu mensaje actual. Las coordenadas y los alelos no se pueden inferir.',
    'error.GENOMICS_NO_KEY': 'Añade tu clave personal de AlphaGenome en la configuración de este paquete.',
    'error.GENOMICS_TERMS': 'Acepta los términos vigentes de AlphaGenome en la configuración de este paquete.',
    'error.GENOMICS_RUNTIME_MISSING': 'Instala el runtime de AlphaGenome desde la configuración de este paquete.',
    'error.GENOMICS_BUSY': 'Hay otra operación de AlphaGenome en curso. Inténtalo cuando termine.',
    'error.GENOMICS_RUNTIME_FAILED': 'Ha fallado el runtime o la petición a la API. Revisa el runtime, la clave personal, tu acceso y tu cuota de consultas.',
    'error.GENOMICS_INVALID_RESULT': 'La predicción llegó con una forma que este paquete no acepta.',
    'error.GENOMICS_UNEXPECTED_INTERVAL': 'La predicción cubre un intervalo distinto del solicitado.',
    'error.GENOMICS_INVALID_TRACKS': 'Las señales de la predicción no tienen la forma esperada.',
    'error.GENOMICS_TOO_LARGE': 'La respuesta supera el límite de tamaño.',
  },
};

export function text(key, locale = 'en') {
  const table = STRINGS[locale] ?? STRINGS[String(locale).split('-')[0]] ?? STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

export function errorText(error, locale) {
  const raw = error instanceof Error ? error.message : String(error);
  const [code] = raw.split(':');
  const localized = text(`error.${code}`, locale);
  return localized === `error.${code}` ? raw : localized;
}

export const localized = (key) => ({
  en: text(key, 'en'), es: text(key, 'es'),
});
