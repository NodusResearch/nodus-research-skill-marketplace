// Reproducible conversion of pinned reference meshes. No generated anatomical geometry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { validateModelAsset } from '../contract-v2.mjs';
import { BODY_PARTS_SELECTION, SYSTEMS, DELTOID_PORTIONS } from './atlas-selection.mjs';
import { SPANISH_FMA } from './terminology.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const target = path.join(root, 'anatomy-visualization/capabilities/anatomy');
const cache = process.env.ANATOMY_SOURCE_CACHE || path.join(os.tmpdir(), 'anatomy-atlas-sources');
const lock = JSON.parse(fs.readFileSync(path.join(here, 'atlas-sources.lock.json')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const offline = process.argv.includes('--offline');
fs.mkdirSync(cache, { recursive: true });
for (const source of lock.sources) {
  const file = path.join(cache, source.file);
  if (!fs.existsSync(file)) {
    if (offline) throw new Error('Missing pinned offline source: ' + source.file);
    const response = await fetch(source.url, { redirect: 'error' });
    if (!response.ok) throw new Error('Source unavailable: ' + source.file);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error('SHA-256 mismatch: ' + source.file);
    fs.writeFileSync(file, bytes);
  }
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error('SHA-256 mismatch: ' + source.file);
}
const read = name => fs.readFileSync(path.join(cache, name));
const rows = name => read(name).toString('utf8').trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));
const entities = new Map(), relations = [], elements = new Map();
const add = (id, name) => {
  if (!/^FMA[0-9]+$/.test(id) || !name) throw new Error('Invalid source identity');
  if (entities.has(id) && entities.get(id).canonicalName !== name) throw new Error('Conflicting source name: ' + id);
  if (!entities.has(id)) entities.set(id, { id, canonicalName: name, ontology: { namespace: 'FMA', id: id.replace('FMA', 'FMA:') }, aliases: [], labels: { en: name }, geometry: [], laterality: name.startsWith('left ') ? 'left' : name.startsWith('right ') ? 'right' : 'unspecified' });
};
for (const [file, predicate] of [['partof_inclusion_relation_list.txt', 'part-of'], ['isa_inclusion_relation_list.txt', 'is-a']]) {
  for (const [parent, parentName, child, childName] of rows(file)) {
    add(parent, parentName); add(child, childName);
    relations.push({ subject: child, predicate, object: parent, source: file });
  }
}
for (const [id, , name] of rows('isa_parts_list_e.txt')) add(id, name);
for (const [id, name, file] of rows('isa_element_parts.txt')) {
  add(id, name); if (!elements.has(id)) elements.set(id, []); elements.get(id).push(file);
}
// PART-OF compounds supply system membership but do not override IS-A mesh definitions.
const partElements = new Map();
for (const [id, name, file] of rows('partof_element_parts.txt')) {
  add(id, name); if (!partElements.has(id)) partElements.set(id, []); partElements.get(id).push(file);
}
const zip = new AdmZip(read('isa_BP3D_4.0_obj_99.zip'));
const partZip = new AdmZip(read('partof_BP3D_4.0_obj_99.zip'));
const zipFiles = new Map();
for (const archive of [zip,partZip]) for (const entry of archive.getEntries()) {
  if (!entry.isDirectory) {
    const id=path.posix.basename(entry.entryName,'.obj'), previous=zipFiles.get(id);
    if(previous && previous.archive.readFile(previous.file).toString('utf8').split(/\r?\n/).filter(l=>!l.startsWith('#')).join('\n')!==entry.getData().toString('utf8').split(/\r?\n/).filter(l=>!l.startsWith('#')).join('\n')) throw new Error('Conflicting source mesh bytes: '+id);
    if(!previous)zipFiles.set(id,{archive,file:entry.entryName});
  }
  if (entry.isDirectory) continue;
  const text = entry.getData().toString('utf8');
  const concept = /^# Concept ID : (FMA[0-9]+)/m.exec(text)?.[1];
  const name = /^# English name : (.+)$/m.exec(text)?.[1];
  if (!concept) continue; // Unlabelled elements can only be reached through an explicit compound table.
  const file = path.posix.basename(entry.entryName, '.obj');
  if (!elements.has(concept)) elements.set(concept, [file]);
}
for (const [id,files] of partElements) if (!elements.has(id)) elements.set(id,files);
const byName = new Map([...entities.values()].map(entry => [entry.canonicalName, entry]));
const selected = new Set();
const missing = BODY_PARTS_SELECTION.filter(name => !byName.has(name) || !elements.has(byName.get(name).id));
if (missing.length) throw new Error('Selected anatomy without source geometry: '+missing.join(', '));
for (const name of BODY_PARTS_SELECTION) {
  const entry = byName.get(name);
  if (!entry || !elements.has(entry.id)) throw new Error('Selected anatomy has no source geometry: ' + name);
  selected.add(entry.id);
  for (const side of ['left', 'right']) {
    const sided = byName.get(side + ' ' + name);
    if (sided && elements.has(sided.id)) selected.add(sided.id);
  }
}
for (const id of Object.values(DELTOID_PORTIONS).flat()) {
  if (!elements.has(id)) throw new Error('Missing deltoid portion: ' + id); selected.add(id);
}
const fileIds = [...new Set([...selected].flatMap(id => elements.get(id)))].sort();
const attribution = 'BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International';
const provenance = { provider: 'BodyParts3D', revision: '4.0 (2013-06-19)', license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution, source: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html', sourceArchives: lock.sources.filter(s => s.file.endsWith('.zip')), coordinateEvidence: lock.sources.find(s => s.file === 'coordinate-system.png'), licenseEvidence: lock.sources.filter(s => ['bodyparts-license.html', 'README_e.html'].includes(s.file)), modifications: 'Selected reference OBJ meshes converted to GLB triangles and float32 coordinates in metres (source millimetres); source vertices retained, with a single rigid root rotation from documented source Z-up to glTF Y-up; no smoothing or generated anatomy.', historicalNotice: lock.licenseNote };
const gltf = { asset: { version: '2.0', generator: 'Nodus anatomy build-atlas.mjs', copyright: attribution }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'BodyParts3D male reference', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], extras: { id: 'bodyparts3d-male', sex: 'male', provenance }, children: [] }], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [{ name: 'Reference anatomy', pbrMetallicRoughness: { baseColorFactor: [0.7,0.58,0.48,1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }] };
const binaries = [], meshLock = [];
let offset = 0;
const bufferView = bytes => { const index = gltf.bufferViews.length; gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); binaries.push(bytes); offset += bytes.length; return index; };
for (const fileId of fileIds) {
  const item = zipFiles.get(fileId);
  if (!item) throw new Error('Missing source mesh: '+fileId);
  const file = item.file;
  const raw = item.archive.readFile(file); if (!raw) throw new Error('Missing verified OBJ: ' + file);
  const positions = [], indices = [];
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    const [kind, ...values] = line.trim().split(/\s+/);
    if (kind === 'v') {
      if (values.length !== 3 || values.some(v => !Number.isFinite(Number(v)))) throw new Error('Invalid OBJ vertex');
      positions.push(...values.map(v => Number(v) / 1000));
    } else if (kind === 'f') {
      if (values.length !== 3) throw new Error('Only source triangles are accepted');
      for (const value of values) { const index = Number(value.split('/')[0]) - 1; if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid OBJ face'); indices.push(index); }
    } else if (kind && !kind.startsWith('#') && !['vn','vt','o','g','s','usemtl','mtllib'].includes(kind)) throw new Error('Unsupported OBJ record: ' + kind);
  }
  if (!positions.length || !indices.length || indices.some(i => i >= positions.length / 3)) throw new Error('Invalid OBJ indices');
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  const vertices = Buffer.alloc(positions.length * 4), faces = Buffer.alloc(indices.length * 4);
  positions.forEach((n,i) => { const value = Math.fround(n); vertices.writeFloatLE(value,i*4); min[i%3]=Math.min(min[i%3],value); max[i%3]=Math.max(max[i%3],value); });
  indices.forEach((n,i) => faces.writeUInt32LE(n,i*4));
  const position = gltf.accessors.length;
  gltf.accessors.push({ bufferView: bufferView(vertices), componentType: 5126, count: positions.length/3, type: 'VEC3', min, max });
  const index = gltf.accessors.length;
  gltf.accessors.push({ bufferView: bufferView(faces), componentType: 5125, count: indices.length, type: 'SCALAR' });
  const mesh = gltf.meshes.length;
  gltf.meshes.push({ name: fileId, primitives: [{ attributes: { POSITION: position }, indices: index, material: 0 }] });
  const sourceEntities = [...selected].filter(id => elements.get(id).includes(fileId));
  gltf.nodes[0].children.push(gltf.nodes.length);
  gltf.nodes.push({ name: fileId, mesh, extras: { id: fileId, canonicalNames: sourceEntities.map(id => entities.get(id).canonicalName), ontologyIds: sourceEntities.map(id => entities.get(id).ontology.id), sourceAsset: file, sha256: hash(raw) } });
  meshLock.push({ file, sha256: hash(raw), bytes: raw.length, vertices: positions.length/3, triangles: indices.length/3 });
}
const makeGlb = (model, binary) => {
  const json=Buffer.from(JSON.stringify(model)), padded=Buffer.alloc(Math.ceil(json.length/4)*4,0x20);json.copy(padded);
  const bin=Buffer.alloc(Math.ceil(binary.length/4)*4);binary.copy(bin);
  const out=Buffer.alloc(28+padded.length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);
  const at=20+padded.length;out.writeUInt32LE(bin.length,at);out.writeUInt32LE(0x004e4942,at+4);bin.copy(out,at+8);return out;
};
const binary = Buffer.concat(binaries);
gltf.buffers.push({ byteLength: binary.length });
for (const id of selected) entities.get(id).geometry.push({ assetId: 'bodyparts3d-male', sex: 'male', nodeIds: elements.get(id), provenance: 'bodyparts3d' });
// A semantic collection may be only partly drawable. Record exactly which descendants have
// verified packaged geometry, and never promote the others into renderable coverage.
const descendants = (id, predicate) => {
  const seen = new Set([id]), queue = [id];
  for (let i=0;i<queue.length;i++) for (const r of relations) if (r.predicate===predicate && r.object===queue[i] && !seen.has(r.subject)) {seen.add(r.subject);queue.push(r.subject);}
  return [...seen].slice(1);
};
const collections = [];
for (const [id, aliases] of Object.entries(SYSTEMS)) {
  const entry = entities.get(id); if (!entry) throw new Error('Missing source system: '+id);
  entry.aliases.push(...aliases.map(term => ({ term, language:'en', generalised:false })));
  const members = descendants(id, 'part-of');
  const compound = partElements.get(id) || [];
  const available = [...new Set([...members.filter(m => selected.has(m)).flatMap(m => elements.get(m)), ...compound.filter(f => fileIds.includes(f))])].sort();
  collections.push({ id, canonicalName: aliases[0], members, relation:'part-of', coverage:'partial reference subset', unavailableMembers:members.filter(m=>!selected.has(m)) });
  if (available.length) entry.geometry.push({assetId:'bodyparts3d-male',sex:'male',nodeIds:available,provenance:'bodyparts3d'});
}
// Keep source frame per HRA model. No registration between organs is invented.
const hraModels = [
  ['VH_F_Kidney_L.glb','kidney-female-left.md','HRA:kidney-left','left kidney'],
  ['VH_F_Kidney_R.glb','kidney-female-right.md','HRA:kidney-right','right kidney'],
  ['VH_F_Uterus.glb','uterus-female.md','HRA:uterus','uterus'],
  ['VH_F_Ovary_L.glb','ovary-female-left.md','HRA:ovary-left','left ovary'],
  ['VH_F_Ovary_R.glb','ovary-female-right.md','HRA:ovary-right','right ovary'],
];
const systemGroups = new Map();
for (const collection of collections) {
  const e=entities.get(collection.id), geometry=e.geometry.find(g=>g.assetId==='bodyparts3d-male');
  if(!geometry)continue;
  const nodeIndex=gltf.nodes.length;
  gltf.nodes.push({name:collection.canonicalName,extras:{id:collection.id,ontologyId:e.ontology.id,coverage:collection.coverage},children:[]});
  systemGroups.set(collection.id,{nodeIndex,members:new Set(geometry.nodeIds)});
}
const roots=[];
for (const index of gltf.nodes[0].children) {
  const node=gltf.nodes[index], groups=[...systemGroups].filter(([,g])=>g.members.has(node.extras.id));
  node.extras.collectionIds=groups.map(([id])=>id);
  if(groups.length)gltf.nodes[groups[0][1].nodeIndex].children.push(index);else roots.push(index);
}
gltf.nodes[0].children=[...systemGroups.values()].filter(g=>gltf.nodes[g.nodeIndex].children.length).map(g=>g.nodeIndex).concat(roots);
const generated = new Map([['bodyparts3d-male.glb', makeGlb(gltf,binary)]]);
const hra = [];
for (const [file, metadataFile, id, canonicalName] of hraModels) {
  const raw = read(file); validateModelAsset(raw,'model/gltf-binary');
  const jsonLength=raw.readUInt32LE(12), model=JSON.parse(raw.subarray(20,20+jsonLength));
  const binAt=20+jsonLength, binLength=raw.readUInt32LE(binAt);
  if (raw.readUInt32LE(binAt+4)!==0x004e4942 || model.buffers.length!==1) throw new Error('Unexpected HRA container');
  const b=raw.subarray(binAt+8,binAt+8+binLength);
  if (model.buffers[0].uri) throw new Error('HRA model must use its own BIN chunk.');
  const omittedNormals=[];
  for (const [meshIndex,mesh] of model.meshes.entries()) for(const [primitiveIndex,primitive] of mesh.primitives.entries()) {
    const normalIndex=primitive.attributes.NORMAL;if(normalIndex===undefined)continue;
    const accessor=model.accessors[normalIndex],view=model.bufferViews[accessor.bufferView];
    if(accessor.componentType!==5126||accessor.type!=='VEC3')throw new Error('Unexpected source normal representation');
    let invalid=false;
    for(let i=0;i<accessor.count;i++){const at=(view.byteOffset||0)+(accessor.byteOffset||0)+i*(view.byteStride||12);const length=Math.hypot(b.readFloatLE(at),b.readFloatLE(at+4),b.readFloatLE(at+8));if(!Number.isFinite(length)||Math.abs(length-1)>0.0005){invalid=true;break;}}
    if(invalid){delete primitive.attributes.NORMAL;omittedNormals.push({mesh:meshIndex,primitive:primitiveIndex,accessor:normalIndex});}
  }
  const assetId=id.toLowerCase().replace(':','-');
  const metadata=read(metadataFile).toString('utf8');
  if (!metadata.includes('CC BY 4.0')) throw new Error('Missing HRA asset-specific licence');
  const source=lock.sources.find(s=>s.file===file);
  const credits={ provider:'HuBMAP HRA', source:source.url, revision:source.revision, sourceAsset:file, sha256:source.sha256, license:'CC-BY-4.0', licenseUrl:'https://creativecommons.org/licenses/by/4.0/', attribution:metadata, modifications:'GLB container retained; stable source node identities and provenance added. Source transforms and coordinates unchanged. Invalid source NORMAL attributes are omitted, allowing standard flat shading from the unchanged source triangles; no vertices or faces are added or moved.', omittedNormals, limitations:'Each organ retains its independent source coordinate frame. Source documentation for the female uterus includes an inconsistent Visible Human Male sentence; the source title and mesh identify female uterus. No patient-specific or clinical validation.' };
  const rootIds=model.scenes[model.scene??0].nodes;
  const nodeIds=[];
  for (let i=0;i<model.nodes.length;i++) {
    const node=model.nodes[i]; const stable=assetId+'.'+i;
    node.extras={...node.extras,id:stable,canonicalName:node.name||canonicalName,sourceNode:i};
    if(rootIds.includes(i))nodeIds.push(stable);
  }
  model.asset.copyright='HuBMAP HRA. CC BY 4.0. See asset.extras.provenance for asset-specific attribution.';
  model.asset.extras={...model.asset.extras,provenance:credits};
  generated.set(assetId+'.glb',makeGlb(model,b.subarray(0,model.buffers[0].byteLength)));
  const spanishNames={'HRA:uterus':['Útero','útero'],'HRA:ovary-left':['Ovario izquierdo','ovario izquierdo'],'HRA:ovary-right':['Ovario derecho','ovario derecho'],'HRA:kidney-left':['Riñón izquierdo','riñón izquierdo'],'HRA:kidney-right':['Riñón derecho','riñón derecho']};
  const spanish=spanishNames[id];
  hra.push({id,canonicalName,aliases:spanish?[{term:spanish[1],language:'es',generalised:false}]:[],labels:{en:canonicalName,...(spanish?{es:spanish[0]}:{})},ontology:null,laterality:canonicalName.startsWith('left ')?'left':canonicalName.startsWith('right ')?'right':'unpaired',geometry:[{assetId,sex:'female',nodeIds,provenance:assetId}],provenance:credits});
}
hra.push({id:'HRA:ovaries',canonicalName:'ovaries',aliases:[{term:'ovary',language:'en',generalised:false},{term:'ovarios',language:'es',generalised:false},{term:'ovario',language:'es',generalised:false}],labels:{en:'ovaries',es:'Ovarios'},ontology:null,laterality:'bilateral',geometry:hra.filter(e=>e.id==='HRA:ovary-left'||e.id==='HRA:ovary-right').flatMap(e=>e.geometry),provenance:{license:'CC-BY-4.0',sources:hra.filter(e=>e.id.startsWith('HRA:ovary-')).map(e=>e.provenance)}});
for (const [id,label] of [['FMA5022','muscles'],['FMA65132','nerves']]) {
  const e=entities.get(id),members=descendants(id,'is-a');
  if (!e) throw new Error('Missing source collection: '+id);
  e.aliases.push({term:label,language:'en',generalised:false});
  const nodeIds=[...new Set(members.filter(m=>selected.has(m)).flatMap(m=>elements.get(m)))].sort();
  collections.push({id,canonicalName:label,members,relation:'is-a',coverage:'partial source class',unavailableMembers:members.filter(m=>!selected.has(m))});
  if(nodeIds.length)e.geometry.push({assetId:'bodyparts3d-male',sex:'male',nodeIds,provenance:'bodyparts3d'});
}
for (const e of entities.values()) {
  const spanish=SPANISH_FMA[e.id];
  if (spanish) {e.labels.es=spanish[0];e.aliases.push(...spanish.slice(1).map(term=>({term,language:'es',generalised:false})));}
}
// Explicit source-labelled left/right mappings (no geometric centroids or model inference).
const laterality={};
for (const e of entities.values()) {
  const left=byName.get('left '+e.canonicalName), right=byName.get('right '+e.canonicalName);
  if (left&&right) laterality[e.id]={left:left.id,right:right.id};
}
laterality['HRA:ovaries']={left:'HRA:ovary-left',right:'HRA:ovary-right'};
// Small reviewed renal subset of Uberon; no cross-species descendants are imported wholesale.
const uberonRoots=new Set(['UBERON:0002113','UBERON:0001224','UBERON:0001293','UBERON:0001294','UBERON:0004100','UBERON:0006171','UBERON:0007684','UBERON:0000362']);
const obo=new Map();
for(const block of read('uberon-edit.obo').toString('utf8').split('[Term]')) {
  const id=/^id: (UBERON:[0-9]+)$/m.exec(block)?.[1],name=/^name: (.+)$/m.exec(block)?.[1];
  if(!id||!name||/^is_obsolete: true$/m.test(block))continue;
  const edges=[];
  for(const line of block.split(/\r?\n/)) {
    const isa=/^is_a: (UBERON:[0-9]+)/.exec(line),part=/^relationship: part_of (UBERON:[0-9]+)/.exec(line);
    if(isa||part)edges.push({subject:id,predicate:isa?'is-a':'part-of',object:(isa||part)[1],source:'uberon-edit.obo'});
  }
  obo.set(id,{id,name,edges});
}
const queue=[...uberonRoots];
for(let i=0;i<queue.length;i++) {
  const term=obo.get(queue[i]);if(!term)throw new Error('Missing curated Uberon term: '+queue[i]);
  for(const edge of term.edges)if(!uberonRoots.has(edge.object)){uberonRoots.add(edge.object);queue.push(edge.object);}
}
for(const id of uberonRoots) {
  const term=obo.get(id);
  entities.set(id,{id,canonicalName:term.name,aliases:[],labels:{en:term.name},ontology:{namespace:'UBERON',id},laterality:'unspecified',geometry:[]});
  relations.push(...term.edges);
}
provenance.uberon={provider:'Uberon ontology contributors',license:'CC-BY-3.0',licenseUrl:'https://creativecommons.org/licenses/by/3.0/',revision:lock.sources.find(s=>s.file==='uberon-edit.obo').revision,source:'https://github.com/obophenotype/uberon',modifications:'Reviewed renal subset plus asserted ancestors; only explicit is_a and part_of edges. No logical inference or FMA identifier rewriting.',scope:'Uberon is a multispecies ontology. This selected reference subset is not a human clinical model.'};
const atlas={schemaVersion:1,provenance:{bodyparts3d:provenance},sources:lock.sources,entities:[...entities.values(),...hra],relations,collections,laterality,deltoidPortions:DELTOID_PORTIONS,limitations:['Semantic coverage exceeds geometry coverage. All system views are explicitly partial subsets.', 'BodyParts3D geometry is male only; HRA female models retain independent source frames.', 'Lymphatic system geometry is not packaged. No model or runtime guesses missing anatomy.']};
generated.set('atlas.json',JSON.stringify(atlas));
generated.set('notices.json',JSON.stringify({bodyparts3d:provenance,hra:hra.map(e=>e.provenance),sourceLocks:lock.sources}));
fs.mkdirSync(path.join(target,'assets'),{recursive:true});
const declarations=[];
for (const [file,text] of generated) {
  const bytes=Buffer.from(text);
  console.log(file,bytes.length);
  if(file.endsWith('.glb'))validateModelAsset(bytes,'model/gltf-binary');
  fs.writeFileSync(path.join(target,'assets',file),bytes);
  declarations.push({id:file.replace(/\.(glb|json)$/,''),path:'assets/'+file,mimeType:file.endsWith('.glb')?'model/gltf-binary':'application/json',bytes:bytes.length,sha256:hash(bytes)});
}
const manifestPath=path.join(target,'capability.json'),manifest=JSON.parse(fs.readFileSync(manifestPath));
manifest.assets=declarations;fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(here,'meshes.lock.json'),JSON.stringify({sourceArchive:lock.sources.find(s=>s.file.endsWith('.zip')),meshes:meshLock},null,2)+'\n');
console.log(JSON.stringify({semanticEntities:atlas.entities.length,relations:relations.length,meshes:fileIds.length,assets:declarations.map(a=>[a.id,a.bytes]),totalBytes:declarations.reduce((a,b)=>a+b.bytes,0)},null,2));
