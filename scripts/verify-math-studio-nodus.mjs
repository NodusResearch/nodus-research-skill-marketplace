// Integration QA using the real Nodus installer, worker host, chat pipeline and ViewMath.
// An ephemeral verification key is confined to the test bundle. This does not sign a release.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {fixtures} from '../plugins/math-studio/test/fixtures.mjs';
const marketplace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appRoot=process.env.NODUS_APP_DIR;
if(!appRoot||!fs.existsSync(path.join(appRoot,'electron/capabilities/runner.ts')))throw new Error('Set NODUS_APP_DIR to the tested Nodus checkout.');
const requireApp=createRequire(path.join(appRoot,'package.json'));
const extraModules=process.env.NODUS_VERIFICATION_NODE_MODULES;
const manifest=JSON.parse(fs.readFileSync(path.join(marketplace,'plugins/math-studio/plugin.json'),'utf8'));
const asset=`math-studio-${manifest.version}-any.nodus-plugin`;
const archive=fs.readFileSync(path.join(marketplace,'build',asset));
const output=path.join(marketplace,'build/math-studio-verification');fs.mkdirSync(output,{recursive:true});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nodus-math-qa-'));
try {
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const release={schemaVersion:1,plugin:manifest.id,version:manifest.version,publisher:manifest.publisher,createdAt:new Date().toISOString(),targets:[{target:'any',asset,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}]};
 const releaseBytes=Buffer.from(JSON.stringify(release));
 const payload={archive:archive.toString('base64'),releaseManifestBytes:releaseBytes.toString('base64'),signature:sign(null,releaseBytes,privateKey).toString('base64')};
 const keys={keys:[{keyId:manifest.publisher.keyId,publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()}]};
 fs.writeFileSync(path.join(temporary,'payload.json'),JSON.stringify(payload));
 fs.writeFileSync(path.join(temporary,'package.json'),JSON.stringify({name:'nodus-math-verification',version:JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version,main:'main.cjs'}));
 await build({entryPoints:[path.join(appRoot,'electron/capabilities/workerBootstrap.ts')],outfile:path.join(temporary,'capabilityWorkerBootstrap.js'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
 await build({stdin:{contents:`
 import React from 'react';
 import {createRoot} from 'react-dom/client';
 import {ViewMath} from './src/components/capabilityViewData';
 const views=window.mathViews;
 createRoot(document.getElementById('root')).render(<main><h1>Math Studio · native Nodus formulas</h1>{views.map((v,i)=><section key={i}><h2>{v.title}</h2>{v.nodes.map((node,j)=>node.kind==='math'?<ViewMath key={j} node={node}/>:node.kind==='paragraph'?<p key={j}>{node.spans.map(s=>s.text).join('')}</p>:null)}</section>)}</main>);
 `,resolveDir:appRoot,loader:'tsx'},outfile:path.join(output,'renderer.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.cpSync(path.join(path.dirname(requireApp.resolve('katex/package.json')),'dist'),path.join(output,'katex'),{recursive:true});
 await build({stdin:{contents:`
 import {app,BrowserWindow} from 'electron';
 import fs from 'node:fs';
 import path from 'node:path';
 import assert from 'node:assert/strict';
 import {initializeCapabilityPluginStore,installVerifiedPlugin,resolveTrustedCapability,removePluginV2} from './electron/capabilities/pluginStoreV2';
 import {rebuildCapabilityRegistry,pinCapabilitiesForTurn} from './electron/capabilities/registry';
 import {CapabilityWorkerHandle} from './electron/capabilities/workerHost';
 import {createCapabilityHostServices} from './electron/capabilities/hostServices';
 import {createTrustedCapabilityRunner} from './electron/capabilities/runner';
 import {runTrustedChatPipeline} from './electron/capabilities/chatPipeline';
 import {chatAssetOwner} from './electron/chatAssets';
 import {materializeTrustedPluginSkills} from './electron/capabilities/skillLibrary';
 import {saveChatSkill,enabledChatSkills} from './electron/chatSkills';
 app.setPath('userData',${JSON.stringify(path.join(temporary,'profile'))});
 app.on('window-all-closed',()=>{});
 app.whenReady().then(async()=>{let handle;try{
 const payload=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(temporary,'payload.json'))},'utf8'));
 initializeCapabilityPluginStore();
 const installed=installVerifiedPlugin({...payload,archive:Buffer.from(payload.archive,'base64'),releaseManifestBytes:Buffer.from(payload.releaseManifestBytes,'base64'),signature:Buffer.from(payload.signature,'base64'),source:{id:'nodusresearch/nodus-research-skill-marketplace',path:'plugins/math-studio',commit:'a'.repeat(40)}},{approvePermissions:true});
 assert.equal(installed.activated,true);assert.equal(installed.state.trust.verified,true);
 const registry=rebuildCapabilityRegistry();assert.ok(registry.providers.has('math-studio:mathematics'));
 const skills=materializeTrustedPluginSkills('math-studio').filter(s=>s.plugin?.id==='math-studio');assert.equal(skills.length,1);
 assert.equal(skills[0].enabled.assistant,false);assert.equal(skills[0].enabled.nodi,false);
 saveChatSkill({...skills[0],enabled:{assistant:true,nodi:true}});
 for(const surface of ['assistant','nodi'])assert.ok(enabledChatSkills(surface).some(s=>s.id===skills[0].id));
 const runtime=resolveTrustedCapability('math-studio:mathematics');
 handle=new CapabilityWorkerHandle(runtime,{services:createCapabilityHostServices({})});
 const health=await handle.call('health',{nodusVersion:app.getVersion(),locale:'en',platform:process.platform,arch:process.arch,dataVersion:0});assert.equal(health.status,'ready');
 const fixtures=${JSON.stringify(fixtures)},views=[];
 for(const input of fixtures){const result=await handle.call('invoke',{invocationId:'math-qa',toolId:'compute',input,locale:'en'});const artifact=result.artifacts[0];assert.ok(artifact.view.nodes.some(n=>n.kind==='math'));const restored=await handle.call('renderArtifact',artifact);assert.deepEqual(restored,artifact.view);views.push(artifact.view);}
 await assert.rejects(handle.call('invoke',{invocationId:'invalid',toolId:'compute',input:{mode:'calculate',expression:'1/0'},locale:'en'}));
 await assert.rejects(createCapabilityHostServices({})({runtime,channel:'network',method:'fetch',payload:{endpointId:'undeclared',path:'/'},signal:new AbortController().signal}),/not permitted/);
 const responses=[];
 for(const surface of ['assistant','nodi','deep-research','immersion']){
  const runner=createTrustedCapabilityRunner({owner:chatAssetOwner(surface,'math-studio-synthetic-qa'),question:'Calculate synthetic mathematics.',locale:'en',pins:pinCapabilitiesForTurn(),runCoreStages:async answer=>answer});
  try{
   for(const input of fixtures){const fence=String.fromCharCode(96).repeat(3);const request=fence+'math-studio-request\\n'+JSON.stringify(input)+'\\n'+fence;const answer=await runTrustedChatPipeline(request,registry,runner,{onProblem:(_,error)=>{throw error;}});assert.match(answer,/nodus-artifact/);assert.match(answer,/nodus-view/);responses.push({surface,input,answer});}
  }finally{await runner.dispose();}
 }
 const output=${JSON.stringify(output)};
 fs.writeFileSync(path.join(output,'views.json'),JSON.stringify(views,null,2));fs.writeFileSync(path.join(output,'responses.json'),JSON.stringify(responses,null,2));
 const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="katex/katex.min.css"><style>body{margin:0;background:#f3f5f9;color:#192337;font:16px system-ui}main{max-width:940px;margin:36px auto}h1{font-size:28px}section{background:white;border:1px solid #d8dfeb;border-radius:16px;padding:24px;margin:24px 0}h2{font-size:18px}p{font-size:14px;line-height:1.6;color:#526078}.capability-view-math{overflow-x:auto;padding:8px}</style><div id="root"></div><script>window.mathViews='+JSON.stringify(views).replace(/</g,'\\u003c')+'</script><script src="renderer.js"></script>';
 fs.writeFileSync(path.join(output,'index.html'),html);
 const window=new BrowserWindow({show:false,width:1120,height:1600,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await window.loadFile(path.join(output,'index.html'));
 await window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
 const visual=await window.webContents.executeJavaScript('({formulas:document.querySelectorAll("[role=math]").length,errors:document.querySelectorAll(".capability-view-math-error").length,overflow:[...document.querySelectorAll(".capability-view-math")].filter(e=>e.scrollWidth>e.clientWidth).length})');
 assert.equal(visual.errors,0);assert.equal(visual.overflow,0);assert.equal(visual.formulas,views.reduce((n,v)=>n+v.nodes.filter(x=>x.kind==='math').length,0));
 fs.writeFileSync(path.join(output,'preview.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());window.destroy();
 await handle.stop();removePluginV2('math-studio');assert.equal(rebuildCapabilityRegistry().providers.has('math-studio:mathematics'),false);
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({nodusVersion:app.getVersion(),platform:process.platform,arch:process.arch,installedWith:'ephemeral test key',fixtures:fixtures.length,pipelineExecutions:responses.length,surfaces:['assistant','nodi','deep-research','immersion'],visual,liveModel:false,productionSignature:false},null,2));
 fs.writeFileSync(${JSON.stringify(path.join(temporary,'pass'))},'pass');app.exit(0);
 }catch(error){console.error(error.stack||error);await handle?.stop();app.exit(1);}});
 `,resolveDir:appRoot,loader:'ts'},outfile:path.join(temporary,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],loader:{'.node':'empty'},logLevel:'silent',plugins:[{name:'verification-only-resolution',setup(api){api.onResolve({filter:/trustedKeys\.json$/},()=>({path:'keys',namespace:'verification'}));api.onLoad({filter:/.*/,namespace:'verification'},()=>({contents:JSON.stringify(keys),loader:'json'}));api.onResolve({filter:/^@shared\//},({path:value})=>({path:path.join(appRoot,'shared',value.slice(8)+'.ts')}));if(extraModules)api.onResolve({filter:/^(d3-geo|topojson-client|topojson-server|topojson-simplify)$/},({path:value})=>({path:createRequire(path.join(extraModules,'..','package.json')).resolve(value)}));}}]});
 const result=await promisify(execFile)(requireApp('electron'),[temporary],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'1'},maxBuffer:16*1024*1024,timeout:120000});
 if(result.stdout.trim())console.log(result.stdout.trim());
 if(fs.readFileSync(path.join(temporary,'pass'),'utf8')!=='pass')throw new Error('No verification verdict.');
 console.log(fs.readFileSync(path.join(output,'verification.json'),'utf8'));
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
