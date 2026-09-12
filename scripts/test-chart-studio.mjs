import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { validatePluginPackage, jsonSchemaMatches } from './contract.mjs';
import { base, fixtures, provenance } from './lib/chart-fixtures.mjs';

const root = fileURLToPath(new URL('../chart-studio/', import.meta.url));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const files = Object.fromEntries(['plugin.json', 'skills/chart-studio/skill.json', 'skills/chart-studio/SKILL.md', 'capabilities/charts/capability.json', 'capabilities/charts/runtime.js'].map(file => [file, read(file)]));
const manifest = JSON.parse(files['plugin.json']);
const capability = JSON.parse(files['capabilities/charts/capability.json']);
const source = files['capabilities/charts/runtime.js'];
const runtime = vm.runInNewContext(`(${source})`, Object.create(null), { timeout: 1000 });
const host = new Proxy({}, { get() { throw new Error('No host access is permitted.'); } });
const render = input => {
  const result = runtime({ toolId: 'render-chart', input }, host);
  if (result.kind === 'text') throw new Error(result.text);
  return result;
};
const clone = type => structuredClone(fixtures[type]);
const plain = value => JSON.parse(JSON.stringify(value));
const attrs = (svg, tag) => [...svg.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(match => Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));

test('package validates, versions match and every operation is permissionless SVG', () => {
  const pkg = validatePluginPackage({ manifest, files });
  assert.equal(pkg.skills.length, 1); assert.equal(pkg.capabilities.length, 1);
  assert.deepEqual(capability.permissions, {});
  assert.deepEqual(capability.tools.map(tool => [tool.id, tool.resultKinds]), [['render-chart', ['svg', 'text']]]);
  assert.deepEqual(pkg.skills[0].package.manifest.capabilities, ['self:charts']);
  assert.equal(capability.version, manifest.version);
  assert.equal(pkg.skills[0].package.manifest.version, manifest.version);
});

for (const [type, input] of Object.entries(fixtures)) test(`${type}: schema, deterministic SVG, provenance, safe finite geometry`, () => {
  assert.ok(jsonSchemaMatches(capability.tools[0].inputSchema, input));
  const before = JSON.stringify(input), result = render(input);
  assert.equal(result.svg, render(input).svg);
  assert.equal(JSON.stringify(input), before, 'input must not be mutated');
  assert.equal(result.kind, 'svg'); assert.equal(result.title, input.title);
  assert.deepEqual(provenance(result).input, input);
  assert.match(result.svg, /SYNTHETIC DATA/);
  assert.match(result.svg, /Source \(supplied, not independently verified\)/);
  assert.ok(result.svg.length < 290000);
  assert.doesNotMatch(result.svg, /<(?:script|foreignObject|image|style|iframe)|\bon\w+=|\bhref=|\b(?:NaN|Infinity)\b/i);
  const [w, h] = result.svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  for (const tag of ['text', 'rect', 'circle', 'line']) for (const item of attrs(result.svg, tag)) {
    for (const key of ['x', 'x1', 'x2', 'cx']) if (key in item) assert.ok(+item[key] >= 0 && +item[key] <= w, `${type} ${key} ${item[key]}`);
    for (const key of ['y', 'y1', 'y2', 'cy']) if (key in item) assert.ok(+item[key] >= 0 && +item[key] <= h, `${type} ${key} ${item[key]}`);
    for (const key of ['width', 'height', 'r']) if (key in item) assert.ok(+item[key] >= 0);
  }
});

test('histogram conserves observations and includes boundary and maximum values exactly once', () => {
  const data = provenance(render(fixtures.histogram)).derived.histogram;
  assert.deepEqual(data.edges, [0, 2, 4, 6, 8]);
  assert.deepEqual(data.counts, [2, 2, 3, 3]);
  const input = clone('histogram'); input.series[0].values = [0.1, 0.2, 0.3]; input.bins = 2;
  assert.equal(provenance(render(input)).derived.histogram.counts.reduce((a, b) => a + b), 3);
  for (const values of [[0], [3, 3, 3], [-1, -1], [1e12, 1e12]]) {
    input.series[0].values = values;
    assert.equal(provenance(render(input)).derived.histogram.counts.reduce((a, b) => a + b), values.length);
  }
});

