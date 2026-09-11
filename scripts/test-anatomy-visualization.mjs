// Deterministic tests for the Anatomy Visualization plugin.
//
// They exercise the real package through the public marketplace contract and the embedded
// capability runtime. No network, credentials, paid services, patient data or student data
// are used, and no test depends on a running Nodus build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginPackage, jsonSchemaMatches } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'anatomy-visualization');
const read = (relative) => fs.readFileSync(path.join(packageDir, relative), 'utf8');
const manifest = JSON.parse(read('plugin.json'));
const skillManifest = JSON.parse(read('skills/anatomy-visualization/skill.json'));
const capabilityManifest = JSON.parse(read('capabilities/anatomy/capability.json'));
const files = {
  'plugin.json': read('plugin.json'),
  'skills/anatomy-visualization/skill.json': read('skills/anatomy-visualization/skill.json'),
  'skills/anatomy-visualization/SKILL.md': read('skills/anatomy-visualization/SKILL.md'),
  'capabilities/anatomy/capability.json': read('capabilities/anatomy/capability.json'),
  'capabilities/anatomy/runtime.js': read('capabilities/anatomy/runtime.js'),
};
const validated = validatePluginPackage({ manifest, files });
const source = files['capabilities/anatomy/runtime.js'];
const runtime = new Function(`return (${source});`)();
const lockedHost = new Proxy({}, { get() { throw new Error('The anatomy capability must not use the host object.'); } });
const invoke = (toolId, input) => runtime({ toolId, input }, lockedHost);
const render = (input) => invoke('render-anatomy', input);
const list = (input = {}) => invoke('list-supported-structures', input);
const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'marker', 'use', 'style']);

const viewBoxOf = (svg) => {
  const match = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(svg);
  assert.ok(match, 'the figure has a viewBox');
  return [Number(match[1]), Number(match[2])];
};

