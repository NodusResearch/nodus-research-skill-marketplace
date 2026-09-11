// Build-time geometry helpers for the Anatomy Visualization reproducible build.
// They parse SVG transforms and path data, round path numbers safely (arc flags are
// consumed as single characters, so packed flags such as `0 012.89` are never merged
// into one number), and sample path geometry to derive deterministic label anchors.

const NUMBER = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/;
const COMMAND_ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

const IDENTITY = [1, 0, 0, 1, 0, 0];
export { IDENTITY };

export function multiplyTransform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

export function applyTransform(matrix, [x, y]) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

export function parseTransform(value) {
  if (!value) return IDENTITY;
  let matrix = IDENTITY;
  const pattern = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1];
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let next = IDENTITY;
    if (name === 'matrix' && args.length === 6) next = args;
    else if (name === 'translate') next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    else if (name === 'scale') next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (name === 'rotate') {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const rotate = [cos, sin, -sin, cos, 0, 0];
      if (args.length >= 3) next = multiplyTransform(multiplyTransform([1, 0, 0, 1, args[1], args[2]], rotate), [1, 0, 0, 1, -args[1], -args[2]]);
      else next = rotate;
    }
    matrix = multiplyTransform(matrix, next);
  }
  return matrix;
}

function skipSeparators(d, state) {
  while (state.index < d.length && (d[state.index] === ' ' || d[state.index] === '\t' || d[state.index] === '\n' || d[state.index] === '\r' || d[state.index] === ',')) state.index += 1;
}

function readNumber(d, state) {
  skipSeparators(d, state);
  const match = NUMBER.exec(d.slice(state.index));
  if (!match) throw new Error(`Invalid path number near ${JSON.stringify(d.slice(state.index, state.index + 16))}`);
  state.index += match[0].length;
  return Number(match[0]);
}

function readFlag(d, state) {
  skipSeparators(d, state);
  const value = d[state.index];
  if (value !== '0' && value !== '1') throw new Error(`Invalid arc flag near ${JSON.stringify(d.slice(state.index, state.index + 16))}`);
  state.index += 1;
  return Number(value);
}

export function parsePathData(d) {
  const commands = [];
  const state = { index: 0 };
  let previous = null;
  while (state.index < d.length) {
    skipSeparators(d, state);
    if (state.index >= d.length) break;
    let letter = d[state.index];
    if (/[A-Za-z]/.test(letter)) state.index += 1;
    else if (previous) letter = previous === 'M' ? 'L' : previous === 'm' ? 'l' : previous;
    else throw new Error(`Path data must start with a command near ${JSON.stringify(d.slice(0, 16))}`);
    const upper = letter.toUpperCase();
    const arity = COMMAND_ARITY[upper];
    if (arity === undefined) throw new Error(`Unsupported path command ${letter}`);
    if (arity === 0) { commands.push({ letter, params: [] }); previous = letter; continue; }
    const params = [];
    for (let position = 0; position < arity; position += 1) {
      params.push(upper === 'A' && (position === 3 || position === 4) ? readFlag(d, state) : readNumber(d, state));
    }
    commands.push({ letter, params });
    previous = letter;
  }
  return commands;
}

const formatNumber = (value, decimals) => String(Number(value.toFixed(decimals)));

export function serializePathData(commands, decimals = 2) {
  return commands.map(({ letter, params }) => {
    if (!params.length) return letter;
    const isArc = letter.toUpperCase() === 'A';
    const parts = params.map((value, position) => (isArc && (position === 3 || position === 4) ? String(value) : formatNumber(value, decimals)));
    return `${letter} ${parts.join(' ')}`;
  }).join(' ');
}

export function normalizePathData(d, decimals = 2) {
  return serializePathData(parsePathData(d), decimals);
}

