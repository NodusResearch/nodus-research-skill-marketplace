// Maintainer-only setup. No workflow can run this with its GITHUB_TOKEN: changing
// branch/environment protection requires the authenticated administrator's access.
import { execFileSync } from 'node:child_process';
import { githubClient } from './lib/github-release-api.mjs';
import { assertMainMerge } from './lib/release-automation.mjs';
import { mainProtection, assertMainProtection, assertMainSigningPolicy } from './lib/release-protection.mjs';
import { validateWorkflowSources } from './validate-workflows.mjs';

const phase = process.argv[2];
if (!['--protect', '--activate'].includes(phase)) throw new Error('Usage: node scripts/configure-release-protection.mjs --protect|--activate');
if (process.env.CI) throw new Error('Protection setup is a maintainer action outside CI.');
// Capture the existing CLI credential in memory; never print it or persist a copy.
const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const client = githubClient('NodusResearch/nodus-research-skill-marketplace', token);
const policies = await client.request('environments/capability-signing/deployment-branch-policies');
assertMainSigningPolicy(policies.branch_policies);
const before = await client.request('branches/main/protection', { missing: true });
if (before) {
  // Refuse to overwrite unrelated or stronger protection; the maintainer can inspect it.
  assertMainProtection(before, before.required_pull_request_reviews?.required_approving_review_count === 0);
  if (before.restrictions || before.required_status_checks.checks.length !== 4 || before.required_linear_history?.enabled
    || before.required_pull_request_reviews.require_last_push_approval || before.lock_branch?.enabled) {
    throw new Error('Main has additional protection; preserve it and configure this change manually.');
  }
}
let ready = false;
if (phase === '--activate') {
  const branch = await client.request('branches/main');
  const sha = branch.commit.sha;
  const read = async file => {
    const result = await client.request(`contents/${file}?ref=${sha}`);
    if (result.encoding !== 'base64') throw new Error('GitHub returned unexpected source encoding.');
    return Buffer.from(result.content, 'base64').toString('utf8');
  };
  const sources = new Map();
  for (const file of ['release-plugin.yml', 'validate.yml']) sources.set(file, await read(`.github/workflows/${file}`));
  const problems = validateWorkflowSources(sources, await read('.github/CODEOWNERS'));
  if (problems.length || !sources.get('validate.yml').includes('check-release-catalog.mjs')) {
    throw new Error('The reviewed automatic workflow and signed-catalog CI gate must already be merged before removing the signing approval.');
  }
  const pulls = await client.request(`commits/${sha}/pulls`);
  const runs = await client.request(`actions/workflows/validate.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`);
  if (!assertMainMerge({ repository: client.repository, source: sha, branch, pullRequests: pulls,
    validation: runs.workflow_runs.find(r => r.head_sha === sha) })) throw new Error('main changed during activation; check it again.');
  ready = true;
}
await client.request('branches/main/protection', { method: 'PUT', body: mainProtection(ready) });
assertMainProtection(await client.request('branches/main/protection'), ready);
await client.request('actions/permissions/workflow', { method: 'PUT', body: {
  default_workflow_permissions: 'read', can_approve_pull_request_reviews: true,
} });
console.log('main requires all four GitHub Actions checks, an up-to-date PR and source-owner review. No bot has a review bypass.');
if (ready) {
  const environment = await client.request('environments/capability-signing');
  if (environment.protection_rules.some(rule => !['required_reviewers', 'branch_policy'].includes(rule.type))) {
    throw new Error('The signing environment has additional protection; preserve it and configure the review change manually.');
  }
  await client.request('environments/capability-signing', { method: 'PUT', body: {
    wait_timer: 0, prevent_self_review: false, reviewers: [],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  } });
  assertMainSigningPolicy((await client.request('environments/capability-signing/deployment-branch-policies')).branch_policies);
  const after = await client.request('environments/capability-signing');
  if (after.protection_rules.some(rule => rule.type === 'required_reviewers')) throw new Error('Signing still requires an extra review.');
  console.log('Automatic signing activated for main only. The existing signing secret was neither read nor changed.');
} else {
  console.log('The signing review remains in place until the implementation is merged and its main CI passes.');
}