test('package validates under the marketplace contract', () => {
  assert.equal(validated.manifest.id, 'anatomy-visualization');
  assert.equal(validated.skills.length, 1);
  assert.equal(validated.capabilities.length, 1);
  assert.equal(skillManifest.version, manifest.version);
  assert.equal(capabilityManifest.version, manifest.version);
  assert.equal(manifest.compatibility.capabilityApi, 1);
  assert.match(manifest.compatibility.minNodusVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.deepEqual(skillManifest.capabilities, ['self:anatomy']);
  assert.deepEqual(manifest.capabilities, ['capabilities/anatomy/capability.json']);
});

test('SKILL.md names every declared capability tool', () => {
  const instructions = files['skills/anatomy-visualization/SKILL.md'];
  for (const tool of capabilityManifest.tools) {
    assert.ok(new RegExp(`(?<![A-Za-z0-9-])${tool.id}(?![A-Za-z0-9-])`).test(instructions), `SKILL.md mentions ${tool.id}`);
  }
});

test('capability is permissionless and its runtime fits the sandbox contract', () => {
  assert.deepEqual(capabilityManifest.permissions, {});
  assert.equal(capabilityManifest.runtime, 'javascript-sandbox-v1');
  assert.equal(capabilityManifest.entry, 'runtime.js');
  assert.ok(source.length <= 256_000, `runtime.js is ${source.length} characters`);
  assert.ok(!source.includes('`'), 'runtime has no backtick');
  assert.ok(!source.includes('$' + '{'), 'runtime has no template interpolation');
  assert.ok(!source.includes('\\'), 'runtime has no backslash');
  assert.equal(typeof runtime, 'function');
  assert.deepEqual(capabilityManifest.tools.map((tool) => tool.id), ['render-anatomy', 'list-supported-structures']);
});

test('terminology: canonical names, aliases, plurals and British spellings resolve', async () => {
  for (const term of ['deltoid', 'deltoids', 'deltoid muscle', 'biceps', 'kidneys', 'both kidneys', 'oesophagus', 'liver']) {
    const result = await render({ structures: [term] });
    assert.equal(result.kind, 'svg', `${term} renders`);
  }
});

test('terminology: an unknown term is refused with a suggestion, never substituted', async () => {
  await assert.rejects(render({ structures: ['supraspinatus'] }), /Unsupported structure/);
  await assert.rejects(render({ structures: ['deltoiod'] }), /Did you mean: Deltoid/);
});

test('terminology: broad ambiguous terms return candidates', async () => {
  await assert.rejects(render({ structures: ['abdominal muscles'] }), /Ambiguous structure/);
  await assert.rejects(render({ structures: ['abdominal muscles'] }), /Rectus abdominis/);
  await assert.rejects(render({ structures: ['back muscles'] }), /Upper back muscles/);
});

test('anatomy: muscles, organs and brain regions render', async () => {
  const muscles = await render({ structures: ['deltoid', 'pectoralis major', 'biceps'] });
  assert.match(muscles.svg, /Muscles - front view/);
  const organs = await render({ structures: ['liver', 'pancreas', 'spleen'] });
  assert.match(organs.svg, /Organs - front view/);
  const brain = await render({ structures: ['cerebellum', 'hippocampus'] });
  assert.match(brain.svg, /Brain regions - schematic view/);
});

test('anatomy: unsupported detail levels fail instead of degrading silently', async () => {
  await assert.rejects(render({ structures: ['quadriceps vastus medialis'] }), /Unsupported structure/);
  await assert.rejects(render({ structures: ['deltoid anterior head'] }), /Unsupported structure/);
});

test('anatomy: per-side laterality is refused and bilateral requests are explicit', async () => {
  await assert.rejects(render({ structures: ['left kidney'] }), /Per-side laterality is not supported/);
  await assert.rejects(render({ structures: ['right deltoid'] }), /Per-side laterality is not supported/);
  const bilateral = await render({ structures: ['kidneys'] });
  assert.match(bilateral.svg, /per-side .*selection is not available/i);
});

test('anatomy: unavailable views are refused with the available views', async () => {
  const back = await render({ structures: ['gluteal muscles'], view: 'back' });
  assert.match(back.svg, /Muscles - back view/);
  await assert.rejects(render({ structures: ['gluteal muscles'], view: 'front' }), /back/);
  await assert.rejects(render({ structures: ['liver'], view: 'back' }), /front view only/);
  await assert.rejects(render({ structures: ['cerebellum'], view: 'front' }), /dedicated brain view/);
});

test('anatomy: sex-specific structures select the right body and refuse impossible mixes', async () => {
  const female = await render({ structures: ['uterus', 'ovaries'] });
  assert.match(female.svg, /front view \(female\)/);
  const male = await render({ structures: ['prostate gland'] });
  assert.match(male.svg, /front view \(male\)/);
  await assert.rejects(render({ structures: ['uterus', 'prostate'] }), /cannot share one body drawing/);
  await assert.rejects(render({ structures: ['uterus'], sex: 'male' }), /male body drawing cannot show/);
});

test('rendering: the figure is an SVG with a positive viewBox, labels, legend and attribution', async () => {
  const result = await render({ structures: ['liver', 'deltoid'], title: 'Test figure' });
  assert.equal(result.kind, 'svg');
  assert.match(result.svg, /^<svg\b/);
  assert.equal(result.title, 'Test figure');
  const [width, height] = viewBoxOf(result.svg);
  assert.ok(width > 0 && height > 0);
  assert.ok(result.svg.length < 300_000);
  assert.match(result.svg, /Legend/);
  assert.match(result.svg, />1</);
  assert.match(result.svg, /Expression Atlas/);
  assert.match(result.svg, /react-native-body-highlighter/);
  assert.match(result.svg, /not validated for clinical use/);
  assert.match(result.svg, /Deltoid/);
  assert.match(result.svg, /Liver/);
});

test('rendering: labels and legend can be disabled independently', async () => {
  const plain = await render({ structures: ['liver'], labels: false, legend: false });
  assert.doesNotMatch(plain.svg, /Legend/);
  assert.doesNotMatch(plain.svg, /<circle/);
  await assert.rejects(render({ structures: ['liver'], labels: false, legend: true }), /legend needs numbered labels/);
});

test('rendering: highlight colours are validated', async () => {
  const teal = await render({ structures: ['heart'], highlight: 'teal' });
  assert.match(teal.svg, /#2a9d8f/);
  await assert.rejects(render({ structures: ['heart'], highlight: 'chartreuse' }), /highlight must be one of/);
});

test('rendering: mixed providers are shown as separate panels with a coordinate notice', async () => {
  const mixed = await render({ structures: ['deltoid', 'liver'] });
  assert.match(mixed.svg, /different coordinate systems/);
  assert.match(mixed.svg, /Muscles - front view/);
  assert.match(mixed.svg, /Organs - front view/);
});

test('rendering: the same request always produces the same figure', async () => {
  const first = await render({ structures: ['deltoid', 'liver'], title: 'Deterministic' });
  const second = await render({ structures: ['deltoid', 'liver'], title: 'Deterministic' });
  assert.equal(first.svg, second.svg);
});

test('security: the figure contains no active or executable content', async () => {
  const inputs = [
    { structures: ['deltoid', 'liver', 'cerebellum'] },
    { structures: ['uterus', 'ovaries'] },
    { structures: ['heart'], title: 'Heart' },
  ];
  for (const input of inputs) {
    const { svg } = await render(input);
    assert.doesNotMatch(svg, /<script/i);
    assert.doesNotMatch(svg, /foreignObject/i);
    assert.doesNotMatch(svg, /<image/i);
    assert.doesNotMatch(svg, /<use/i);
    assert.doesNotMatch(svg, /\son[a-z]+=/i);
    assert.doesNotMatch(svg, /javascript:/i);
    assert.doesNotMatch(svg, /\bhref=/i);
    assert.doesNotMatch(svg, /<style/i);
    assert.doesNotMatch(svg, /<iframe|@import|<!DOCTYPE|<!ENTITY/i);
    assert.doesNotMatch(svg, /url\((?!#)/i);
  }
});

test('security: every emitted tag is inside the Nodus SVG allowlist', async () => {
  const { svg } = await render({ structures: ['deltoid', 'liver', 'cerebellum'] });
  for (const match of svg.matchAll(/<([A-Za-z][A-Za-z0-9:-]*)/g)) {
    assert.ok(ALLOWED_TAGS.has(match[1]), `unexpected tag ${match[1]}`);
  }
});

test('security: the runtime never reaches the host, the network or stored state', () => {
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|importScripts/);
  assert.doesNotMatch(source, /host\./);
  assert.deepEqual(capabilityManifest.permissions, {});
});

test('input validation: count, size, unknown fields and titles are bounded', async () => {
  await assert.rejects(render({ structures: [] }), /at least one structure/);
  await assert.rejects(render({ structures: Array.from({ length: 13 }, () => 'liver') }), /At most 12 structures/);
  await assert.rejects(render({ structures: ['x'.repeat(65)] }), /64 characters/);
  await assert.rejects(render({ structures: ['liver'], title: '<b>bad</b>' }), /markup characters/);
  await assert.rejects(render({ structures: ['liver'], title: 'y'.repeat(81) }), /between 1 and 80/);
  const schema = capabilityManifest.tools[0].inputSchema;
  assert.equal(jsonSchemaMatches(schema, { structures: ['liver'], unknown: true }), false);
  assert.equal(jsonSchemaMatches(schema, { structures: ['liver'], view: 'sideways' }), false);
  assert.equal(jsonSchemaMatches(schema, { structures: ['liver'], highlight: 'chartreuse' }), false);
  assert.equal(jsonSchemaMatches(schema, { structures: ['liver'], view: 'front' }), true);
});

test('input validation: related structures must be passed separately', async () => {
  await assert.rejects(render({ structures: ['deltoid and pectoralis major'] }), /one structure per array item/);
});

test('failure modes: unknown tools and a corrupted payload fail honestly', async () => {
  await assert.rejects(invoke('render-everything', {}), /Unknown anatomy capability tool/);
  const corrupted = source.replace(/const PAYLOAD = '[^']+'/, "const PAYLOAD = 'AAAA'");
  const broken = new Function(`return (${corrupted});`)();
  await assert.rejects(broken({ toolId: 'render-anatomy', input: { structures: ['liver'] } }, {}));
});

test('catalog: list-supported-structures reports categories, aliases, ontology and licence', async () => {
  const all = await list();
  assert.ok(all.value.total >= 70);
  assert.ok(all.value.structures.length === all.value.total);
  assert.ok(JSON.stringify(all.value).length < 256_000);
  const organs = await list({ category: 'organ' });
  assert.ok(organs.value.structures.every((entry) => entry.category === 'organ'));
  const search = await list({ search: 'kidney' });
  assert.ok(search.value.structures.some((entry) => entry.canonicalName === 'Kidneys'));
  const liver = all.value.structures.find((entry) => entry.id === 'liver');
  assert.equal(liver.ontology.namespace, 'UBERON');
  assert.equal(liver.ontology.id, 'UBERON:0002107');
  assert.equal(liver.fma.id, 'FMA:7197');
  assert.match(liver.license, /CC BY 4.0/);
  const deltoid = all.value.structures.find((entry) => entry.id === 'deltoid');
  assert.equal(deltoid.ontology, null);
  assert.equal(deltoid.fma.id, 'FMA:32521');
  assert.match(deltoid.license, /MIT/);
  assert.ok(all.value.ambiguousTerms.some((entry) => entry.term === 'abdominal muscles'));
});

test('provenance: notices and pinned sources travel with the installable package', () => {
  assert.match(source, /Copyright \(c\) 2022 ELABBASSI Hicham/);
  assert.match(source, /EMBL-EBI Expression Atlas \(CC BY 4\.0\)/);
  assert.match(source, /Foundational Model of Anatomy \(CC BY 4\.0\)/);
  assert.match(source, /packaged by Anatome/);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/anatomy/sources.lock.json'), 'utf8'));
  for (const entry of lock.sources) {
    assert.match(entry.revision, /^[0-9a-f]{40}$/, `${entry.id} has a pinned revision`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.id} has a SHA-256 digest`);
  }
  assert.ok(lock.fma.matches.liver.id === 'FMA:7197');
});

test('skill documentation covers the ordered workflow and the required behaviours', () => {
  const instructions = files['skills/anatomy-visualization/SKILL.md'];
  for (const heading of ['Purpose', 'Required inputs', 'Required capabilities', 'Input validation', 'execution steps', 'attribution', 'Limitations', 'refusal']) {
    assert.match(instructions, new RegExp(heading, 'i'), `SKILL.md covers ${heading}`);
  }
  for (const behaviour of ['unsupported term', 'ambiguous term', 'laterality', 'Network', 'resource-integrity', 'disabled capability']) {
    assert.match(instructions, new RegExp(behaviour.split(' ')[0], 'i'), `SKILL.md covers ${behaviour}`);
  }
  assert.ok(instructions.length <= 16_000, 'SKILL.md is within the 16,000-character limit');
  assert.match(instructions, /English-only/, 'this version is English-only');
  assert.deepEqual(Object.keys(capabilityManifest.permissions), [], 'the capability has no localisation or language configuration');
});