test('box plot computes interpolated quartiles, sample whiskers and outliers', () => {
  const boxes = provenance(render(fixtures.box)).derived.boxes;
  assert.deepEqual(boxes[0], { name: 'Material A', n: 8, q1: 2.75, median: 4.5, q3: 6.25, low: 1, high: 7, outliers: [20] });
  const input = clone('box'); input.series = [{ name: 'Constant', values: [0, 0] }];
  assert.deepEqual(provenance(render(input)).derived.boxes[0], { name: 'Constant', n: 2, q1: 0, median: 0, q3: 0, low: 0, high: 0, outliers: [] });
});

test('pie percentages preserve values, handle zero parts and render a full circle for one part', () => {
  const input = clone('pie'); input.labels = ['A', 'B', 'C']; input.series[0].values = [1, 2, 1];
  assert.deepEqual(provenance(render(input)).derived, { total: 4, percentages: [25, 50, 25] });
  input.series[0].values = [0, 4, 0];
  assert.ok(attrs(render(input).svg, 'circle').some(item => +item.r === 210));
});

test('bar lengths are proportional to values and signed stacks keep separate baselines', () => {
  const input = clone('bar'); input.labels = ['A', 'B']; input.series[0].values = [2, 4];
  const bars = attrs(render(input).svg, 'rect').filter(item => item.stroke === '#FFFFFF');
  assert.equal(+bars[1].height / +bars[0].height, 2);
  const stacked = clone('stacked-bar'); stacked.labels = ['A']; stacked.series = [{ name: 'One', values: [4] }, { name: 'Two', values: [-3] }, { name: 'Three', values: [2] }];
  const marks = attrs(render(stacked).svg, 'rect').filter(item => item.stroke === '#FFFFFF');
  assert.ok(Math.abs((+marks[0].y + +marks[0].height) - +marks[1].y) < 0.002, 'positive and negative segments start at zero');
  assert.ok(Math.abs((+marks[2].y + +marks[2].height) - +marks[0].y) < 0.002, 'second positive starts at first positive endpoint');
});

test('line category labels stay aligned with their points at both domain endpoints', () => {
  const svg = render(fixtures.line).svg;
  const dots = attrs(svg, 'circle');
  const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)];
  for (const [index, name] of [[0, 'Cold'], [3, 'Hot']]) {
    const attributes = texts.find(match => match[2] === name)[1];
    assert.equal(+attributes.match(/\bx="([^"]+)"/)[1], +dots[index].cx);
  }
});

test('bubble AREA, not radius, encodes size and domain-edge marks stay inside plot', () => {
  const marks = attrs(render(fixtures.bubble).svg, 'circle').slice(0, 4);
  assert.deepEqual(marks.map(item => +item.r), [6.5, 13, 19.5, 26]);
  for (const item of marks) { assert.ok(+item.cx - +item.r >= 160); assert.ok(+item.cx + +item.r <= 1130); }
});

test('XML metacharacters stay text and exact source values survive', () => {
  const input = clone('bar'); input.title = '<script>alert("example")</script>'; input.source = 'A & B < C';
  const result = render(input);
  assert.doesNotMatch(result.svg, /<script>/); assert.match(result.svg, /&lt;script&gt;/);
  assert.deepEqual(provenance(result).input, input);
});

