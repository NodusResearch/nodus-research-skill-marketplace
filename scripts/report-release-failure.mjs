import { githubClient } from './lib/github-release-api.mjs';

const client = githubClient();
const run = process.env.GITHUB_RUN_ID;
const source = process.env.RELEASE_SOURCE_SHA;
if (!/^\d+$/.test(run ?? '') || !/^[0-9a-f]{40}$/.test(source ?? '')) throw new Error('A workflow run and source SHA are required.');
const marker = `<!-- capability-release:${source} -->`;
const issues = await client.pages('issues?state=open');
const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(marker));
const body = `${marker}\n\nAutomatic capability publication or catalog validation failed for main commit ${source}.\n\n[Inspect the failed workflow](https://github.com/${client.repository}/actions/runs/${run}). Published versions remain immutable; correct the failure and rerun the workflow to resume unpublished packages and catalog synchronization.\n\nNo credentials or logs are included in this report.`;
const result = existing
  ? await client.request(`issues/${existing.number}`, { method: 'PATCH', body: { body } })
  : await client.request('issues', { method: 'POST', body: {
    title: `Automatic capability release failed (${source.slice(0, 12)})`, body, assignees: ['jorgepb96'],
  } });
console.log(`Failure reported: ${result.html_url}`);
