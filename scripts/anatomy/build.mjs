// Reproducible build for the Anatomy Visualization capability.
//
// It downloads the pinned upstream resources recorded in sources.lock.json, verifies
// their SHA-256 digests, extracts the curated structure subsets, derives deterministic
// label anchors, resolves reviewed FMA cross-references through EMBL-EBI OLS4 (only when
// --fetch-fma is given), and writes capabilities/anatomy/runtime.js inside the package.
//
// Usage:
//   node scripts/anatomy/build.mjs               regenerate the runtime from the lock
//   node scripts/anatomy/build.mjs --fetch-fma   refresh the FMA cross-references first
//   node scripts/anatomy/build.mjs --offline     never touch the network (cache only)
//
// The build never modifies Nodus. It only reads pinned public resources and writes inside
// this marketplace checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseXml, serializeXml } from './xml.mjs';
import { elementPoints, boundsOf, normalizePathData, parsePathData, samplePathPoints, parseTransform, multiplyTransform, IDENTITY } from './geometry.mjs';
import { ALL_STRUCTURES, MUSCLE_STRUCTURES, BODY_STRUCTURES, BRAIN_STRUCTURES, AMBIGUOUS_TERMS } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const packageDir = path.join(root, 'anatomy-visualization');
const capabilityDir = path.join(packageDir, 'capabilities', 'anatomy');
const lockPath = path.join(here, 'sources.lock.json');
const templatePath = path.join(here, 'runtime.template.js');
const cacheDir = path.join(os.tmpdir(), 'anatomy-visualization-sources');

