// A real local Git remote plus a synthetic, fully intercepted GitHub API. No network,
// credentials, production signing key, paid calls or personal data enter these fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(outcome) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-catalog-automation-'));
  const checkout = path.join(temporary, 'checkout'), remote = path.join(temporary, 'remote.git');
  const git = args => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(path.join(checkout, 'scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'plugins/test-package'), { recursive: true });
    for (const file of ['sync-published-catalog.mjs', 'record-release-sizes.mjs', 'build-catalog-v2.mjs', 'contract-v2.mjs',
      'lib/github-release-api.mjs', 'lib/release-automation.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(checkout, '.gitignore'), 'build/\n');
    const manifest = { ...JSON.parse(fs.readFileSync(path.join(root, 'plugins/math-studio/plugin.json'), 'utf8')), id: 'test-package' };
    fs.writeFileSync(path.join(checkout, 'plugins/test-package/plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(checkout, 'plugins/test-package/catalog.json'), JSON.stringify({ description: { en: 'Synthetic arithmetic fixture.' } }));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(checkout, 'trusted-keys.json'), JSON.stringify({ keys: [{ keyId: manifest.publisher.keyId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }));
    const target = { target: 'any', asset: `test-package-${manifest.version}-any.nodus-plugin`, bytes: 12, sha256: 'a'.repeat(64) };
    const release = { schemaVersion: 1, plugin: manifest.id, version: manifest.version, publisher: manifest.publisher,
      createdAt: '2026-01-01T00:00:00Z', targets: [target] };
    const bytes = Buffer.from(JSON.stringify(release));
    const fixtureData = path.join(temporary, 'release.json'), signature = path.join(temporary, 'release.sig');
    fs.writeFileSync(fixtureData, bytes); fs.writeFileSync(signature, sign(null, bytes, privateKey));
    execFileSync(process.execPath, [path.join(checkout, 'scripts/build-catalog-v2.mjs')], { cwd: checkout, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Synthetic Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '.']); git(['commit', '-m', 'Synthetic catalog baseline']);
    const before = git(['rev-parse', 'HEAD']);
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
    const stateFile = path.join(temporary, 'calls.json'), preload = path.join(temporary, 'intercept.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
      const remote=${JSON.stringify(remote)}, stateFile=${JSON.stringify(stateFile)}, outcome=${JSON.stringify(outcome)};
      const calls=[], prs=new Map(); let advanced=false;
      const git=args=>execFileSync('git',['--git-dir',remote,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
      const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
      globalThis.fetch=async (input,options={})=>{
        const url=new URL(input), method=options.method||'GET', body=options.body?JSON.parse(options.body):undefined;
        const route=url.pathname.replace('/repos/MarketplaceFixture/repo/','');
        if(url.hostname==='github.com'){
          if(url.pathname.endsWith('/release-manifest.json'))return new Response(fs.readFileSync(${JSON.stringify(fixtureData)}));
          if(url.pathname.endsWith('/release-manifest.sig'))return new Response(fs.readFileSync(${JSON.stringify(signature)}));
          throw Error('Unexpected public fixture URL');
        }
        if(url.hostname!=='api.github.com')throw Error('Network is forbidden in this fixture');
        calls.push({method,route,body}); fs.writeFileSync(stateFile,JSON.stringify(calls));
        if(route.startsWith('releases/tags/'))return response({draft:false,prerelease:false,assets:[{name:${JSON.stringify(target.asset)},state:'uploaded',size:12,digest:'sha256:${target.sha256}'}]});
        if(route==='pulls'&&method==='POST'){
          const number=7+prs.size; prs.set(number,{branch:body.head,base:git(['rev-parse','main'])});
          return response({number,html_url:'https://github.com/MarketplaceFixture/repo/pull/'+number});
        }
        if(route==='actions/workflows/validate.yml/dispatches')return new Response(null,{status:204});
        if(route==='actions/workflows/validate.yml/runs')return response({workflow_runs:[{head_sha:url.searchParams.get('head_sha'),event:'workflow_dispatch',status:'completed',conclusion:outcome==='failure'?'failure':'success',html_url:'https://github.com/MarketplaceFixture/repo/actions/runs/1'}]});
        const match=/^pulls\\/(\\d+)(?:\\/(files|merge))?$/.exec(route);
        if(match){
          const pr=prs.get(Number(match[1])); if(!pr)throw Error('Unknown synthetic PR');
          if(match[2]==='files')return response(git(['diff','--name-only',pr.base+'..refs/heads/'+pr.branch]).split('\\n').filter(Boolean).map(filename=>({filename,status:'modified'})));
          if(match[2]==='merge'){
            if(body.sha!==git(['rev-parse','refs/heads/'+pr.branch]))return response({},409);
            if(outcome==='advance'&&!advanced){
              advanced=true; const parent=git(['rev-parse','main']), tree=git(['rev-parse','main^{tree}']);
              const commit=execFileSync('git',['--git-dir',remote,'-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-p',parent,'-m','Synthetic concurrent merge'],{encoding:'utf8'}).trim();
              git(['update-ref','refs/heads/main',commit]);return response({},409);
            }
            git(['update-ref','refs/heads/main',body.sha]);return response({merged:true});
          }
          if(method==='PATCH')return response({state:'closed'});
        }
        if(route==='git/ref/heads/main')return response({object:{sha:git(['rev-parse','main'])}});
        if(route.startsWith('git/refs/heads/')&&method==='DELETE'){git(['update-ref','-d','refs/heads/'+route.slice('git/refs/heads/'.length)]);return new Response(null,{status:204});}
        throw Error('Unexpected GitHub fixture operation '+method+' '+route);
      };
    `);
    let error;
    try {
      execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(checkout, 'scripts/sync-published-catalog.mjs')], {
        cwd: checkout, stdio: 'pipe', timeout: 30000,
        env: { ...process.env, CI: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'MarketplaceFixture/repo', GH_TOKEN: 'synthetic-fixture-token', GITHUB_STEP_SUMMARY: '' },
      });
    } catch (caught) { error = caught; }
    const calls = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const after = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    const catalog = JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', 'main:plugins/test-package/catalog.json'], { encoding: 'utf8' }));
    return { error, before, after, catalog, calls };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('a generated metadata PR dispatches exact-head CI and merges the signed sizes through normal GitHub operations', () => {
  const result = fixture('success');
  assert.equal(result.error, undefined);
  assert.notEqual(result.after, result.before);
  assert.equal(result.catalog.assetVersion, '1.0.1');
  assert.deepEqual(result.catalog.assetBytes, { any: 12 });
  assert.ok(result.calls.find(c => c.route.endsWith('/dispatches')));
  const merge = result.calls.findIndex(c => c.route.endsWith('/merge'));
  const ci = result.calls.findIndex(c => c.route.endsWith('/runs'));
  assert.ok(ci >= 0 && merge > ci);
});
test('failed metadata CI leaves main untouched and never attempts a merge', () => {
  const result = fixture('failure');
  assert.ok(result.error);
  assert.equal(result.after, result.before);
  assert.equal(result.catalog.assetVersion, undefined);
  assert.ok(!result.calls.some(c => c.route.endsWith('/merge')));
});
test('a concurrent main merge closes the stale metadata PR and regenerates with fresh CI', () => {
  const result = fixture('advance');
  assert.equal(result.error, undefined);
  assert.equal(result.catalog.assetVersion, '1.0.1');
  assert.equal(result.calls.filter(c => c.route === 'pulls' && c.method === 'POST').length, 2);
  assert.equal(result.calls.filter(c => c.route.endsWith('/dispatches')).length, 2);
  assert.ok(result.calls.some(c => c.method === 'PATCH' && c.body?.state === 'closed'));
});
