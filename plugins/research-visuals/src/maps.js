import { validateMapRenderRequest, validateViewDocument } from '../../../scripts/contract-v2.mjs';

/** A dated map, and what each part of it actually is.
 *
 *  A historical map is a dated interpretation, and the honest line is not between "supplied by a
 *  dataset" and "refused": it is between what a released set of sources can carry and what only
 *  the researcher or the model can supply. Everything renders. What differs is the label, and the
 *  label is load-bearing — a reconstruction drawn from general knowledge is useful for teaching
 *  and for planning a route, and is not evidence, so it says so in the map itself rather than in a
 *  paragraph the reader may never see.
 *
 *  The label is read from the renderer's own provenance rather than guessed from the request. A
 *  provider source that carries a period was retrieved *for* that period (OpenHistoricalMap keeps
 *  only the boundaries whose own dates cover it, and reports that) and is dated geometry; a
 *  provider source without one is today's map drawn as a reference frame; a caller source without
 *  a covering period and an evidence link is a reconstruction. That is the distinction the reader
 *  needs, and it is decided by what the geometry is, not by how the request was written.
 *
 *  What stays refused is the substitution that would make the label untrue: an opaque dataset
 *  handle, which cannot be attributed, and a source that declares a period which does not cover
 *  the request. */
export function historicalRequest(input) {
  const { period, ...request } = input ?? {};
  if (!period) throw new Error('A historical map needs its period, for example {"from":"1940-01-01","to":"1940-12-31"}.');
  // Shapes first: the injected source is how the period itself is validated, without requiring
  // the caller to restate it on an overlay it may not have.
  const validated = validateMapRenderRequest({ ...request, overlaySource: { label: 'Period validation', attribution: 'Period validation', license: 'CC0', period } });
  if (!validated.overlaySource.period) throw new Error('Invalid map period.');
  const time = Date.parse;
  const covers = source => !source?.period || (time(source.period.from) <= time(period.from) && time(source.period.to) >= time(period.to));
  for (const layer of request.layers ?? []) {
    if (layer.datasetId) throw new Error('An opaque dataset handle cannot be attributed, so it cannot support a historical map. Query an approved provider or supply the GeoJSON.');
    if (layer.data && !covers(layer.data.source)) throw new Error('A source period that does not cover the requested interval cannot date this map.');
  }
  if ((request.markers?.length || request.routes?.length) && !covers(request.overlaySource)) throw new Error('A source period that does not cover the requested interval cannot date this map.');
  return { request: validateMapRenderRequest(request) };
}

/** What the result is, said in the map: dated, approximate, or a reference frame. */
export function historicalLabels(sources, period) {
  const dated = source => Boolean(source.period && (source.url || source.origin === 'provider'))
    && Date.parse(source.period.from) <= Date.parse(period.from) && Date.parse(source.period.to) >= Date.parse(period.to);
  const supplied = sources.filter(source => source.origin === 'caller');
  const references = sources.filter(source => source.origin === 'provider' && !source.period).map(source => source.label);
  const datedSources = sources.filter(dated);
  return {
    // Nothing of the period was supplied: what remains is a frame for it, and says so.
    referenceOnly: references.length > 0 && !datedSources.length && !supplied.length,
    approximate: supplied.some(source => !dated(source)) || (references.length > 0 && !datedSources.length && !supplied.length),
    references,
  };
}

const APPROXIMATE_NOTICE = 'Dates, geometry and coordinates here are supplied by the model or the researcher and are not checked against a dated source. Treat shapes, boundaries and routes as an approximate reconstruction for orientation and teaching, not as documented historical evidence.';
const DATED_NOTE = (from, to) => `Historical source period: ${from} to ${to}. Source dating is supplied by the researcher; Nodus does not authenticate historical borders.`;
const REFERENCE_NOTE = references => `${references.length === 1 ? 'A reference layer is' : 'Reference layers are'} drawn from published current geometry (${references.join(', ')}): those are today's boundaries and administrative divisions, not the requested period's.`;
const REFERENCE_ONLY_NOTE = (references, from, to) => `No geometry of ${from} to ${to} was supplied. This map shows the current administrative division published by ${references.join(', ')} as a reference frame for the period, and its boundaries are today's.`;

