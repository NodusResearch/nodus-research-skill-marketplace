import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflowSources } from './validate-workflows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map(['release-plugin.yml', 'validate.yml'].map(file => [file, fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')]));
const owners = fs.readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8');
const changed = (file, before, after) => {
  const clone = new Map(files);
  assert.ok(clone.get(file).includes(before), `fixture mutation not applied: ${before}`);
  clone.set(file, clone.get(file).replace(before, after));
  return validateWorkflowSources(clone, owners);
};
test('the checked-in workflow preserves its publication boundaries', () => assert.deepEqual(validateWorkflowSources(files, owners), []));
test('the key cannot move into a build job', () => {
  assert.ok(changed('release-plugin.yml', '  build:\n', '  build:\n    environment: capability-signing\n').length);
});
test('signing cannot build what it signs', () => {
  assert.ok(changed('release-plugin.yml', 'run: node scripts/sign-release.mjs', 'run: node scripts/build-plugins.mjs').some(p => p.includes('must only assemble')));
});
test('a PR workflow cannot request a write token', () => {
  assert.ok(changed('validate.yml', '  contents: read', '  contents: write').some(p => p.includes('read-only')));
  assert.ok(changed('validate.yml', '  contents: read', '  contents: read\n  checks: write').some(p => p.includes('read-only')));
});
test('catalog metadata exemptions cannot lose their production signature CI gate', () => {
  assert.ok(changed('validate.yml', 'node scripts/check-release-catalog.mjs', 'node scripts/validate-plugins.mjs').some(p => p.includes('production-signature')));
});
test('a PR workflow cannot name the release environment', () => {
  assert.ok(changed('validate.yml', '  validate:\n', '  validate:\n    environment: capability-signing\n').some(p => p.includes('runs on pull requests')));
});
test('an automatic release cannot consume PR CI instead of main push CI', () => {
  assert.ok(changed('release-plugin.yml', "github.event.workflow_run.event == 'push'", "github.event.workflow_run.event == 'pull_request'").some(p => p.includes('main CI gate')));
});
test('unsuccessful CI cannot authorize a release', () => {
  assert.ok(changed('release-plugin.yml', "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.conclusion == 'failure'").some(p => p.includes('main CI gate')));
});
test('the source repository guard cannot be removed', () => {
  assert.ok(changed('release-plugin.yml', 'github.event.workflow_run.head_repository.full_name == github.repository', 'true').length);
});
test('signing must use the exact source SHA and this run artifacts', () => {
  const source = new Map(files);
  source.set('release-plugin.yml', source.get('release-plugin.yml').replaceAll('ref: ${{ needs.plan.outputs.source }}', 'ref: main'));
  assert.ok(validateWorkflowSources(source, owners).some(p => p.includes('source SHA')));
  assert.ok(changed('release-plugin.yml', 'pattern: package-${{ matrix.plugin }}-*', 'run-id: 123\n          pattern: package-${{ matrix.plugin }}-*').some(p => p.includes('another workflow')));
});
test('CODEOWNERS cannot exempt a runtime, workflow or broad directory', () => {
  for (const line of ['/plugins/*/src/', '/.github/', '/plugins/']) {
    assert.ok(validateWorkflowSources(files, `${owners}\n${line}`).some(p => p.includes('CODEOWNERS')));
  }
});