const args = new Set(process.argv.slice(2));
const fetchFma = args.has('--fetch-fma');
const offline = args.has('--offline');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function readLock() {
  if (!fs.existsSync(lockPath)) throw new Error(`Missing ${path.relative(root, lockPath)}. Generate it once from the pinned revisions before building.`);
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

async function fetchPinned(source) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, source.sha256);
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile);
    if (sha256(cached) === source.sha256) return cached.toString('utf8');
  }
  if (offline) throw new Error(`Offline build requested but ${source.file} is not cached.`);
  const response = await fetch(source.rawUrl, { redirect: 'error' });
  if (!response.ok) throw new Error(`Downloading ${source.rawUrl} returned HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== source.sha256) throw new Error(`SHA-256 mismatch for ${source.rawUrl}: expected ${source.sha256}, got ${digest}. Refusing to build from unverified bytes.`);
  fs.writeFileSync(cacheFile, buffer);
  return buffer.toString('utf8');
}

const ALLOWED_TAGS = new Set(['g', 'path', 'ellipse', 'circle', 'rect', 'line', 'polyline', 'polygon']);
const REMOVED_TAGS = new Set(['title', 'a']);
const DROPPED_ATTRIBUTES = new Set([
  'style', 'fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity',
  'display', 'visibility', 'id', 'class', 'connector-curvature', 'nodetypes', 'label',
  'export-xdpi', 'export-ydpi', 'groupmode',
]);
const SIMPLE_NUMBERS = new Set(['cx', 'cy', 'rx', 'ry', 'r', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height']);

function cloneNode(node) {
  return { name: node.name, attributes: { ...node.attributes }, children: node.children.map(cloneNode), text: node.text };
}

function roundValue(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return String(Number(parsed.toFixed(decimals)));
}

function cleanElement(source, label) {
  const node = cloneNode(source);
  const scrub = (element, parent) => {
    const local = element.name.includes(':') ? element.name.split(':').pop() : element.name;
    if (REMOVED_TAGS.has(local)) return false;
    if (!ALLOWED_TAGS.has(local)) throw new Error(`${label}: refusing to package unexpected element <${element.name}>.`);
    element.children = element.children.filter((child) => {
      const childLocal = child.name.includes(':') ? child.name.split(':').pop() : child.name;
      if (REMOVED_TAGS.has(childLocal)) return false;
      if (!ALLOWED_TAGS.has(childLocal)) throw new Error(`${label}: refusing to package unexpected element <${child.name}>.`);
      return true;
    });
    for (const attribute of Object.keys(element.attributes)) {
      const localAttribute = attribute.includes(':') ? attribute.split(':').pop() : attribute;
      const namespaced = attribute.includes(':');
      if (namespaced && !['xlink'].includes(attribute.split(':')[0])) { delete element.attributes[attribute]; continue; }
      if (localAttribute === 'href' || attribute.endsWith('href')) throw new Error(`${label}: refusing to package an external reference.`);
      if (DROPPED_ATTRIBUTES.has(localAttribute)) { delete element.attributes[attribute]; continue; }
      if (!namespaced && SIMPLE_NUMBERS.has(localAttribute)) element.attributes[attribute] = roundValue(element.attributes[attribute]);
      if (!namespaced && localAttribute === 'd') element.attributes[attribute] = normalizePathData(element.attributes[attribute], 2);
      if (!namespaced && localAttribute === 'points') element.attributes[attribute] = element.attributes[attribute].split(/[\s,]+/).filter(Boolean).map((value) => roundValue(value)).join(' ');
    }
    for (const child of element.children) scrub(child, element);
    return true;
  };
  scrub(node, null);
  return node;
}

function markupOf(node) {
  return serializeXml(node);
}

function transformAttribute(matrix) {
  if (matrix.every((value, index) => Math.abs(value - IDENTITY[index]) < 1e-9)) return null;
  return `matrix(${matrix.map((value) => String(Number(value.toFixed(6)))).join(' ')})`;
}

function collectWithTransforms(root) {
  const found = [];
  const visit = (node, matrix) => {
    const own = multiplyTransform(matrix, parseTransform(node.attributes.transform));
    found.push({ node, matrix: own });
    for (const child of node.children) visit(child, own);
  };
  visit(root, IDENTITY);
  return found;
}

function cleanWithMatrix(node, label, matrix) {
  const cleaned = cleanElement(node, label);
  const attribute = transformAttribute(matrix);
  if (attribute) cleaned.attributes.transform = attribute;
  else delete cleaned.attributes.transform;
  return cleaned;
}

function anchorOf(node) {
  const bounds = boundsOf(elementPoints(node, IDENTITY));
  if (!bounds || !Number.isFinite(bounds.center[0]) || !Number.isFinite(bounds.center[1])) return null;
  return [Number(bounds.center[0].toFixed(2)), Number(bounds.center[1].toFixed(2))];
}

// Some source drawings hold several views on one canvas (the brain anatomogram has two axial,
// one sagittal and one lateral view). Keep only the sub-shapes that belong to the supported
// views so nothing floats outside an omitted outline.
function pruneAbove(node, minY) {
  const isLeaf = (element) => {
    const local = element.name.includes(':') ? element.name.split(':').pop() : element.name;
    return ['path', 'ellipse', 'circle', 'rect', 'line', 'polyline', 'polygon'].includes(local);
  };
  const inView = (element, parentMatrix) => {
    const bounds = boundsOf(elementPoints(element, parentMatrix));
    return Boolean(bounds && (bounds.minY + bounds.maxY) / 2 >= minY);
  };
  const prune = (element, parentMatrix) => {
    const own = multiplyTransform(parentMatrix, parseTransform(element.attributes.transform));
    if (isLeaf(element)) return inView(element, parentMatrix);
    element.children = element.children.filter((child) => prune(child, own));
    return element.children.length > 0;
  };
  if (isLeaf(node)) return inView(node, IDENTITY) ? node : null;
  const own = multiplyTransform(IDENTITY, parseTransform(node.attributes.transform));
  node.children = node.children.filter((child) => prune(child, own));
  return node.children.length ? node : null;
}

function subshapeBounds(node, matrix = IDENTITY) {
  const results = [];
  const visit = (element, parentMatrix) => {
    const own = multiplyTransform(parentMatrix, parseTransform(element.attributes.transform));
    const local = element.name.includes(':') ? element.name.split(':').pop() : element.name;
    if (['path', 'ellipse', 'circle', 'rect', 'line', 'polyline', 'polygon'].includes(local)) {
      const bounds = boundsOf(elementPoints(element, parentMatrix));
      if (bounds) results.push(bounds);
      return;
    }
    for (const child of element.children) visit(child, own);
  };
  visit(node, matrix);
  return results;
}

// Paired organs are drawn as separate components (kidneys, lungs, adrenal glands, ovaries).
// Cluster nearby components and place one numbered marker on each substantial cluster, so a
// bilateral structure is marked on both sides instead of in the empty space between them.
function anchorsOf(node) {
  const shapes = subshapeBounds(node);
  if (!shapes.length) {
    const single = anchorOf(node);
    return single ? [single] : [];
  }
  const all = shapes.reduce((box, shape) => ({
    minX: Math.min(box.minX, shape.minX), minY: Math.min(box.minY, shape.minY),
    maxX: Math.max(box.maxX, shape.maxX), maxY: Math.max(box.maxY, shape.maxY),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const gap = Math.hypot(all.maxX - all.minX, all.maxY - all.minY) * 0.03;
  const parent = shapes.map((_, index) => index);
  const find = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const union = (left, right) => { const a = find(left), b = find(right); if (a !== b) parent[b] = a; };
  const near = (a, b) => !(a.maxX + gap < b.minX || b.maxX + gap < a.minX || a.maxY + gap < b.minY || b.maxY + gap < a.minY);
  for (let left = 0; left < shapes.length; left += 1) for (let right = left + 1; right < shapes.length; right += 1) if (near(shapes[left], shapes[right])) union(left, right);
  const clusters = new Map();
  shapes.forEach((shape, index) => {
    const root = find(index);
    const box = clusters.get(root) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    clusters.set(root, {
      minX: Math.min(box.minX, shape.minX), minY: Math.min(box.minY, shape.minY),
      maxX: Math.max(box.maxX, shape.maxX), maxY: Math.max(box.maxY, shape.maxY),
    });
  });
  const boxes = [...clusters.values()].map((box) => ({ box, area: (box.maxX - box.minX) * (box.maxY - box.minY) }))
    .sort((a, b) => b.area - a.area);
  const largest = boxes[0]?.area ?? 0;
  const anchors = [];
  for (const { box, area } of boxes) {
    if (area < largest * 0.2) continue;
    const anchor = [Number(((box.minX + box.maxX) / 2).toFixed(2)), Number(((box.minY + box.maxY) / 2).toFixed(2))];
    if (anchors.some((existing) => Math.hypot(existing[0] - anchor[0], existing[1] - anchor[1]) < gap)) continue;
    anchors.push(anchor);
    if (anchors.length >= 2) break;
  }
  return anchors.length ? anchors : [anchorOf(node)].filter(Boolean);
}

function extractMuscles(bodyPaths, lock) {
  const slugs = new Map(MUSCLE_STRUCTURES.map((entry) => [entry.providerId, entry]));
  const resources = { male: {}, female: {} };
  for (const sex of ['male', 'female']) {
    if (!bodyPaths[sex]) throw new Error(`Anatome bodyPaths.json has no "${sex}" dataset.`);
    for (const view of ['front', 'back']) {
      const parts = bodyPaths[sex][view];
      if (!Array.isArray(parts)) throw new Error(`Anatome bodyPaths.json has no ${sex}.${view} dataset.`);
      const slugsOut = {};
      const order = [];
      for (const part of parts) {
        if (!slugs.has(part.slug)) continue;
        const sides = part.path || {};
        const markup = ['common', 'left', 'right']
          .flatMap((side) => (sides[side] || []).map((d) => `<path d="${d}"/>`))
          .join('');
        if (!markup) continue;
        const centers = [];
        for (const side of ['common', 'left', 'right']) {
          const paths = sides[side];
          if (!paths || !paths.length) continue;
          const points = paths.flatMap((d) => samplePathPoints(parsePathData(d), IDENTITY));
          const bounds = boundsOf(points);
          if (bounds) centers.push([Number(bounds.center[0].toFixed(2)), Number(bounds.center[1].toFixed(2))]);
        }
        const box = lock.anatomeViewBoxes[`${sex}-${view}`];
        const mergeDistance = (box[2] * 0.08) ** 2;
        const anchors = [];
        for (const center of centers) {
          if (anchors.some((anchor) => (anchor[0] - center[0]) ** 2 + (anchor[1] - center[1]) ** 2 < mergeDistance)) continue;
          anchors.push(center);
        }
        slugsOut[part.slug] = { markup, anchors };
        order.push(part.slug);
      }
      resources[sex][view] = { viewBox: lock.anatomeViewBoxes[`${sex}-${view}`].join(' '), order, slugs: slugsOut };
    }
  }
  return resources;
}

function extractAnatomogram(svgText, providerIds, label, options = {}) {
  const document = parseXml(svgText);
  const widthBox = document.attributes.viewBox;
  if (!widthBox) throw new Error(`${label}: the SVG has no viewBox.`);
  const located = collectWithTransforms(document);
  let outline = '';
  if (options.outlineIds) {
    const parts = [];
    for (const outlineId of options.outlineIds) {
      const match = located.find((item) => item.node.attributes.id === outlineId);
      if (!match) throw new Error(`${label}: missing outline path ${outlineId}.`);
      parts.push(markupOf(cleanWithMatrix(match.node, `${label} ${outlineId}`, match.matrix)));
    }
    outline = parts.join('');
  } else if (options.withOutline !== false) {
    const match = located.find((item) => item.node.attributes.id === 'LAYER_OUTLINE');
    if (!match) throw new Error(`${label}: the SVG has no LAYER_OUTLINE group.`);
    outline = markupOf(cleanWithMatrix(match.node, `${label} outline`, match.matrix));
  }
  const structures = {};
  const order = [];
  const found = new Map();
  for (const item of located) {
    const id = item.node.attributes.id;
    if (!id || !id.startsWith('UBERON_')) continue;
    const providerId = id.replace('_', ':');
    if (!providerIds.has(providerId) || found.has(providerId)) continue;
    let cleaned = cleanWithMatrix(item.node, `${label} ${providerId}`, item.matrix);
    if (options.minY !== undefined) {
      cleaned = pruneAbove(cleaned, options.minY);
      if (!cleaned) continue;
    }
    const anchors = anchorsOf(cleaned);
    if (!anchors.length) throw new Error(`${label}: could not derive an anchor for ${providerId}.`);
    structures[providerId] = { markup: markupOf(cleaned), anchors };
    order.push(providerId);
    found.set(providerId, true);
  }
  return { viewBox: widthBox, outline, order, structures, found: new Set(found.keys()) };
}

function buildStructureRecords(lock, muscleResources, bodyResources, brainResources) {
  const records = [];
  for (const entry of ALL_STRUCTURES) {
    const record = {
      id: entry.id,
      canonicalName: entry.canonicalName,
      category: entry.category,
      granularity: entry.granularity,
      provider: entry.provider,
      providerId: entry.providerId,
      laterality: entry.laterality,
      aliases: entry.aliases,
      notes: entry.notes || null,
      license: entry.provider === 'anatome'
        ? 'MIT (react-native-body-highlighter path data, Copyright (c) 2022 ELABBASSI Hicham); provider repository Apache-2.0 (Anatome by NextSolutions)'
        : 'CC BY 4.0 (EMBL-EBI Expression Atlas anatomogram)',
      fma: entry.fmaQuery && lock.fma && lock.fma.matches[entry.fmaQuery] ? lock.fma.matches[entry.fmaQuery] : null,
    };
    if (entry.provider === 'anatome') {
      const views = [];
      const sexes = [];
      for (const sex of ['male', 'female']) {
        let inSex = false;
        for (const view of ['front', 'back']) {
          if (muscleResources[sex][view].slugs[entry.providerId]) {
            inSex = true;
            if (!views.includes(view)) views.push(view);
          }
        }
        if (inSex) sexes.push(sex);
      }
      if (!views.length) throw new Error(`Registry entry ${entry.id} (${entry.providerId}) is not present in any Anatome view.`);
      record.views = ['front', 'back'].filter((view) => views.includes(view));
      record.sexes = sexes;
      record.ontology = null;
    } else if (entry.panel === 'brain') {
      if (!brainResources.structures[entry.providerId]) throw new Error(`Registry entry ${entry.id} (${entry.providerId}) is not present in the brain anatomogram.`);
      record.panel = 'brain';
      record.views = ['brain'];
      record.sexes = [];
      record.ontology = { namespace: 'UBERON', id: entry.providerId, source: 'anatomogram element id' };
    } else {
      const inMale = Boolean(bodyResources.male.structures[entry.providerId]);
      const inFemale = Boolean(bodyResources.female.structures[entry.providerId]);
      if (!inMale && !inFemale) throw new Error(`Registry entry ${entry.id} (${entry.providerId}) is not present in either body anatomogram.`);
      record.panel = 'body';
      record.views = ['front'];
      record.sexes = [inMale ? 'male' : null, inFemale ? 'female' : null].filter(Boolean);
      record.ontology = { namespace: 'UBERON', id: entry.providerId, source: 'anatomogram element id' };
      if (!inMale) record.notes = record.notes || 'Only the female anatomogram draws this structure.';
      if (!inFemale) record.notes = record.notes || 'Only the male anatomogram draws this structure.';
    }
    records.push(record);
  }
  return records;
}

async function fetchFmaMatches(lock) {
  const queries = [...new Set(ALL_STRUCTURES.map((entry) => entry.fmaQuery).filter(Boolean))].sort();
  const matches = {};
  const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const term of queries) {
    const url = `https://www.ebi.ac.uk/ols4/api/search?ontology=fma&q=${encodeURIComponent(term)}&queryFields=label,synonym&exact=true&rows=10&fieldList=iri,label,obo_id,synonym`;
    let payload;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`OLS4 returned HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      throw new Error(`FMA lookup failed for "${term}": ${error.message}. Re-run without --offline or keep the previous lock file.`);
    }
    const documents = payload?.response?.docs ?? [];
    const hit = documents.find((document) => normalize(document.label ?? '') === normalize(term)
      || (document.synonym ?? []).some((synonym) => normalize(synonym) === normalize(term)));
    if (hit) {
      const matched = normalize(hit.label ?? '') === normalize(term) ? 'label' : 'synonym';
      const iri = String(hit.iri ?? '');
      const local = iri.split('/').pop() ?? '';
      const id = /^fma[0-9]+$/i.test(local) ? `FMA:${local.slice(3)}` : String(hit.obo_id).toUpperCase();
      matches[term] = { id, iri, label: hit.label, matched };
      console.log(`FMA  ${term.padEnd(24)} ${id} (${matched})`);
    } else {
      console.log(`FMA  ${term.padEnd(24)} no exact label or synonym; omitted`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  lock.fma = { service: 'https://www.ebi.ac.uk/ols4', ontology: 'fma', fetchedAt: new Date().toISOString(), matches };
  return lock;
}

function verifyRuntimeSource(source) {
  if (source.length > 256_000) throw new Error(`runtime.js is ${source.length} characters, above the 256000-character capability limit.`);
  if (source.includes('`')) throw new Error('runtime.js contains a backtick; Nodus embeds the runtime in a template literal.');
  if (source.includes('$' + '{')) throw new Error('runtime.js contains template interpolation; Nodus embeds the runtime in a template literal.');
  if (source.includes('\\')) throw new Error('runtime.js contains a backslash; Nodus embeds the runtime in a template literal.');
  const factory = new Function(`return (${source});`);
  const runtime = factory();
  if (typeof runtime !== 'function') throw new Error('runtime.js is not a function expression.');
}

