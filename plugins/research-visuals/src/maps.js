import { validateMapRenderRequest, validateViewDocument } from '../../../scripts/contract-v2.mjs';
export function historicalRequest(input) {
  const { period, ...request } = input ?? {};
  const validated = validateMapRenderRequest({ ...request, overlaySource: { label: 'Period validation', attribution: 'Period validation', license: 'CC0', period } });
  if (!period || !validated.overlaySource.period) throw new Error('Historical maps require a period.');
  const time = Date.parse;
  validateMapRenderRequest(request);
  const covers = source => {
    if (!source?.period || !source.url || time(source.period.from) > time(period.from) || time(source.period.to) < time(period.to)) throw new Error('Every historical source needs an evidence URL and a date range covering the requested period.');
  };
  for (const layer of request.layers ?? []) {
    if (!layer.data || layer.query || layer.datasetId) throw new Error('Historical boundaries require supplied dated GeoJSON; provider or opaque dataset substitution is forbidden.');
    covers(layer.data.source);
  }
  if (request.markers?.length || request.routes?.length) covers(request.overlaySource);
  return validateMapRenderRequest(request);
}
const view = data => validateViewDocument({ schemaVersion: 1, summary: data.summary, nodes: [
  { kind: 'svg', svg: data.svg, title: data.title, alt: data.alt },
  { kind: 'paragraph', spans: [{ text: data.historical ? `Historical source period: ${data.period.from} to ${data.period.to}. Source dating is supplied by the researcher; Nodus does not authenticate historical borders.` : 'Source geometry rendered deterministically; coordinate overlays are researcher-supplied.' }] },
  { kind: 'download', ...data.download, label: 'Editable SVG' },
  { kind: 'download', ...data.provenanceDownload, label: 'Geometry and provenance (JSON)' },
] });
export default host => ({
  async health() { return { status: 'ready', dataVersion: 0 }; },
  async invoke({ toolId, input }) {
    host.signal.throwIfAborted();
    if (!['render-map','render-historical-map'].includes(toolId)) throw new Error('Unknown map tool.');
    const historical = toolId === 'render-historical-map';
    const request = historical ? historicalRequest(input) : validateMapRenderRequest(input);
    const result = await host.maps.render(request);
    host.signal.throwIfAborted();
    const store = async (text, name, mimeType) => ({ ...await host.attachments.store({ bytes: new TextEncoder().encode(text), name, mimeType }), name, mimeType });
    const data = { title: request.title, alt: request.alt, summary: request.title, svg: result.svg, historical, ...(historical ? { period: input.period } : {}),
      download: await store(result.svg, 'research-map.svg', 'image/svg+xml'),
      provenanceDownload: await store(JSON.stringify(result, null, 2), 'research-map-provenance.json', 'application/json') };
    return { artifacts: [{ artifactType: 'research-map', artifactVersion: 1, summary: data.summary, data, view: view(data) }] };
  },
  async renderArtifact({ artifactType, artifactVersion, data }) { if (artifactType !== 'research-map' || artifactVersion !== 1) throw new Error('Unknown map artifact.'); return view(data); },
  async shutdown() {},
});
