// Explicit integration check against a local Nodus checkout, with an isolated profile.
// Runs real directory import, Assistant/Nodi orchestration and Chromium sandbox; only
// model completions are scripted fixtures. No account, external network or paid API.
// Usage: node scripts/verify-chart-studio-nodus.mjs /absolute/path/to/nodus
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixtures } from './lib/chart-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = path.resolve(process.argv[2] || process.env.NODUS_CHECKOUT || '');
if (!process.argv[2] && !process.env.NODUS_CHECKOUT) throw new Error('Provide a local Nodus checkout; no profile or executable is inferred.');
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-chart-studio-'));
const artifacts = path.join(root, 'build/chart-studio-verification');
fs.mkdirSync(artifacts, { recursive: true });
const verdict = path.join(temp, 'verdict.json');
try {
  const hookFile = path.join(appRoot, 'scripts/lib/tsRuntimeHooks.mjs');
  const hooks = fs.readFileSync(hookFile, 'utf8').replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(hookFile).href));
  fs.writeFileSync(path.join(temp, 'hooks.cjs'), appRequire('esbuild').transformSync(hooks, { format: 'cjs', platform: 'node' }).code);
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'nodus-chart-verification', version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(temp, 'main.cjs'), `
const electron = require('electron');
const {app, BrowserWindow} = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
app.on('window-all-closed', () => {});
const {installRuntimeHooks} = require('./hooks.cjs');
installRuntimeHooks(app.getPath('userData'), electron);
// Optional supplemental dependencies for a stale local checkout. This changes module
// resolution only in this isolated verifier, never the application or package files.
const extraModules = ${JSON.stringify(process.env.NODUS_VERIFICATION_NODE_MODULES || null)};
if (extraModules) {
  const Module = require('node:module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function(specifier, parent, ...rest) {
    if (parent && !parent.paths.includes(extraModules)) parent.paths.push(extraModules);
    return resolve.call(this, specifier, parent, ...rest);
  };
}
const load = relative => require(path.join(${JSON.stringify(appRoot)}, relative));
const sandbox = load('skill-capabilities/sandbox/runtime.ts');
sandbox.registerCapabilitySchemePrivileges();
const fixtures = ${JSON.stringify(fixtures)};
let stage = 'initialization';
app.whenReady().then(async () => { try {
  fs.mkdirSync(app.getPath('userData'), {recursive: true});
  const plugins = load('electron/skillPlugins.ts');
  const skills = load('electron/chatSkills.ts');
  const shared = load('shared/chatSkills.ts');
  const settings = load('electron/db/settingsRepo.ts');
  const ai = load('electron/ai/aiClient.ts');
  settings.updateSettings({chatModel:{provider:'google',model:'fixture'}, synthesisModel:{provider:'google',model:'fixture'}, nodiModel:{provider:'google',model:'fixture'}, promptLanguage:'en'});
  plugins.initializePluginStore(); skills.restoreChatSkills();
  stage = 'directory install';
  skills.installChatPluginDirectory(${JSON.stringify(path.join(root, 'chart-studio'))}, {sourceId:'chart-studio-verification', approvePermissions:true});
  for (const skill of skills.listChatSkills()) skills.saveChatSkill({...skill, enabled:{assistant:skill.plugin?.id === 'chart-studio', nodi:skill.plugin?.id === 'chart-studio'}});
  const installed = skills.listChatSkills().find(skill => skill.plugin?.id === 'chart-studio');
  assert.ok(installed); assert.ok(installed.capabilities.includes('chart-studio:charts'));
  const runtime = plugins.resolveInstalledCapability('chart-studio:charts', {version:installed.plugin.version, digest:installed.plugin.digest});
  assert.ok(runtime); assert.deepEqual(runtime.manifest.permissions, {});
  assert.equal(runtime.permissions.network?.length || 0, 0);
  assert.equal(runtime.permissions.secrets?.length || 0, 0);
  assert.equal(runtime.permissions.storage, undefined);
  assert.equal(runtime.source, fs.readFileSync(${JSON.stringify(path.join(root, 'chart-studio/capabilities/charts/runtime.js'))}, 'utf8'));
  assert.equal(plugins.resolveInstalledCapability('chart-studio:charts', {version:installed.plugin.version,digest:'b'.repeat(64)}), null);
  const invoke = input => sandbox.runCapabilitySandbox(runtime, {skillId:installed.id,capabilityId:'chart-studio:charts',toolId:'render-chart',input});
  const fence = input => '\x60\x60\x60nodus-capability\\n' + JSON.stringify({skillId:installed.id,capabilityId:'chart-studio:charts',toolId:'render-chart',input}) + '\\n\x60\x60\x60';
  const results = answer => shared.splitChatVisuals(answer).filter(part => part.kind === 'capability-result').map(part => JSON.parse(part.content));
  let scripted = '', modelCalls = 0, promptSeen = '';
  ai.completeText = async options => { modelCalls++; promptSeen = (options.system || '') + (options.user || ''); return scripted; };
  ai.completeTextStream = async (options, delta) => {const text = await ai.completeText(options); delta(text, 'content'); return text;};
  ai.localModelContextWindow = async () => null;
  const research = load('electron/ai/researchAssistant.ts');
  const nodi = load('electron/ai/nodiChat.ts');
  const chatRepo = load('electron/db/chatRepo.ts');
  const nodiRepo = load('electron/nodiConversations.ts');
  const conversation = chatRepo.createConversation({title:'Synthetic chart verification'});
  const turn = {id:'fixture-u1',role:'user',content:'Create a chart from this synthetic fictional materials fixture.',createdAt:'2026-09-12T00:00:00.000Z'};
  const nodiConversation = nodiRepo.saveNodiConversation({title:'Synthetic chart verification',messages:[turn]});
  const selection = {ideas:false,themes:false,contradictions:false,gaps:false,readingPath:false,authors:false,documents:false,passages:false,graph:false,graphParts:{}};
  const surfaces = [
    ['assistant', () => research.streamResearchChat({conversationId:conversation.id,messages:[turn],selection}, () => {}).then(r => r.answer)],
    ['nodi', () => nodi.streamNodiChat({conversationId:nodiConversation.id,messages:[turn],contexts:[]}, () => {})],
  ];
  const sanitizer = load('shared/chatSvg.ts').sanitizeChatSvg;
  const probe = new BrowserWindow({show:false,focusable:false,width:1200,height:1500,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  await probe.loadURL('data:text/html,<body style="margin:0"></body>');
  const images = [];
  const inspect = async svg => {
    const clean = await probe.webContents.executeJavaScript('(' + sanitizer.toString() + ')(' + JSON.stringify(svg) + ')');
    assert.ok(clean, 'real DOM sanitizer must accept SVG');
    const qa = await probe.webContents.executeJavaScript('(() => { document.body.innerHTML = ' + JSON.stringify(clean.svg) + '; const svg = document.querySelector("svg"); const box = svg.viewBox.baseVal; const texts=[...svg.querySelectorAll("text")].map(t=>({text:t.textContent,b:t.getBBox()})); const overlaps=[]; for(let i=0;i<texts.length;i++) for(let j=i+1;j<texts.length;j++){const a=texts[i].b,b=texts[j].b;if(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1)overlaps.push([texts[i].text,texts[j].text]);} return {provenance:JSON.parse(svg.querySelector("desc").textContent),clipped:texts.filter(({b})=>b.x<0||b.y<0||b.x+b.width>box.width||b.y+b.height>box.height).map(t=>t.text),overlaps}; })()');
    assert.deepEqual(qa.clipped, [], 'no clipped labels');
    assert.deepEqual(qa.overlaps, [], 'no overlapping text labels');
    return {clean,qa};
  };
  let routed = 0;
  for (const [surface, run] of surfaces) for (const [type, input] of Object.entries(fixtures)) {
    stage = surface + ' / ' + type;
    scripted = fence(input);
    const before = modelCalls;
    const answer = await run();
    assert.equal(modelCalls - before, 1, 'one scripted completion; no second model turn');
    assert.match(promptSeen, /Chart Studio/);
    const result = results(answer).find(item => item.capabilityId === 'chart-studio:charts')?.result;
    assert.equal(result?.kind, 'svg', answer.slice(0,500));
    assert.equal(result.svg, (await invoke(input)).svg);
    assert.ok(!shared.splitChatVisuals(answer).some(part => part.kind === 'capability-request'));
    routed++;
    if (surface === 'assistant') {
      const {clean,qa} = await inspect(result.svg);
      assert.deepEqual(qa.provenance.input, input);
      assert.deepEqual(qa.clipped, [], 'no clipped labels');
      fs.writeFileSync(path.join(${JSON.stringify(artifacts)},type+'.svg'), clean.svg);
      const imageHeight = await probe.webContents.executeJavaScript('(async()=>{document.querySelector("svg").style.width="600px";await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return Math.ceil(document.querySelector("svg").getBoundingClientRect().height);})()');
      const png = (await probe.webContents.capturePage({x:0,y:0,width:600,height:imageHeight},{stayHidden:true,stayAwake:true})).toPNG();
      fs.writeFileSync(path.join(${JSON.stringify(artifacts)},type+'.png'),png);
      images.push(type);
    }
    console.log('PASS ' + stage);
  }
  stage = 'four calls in one reply';
  scripted = Array(4).fill(fence(fixtures.bar)).join('\\n\\n');
  assert.equal(results(await surfaces[0][1]()).length, 4);
  stage = 'long labels and maximum matrix';
  for (const type of ['line','grouped-bar','horizontal-bar','heatmap','radar']) {
    const input = structuredClone(fixtures[type]);
    input.title = 'A deliberately long synthetic chart title with several words for robust line wrapping verification';
    input.title = input.title.slice(0,96);
    input.source = '測'.repeat(180);
    input.labels = input.labels.map((_,i)=>String(i).padEnd(36,'測'));
    input.series.forEach((s,i)=>{s.name=String(i).padEnd(48,'測');});
    const result = await invoke(input); assert.equal(result.kind,'svg'); await inspect(result.svg);
  }
  const largeMatrix = structuredClone(fixtures.heatmap);
  largeMatrix.labels = Array.from({length:24},(_,i)=>String(i).padEnd(36,'測'));
  largeMatrix.series = Array.from({length:8},(_,i)=>({name:String(i).padEnd(48,'測'),values:Array.from({length:24},(_,j)=>i-j)}));
  await inspect((await invoke(largeMatrix)).svg);
  stage = 'invalid input';
  const invalid = await invoke({...fixtures.pie,series:[{name:'A',values:[-1,2,3,4]}]});
  assert.equal(invalid.kind,'text'); assert.match(invalid.text,/nonnegative/);
  await assert.rejects(invoke({...fixtures.bar,unknown:true}), /schema/);
  stage = 'disabled skill';
  const dispatch = load('electron/ai/chatSkillExecution.ts');
  const execution = {version:0,skills:[installed],isCurrent:()=>true,question:turn.content};
  assert.match(await dispatch.executeChatSkills(fence(fixtures.bar), {...execution,skills:[]}), /not enabled/);
  stage = 'unavailable capability';
  assert.match(await dispatch.executeChatSkills(fence(fixtures.bar).replace('chart-studio:charts','chart-studio:absent'),execution), /not enabled/);
  stage = 'host budget';
  const {SANDBOXED_CALL_LIMIT} = load('skill-capabilities/contracts.ts');
  assert.equal(SANDBOXED_CALL_LIMIT,16,'report contract changes before adjusting this compatibility check');
  const limited = await dispatch.executeChatSkills(Array(17).fill(fence(fixtures.bar)).join('\\n'),execution);
  assert.equal(results(limited).length,16); assert.match(limited,/At most 16 sandboxed/);
  stage = 'cancellation';
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(dispatch.executeChatSkills(fence(fixtures.bar),execution,aborter.signal), error=>error.name==='AbortError');
  await assert.rejects(dispatch.executeChatSkills(fence(fixtures.bar),{...execution,isCurrent:()=>false}), error=>error.name==='AbortError');
  const during = new AbortController();
  const pending = sandbox.runCapabilitySandbox(runtime,{skillId:installed.id,capabilityId:'chart-studio:charts',toolId:'render-chart',input:fixtures.bar},during.signal);
  setTimeout(()=>during.abort(),1);
  await assert.rejects(pending,error=>error.name==='AbortError');
  probe.destroy();
  fs.writeFileSync(${JSON.stringify(verdict)},JSON.stringify({ok:true,nodusVersion:app.getVersion(),routed,images,model:'scripted fixture; no model API',sandbox:'real Chromium',install:'unmodified plugin directory in isolated profile'}));
  app.exit(0);
} catch(error) { console.error('FAIL '+stage, error); fs.writeFileSync(${JSON.stringify(verdict)},JSON.stringify({ok:false,stage,error:String(error.stack || error)})); app.exit(1); }});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const execution = promisify(execFile)(appRequire('electron'), [temp], { cwd: appRoot, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  execution.child.stdout.on('data', chunk => process.stdout.write(chunk));
  const { stderr } = await execution;
  const record = JSON.parse(fs.readFileSync(verdict, 'utf8'));
  if (!record.ok) throw new Error(JSON.stringify(record));
  fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify(record, null, 2) + '\n');
  if (stderr) console.error(stderr.trim());
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  if (fs.existsSync(verdict)) console.error(fs.readFileSync(verdict, 'utf8'));
  throw error;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
