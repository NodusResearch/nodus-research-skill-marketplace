// CI-only metadata PR. It has no signing key and cannot change package source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { githubClient, readPublishedRelease } from './lib/github-release-api.mjs';
import { REQUIRED_CHECKS, assertCatalogDiff, assertCatalogIndexDiff, isCatalogPath } from './lib/release-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.CI !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Catalog synchronization runs only in a disposable main CI checkout.');
}
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
if (!/^\d+$/.test(runId ?? '') || !/^\d+$/.test(attempt ?? '')) throw new Error('A workflow run identity is required.');
const client = githubClient();
// A PR opened with GITHUB_TOKEN gets its pull_request CI only after a maintainer approves the
// run, and dispatched runs do not satisfy the PR's required checks. The catalog GitHub App
// therefore opens the PR, so its own required checks start like any other PR's. It can only
// write pull requests; pushing, waiting and merging keep the job's GITHUB_TOKEN.
const author = process.env.CATALOG_PR_TOKEN ? githubClient(undefined, process.env.CATALOG_PR_TOKEN) : null;
const ACTIONS_APP_ID = 15368; // The only app branch protection accepts for the required checks.
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
  if (!author) {
    throw new Error('CATALOG_PR_TOKEN is missing. Configure the catalog GitHub App (variable CATALOG_APP_CLIENT_ID, '
      + 'secret CATALOG_APP_PRIVATE_KEY): a PR opened with GITHUB_TOKEN cannot run its required checks unattended.');
  }
  const branch = `codex/release-catalog-${runId}-${attempt}-${retry}`;
  git(['switch', '-c', branch]);
  git(['add', '--', ...files]);
  git(['commit', '-m', 'Record sizes from published signed capability manifests']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const pr = await author.request('pulls', { method: 'POST', body: {
    title: 'Record signed capability release sizes', base: 'main', head: branch,
    body: `Record the exact archive bounds and versions verified from published release signatures.\n\n${records.map(r => `- ${r}`).join('\n')}\n\nOnly catalog metadata changes. The complete marketplace CI must pass before this generated update merges.\n\n[Release workflow](https://github.com/${client.repository}/actions/runs/${runId})`,
  } });
  summary(`Generated catalog PR: ${pr.html_url}`);
  // Wait for the PR's own required checks on its exact head: the ones branch protection reads.
  const deadline = Date.now() + 20 * 60 * 1000;
  let validated = false;
  while (Date.now() < deadline) {
    const runs = await client.request(`actions/runs?head_sha=${sha}&event=pull_request&per_page=100`);
    if (runs.workflow_runs.some(r => r.status === 'action_required' || r.conclusion === 'action_required')) {
      throw new Error(`Catalog PR CI is waiting for a maintainer's approval; the catalog GitHub App must open the PR: ${pr.html_url}`);
    }
    const { check_runs: checks } = await client.request(`commits/${sha}/check-runs?filter=latest&per_page=100`);
    const required = REQUIRED_CHECKS.map(name => checks.find(c => c.name === name && c.app?.id === ACTIONS_APP_ID));
    const failed = required.find(c => c?.status === 'completed' && c.conclusion !== 'success');
    if (failed) throw new Error(`Catalog PR CI failed (${failed.name}): ${failed.html_url}`);
    if (required.every(c => c?.status === 'completed')) { validated = true; break; }
    await sleep(15000);
  }
  if (!validated) throw new Error(`Catalog PR CI did not finish within 20 minutes: ${pr.html_url}`);
  const changed = await client.pages(`pulls/${pr.number}/files`);
  if (changed.some(f => !isCatalogPath(f.filename) || f.status === 'removed' || f.status === 'renamed')) {
    throw new Error('The generated PR no longer contains only catalog metadata.');
  }
  for (let settle = 0; settle < 12; settle++) {
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
      if (settle === 11) throw new Error(`Catalog PR remains blocked by branch policy: ${pr.html_url}`);
      await sleep(5000);
    }
  }
  if (retry === 2) throw new Error('main advanced repeatedly; rerun catalog synchronization.');
}