const invalid = [
  ['unknown type', 'bar', input => { input.chartType = 'violin'; }, /Unsupported chart/],
  ['personal data declaration', 'bar', input => { input.dataKind = 'personal'; }, /Only synthetic/],
  ['unexpected raw record field', 'bar', input => { input.records = [{ patient: 'synthetic' }]; }, /unsupported input/],
  ['missing source', 'bar', input => { delete input.source; }, /Missing/],
  ['empty title', 'bar', input => { input.title = ''; }, /Labels/],
  ['overlong label', 'bar', input => { input.labels[0] = 'x'.repeat(37); }, /Labels/],
  ['bidi control', 'bar', input => { input.title = 'abc\u202etest'; }, /control/],
  ['unpaired surrogate', 'bar', input => { input.title = '\ud800'; }, /control/],
  ['missing value', 'bar', input => { input.series[0].values.pop(); }, /match/],
  ['duplicate label', 'bar', input => { input.labels[0] = input.labels[1]; }, /unique/],
  ['duplicate series', 'line', input => { input.series.push(structuredClone(input.series[0])); }, /unique/],
  ['string number', 'bar', input => { input.series[0].values[0] = '4'; }, /finite/],
  ['null', 'bar', input => { input.series[0].values[0] = null; }, /finite/],
  ['NaN', 'bar', input => { input.series[0].values[0] = NaN; }, /finite/],
  ['infinite', 'bar', input => { input.series[0].values[0] = Infinity; }, /finite/],
  ['too large', 'bar', input => { input.series[0].values[0] = 1e13; }, /finite/],
  ['too small', 'bar', input => { input.series[0].values[0] = 1e-12; }, /finite/],
  ['pie negative', 'pie', input => { input.series[0].values[0] = -1; }, /nonnegative/],
  ['pie zero total', 'pie', input => { input.series[0].values.fill(0); }, /positive total/],
  ['area negative', 'area', input => { input.series[0].values[0] = -1; }, /nonnegative/],
  ['radar missing scale', 'radar', input => { delete input.radarMax; }, /radarMax/],
  ['radar range', 'radar', input => { input.radarMax = 1; }, /exceed/],
  ['radar few axes', 'radar', input => { input.labels = ['A', 'B']; }, /array/],
  ['bubble zero size', 'bubble', input => { input.series[0].points[0].size = 0; }, /positive/],
  ['bubble missing size', 'bubble', input => { delete input.series[0].points[0].size; }, /Missing/],
  ['scatter extra size', 'scatter', input => { input.series[0].points[0].size = 1; }, /unsupported/],
  ['scatter category labels', 'scatter', input => { input.labels = ['A']; }, /numeric/],
  ['mixed data shapes', 'scatter', input => { input.series[0].values = [1]; }, /unsupported/],
  ['histogram bins range', 'histogram', input => { input.bins = 31; }, /bins/],
  ['histogram density label', 'histogram', input => { input.yLabel = 'Density'; }, /Count/],
  ['irrelevant bins', 'bar', input => { input.bins = 3; }, /bins/],
  ['irrelevant axes', 'pie', input => { input.xLabel = 'X'; }, /axes/],
  ['irrelevant radar x axis', 'radar', input => { input.xLabel = 'X'; }, /x axis/],
  ['one grouped series', 'grouped-bar', input => { input.series.pop(); }, /two series/],
  ['one box observation', 'box', input => { input.series[0].values = [1]; }, /array/],
  ['too many observations', 'box', input => { input.series.forEach(s => { s.values = Array(501).fill(1); }); }, /Too many/],
];
for (const [name, type, mutate, error] of invalid) test(`reject: ${name}`, () => { const input = clone(type); mutate(input); assert.throws(() => render(input), error); });

test('all zero, constant and signed Cartesian data remain representable', () => {
  for (const type of ['line', 'bar', 'grouped-bar', 'horizontal-bar', 'stacked-bar', 'heatmap']) for (const values of [[0, 0, 0, 0], [-5, -3, 1, 4], [1e-9, 1e-9, 1e-9, 1e-9]]) {
    const input = clone(type); input.series.forEach(s => { s.values = values; });
    assert.doesNotMatch(render(input).svg, /NaN|Infinity/);
  }
});

test('bounded largest category matrix, long CJK strings and 600 numeric points render without truncation', () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${i}測`.padEnd(36, '測'));
  const input = { ...base, title: '測'.repeat(96), source: '測'.repeat(180), chartType: 'heatmap', labels, series: Array.from({ length: 8 }, (_, i) => ({ name: `${i}`.padEnd(48, '測'), values: Array.from({ length: 24 }, (_, j) => i - j) })) };
  assert.deepEqual(provenance(render(input)).input, input);
  const points = Array.from({ length: 300 }, (_, i) => ({ x: i, y: Math.sin(i) }));
  const numeric = { ...base, chartType: 'scatter', series: [{ name: 'A', points }, { name: 'B', points }] };
  assert.equal(attrs(render(numeric).svg, 'circle').length, 600);
});

test('unknown tool fails and direct runtime results are plain JSON', () => {
  assert.deepEqual(plain(runtime({ toolId: 'shell', input: {} })), { kind: 'text', text: 'Chart not generated: Unknown tool. Use render-chart.' });
  assert.deepEqual(Object.keys(plain(render(fixtures.bar))), ['kind', 'svg', 'title']);
});
