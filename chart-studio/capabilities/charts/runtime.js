// Original, dependency-free SVG chart engine. No host operations or model calls.
// A function expression is the installable javascript-sandbox-v1 entry point.
(request) => {
  try {
  const fail = (message) => { throw new Error(message); };
  const object = (value, keys, required = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))
      || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('Missing or unsupported input fields.');
  };
  const text = (value, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max
      || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
      || /[\ud800-\udfff]/u.test(value)) fail('Labels must be bounded, nonempty plain text without control characters.');
    return value;
  };
  const number = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12
      || (value !== 0 && Math.abs(value) < 1e-9)) fail('Values must be finite numbers: zero or magnitude from 1e-9 to 1e12. Rescale units if needed.');
    return value;
  };
  const array = (value, min, max) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(`Expected an array with ${min} to ${max} entries.`);
    return value;
  };
  const types = ['line', 'area', 'bar', 'grouped-bar', 'horizontal-bar', 'stacked-bar', 'pie', 'donut', 'histogram', 'scatter', 'bubble', 'box', 'heatmap', 'radar'];
  if (request.toolId !== 'render-chart') fail('Unknown tool. Use render-chart.');
  const input = request.input;
  object(input, ['chartType', 'title', 'dataKind', 'source', 'xLabel', 'yLabel', 'labels', 'series', 'bins', 'radarMax'], ['chartType', 'title', 'dataKind', 'source', 'series']);
  if (!types.includes(input.chartType)) fail('Unsupported chart type.');
  if (!['synthetic', 'non-personal'].includes(input.dataKind)) fail('Only synthetic or demonstrably non-personal data is supported.');
  text(input.title, 96); text(input.source, 180);
  for (const key of ['xLabel', 'yLabel']) if (input[key] !== undefined) text(input[key], 64);
  const type = input.chartType;
  const xy = ['scatter', 'bubble'].includes(type);
  const sampled = ['histogram', 'box'].includes(type);
  const categorical = !xy && !sampled;
  const single = ['bar', 'horizontal-bar', 'pie', 'donut', 'histogram'].includes(type);
  if (['pie', 'donut'].includes(type) && (input.xLabel !== undefined || input.yLabel !== undefined)) fail('Pie and donut charts do not have axes.');
  if (type === 'radar' && input.xLabel !== undefined) fail('Radar charts use a common scale, not an x axis.');
  if (type === 'histogram' && input.yLabel !== undefined && input.yLabel !== 'Count') fail('The histogram y axis is Count. Density normalization is not supported.');
  const series = array(input.series, 1, single ? 1 : 8);
  if (type === 'grouped-bar' && series.length < 2) fail('Grouped bars require at least two series; use bar for one.');
  const labels = categorical ? array(input.labels, type === 'radar' ? 3 : 1, type === 'radar' ? 12 : 24) : [];
  labels.forEach(label => text(label, 36));
  if (new Set(labels).size !== labels.length) fail('Category labels must be unique.');
  if (!categorical && input.labels !== undefined) fail('This chart uses numeric samples or points, not category labels.');
  if (input.bins !== undefined && (type !== 'histogram' || !Number.isInteger(input.bins) || input.bins < 2 || input.bins > 30)) fail('bins is only valid for histograms, from 2 to 30.');
  if (input.radarMax !== undefined && (type !== 'radar' || number(input.radarMax) <= 0)) fail('radarMax is only valid for radar charts and must be positive.');
  if (type === 'radar' && input.radarMax === undefined) fail('Supply radarMax: all radar axes must share one meaningful scale.');
  let count = 0;
  for (const item of series) {
    object(item, xy ? ['name', 'points'] : ['name', 'values'], xy ? ['name', 'points'] : ['name', 'values']);
    text(item.name, 48);
    if (xy) {
      array(item.points, 1, 300).forEach(point => {
        object(point, type === 'bubble' ? ['x', 'y', 'size'] : ['x', 'y'], type === 'bubble' ? ['x', 'y', 'size'] : ['x', 'y']);
        number(point.x); number(point.y);
        if (type === 'bubble' && number(point.size) <= 0) fail('Bubble sizes must be positive; circle area represents size.');
      });
      count += item.points.length;
    } else {
      array(item.values, type === 'box' ? 2 : 1, sampled ? 1000 : 24).forEach(number);
      if (categorical && item.values.length !== labels.length) fail('Every series must match the category labels exactly. Missing values are not filled.');
      count += item.values.length;
    }
  }
  if (count > (xy ? 600 : 1000)) fail('Too many observations; supply a smaller non-personal dataset. No silent sampling is performed.');
  if (new Set(series.map(item => item.name)).size !== series.length) fail('Series names must be unique.');
  const raw = xy ? series.flatMap(item => item.points.flatMap(point => [point.x, point.y])) : series.flatMap(item => item.values);
  if (['pie', 'donut', 'radar'].includes(type) && raw.some(value => value < 0)) fail('Pie, donut and radar charts require nonnegative values.');
  if (type === 'radar' && raw.some(value => value > input.radarMax)) fail('Radar values exceed radarMax. Use a justified common scale.');
  if (['pie', 'donut'].includes(type) && !raw.some(value => value > 0)) fail('A part-to-whole chart needs a positive total.');
  if (type === 'area' && raw.some(value => value < 0)) fail('Area charts require nonnegative values; use line for signed data.');

  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
  const f = value => {
    if (!Number.isFinite(value)) fail('Numeric range cannot be rendered. Rescale the input units.');
    return String(Number(value.toFixed(3)));
  };
  const fmt = value => value === 0 ? '0' : String(Number(value.toPrecision(6)));
  const palette = ['#007C83', '#B44B1F', '#5E4FA2', '#A52A68', '#3767A6', '#697B21', '#815B37', '#526B73'];
  const ink = '#172D3B', muted = '#526674', grid = '#DCE4E6';
  const out = [];
  const line = (x1, y1, x2, y2, color = grid, width = 1) => out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${width}"/>`);
  const rect = (x, y, w, h, color, extra = '') => out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(Math.max(0, w))}" height="${f(Math.max(0, h))}" fill="${color}" ${extra}/>`);
  const circle = (x, y, r, color, extra = '') => out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${color}" ${extra}/>`);
  const label = (value, x, y, size = 18, anchor = 'start', color = ink, extra = '') => out.push(`<text x="${f(x)}" y="${f(y)}" font-size="${size}" text-anchor="${anchor}" fill="${color}" ${extra}>${esc(value)}</text>`);
  // Manual wrapping also bounds unbroken strings. Width reserves a full em per glyph,
  // including CJK; extra height is preferable to truncation or overlapping labels.
  const wrap = (value, x, y, columns, size = 18, anchor = 'start', color = ink) => {
    let chars = Array.from(value), row = 0;
    while (chars.length) {
      let end = Math.min(columns, chars.length);
      if (chars.length > columns) {
        const space = chars.slice(0, columns + 1).lastIndexOf(' ');
        if (space >= columns * 0.4) end = space;
      }
      label(chars.slice(0, end).join(''), x, y + row * (size + 5), size, anchor, color);
      chars = chars.slice(end); while (chars[0] === ' ') chars.shift(); row++;
    }
    return row * (size + 5);
  };
  const path = (d, color, extra = '') => out.push(`<path d="${d}" fill="${color}" ${extra}/>`);
  const polygon = (points, color, extra = '') => out.push(`<polygon points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}" fill="${color}" ${extra}/>`);
  const min = values => Math.min(...values), max = values => Math.max(...values);
  const scale = (values, zero = false, integer = false) => {
    let lo = min(values), hi = max(values);
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (lo === hi) { const pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; if (zero && values.every(v => v >= 0)) lo = 0; }
    const span = hi - lo;
    if (!Number.isFinite(span) || span <= 0 || span < Math.max(Math.abs(lo), Math.abs(hi)) * 1e-12) fail('Numeric span is too small relative to the values. Recenter or rescale units explicitly.');
    const unit = 10 ** Math.floor(Math.log10(span / 5));
    const ratio = span / 5 / unit;
    const step = Math.max(integer ? 1 : 0, (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * unit);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => Number((lo + i * step).toPrecision(14)));
    // Reject visually indistinguishable numeric labels instead of implying false precision.
    if (new Set(ticks.map(fmt)).size !== ticks.length) fail('Tick labels would be indistinguishable. Recenter or rescale units.');
    return { lo, hi, ticks, at: value => (value - lo) / (hi - lo) };
  };
  const derived = {};
  const notes = [];
  let legend = series.map((item, i) => ({ name: item.name, color: palette[i] }));
  const W = 1200, L = type === 'horizontal-bar' || type === 'heatmap' ? 330 : 160, R = 1130;
  label(`CHART STUDIO / ${type.toUpperCase()}`, 55, 46, 15, 'start', muted);
  const titleHeight = wrap(input.title, 55, 88, 40, 26);
  const statusY = 88 + titleHeight + 18;
  label(input.dataKind === 'synthetic' ? 'SYNTHETIC DATA · Illustrative example' : 'NON-PERSONAL DATA · Declared by caller; not an anonymity certification', 55, statusY, 14, 'start', muted);
  const heading = out.join(''); out.length = 0;
  const T = statusY + 70;
  let B = T + 460, afterPlot = B + 140;
  if (type === 'horizontal-bar') { B = T + Math.max(400, labels.length * 66); afterPlot = B + 130; }
  if (type === 'heatmap') { B = T + Math.max(400, series.length * 70); afterPlot = B + 160; }
  const width = R - L;
  const xCategories = (categories, centered = true) => {
    const step = width / (centered ? categories.length : Math.max(1, categories.length - 1));
    const x = index => !centered && categories.length === 1 ? (L + R) / 2 : L + (index + (centered ? 0.5 : 0)) * step;
    const columns = Math.max(2, Math.floor(Math.min(step - 6, 160) / 16));
    const heights = categories.map((value, i) => {
      const edgeColumns = Math.max(2, Math.floor(Math.min(x(i) - 40, W - 40 - x(i)) * 2 / 16));
      return wrap(value, x(i), B + 28, Math.min(columns, edgeColumns), 16, 'middle', muted);
    });
    afterPlot = Math.max(afterPlot, B + 40 + Math.max(...heights) + 55);
    if (input.xLabel) afterPlot += wrap(input.xLabel, (L + R) / 2, afterPlot - 22, 44, 18, 'middle', muted) - 23;
    return { x, step };
  };
  const yAxis = domain => {
    const y = value => B - domain.at(value) * (B - T);
    domain.ticks.forEach(value => { line(L, y(value), R, y(value), value === 0 ? '#889BA5' : grid); label(fmt(value), L - 14, y(value) + 6, 16, 'end', muted); });
    if (input.yLabel) wrap(input.yLabel, L, T - 35, 44, 18, 'start', muted);
    return y;
  };
  const xAxis = domain => {
    const x = value => L + domain.at(value) * width;
    domain.ticks.forEach(value => { line(x(value), T, x(value), B); label(fmt(value), x(value), B + 30, 16, 'middle', muted); });
    if (input.xLabel) wrap(input.xLabel, (L + R) / 2, B + 74, 44, 18, 'middle', muted);
    return x;
  };

  if (['line', 'area', 'bar', 'grouped-bar', 'stacked-bar'].includes(type)) {
    let bounds = raw;
    if (type === 'stacked-bar') bounds = labels.flatMap((_, i) => [series.reduce((sum, s) => sum + Math.min(0, s.values[i]), 0), series.reduce((sum, s) => sum + Math.max(0, s.values[i]), 0)]);
    const y = yAxis(scale(bounds, true));
    const { x, step } = xCategories(labels, !['line', 'area'].includes(type));
    if (type === 'line' || type === 'area') {
      series.forEach((item, si) => {
        const points = item.values.map((v, i) => [x(i), y(v)]);
        if (type === 'area') polygon([[x(0), y(0)], ...points, [x(labels.length - 1), y(0)]], palette[si], 'fill-opacity="0.14"');
        const d = points.map(([px, py], i) => `${i ? 'L' : 'M'}${f(px)} ${f(py)}`).join(' ');
        path(d, 'none', `stroke="${palette[si]}" stroke-width="3"`);
        points.forEach(([px, py]) => circle(px, py, 4, palette[si]));
      });
      notes.push('Categories are equally spaced in supplied order; no interpolation of missing data.', ...(type === 'area' ? ['Areas overlap transparently; they are not stacked.'] : []));
    } else {
      labels.forEach((_, i) => {
        let positive = 0, negative = 0;
        series.forEach((item, si) => {
          const value = item.values[i], stacked = type === 'stacked-bar';
          const start = stacked ? (value >= 0 ? positive : negative) : 0;
          const end = start + value;
          if (value >= 0) positive = end; else negative = end;
          const barWidth = step * 0.76 / (stacked ? 1 : series.length);
          rect(x(i) - step * 0.38 + (stacked ? 0 : si * barWidth), Math.min(y(start), y(end)), barWidth, Math.abs(y(end) - y(start)), palette[si], 'stroke="#FFFFFF" stroke-width="0.6"');
        });
      });
      notes.push('Zero baseline; category order is preserved.', ...(type === 'stacked-bar' ? ['Positive and negative stacks accumulate separately.'] : []));
    }
  } else if (type === 'horizontal-bar') {
    const domain = scale(raw, true), x = xAxis(domain), step = (B - T) / labels.length;
    if (input.yLabel) wrap(input.yLabel, L, T - 35, 44, 18, 'start', muted);
    labels.forEach((value, i) => {
      const cy = T + (i + 0.5) * step;
      wrap(value, L - 18, cy - 10, 16, 16, 'end', muted);
      rect(Math.min(x(0), x(raw[i])), cy - step * 0.3, Math.abs(x(raw[i]) - x(0)), step * 0.6, palette[0]);
    });
    notes.push('Zero baseline; category order is preserved.');
  } else if (type === 'pie' || type === 'donut') {
    const total = raw.reduce((a, b) => a + b, 0), cx = 440, cy = T + 230, radius = 210;
    let angle = -Math.PI / 2;
    const positive = raw.filter(v => v > 0).length;
    legend = labels.map((name, i) => ({ name: `${name}: ${fmt(raw[i])} (${fmt(raw[i] / total * 100)}%)`, color: palette[i % palette.length] }));
    raw.forEach((value, i) => {
      if (value === 0) return;
      const next = angle + value / total * 2 * Math.PI;
      if (positive === 1) circle(cx, cy, radius, palette[i % palette.length]);
      else path(`M${cx} ${cy} L${f(cx + radius * Math.cos(angle))} ${f(cy + radius * Math.sin(angle))} A${radius} ${radius} 0 ${next - angle > Math.PI ? 1 : 0} 1 ${f(cx + radius * Math.cos(next))} ${f(cy + radius * Math.sin(next))} Z`, palette[i % palette.length], 'stroke="#FFFFFF" stroke-width="2"');
      angle = next;
    });
    if (type === 'donut') { circle(cx, cy, radius * 0.58, '#FFFFFF'); label('Total', cx, cy - 12, 18, 'middle', muted); label(fmt(total), cx, cy + 22, 25, 'middle'); }
    else { label('Total', 820, cy - 30, 18, 'middle', muted); label(fmt(total), 820, cy + 7, 30, 'middle'); }
    derived.total = total;
    derived.percentages = raw.map(value => value / total * 100);
    notes.push('Shares use the supplied total; rounded labels may not add to exactly 100%.');
    if (labels.length > 8) notes.push('Colors repeat after eight categories; use bars for easier comparison.');
    afterPlot = cy + radius + 80;
  } else if (type === 'scatter' || type === 'bubble') {
    const points = series.flatMap(item => item.points);
    const xd = scale(points.map(p => p.x)), yd = scale(points.map(p => p.y));
    // Inset marks from the numeric domain border so full bubbles remain visible.
    const padding = type === 'bubble' ? 28 : 8;
    const x = value => L + padding + xd.at(value) * (width - padding * 2);
    const y = value => B - padding - yd.at(value) * (B - T - padding * 2);
    xd.ticks.forEach(value => { line(x(value), T, x(value), B); label(fmt(value), x(value), B + 30, 16, 'middle', muted); });
    yd.ticks.forEach(value => { line(L, y(value), R, y(value)); label(fmt(value), L - 14, y(value) + 6, 16, 'end', muted); });
    if (input.xLabel) wrap(input.xLabel, (L + R) / 2, B + 74, 44, 18, 'middle', muted);
    if (input.yLabel) wrap(input.yLabel, L, T - 35, 44, 18, 'start', muted);
    const largest = type === 'bubble' ? max(points.map(p => p.size)) : 1;
    series.forEach((item, si) => item.points.forEach(point => circle(x(point.x), y(point.y), type === 'bubble' ? 26 * Math.sqrt(point.size / largest) : 5, palette[si], 'fill-opacity="0.65" stroke="#FFFFFF" stroke-width="0.6"')));
    notes.push('Numeric axes; no fitted trend or causal inference.');
    if (type === 'bubble') {
      circle(935, B + 110, 26, palette[0], 'fill-opacity="0.65"');
      label(`Size ${fmt(largest)}`, 978, B + 116, 16, 'start', muted);
      notes.push('Bubble area is proportional to size; overlaps can obscure points.'); afterPlot = B + 175;
    }
  } else if (type === 'histogram') {
    let lo = min(raw), hi = max(raw);
    const bins = input.bins === undefined ? Math.min(30, Math.max(2, Math.ceil(Math.sqrt(raw.length)))) : input.bins;
    if (lo === hi) { const pad = Math.abs(lo) * 0.05 || 0.5; lo -= pad; hi += pad; }
    const edges = Array.from({ length: bins + 1 }, (_, i) => lo + (hi - lo) * i / bins);
    if (edges.some((edge, i) => i > 0 && edge <= edges[i - 1])) fail('Histogram boundaries cannot be represented. Recenter or rescale units.');
    const counts = Array(bins).fill(0);
    // Compare against the exact reported boundaries, avoiding floating division at edges.
    raw.forEach(value => { let i = 0; while (i < bins - 1 && value >= edges[i + 1]) i++; counts[i]++; });
    const y = yAxis(scale(counts, true, true)), step = width / bins;
    if (!input.yLabel) label('Count', L, T - 35, 18, 'start', muted);
    counts.forEach((value, i) => rect(L + i * step, y(value), step, y(0) - y(value), palette[0], 'stroke="#FFFFFF" stroke-width="1"'));
    const stride = Math.ceil(bins / 5);
    edges.forEach((value, i) => { if (i % stride === 0 || i === bins) label(fmt(value), L + i * step, B + 30, 16, 'middle', muted); });
    if (input.xLabel) wrap(input.xLabel, (L + R) / 2, B + 74, 44, 18, 'middle', muted);
    derived.histogram = { edges, counts, bins };
    notes.push(`${raw.length} observations; ${bins} equal-width bins. Left-closed, right-open; last bin includes maximum.`, 'Vertical axis: observation count. No density normalization.');
  } else if (type === 'box') {
    const y = yAxis(scale(raw)), { x, step } = xCategories(series.map(s => s.name));
    const quantile = (sorted, p) => { const at = (sorted.length - 1) * p, i = Math.floor(at); return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (at - i); };
    derived.boxes = series.map((item, si) => {
      const sorted = [...item.values].sort((a, b) => a - b), q1 = quantile(sorted, 0.25), median = quantile(sorted, 0.5), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
      const inside = sorted.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr), low = inside[0], high = inside[inside.length - 1];
      const outliers = sorted.filter(v => v < low || v > high), half = Math.min(50, step * 0.3);
      line(x(si), y(low), x(si), y(high), palette[si], 2);
      line(x(si) - half / 2, y(low), x(si) + half / 2, y(low), palette[si], 2);
      line(x(si) - half / 2, y(high), x(si) + half / 2, y(high), palette[si], 2);
      rect(x(si) - half, y(q3), half * 2, y(q1) - y(q3), '#FFFFFF', `stroke="${palette[si]}" stroke-width="2"`);
      line(x(si) - half, y(median), x(si) + half, y(median), palette[si], 3);
      outliers.forEach(v => circle(x(si), y(v), 4, palette[si]));
      return { name: item.name, n: sorted.length, q1, median, q3, low, high, outliers };
    });
    notes.push('Quartiles: linear interpolation at (n - 1)p. Whiskers: extreme samples within 1.5 IQR.', 'All outside samples are drawn; coincident outliers overlap. No samples are discarded.');
  } else if (type === 'heatmap') {
    const lo = min(raw), hi = max(raw), { step } = xCategories(labels), row = (B - T) / series.length;
    if (input.yLabel) wrap(input.yLabel, L, T - 35, 44, 18, 'start', muted);
    const color = value => {
      const t = hi === lo ? 0.5 : (value - lo) / (hi - lo);
      const a = [237, 246, 248], b = [0, 91, 111];
      return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
    };
    series.forEach((item, si) => {
      wrap(item.name, L - 18, T + (si + 0.5) * row - 10, 16, 16, 'end', muted);
      item.values.forEach((value, i) => rect(L + i * step, T + si * row, step, row, color(value), 'stroke="#FFFFFF" stroke-width="1"'));
    });
    for (let i = 0; i < 100; i++) rect(L + i * width / 100, afterPlot, width / 100 + 0.2, 16, color(lo + (hi - lo) * i / 99));
    label(fmt(lo), L, afterPlot + 42, 16, 'start', muted); label(fmt(hi), R, afterPlot + 42, 16, 'end', muted);
    afterPlot += 85; legend = [];
    notes.push('One linear color scale across all cells; values and row order are preserved in SVG provenance.');
  } else if (type === 'radar') {
    const cx = 600, cy = T + 215, radius = 180, limit = input.radarMax;
    const pos = (i, r) => [cx + r * Math.sin(i * 2 * Math.PI / labels.length), cy - r * Math.cos(i * 2 * Math.PI / labels.length)];
    for (let ring = 1; ring <= 4; ring++) { polygon(labels.map((_, i) => pos(i, radius * ring / 4)), 'none', `stroke="${grid}"`); label(fmt(limit * ring / 4), cx + 8, cy - radius * ring / 4 + 17, 14, 'start', muted); }
    labels.forEach((value, i) => {
      const [x, y] = pos(i, radius), [tx, ty] = pos(i, radius + 38);
      line(cx, cy, x, y);
      label(String(i + 1), tx, ty, 18, 'middle', muted);
    });
    series.forEach((item, si) => polygon(item.values.map((v, i) => pos(i, radius * v / limit)), palette[si], `fill-opacity="0.10" stroke="${palette[si]}" stroke-width="2"`));
    notes.push(...labels.map((value, i) => `Axis ${i + 1}: ${value}`), `Every axis uses 0 to ${fmt(limit)} in the same units; no per-axis normalization.`, ...(input.yLabel ? [`Common unit: ${input.yLabel}`] : []), 'Axis order affects polygon shape; compare values, not enclosed area.');
  }

  let cursor = afterPlot + 15;
  for (let i = 0; i < legend.length; i += 2) {
    let rowHeight = 0;
    legend.slice(i, i + 2).forEach((item, col) => {
      const x = 55 + col * 560;
      rect(x, cursor - 14, 18, 18, item.color);
      rowHeight = Math.max(rowHeight, wrap(item.name, x + 30, cursor, 30, 17));
    });
    cursor += rowHeight + 24;
  }
  if (legend.length) cursor += 15;
  notes.forEach(note => { cursor += wrap(note, 55, cursor, 104, 15, 'start', muted) + 8; });
  cursor += 12;
  cursor += wrap(`Source (supplied, not independently verified): ${input.source}`, 55, cursor, 72, 15, 'start', muted);
  label('Chart Studio 1.0.0 · Deterministic SVG · Exact input and method in SVG description', 55, cursor + 25, 14, 'start', muted);
  const height = cursor + 65;
  const header = `<rect width="1200" height="${f(height)}" fill="#FFFFFF"/><rect x="0" y="0" width="1200" height="8" fill="#007C83"/>`;
  const body = out.join('');
  const provenance = { generator: 'Chart Studio', version: '1.0.0', input, derived, method: notes };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${f(height)}" font-family="Arial, Helvetica, sans-serif"><title>${esc(input.title)}</title><desc>${esc(JSON.stringify(provenance))}</desc>${header}${heading}${body}</svg>`;
  if (svg.length > 290000) fail('Chart exceeds the SVG size limit; reduce the data explicitly.');
  return { kind: 'svg', svg, title: input.title };
  } catch (error) {
    // Electron may replace a thrown renderer error with a generic message. Return a
    // declared inert text result so callers see validation failures, never a false chart.
    return { kind: 'text', text: 'Chart not generated: ' + String(error.message || 'Invalid input.').replace(/[<>]/g, '').slice(0, 400) };
  }
}