const view = data => validateViewDocument({ schemaVersion: 1, summary: data.summary, nodes: [
  { kind: 'svg', svg: data.svg, title: data.title, alt: data.alt },
  ...(data.historical && data.approximate ? [{ kind: 'notice', tone: 'warning', title: data.referenceOnly ? 'Reference frame, not a historical boundary map' : 'Approximate historical reconstruction', spans: [{ text: data.referenceOnly ? REFERENCE_ONLY_NOTE(data.references, data.period.from, data.period.to) : APPROXIMATE_NOTICE }] }] : []),
  { kind: 'paragraph', spans: [{ text: data.historical ? referenceText(data) : 'Source geometry rendered deterministically; coordinate overlays are researcher-supplied.' }] },
  { kind: 'download', ...data.download, label: 'Editable SVG' },
  { kind: 'download', ...data.provenanceDownload, label: 'Geometry and provenance (JSON)' },
] });

function referenceText(data) {
  const { from, to } = data.period;
  if (data.referenceOnly) return REFERENCE_ONLY_NOTE(data.references, from, to);
  const core = data.approximate ? APPROXIMATE_NOTICE : DATED_NOTE(from, to);
  return data.references?.length ? `${core} ${REFERENCE_NOTE(data.references)}` : core;
}


/** When a map request is answered by hand.
 *
 *  A model that decides the tool cannot help will draw the map itself, and that drawing is the
 *  one thing this Skill exists to prevent: it looks like a map, it is not one, and nothing about
 *  it can be checked. The package cannot delete a node it does not own, so it takes the drawing
 *  lane instead — which retires the hand-drawn block and skips the core's own SVG pass — and says
 *  what to do next. It claims only on a cartographic question that was actually answered with an
 *  SVG block, so a diagram beside a map request is left alone. */