async function main() {
  const lock = readLock();
  if (fetchFma) {
    if (offline) throw new Error('--fetch-fma cannot be combined with --offline.');
    await fetchFmaMatches(lock);
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Updated ${path.relative(root, lockPath)} with FMA cross-references.`);
    return;
  }
  const sources = new Map(lock.sources.map((source) => [source.id, source]));
  const text = {};
  for (const source of lock.sources) {
    if (source.fetch === false) continue;
    text[source.id] = await fetchPinned(source);
  }
  const bodyPaths = JSON.parse(text['anatome-body-paths']);
  const muscleResources = extractMuscles(bodyPaths, lock);
  const bodyProviderIds = new Set(BODY_STRUCTURES.map((entry) => entry.providerId));
  const brainProviderIds = new Set(BRAIN_STRUCTURES.map((entry) => entry.providerId));
  const bodyResources = {
    male: extractAnatomogram(text['anatomogram-male'], bodyProviderIds, 'male anatomogram'),
    female: extractAnatomogram(text['anatomogram-female'], bodyProviderIds, 'female anatomogram'),
  };
  const brainResources = extractAnatomogram(text['anatomogram-brain'], brainProviderIds, 'brain anatomogram', { outlineIds: ['bottom_left_outline', 'bottom_right_outline'], minY: 55 });
  for (const entry of BODY_STRUCTURES) {
    if (!bodyResources.male.found.has(entry.providerId) && !bodyResources.female.found.has(entry.providerId)) throw new Error(`Extraction never found body structure ${entry.providerId}.`);
  }
  for (const entry of BRAIN_STRUCTURES) {
    if (!brainResources.found.has(entry.providerId)) throw new Error(`Extraction never found brain structure ${entry.providerId}.`);
  }

  const structures = buildStructureRecords(lock, muscleResources, bodyResources, brainResources);
  const fmaCount = structures.filter((entry) => entry.fma).length;
  const payload = {
    catalogVersion: 1,
    views: {
      muscles: 'Muscle drawings support front and back views, male and female.',
      organs: 'The organ drawing is a schematic front view, male and female.',
      brain: 'Brain regions use the dedicated schematic brain drawing.',
    },
    attribution: {
      anatome: 'Muscle paths: react-native-body-highlighter (MIT, Copyright (c) 2022 ELABBASSI Hicham) via Anatome by NextSolutions. https://github.com/HichamELBSI/react-native-body-highlighter and https://github.com/Rippy1911/anatome',
      anatomogram: 'Human anatomograms: EMBL-EBI Expression Atlas (CC BY 4.0). https://www.ebi.ac.uk/gxa/licence.html',
      fma: 'Semantic cross-references: Foundational Model of Anatomy (CC BY 4.0), University of Washington. https://github.com/uw-sig/FMA',
    },
    resources: {
      anatome: muscleResources,
      anatomogram: { body: bodyResources, brain: brainResources },
    },
    structures,
    ambiguousTerms: AMBIGUOUS_TERMS,
  };

  const json = JSON.stringify(payload);
  const compressed = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  const encoded = compressed.toString('base64');
  const template = fs.readFileSync(templatePath, 'utf8');
  if (!template.includes('__ANATOMY_PAYLOAD__')) throw new Error('runtime.template.js lost its payload placeholder.');
  let source = template.replace('__ANATOMY_PAYLOAD__', encoded);
  source = `${source}\n`;
  verifyRuntimeSource(source);
  fs.mkdirSync(capabilityDir, { recursive: true });
  fs.writeFileSync(path.join(capabilityDir, 'runtime.js'), source);

  console.log(`Payload JSON ${json.length} bytes, gzip ${compressed.length} bytes, base64 ${encoded.length} characters.`);
  console.log(`runtime.js ${source.length} characters (limit 256000).`);
  console.log(`Structures ${structures.length} (${MUSCLE_STRUCTURES.length} muscle/region, ${BODY_STRUCTURES.length} body, ${BRAIN_STRUCTURES.length} brain); FMA cross-references ${fmaCount}.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
