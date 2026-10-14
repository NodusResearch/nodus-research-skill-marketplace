import fs from 'node:fs';
import path from 'node:path';
import { verifyReleaseManifest } from '../contract-v2.mjs';
import { assertReleaseMatchesPackage, releaseTag } from './release-automation.mjs';

export function githubClient(repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('A GitHub owner/repository is required.');
  if (!token) throw new Error('GH_TOKEN is required for GitHub release operations.');
  const request = async (route, { method = 'GET', body, missing = false } = {}) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${route.split('?')[0]} failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  return { repository, request, async pages(route, key) {
    const collected = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw new Error('GitHub returned an invalid collection.');
      collected.push(...rows);
      if (rows.length < 100) return collected;
    }
    throw new Error('GitHub pagination exceeded its bound.');
  } };
}

export async function downloadSmall(url, maximum = 256 * 1024, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Public release download failed (${response.status}).`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Public release metadata exceeds its limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readPublishedRelease(client, root, manifest, destination, fetcher = fetch) {
  const tag = releaseTag(manifest);
  const record = await client.request(`releases/tags/${tag}`, { missing: true });
  if (!record) return null;
  if (record.draft || record.prerelease) throw new Error(`${tag} is not a stable published release.`);
  const base = `https://github.com/${client.repository}/releases/download/${tag}`;
  const bytes = await downloadSmall(`${base}/release-manifest.json`, 256 * 1024, fetcher);
  const signature = await downloadSmall(`${base}/release-manifest.sig`, 4096, fetcher);
  const keys = JSON.parse(fs.readFileSync(path.join(root, 'trusted-keys.json'), 'utf8')).keys;
  const release = verifyReleaseManifest(bytes, signature, keys);
  assertReleaseMatchesPackage(release, manifest);
  for (const target of release.targets) {
    const asset = record.assets.find(a => a.name === target.asset && a.state === 'uploaded');
    if (!asset || asset.size !== target.bytes || (asset.digest && asset.digest !== `sha256:${target.sha256}`)) {
      throw new Error(`The published asset metadata does not match the signed ${target.asset}.`);
    }
  }
  if (destination) {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'release-manifest.json'), bytes);
    fs.writeFileSync(path.join(destination, 'release-manifest.sig'), signature);
  }
  return release;
}
