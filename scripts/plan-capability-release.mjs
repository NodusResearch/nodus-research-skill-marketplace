import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { githubClient } from './lib/github-release-api.mjs';
import { assertMainMerge, buildMatrix, selectPackages } from './lib/release-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.RELEASE_SOURCE_SHA;
if (!/^[0-9a-f]{40}$/.test(source ?? '')) throw new Error('A full release source SHA is required.');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== source) {
  throw new Error('The release checkout must be the exact declared source commit.');
}
const client = githubClient();
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release workflows run only from main.');
const branch = await client.request('branches/main');
const pullRequests = await client.request(`commits/${source}/pulls`);
const workflow = await client.request('actions/workflows/validate.yml');
const runs = await client.request(`actions/workflows/${workflow.id}/runs?branch=main&event=push&head_sha=${source}&per_page=100`);
const validation = runs.workflow_runs.find(run => run.head_sha === source);
const manifests = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => JSON.parse(fs.readFileSync(path.join(root, 'plugins', e.name, 'plugin.json'), 'utf8')));
if (!branch.protected) throw new Error('main must be protected before automatic publication is enabled.');
const current = branch.commit.sha === source;
const releases = current ? await client.pages('releases') : [];
const packages = current ? selectPackages(manifests, releases, process.env.RELEASE_PLUGIN || undefined) : [];
// GITHUB_TOKEN catalog merges produce no push CI. A no-op/manual catalog repair
// reaches no signing key; pending packages still require the exact main merge and CI.
if (packages.length) assertMainMerge({ repository: client.repository, source, branch, pullRequests, validation });
const output = {
  matrix: JSON.stringify(buildMatrix(packages)), plugins: JSON.stringify(packages.map(p => p.id)),
  pending: String(packages.length > 0), source,
};
fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
const summary = current
  ? packages.length ? packages.map(p => `- ${p.id} ${p.version}`).join('\n') : 'Every current package version is already published; nothing will be rebuilt or signed.'
  : 'A newer main commit superseded this run. Its successful CI will check publication.';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Capability release plan\n\nSource: ${source}\n\n${summary}\n`);
