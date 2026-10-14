// Shared, deterministic release decisions. No credentials or network access here.
import { compareSemver, validatePluginManifestV2 } from '../contract-v2.mjs';

export const RUNNERS = Object.freeze({
  any: 'ubuntu-latest', 'linux-x64': 'ubuntu-latest',
  'darwin-arm64': 'macos-14', 'darwin-x64': 'macos-15-intel',
  'win32-x64': 'windows-latest',
});
export const REQUIRED_CHECKS = Object.freeze([
  'validate', 'package-tests (ubuntu-latest)',
  'package-tests (windows-latest)', 'package-tests (macos-14)',
]);
export const isCatalogPath = file => file === 'catalog-v2.json'
  || /^plugins\/[a-z0-9]+(?:-[a-z0-9]+)*\/catalog\.json$/.test(file);

export function releaseTag(manifest) {
  return `${manifest.id}-v${manifest.version}`;
}

export function selectPackages(manifests, releases, only) {
  if (only && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(only)) throw new Error('Invalid package id.');
  const packages = manifests.map(validatePluginManifestV2).sort((a, b) => a.id.localeCompare(b.id));
  if (only && !packages.some(p => p.id === only)) throw new Error(`No such package: ${only}`);
  return packages.filter(p => !only || p.id === only).filter(p => {
    const existing = releases.find(r => r.tag_name === releaseTag(p));
    if (existing) {
      if (existing.draft || existing.prerelease) throw new Error(`${releaseTag(p)} exists but is not a stable published release.`);
      return false;
    }
    const pattern = new RegExp(`^${p.id}-v(\\d+\\.\\d+\\.\\d+)$`);
    const versions = releases.filter(r => !r.draft && !r.prerelease)
      .map(r => pattern.exec(r.tag_name)?.[1]).filter(Boolean);
    if (versions.some(v => compareSemver(p.version, v) <= 0)) {
      throw new Error(`${p.id} ${p.version} must exceed its published versions; rollback is explicit in Nodus.`);
    }
    return true;
  });
}

export function buildMatrix(packages) {
  return { include: packages.flatMap(p => p.compatibility.targets.map(target => {
    const runner = RUNNERS[target];
    if (!runner) throw new Error(`No runner is configured for ${target}.`);
    return { plugin: p.id, version: p.version, target, runner };
  })) };
}

export function assertMainMerge({ repository, source, branch, pullRequests, validation }) {
  if (!/^[0-9a-f]{40}$/.test(source)) throw new Error('A full source commit SHA is required.');
  if (!branch.protected) throw new Error('main must be protected before automatic signing is enabled.');
  if (branch.commit.sha !== source) return false; // A newer merge will be checked by its own CI.
  if (!pullRequests.some(pr => pr.merged_at && pr.merge_commit_sha === source
    && pr.base.ref === 'main' && pr.base.repo.full_name === repository)) {
    throw new Error('Publication requires a merged pull request into main; a direct push is insufficient.');
  }
  if (!validation || validation.head_sha !== source || validation.head_branch !== 'main'
    || validation.event !== 'push' || validation.status !== 'completed' || validation.conclusion !== 'success') {
    throw new Error('The source commit must pass the main push run of Validate marketplace.');
  }
  return true;
}

export function assertReleaseMatchesPackage(release, manifest) {
  if (release.plugin !== manifest.id || release.version !== manifest.version) {
    throw new Error(`The signed release does not describe ${releaseTag(manifest)}.`);
  }
  const expected = [...manifest.compatibility.targets].sort();
  const actual = release.targets.map(t => t.target).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('The signed target set differs from the package.');
  for (const t of release.targets) {
    if (t.asset !== `${manifest.id}-${manifest.version}-${t.target}.nodus-plugin`) {
      throw new Error('Unexpected archive name in the signed release.');
    }
  }
}

export function assertPublishedBuildMatches(release, built) {
  for (const target of release.targets) {
    const entry = built.find(e => e.manifest.id === release.plugin && e.target === target.target);
    if (!entry || entry.sha256 !== target.sha256 || entry.bytes !== target.bytes) {
      throw new Error('This version was published with different content.');
    }
  }
}

export function recordedAssetBytes(description, target, version, ceiling) {
  if (description.assetVersion !== version || description.assetBytes?.[target] === undefined) return ceiling;
  const bytes = description.assetBytes[target];
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > ceiling) throw new Error(`Invalid recorded asset size for ${target}.`);
  return bytes;
}

export function assertCatalogDiff(before, after) {
  if (before.description && JSON.stringify(before.description) !== JSON.stringify(after.description)) {
    throw new Error('A release metadata update cannot change descriptions.');
  }
  const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['assetBytes', 'assetVersion'].includes(key)));
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) throw new Error('Only signed asset sizes and their version may change.');
}

export function assertCatalogIndexDiff(before, after) {
  const strip = value => ({ ...value, updatedAt: undefined, plugins: value.plugins.map(p => ({
    ...p, release: { ...p.release, assets: p.release.assets.map(({ bytes, ...asset }) => asset) },
  })) });
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) {
    throw new Error('The catalog index may only change signed byte counts and its timestamp.');
  }
}
