// The signing key is reachable from exactly one job, and that job builds nothing.
//
// This is the one property of the release pipeline that cannot be checked by running it:
// a workflow edit that gives a build job the protected environment, or that adds a `run:`
// to the signing job, would publish signatures over bytes nobody reviewed and every run
// would still be green. So it is checked as text, here, on every push.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workflows = path.join(root, '.github/workflows');
const problems = [];

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

for (const file of fs.readdirSync(workflows).filter(name => name.endsWith('.yml'))) {
  const text = fs.readFileSync(path.join(workflows, file), 'utf8');
  const jobs = jobsOf(text);

  for (const [name, body] of jobs) {
    const protectedEnvironment = new RegExp(`^\\s*environment:\\s*${SIGNING_ENVIRONMENT}\\s*$`, 'm').test(body);
    const usesSecret = body.includes(`secrets.${SECRET}`);

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
  }
}

const release = fs.readFileSync(path.join(workflows, 'release-plugin.yml'), 'utf8');
if (!release.includes('workflow_dispatch')) problems.push('release-plugin.yml must be started deliberately, not by a push.');
if (/^on:[\s\S]*?^jobs:/m.exec(release)?.[0].includes('push:')) problems.push('release-plugin.yml must not publish on a push.');

if (problems.length) {
  console.error('Workflow problems:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Checked ${fs.readdirSync(workflows).filter(name => name.endsWith('.yml')).length} workflow(s): the signing key is reachable from the signing job alone, and that job builds nothing.`);