const MAP_QUESTION = /(?:\bmapas?\b|\bmaps?\b|\bcartes?\b|\bkarten?\b|\bmappa\b|\bharita\b|\bplano\b|\bcroquis\b|地図|지도|地图|地圖)/i;
const RETIRED = {
  es: ['Se ha retirado un mapa dibujado a mano', 'Un mapa lo traza la herramienta de cartografía, con sus fuentes y su atribución, no el modelo a mano. Vuelve a pedirlo y se dibujará con las fronteras datadas del periodo; si no existen para esa zona, te diré qué falta y qué conjunto de datos serviría.'],
  en: ['A hand-drawn map was retired', 'A map is drawn by the cartography tool, with its sources and attribution, not by hand. Ask again and it will be traced from the period\'s dated boundaries; where none exist for that area, you will be told what is missing and which dataset would serve.'],
  fr: ['Une carte dessinée à la main a été retirée', 'Une carte est tracée par l\'outil de cartographie, avec ses sources et son attribution, et non à la main. Redemandez-la : elle sera dessinée à partir des frontières datées de la période ; là où il n\'en existe pas, on vous dira ce qui manque et quel jeu de données conviendrait.'],
  de: ['Eine handgezeichnete Karte wurde entfernt', 'Eine Karte zeichnet das Kartografie-Werkzeug, mit Quellen und Attribution, nicht die Hand des Modells. Fragen Sie erneut: Sie wird aus den datierten Grenzen des Zeitraums gezeichnet; wo es keine gibt, erfahren Sie, was fehlt und welcher Datensatz geeignet wäre.'],
  pt: ['Foi retirado um mapa desenhado à mão', 'Um mapa é traçado pela ferramenta de cartografia, com as suas fontes e atribuição, não à mão. Peça de novo e será desenhado com as fronteiras datadas do período; onde não existam, dir-se-á o que falta e que conjunto de dados serviria.'],
  'pt-BR': ['Um mapa desenhado à mão foi retirado', 'Um mapa é traçado pela ferramenta de cartografia, com suas fontes e atribuição, não à mão. Peça novamente e ele será desenhado com as fronteiras datadas do período; onde não houver, você será informado do que falta e de qual conjunto de dados serviria.'],
  it: ['È stata ritirata una mappa disegnata a mano', 'Una mappa la traccia lo strumento di cartografia, con le sue fonti e attribuzione, non la mano del modello. Richiedila di nuovo: sarà disegnata con i confini datati del periodo; dove non esistono, ti sarà detto cosa manca e quale dataset servirebbe.'],
  tr: ['Elle çizilmiş bir harita kaldırıldı', 'Bir haritayı kaynakları ve atfıyla kartografi aracı çizer, model eliyle değil. Yeniden isteyin: dönemin tarihli sınırlarıyla çizilecek; o bölge için yoksa neyin eksik olduğu ve hangi veri kümesinin işe yarayacağı söylenecek.'],
  ja: ['手描きの地図は取り下げられました', '地図は出典と帰属を伴ってカルトグラフィー・ツールが描くもので、モデルが手で描くものではありません。もう一度お求めください。その時代の日付付き境界線で描きます。その地域に存在しない場合は、何が足りないか、どのデータセットが使えるかを示します。'],
  ko: ['손으로 그린 지도는 철회되었습니다', '지도는 출처와 저작자 표시와 함께 지도 도구가 그리는 것이며, 모델이 손으로 그리는 것이 아닙니다. 다시 요청하시면 해당 시대의 날짜가 있는 경계로 그립니다. 그 지역에 없다면 무엇이 없고 어떤 데이터셋이 필요한지 알려 드립니다.'],
  'zh-CN': ['手绘地图已被撤回', '地图由制图工具绘制，并附来源与署名，而不是模型手绘。请再提出一次，它会依据该时期的带日期边界绘制；若该地区没有，会说明缺少什么以及哪种数据集可用。'],
  'zh-TW': ['手繪地圖已被撤回', '地圖由製圖工具繪製，並附來源與署名，而不是模型手繪。請再提出一次，它會依據該時期的帶日期邊界繪製；若該地區沒有，會說明缺少什麼以及哪種資料集可用。'],
};
function retiredMutations({ question, nodes, locale }) {
  const asked = MAP_QUESTION.test(String(question ?? ''));
  const drawn = (nodes ?? []).some(node => node?.kind === 'fence' && node.fence === 'svg' && /<svg[\s>]/i.test(String(node.content ?? '')));
  if (!asked || !drawn) return [];
  const key = String(locale ?? 'en');
  const [title, text] = RETIRED[key] ?? RETIRED[key.split('-')[0]] ?? RETIRED.en;
  return [
    { op: 'claim', suppressSvgRefinement: true },
    { op: 'notice', position: 'before', view: validateViewDocument({ schemaVersion: 1, summary: title, nodes: [{ kind: 'notice', tone: 'warning', title, spans: [{ text }] }] }) },
  ];
}

export default host => ({
  async health() { return { status: 'ready', dataVersion: 0 }; },
  /** The hook the application calls before the core's own stages run. */
  async prepareChat(input) { return retiredMutations(input ?? {}); },
  async invoke({ toolId, input }) {
    host.signal.throwIfAborted();
    if (!['render-map','render-historical-map'].includes(toolId)) throw new Error('Unknown map tool.');
    const historical = toolId === 'render-historical-map';
    const { request } = historical ? historicalRequest(input) : { request: validateMapRenderRequest(input) };
    const result = await host.maps.render(request);
    host.signal.throwIfAborted();
    const store = async (text, name, mimeType) => ({ ...await host.attachments.store({ bytes: new TextEncoder().encode(text), name, mimeType }), name, mimeType });
    const labels = historical ? historicalLabels(result.provenance.sources, input.period) : { approximate: false, referenceOnly: false, references: [] };
    const data = { title: request.title, alt: request.alt, summary: request.title, svg: result.svg, historical, ...labels, ...(historical ? { period: input.period } : {}),
      download: await store(result.svg, 'research-map.svg', 'image/svg+xml'),
      provenanceDownload: await store(JSON.stringify(result, null, 2), 'research-map-provenance.json', 'application/json') };
    return { artifacts: [{ artifactType: 'research-map', artifactVersion: 1, summary: data.summary, data, view: view(data) }] };
  },
  async renderArtifact({ artifactType, artifactVersion, data }) { if (artifactType !== 'research-map' || artifactVersion !== 1) throw new Error('Unknown map artifact.'); return view(data); },
  async shutdown() {},
});