export function samplePathPoints(commands, matrix) {
  const points = [];
  let current = [0, 0];
  let start = [0, 0];
  let lastControl = null;
  const push = (point) => points.push(applyTransform(matrix, point));
  const reflect = () => (lastControl ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]] : current);
  const cubic = (c1, c2, end) => {
    push(current); push(c1); push(c2); push(end);
    for (const t of [0.25, 0.5, 0.75]) {
      const u = 1 - t;
      push([
        u * u * u * current[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
        u * u * u * current[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
      ]);
    }
    lastControl = c2;
    current = end;
  };
  for (const { letter, params } of commands) {
    const relative = letter === letter.toLowerCase();
    const x = (value) => (relative ? current[0] + value : value);
    const y = (value) => (relative ? current[1] + value : value);
    switch (letter.toUpperCase()) {
      case 'M': current = [x(params[0]), y(params[1])]; start = current; push(current); lastControl = null; break;
      case 'L': current = [x(params[0]), y(params[1])]; push(current); lastControl = null; break;
      case 'H': current = [x(params[0]), current[1]]; push(current); lastControl = null; break;
      case 'V': current = [current[0], y(params[0])]; push(current); lastControl = null; break;
      case 'C': cubic([x(params[0]), y(params[1])], [x(params[2]), y(params[3])], [x(params[4]), y(params[5])]); break;
      case 'S': cubic(reflect(), [x(params[0]), y(params[1])], [x(params[2]), y(params[3])]); break;
      case 'Q': {
        const control = [x(params[0]), y(params[1])];
        const end = [x(params[2]), y(params[3])];
        cubic(control, control, end);
        break;
      }
      case 'T': {
        const control = reflect();
        cubic(control, control, [x(params[0]), y(params[1])]);
        break;
      }
      case 'A': current = [x(params[5]), y(params[6])]; push(current); lastControl = null; break;
      case 'Z': current = start; push(current); lastControl = null; break;
      default: break;
    }
  }
  return points;
}

export function boundsOf(points) {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, center: [(minX + maxX) / 2, (minY + maxY) / 2] };
}

const pathData = (attributes) => attributes.d ?? '';
const numeric = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

export function elementPoints(node, matrix = IDENTITY) {
  const own = multiplyTransform(matrix, parseTransform(node.attributes.transform));
  const name = node.name.split(':').pop();
  switch (name) {
    case 'path': return samplePathPoints(parsePathData(pathData(node.attributes)), own);
    case 'ellipse': {
      const cx = numeric(node.attributes.cx, 0), cy = numeric(node.attributes.cy, 0);
      const rx = numeric(node.attributes.rx, 0), ry = numeric(node.attributes.ry, 0);
      const points = [];
      for (let step = 0; step < 16; step += 1) {
        const angle = (step / 16) * Math.PI * 2;
        points.push(applyTransform(own, [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]));
      }
      return points;
    }
    case 'circle': {
      const cx = numeric(node.attributes.cx, 0), cy = numeric(node.attributes.cy, 0), r = numeric(node.attributes.r, 0);
      const points = [];
      for (let step = 0; step < 16; step += 1) {
        const angle = (step / 16) * Math.PI * 2;
        points.push(applyTransform(own, [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]));
      }
      return points;
    }
    case 'rect': {
      const x = numeric(node.attributes.x, 0), y = numeric(node.attributes.y, 0);
      const width = numeric(node.attributes.width, 0), height = numeric(node.attributes.height, 0);
      return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map((point) => applyTransform(own, point));
    }
    case 'line': return [[numeric(node.attributes.x1, 0), numeric(node.attributes.y1, 0)], [numeric(node.attributes.x2, 0), numeric(node.attributes.y2, 0)]].map((point) => applyTransform(own, point));
    case 'polyline':
    case 'polygon': {
      const numbers = (node.attributes.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const points = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) points.push(applyTransform(own, [numbers[index], numbers[index + 1]]));
      return points;
    }
    default: {
      const points = [];
      for (const child of node.children) points.push(...elementPoints(child, own));
      return points;
    }
  }
}
