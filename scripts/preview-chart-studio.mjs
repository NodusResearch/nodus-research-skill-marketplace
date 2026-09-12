// Generate self-contained review artifacts. No browser, model, data download or service.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures } from './lib/chart-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'build/chart-studio-preview');
fs.mkdirSync(directory, { recursive: true });
const runtime = new Function(`return (${fs.readFileSync(path.join(root, 'chart-studio/capabilities/charts/runtime.js'), 'utf8')});`)();
const sections = Object.entries(fixtures).map(([type, input]) => {
  const { svg } = runtime({ toolId: 'render-chart', input });
  fs.writeFileSync(path.join(directory, `${type}.svg`), svg);
  return `<section><h2>${type}</h2><a href="${type}.svg"><img src="${type}.svg" alt="Synthetic ${type} chart"></a></section>`;
});
fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Chart Studio · synthetic preview</title><style>body{margin:40px;background:#edf2f3;color:#172d3b;font:16px system-ui}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}section{background:white;border:1px solid #ccd9dc;padding:20px}img{width:100%;height:auto}h1{font-size:32px}h2{font-size:18px}</style><h1>Chart Studio</h1><p>14 deterministic SVG charts. Synthetic data only. Select a chart to inspect the original SVG.</p><main>${sections.join('')}</main></html>`);
console.log(directory);
