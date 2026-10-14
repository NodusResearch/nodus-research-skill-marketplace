// CI-only metadata PR. It has no signing key and cannot change package source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { githubClient, readPublishedRelease } from './lib/github-release-api.mjs';
import { assertCatalogDiff, assertCatalogIndexDiff, isCatalogPath } from './lib/release-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.CI !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Catalog synchronization runs only in a disposable main CI checkout.');
}
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
if (!/^\d+$/.test(runId ?? '') || !/^\d+$/.test(attempt ?? '')) throw new Error('A workflow run identity is required.');
const client = githubClient();
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const node = args => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = message => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
};
git(['config', 'user.name', 'github-actions[bot]']);
git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

for (let retry = 0; retry < 3; retry++) {
  git(['fetch', 'origin', 'main']);
  git(['reset', '--hard', 'origin/main']);
  const base = git(['rev-parse', 'HEAD']);
  const beforeIndex = JSON.parse(fs.readFileSync(path.join(root, 'catalog-v2.json'), 'utf8'));
  const descriptions = new Map();
  const records = [];
  for (const entry of fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true }).filter(e => e.isDirectory())) {
    const dir = path.join(root, 'plugins', entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    descriptions.set(`plugins/${entry.name}/catalog.json`, before);
    const release = await readPublishedRelease(client, root, manifest, path.join(root, 'build'));
    if (!release) continue; // Another version has not passed its release job yet.
    node(['scripts/record-release-sizes.mjs', entry.name]);
    records.push(`${release.plugin} ${release.version}`);
  }
  node(['scripts/build-catalog-v2.mjs']);
  const files = git(['diff', '--name-only']).split('\n').filter(Boolean);
  if (!files.length) { summary('The public catalog already records every available signed release.'); break; }
  if (files.some(file => !isCatalogPath(file))) throw new Error('Catalog automation attempted to change a source file.');
  for (const file of files) {
    const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (file === 'catalog-v2.json') assertCatalogIndexDiff(beforeIndex, after);
    else assertCatalogDiff(descriptions.get(file), after);
  }
  node(['scripts/build-catalog-v2.mjs', '--check']);
  git(['diff', '--check']);
  const branch = `codex/release-catalog-${runId}-${attempt}-${retry}`;
  git(['switch', '-c', branch]);
  git(['add', '--', ...files]);
  git(['commit', '-m', 'Record sizes from published signed capability manifests']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const pr = await client.request('pulls', { method: 'POST', body: {
    title: 'Record signed capability release sizes', base: 'main', head: branch,
    body: `Record the exact archive bounds and versions verified from published release signatures.\n\n${records.map(r => `- ${r}`).join('\n')}\n\nOnly catalog metadata changes. The complete marketplace CI must pass before this generated update merges.\n\n[Release workflow](https://github.com/${client.repository}/actions/runs/${runId})`,
  } });
  summary(`Generated catalog PR: ${pr.html_url}`);
  // GITHUB_TOKEN pushes do not start another workflow. Dispatch read-only validation explicitly.
  await client.request('actions/workflows/validate.yml/dispatches', { method: 'POST', body: { ref: branch } });
  const deadline = Date.now() + 20 * 60 * 1000;
  let validated = false;
  while (Date.now() < deadline) {
    const response = await client.request(`actions/workflows/validate.yml/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&head_sha=${sha}&per_page=100`);
    const run = response.workflow_runs.find(r => r.head_sha === sha && r.event === 'workflow_dispatch');
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Catalog PR CI failed: ${run.html_url}`);
      validated = true; break;
    }
    await sleep(15000);
  }
  if (!validated) throw new Error(`Catalog PR CI did not finish within 20 minutes: ${pr.html_url}`);
  const changed = await client.pages(`pulls/${pr.number}/files`);
  if (changed.some(f => !isCatalogPath(f.filename) || f.status === 'removed' || f.status === 'renamed')) {
    throw new Error('The generated PR no longer contains only catalog metadata.');
  }
  for (let settle = 0; settle < 6; settle++) {
    try {
      const merged = await client.request(`pulls/${pr.number}/merge`, {
        method: 'PUT', body: { sha, merge_method: 'squash', commit_title: 'Record signed capability release sizes' },
      });
      if (!merged.merged) throw new Error('GitHub did not merge the generated catalog PR.');
      summary(`Catalog sizes published through ${pr.html_url}; all required checks passed.`);
      await client.request(`git/refs/heads/${branch}`, { method: 'DELETE' });
      process.exit(0);
    } catch (error) {
      if (![405, 409].includes(error.status)) throw error;
      const latest = await client.request('git/ref/heads/main');
      if (latest.object.sha !== base) {
        await client.request(`pulls/${pr.number}`, { method: 'PATCH', body: { state: 'closed' } });
        await client.request(`git/refs/heads/${branch}`, { method: 'DELETE' });
        break; // Rebuild the metadata from the new main, with a fresh CI run.
      }
      if (settle === 5) throw new Error(`Catalog PR remains blocked by branch policy: ${pr.html_url}`);
      await sleep(5000);
    }
  }
  if (retry === 2) throw new Error('main advanced repeatedly; rerun catalog synchronization.');
}
