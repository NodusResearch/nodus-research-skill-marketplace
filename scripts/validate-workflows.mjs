// The signing key is reachable from exactly one job, and that job builds nothing.
//
// This is the one property of the release pipeline that cannot be checked by running it:
// a workflow edit that gives a build job the protected environment, or that adds a `run:`
// to the signing job, would publish signatures over bytes nobody reviewed and every run
// would still be green. So it is checked as text, here, on every push.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const workflows = path.join(root, '.github/workflows');

/** A blunt, indentation-based reader. Enough to tell one job from another without adding
 *  a YAML dependency to a repository that otherwise needs none. */
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start === -1) return new Map();
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) { current = header[1]; jobs.set(current, []); continue; }
    if (current && (line.trim() === '' || /^ {3,}/.test(line))) jobs.get(current).push(line);
    else if (line.trim() !== '' && !/^ /.test(line)) current = null;
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

const SIGNING_ENVIRONMENT = 'capability-signing';
const SECRET = 'CAPABILITY_SIGNING_KEY';
// The catalog App may open PRs whose CI then runs unattended, so its key stays with the job
// whose diff is limited to signed catalog metadata.
const CATALOG_APP_SECRET = 'CATALOG_APP_PRIVATE_KEY';

export function validateWorkflowSources(sources, codeowners) {
  const problems = [];
  for (const [file, text] of sources) {
    const jobs = jobsOf(text);

    for (const [name, body] of jobs) {
      const protectedEnvironment = new RegExp(`^\\s*environment:\\s*${SIGNING_ENVIRONMENT}\\s*$`, 'm').test(body);
      const usesSecret = body.includes(`secrets.${SECRET}`);

      if (body.includes(`secrets.${CATALOG_APP_SECRET}`) && (file !== 'release-plugin.yml' || name !== 'catalog')) {
        problems.push(`${file}: only release-plugin.yml's catalog job may use ${CATALOG_APP_SECRET}.`);
      }

      if ((usesSecret || protectedEnvironment) && (file !== 'release-plugin.yml' || name !== 'sign')) {
        problems.push(`${file}: only release-plugin.yml's sign job may reach the signing environment or key.`);
      }

      // The secret and the environment travel together: a job that reads one without the
      // other is either unprotected or pointless.
      if (usesSecret && !protectedEnvironment) problems.push(`${file}: job "${name}" reads ${SECRET} without the ${SIGNING_ENVIRONMENT} environment.`);

      if (!protectedEnvironment) continue;

      // A job that can sign must not also be the job that produces what it signs. Building
      // and signing in one place is how unreviewed bytes acquire a signature.
      for (const forbidden of ['build-plugins.mjs', 'build-notices.mjs', 'npm run build']) {
        if (body.includes(forbidden)) problems.push(`${file}: the signing job "${name}" runs ${forbidden}; it must only assemble, sign, verify and publish.`);
      }
      if (!body.includes('collect-release.mjs')) problems.push(`${file}: the signing job "${name}" does not assemble the release from the per-target builds.`);
      if (!body.includes('verify-release.mjs')) problems.push(`${file}: the signing job "${name}" does not verify what it signed.`);
    }

    // Nothing that runs on a pull request may reach the key, whatever job it is in.
    if (/^on:\s*\[?[^\n]*pull_request/m.test(text) || /^\s{2}pull_request:/m.test(text)) {
      if (text.includes(`secrets.${SECRET}`)) problems.push(`${file}: runs on pull requests and mentions ${SECRET}.`);
      if (text.includes(SIGNING_ENVIRONMENT)) problems.push(`${file}: runs on pull requests and names the ${SIGNING_ENVIRONMENT} environment.`);
      if (text.includes(`secrets.${CATALOG_APP_SECRET}`)) problems.push(`${file}: runs on pull requests and mentions ${CATALOG_APP_SECRET}.`);
      if (/^\s+[a-z-]+:\s*write\s*$/m.test(text)) problems.push(`${file}: pull-request validation must have read-only tokens.`);
    }
  }

  const release = sources.get('release-plugin.yml') ?? '';
  if (!release.includes('workflow_dispatch:')) problems.push('release-plugin.yml must keep an idempotent manual recovery trigger.');
  for (const required of ['workflow_run:', 'workflows: [Validate marketplace]', 'types: [completed]', 'branches: [main]']) {
    if (!release.includes(required)) problems.push(`release-plugin.yml is missing ${required}`);
  }
  if (/^on:[\s\S]*?^jobs:/m.exec(release)?.[0].includes('push:')) problems.push('release-plugin.yml must not publish on a push.');
  const jobs = jobsOf(release);
  const plan = jobs.get('plan') ?? '';
  for (const required of ["github.ref == 'refs/heads/main'", "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository', 'plan-capability-release.mjs']) {
    if (!plan.includes(required)) problems.push(`release plan is missing its main CI gate: ${required}`);
  }
  for (const name of ['build', 'sign']) {
    const body = jobs.get(name) ?? '';
    if (!body.includes('ref: ${{ needs.plan.outputs.source }}')) problems.push(`${name} must check out the exact validated source SHA.`);
    if (!body.includes('persist-credentials: false')) problems.push(`${name} must not persist a write credential in its checkout.`);
  }
  const signing = jobs.get('sign') ?? '';
  if (!signing.includes('needs: [plan, build]')) problems.push('sign must depend on the validated plan and every build.');
  if (/^\s+(?:run-id|github-token):/m.test(signing)) problems.push('sign must not download artifacts from another workflow run.');
  if (!signing.includes('publish-capability-release.mjs')) problems.push('sign must use the immutable source-pinned publisher.');
  const catalog = jobs.get('catalog') ?? '';
  if (!catalog.includes('sync-published-catalog.mjs') || !catalog.includes('ref: main')) problems.push('catalog must use the checked metadata-PR synchronizer from main.');
  if (!(sources.get('validate.yml') ?? '').includes('check-release-catalog.mjs')) problems.push('catalog-only PRs must retain their production-signature CI gate.');
  const owners = (codeowners ?? '').split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);
  if (JSON.stringify(owners) !== JSON.stringify(['* @jorgepb96', '/catalog-v2.json', '/plugins/*/catalog.json'])) {
    problems.push('CODEOWNERS must require the maintainer for every file except the two generated catalog patterns.');
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sources = new Map(fs.readdirSync(workflows).filter(name => name.endsWith('.yml'))
    .map(name => [name, fs.readFileSync(path.join(workflows, name), 'utf8')]));
  const problems = validateWorkflowSources(sources, fs.readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8'));
  if (problems.length) {
    console.error('Workflow problems:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Checked ${sources.size} workflow(s): main CI gates publication, signing builds nothing, and catalog automation grants no branch bypass.`);
}
