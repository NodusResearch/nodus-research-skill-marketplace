import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { githubClient, readPublishedRelease } from './lib/github-release-api.mjs';
import { assertPublishedBuildMatches, releaseTag } from './lib/release-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? '')) throw new Error('A package id is required.');
if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SOURCE_SHA ?? '')) throw new Error('A full release source SHA is required.');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'plugin.json'), 'utf8'));
const client = githubClient();
const tag = releaseTag(manifest);
const alreadyPublished = async () => {
  const release = await readPublishedRelease(client, root, manifest);
  if (!release) return false;
  const built = JSON.parse(fs.readFileSync(path.join(root, 'build/index.json'), 'utf8'));
  assertPublishedBuildMatches(release, built);
  console.log(`${tag} is already published with these exact archives; skipping.`);
  return true;
};
if (!await alreadyPublished()) {
  const files = manifest.compatibility.targets.map(target => path.join(root, 'build', `${id}-${manifest.version}-${target}.nodus-plugin`));
  try {
    execFileSync('gh', ['release', 'create', tag, '--repo', client.repository,
      '--target', process.env.RELEASE_SOURCE_SHA, '--title', `${id} ${manifest.version}`,
      '--notes-file', path.join(root, 'plugins', id, 'RELEASE_NOTES.md'), ...files,
      path.join(root, 'build/release-manifest.json'), path.join(root, 'build/release-manifest.sig')], { stdio: 'inherit' });
  } catch (error) {
    if (!await alreadyPublished()) throw error;
  }
  await readPublishedRelease(client, root, manifest); // Publication is checked before metadata is committed.
}
