// Deterministic tests for the Anatomy Visualization plugin.
//
// They exercise the real package through the public marketplace contract and the embedded
// capability runtime. No network, credentials, paid services, patient data or student data
// are used, and no test depends on a running Nodus build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateModelAsset } from './contract-v2.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginPackage, jsonSchemaMatches, validatePackagedModelResult } from './contract.mjs';

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
for (const asset of capabilityManifest.assets ?? []) files['capabilities/anatomy/' + asset.path] = fs.readFileSync(path.join(packageDir,'capabilities/anatomy',asset.path), asset.mimeType === 'model/gltf-binary' ? 'base64' : 'utf8');
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
  assert.deepEqual(skillManifest.capabilities, ['self:anatomy', 'nodus:3d']);
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
  assert.deepEqual(capabilityManifest.tools.map((tool) => tool.id), ['render-anatomy', 'list-supported-structures', 'render-anatomy-3d', 'query-anatomy']);
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

test('rendering: every structure gets its own colour and a numbered callout with a leader line', async () => {
  const result = await render({ structures: ['heart', 'liver', 'kidneys'] });
  for (const color of ['#d1495b', '#2a9d8f', '#3a6ea5']) assert.match(result.svg, new RegExp(color));
  assert.match(result.svg, /<line\b/, 'callout leader lines are drawn');
  assert.match(result.svg, /Numbers and leader lines identify/);
  const schema = capabilityManifest.tools[0].inputSchema;
  assert.equal(jsonSchemaMatches(schema, { structures: ['heart'], highlight: 'teal' }), false);
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

test('security: runtime host use is confined to declared read-only atlas data', () => {
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|importScripts/);
  assert.doesNotMatch(source, /host\.(network|storage|secrets|files|models)/);
  assert.match(source, /host\.assets\.read\('atlas'\)/);
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
  assert.match(instructions, /English and Spanish/, 'terminology is curated in both languages');
  assert.deepEqual(Object.keys(capabilityManifest.permissions), [], 'the capability has no localisation or language configuration');
});

const assetHost = { assets: { read: async id => {
  const asset = capabilityManifest.assets.find(a=>a.id===id);
  if (!asset || asset.mimeType !== 'application/json') throw new Error('Undeclared JSON asset');
  const bytes=fs.readFileSync(path.join(packageDir,'capabilities/anatomy',asset.path));
  assert.equal(bytes.length,asset.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  return JSON.parse(bytes);
} } };
const atlasInvoke=(toolId,input)=>runtime({toolId,input},assetHost);
const render3d=async input=>{const result=await atlasInvoke('render-anatomy-3d',input);validatePackagedModelResult(result);return result;};
const query=input=>atlasInvoke('query-anatomy',input);

test('legacy default SVGs match the exact pre-release output hashes',async()=>{
  const fixtures=JSON.parse(fs.readFileSync(path.join(root,'scripts/anatomy/svg-compatibility.json')));
  for(const {input,sha256} of fixtures){const result=await render(input);assert.equal(crypto.createHash('sha256').update(result.svg).digest('hex'),sha256);}
});
test('English and Spanish aliases resolve deterministically without accepting translations outside the registry',async()=>{
  for(const term of ['riñón','riñones','hígado','deltoides'])assert.equal((await render({structures:[term],language:'es'})).kind,'svg');
  const spanish=await render({structures:['hígado','riñones'],language:'es'});
  assert.match(spanish.svg,/Hígado/);assert.match(spanish.svg,/Riñones/);assert.match(spanish.svg,/Leyenda/);
  await assert.rejects(render({structures:['foie']}),/Unsupported structure/);
  await assert.rejects(render({structures:['rinon']}),/Unsupported structure/);
  await assert.rejects(render({structures:['liver'],language:'fr'}),/language/);
});
test('sex both renders male and female organs on separate source panels',async()=>{
  const r=await render({structures:['uterus','ovaries','prostate','testes'],sex:'both'});
  assert.match(r.svg,/front view \(male\)/);assert.match(r.svg,/front view \(female\)/);
  assert.match(r.svg,/Sex comparison: independent panels/);
  await assert.rejects(render({structures:['uterus'],sex:'male'}),/cannot show/);
});
test('number-only quiz has numbered callouts without a legend or hidden answer names',async()=>{
  const r=await render({structures:['liver','kidneys'],labelMode:'numbers',legend:false});
  assert.match(r.svg,/>1</);assert.match(r.svg,/>2</);assert.match(r.svg,/<line /);
  assert.doesNotMatch(r.svg,/Legend|Liver|Kidneys/);
  const names=await render({structures:['liver'],labelMode:'names',legend:false});assert.match(names.svg,/>Liver</);
  await assert.rejects(render({structures:['liver'],labelMode:'names',labels:true}),/labelMode or legacy/);
  await assert.rejects(render({structures:['liver'],labelMode:'guess'}),/labelMode/);
});
test('runtime independently rejects unknown fields and wrong scalar types',async()=>{
  for(const input of [{structures:['liver'],url:'https://example.com'},{structures:['liver'],legend:1},{structures:['liver'],labels:'false'},{structures:['liver'],title:{}}])await assert.rejects(render(input));
});
test('every packaged 3D asset verifies its hash and passes the native format contract',()=>{
  for(const asset of capabilityManifest.assets){
    const bytes=fs.readFileSync(path.join(packageDir,'capabilities/anatomy',asset.path));
    assert.equal(bytes.length,asset.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    if(asset.mimeType.startsWith('model/')){
      const result=validateModelAsset(bytes,asset.mimeType);assert.equal(result.selfContained,true);
      const model=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
      assert.ok(model.nodes.some(n=>n.extras?.id));assert.ok(model.asset.copyright);
      assert.ok(model.nodes.some(n=>n.extras?.ontologyIds?.length)||model.asset.extras?.provenance);
      assert.ok(!model.buffers.some(b=>b.uri));
    }
  }
});
test('3D laterality uses explicitly source-labelled structures and never guesses a side',async()=>{
  const left=await render3d({structures:['left kidney']}),right=await render3d({structures:['right kidney']}),both=await render3d({structures:['both kidneys']});
  assert.notDeepEqual(left.panels[0].nodeIds,right.panels[0].nodeIds);
  assert.deepEqual(both.panels[0].nodeIds,[...left.panels[0].nodeIds,...right.panels[0].nodeIds].sort());
  assert.deepEqual((await render3d({structures:['riñón izquierdo'],language:'es'})).panels[0].nodeIds,left.panels[0].nodeIds);
  const ld=await render3d({structures:['left deltoid']}),rd=await render3d({structures:['right deltoid']});
  assert.notDeepEqual(ld.panels[0].nodeIds,rd.panels[0].nodeIds);assert.match(ld.metadata.notices.join(' '),/portions/);
  await assert.rejects(render3d({structures:['left liver']}),/Unsupported laterality/);
  await assert.rejects(render3d({structures:['both liver']}),/Unsupported bilateral/);
  await assert.rejects(render3d({structures:['left ambos riñones']}),/Conflicting laterality/);
  await assert.rejects(render3d({structures:['kidney'],sex:null}),/Invalid sex/);
});
test('3D source frames and sex-specific anatomy remain separate',async()=>{
  const result=await render3d({structures:['uterus','ovaries','prostate','testes'],sex:'both'});
  assert.equal(result.kind,'model');assert.ok(result.panels.length>=4);
  assert.ok(result.panels.some(p=>p.assetId==='bodyparts3d-male'));assert.ok(result.panels.some(p=>p.assetId==='hra-uterus'));
  const kidneys=await render3d({structures:['kidneys'],sex:'both'});assert.equal(kidneys.panels.length,3);
  await assert.rejects(render3d({structures:['uterus'],sex:'male'}),/No verified 3D/);
  await assert.rejects(render3d({structures:['prostate'],sex:'female'}),/No verified 3D/);
});
test('source relationships, inverse HAS-PART, namespaces and unsupported query bounds are explicit',async()=>{
  const parts=await query({structure:'kidney',relation:'has-part',depth:2});
  assert.ok(parts.value.edges.length);assert.ok(parts.value.edges.every(e=>e.predicate==='part-of'));
  const edge=parts.value.edges[0];
  const parent=await query({structure:edge.subject,relation:'part-of'});assert.ok(parent.value.edges.some(e=>e.object===edge.object));
  const isa=await query({structure:'left kidney',relation:'is-a'});assert.ok(isa.value.edges.some(e=>e.predicate==='is-a'));
  assert.ok(isa.value.nodes.every(n=>n.ontology.namespace==='FMA'&&n.ontology.id.startsWith('FMA:')));
  const uberon=await query({structure:'UBERON:0002113',relation:'is-a'});assert.ok(uberon.value.nodes.every(n=>n.ontology.namespace==='UBERON'));
  await assert.rejects(query({structure:'UBERON:9999999',relation:'is-a'}),/Unsupported structure/);
  await assert.rejects(query({structure:'kidney',relation:'invented'}),/relation/);
  await assert.rejects(query({structure:'kidney',relation:'is-a',depth:100}),/bounds/);
});
test('system collections expose their source memberships and partial geometry coverage',async()=>{
  for(const term of ['digestive system','urinary system','skeletal system','respiratory system','endocrine system','cardiovascular system','nervous system']){
    const q=await query({structure:term,relation:'has-part'});assert.ok(q.value.edges.length,term);
    const r=await render3d({structures:[term]});assert.ok(r.panels[0].nodeIds.length);assert.match(r.metadata.notices.join(' '),/partial/);
  }
  const es=await render3d({structures:['sistema digestivo'],language:'es'});assert.ok(es.panels.length);
  await assert.rejects(render3d({structures:['lymphatic system']}),/Unsupported structure/);
});
test('geometry metadata distinguishes semantic-only entities, renderable anatomy and licences',async()=>{
  const result=await atlasInvoke('list-supported-structures',{dimension:'model',search:'femur'});
  assert.ok(result.value.structures.length);assert.ok(result.value.structures.every(e=>e.availability.model));
  assert.ok(result.value.sources.every(s=>s.sha256.length===64&&['CC-BY-4.0','CC-BY-3.0'].includes(s.license)));
  const r=await render3d({structures:['kidney']});assert.match(JSON.stringify(r.metadata.provenance),/Database Center for Life Science/);
  assert.match(JSON.stringify(r.metadata.provenance),/CC-BY-4.0/);
  await assert.rejects(atlasInvoke('list-supported-structures',{dimension:'model',limit:1000}),/pagination/);
});
test('offline 3D and query outputs are deterministic and missing assets fail without fallback',async()=>{
  for(const [tool,input] of [['render-anatomy-3d',{structures:['kidney','femur']}],['query-anatomy',{structure:'urinary system',relation:'has-part',depth:4}]])assert.deepEqual(await atlasInvoke(tool,input),await atlasInvoke(tool,input));
  await assert.rejects(runtime({toolId:'render-anatomy-3d',input:{structures:['kidney']}},{}),/Packaged assets are unavailable/);
  const corrupt={assets:{read:async()=>({schemaVersion:99})}};await assert.rejects(runtime({toolId:'query-anatomy',input:{structure:'kidney',relation:'has-part'}},corrupt),/resource-integrity/);
  await assert.rejects(render3d({structures:['unicorn horn']}),/Unsupported structure/);
});
