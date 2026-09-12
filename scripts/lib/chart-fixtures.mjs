// Synthetic fixtures only. These are not experimental observations.
export const base = {
  title: 'Synthetic material response', dataKind: 'synthetic',
  source: 'Fictional materials fixture v1; no empirical findings',
};
const categories = { labels: ['Cold', 'Ambient', 'Warm', 'Hot'], series: [{ name: 'Material A', values: [4, 7, 5, 9] }] };
const second = { name: 'Material B', values: [3, 5, 8, 6] };
export const fixtures = Object.fromEntries([
  ...['line', 'area', 'bar', 'horizontal-bar', 'pie', 'donut'].map(chartType => [chartType, { ...base, chartType, ...structuredClone(categories) }]),
  ...['grouped-bar', 'stacked-bar', 'heatmap'].map(chartType => [chartType, { ...base, chartType, ...structuredClone(categories), series: [...structuredClone(categories.series), structuredClone(second)] }]),
  ['histogram', { ...base, chartType: 'histogram', bins: 4, xLabel: 'Response (arbitrary units)', series: [{ name: 'Material A', values: [0, 1, 2, 3, 4, 4, 5, 6, 7, 8] }] }],
  ['scatter', { ...base, chartType: 'scatter', xLabel: 'Temperature (arbitrary units)', yLabel: 'Response (arbitrary units)', series: [{ name: 'Material A', points: [{ x: -2, y: 1 }, { x: 0, y: 3 }, { x: 2, y: 2 }, { x: 10, y: 8 }] }] }],
  ['bubble', { ...base, chartType: 'bubble', xLabel: 'Temperature (arbitrary units)', yLabel: 'Response (arbitrary units)', series: [{ name: 'Material A', points: [{ x: -2, y: 1, size: 1 }, { x: 0, y: 3, size: 4 }, { x: 2, y: 2, size: 9 }, { x: 10, y: 8, size: 16 }] }] }],
  ['box', { ...base, chartType: 'box', yLabel: 'Response (arbitrary units)', series: [{ name: 'Material A', values: [1, 2, 3, 4, 5, 6, 7, 20] }, { name: 'Material B', values: [-5, 0, 2, 3, 4, 4, 5, 6] }] }],
  ['radar', { ...base, chartType: 'radar', radarMax: 10, ...structuredClone(categories), series: [...structuredClone(categories.series), structuredClone(second)] }],
]);

export const decodeXml = text => text.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);
export const provenance = result => JSON.parse(decodeXml(result.svg.match(/<desc>([\s\S]*?)<\/desc>/)[1]));
