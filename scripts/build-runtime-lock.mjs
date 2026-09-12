// Generates the dependency locks for a package's Python runtime, one per target and
// interpreter version.
//
// What it produces is the complete resolved set, each artifact pinned by URL, size and
// SHA-256, so the user's machine installs exactly those bytes with `--no-index
// --require-hashes` and resolves nothing from an index at install time.
//
// Two things this deliberately does not do. It does not use `pip download --report`: that
// combination does not exist, so the previous version of this script could not have run.
// And it does not resolve on the user's machine: a wheel is built for one platform and one
// interpreter, so the resolution happens here, once, for every combination the package
// says it supports, and anything outside that list is told so plainly instead of being
// resolved into something nobody reviewed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const [id, runtimeId = 'alphagenome'] = process.argv.slice(2);
if (!id) throw new Error('Usage: node scripts/build-runtime-lock.mjs <plugin-id> [runtime-id]');

const spec = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'runtimes', `${runtimeId}.requirements.json`), 'utf8'));
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');

/** Which wheel tags each target resolves against. `manylinux2014` is the oldest glibc a
 *  current wheel is built for; the macOS floors match what the published wheels carry. */
const TARGETS = {
  'darwin-arm64': ['macosx_11_0_arm64', 'macosx_12_0_arm64', 'macosx_13_0_arm64', 'macosx_14_0_arm64'],
  'darwin-x64': ['macosx_10_13_x86_64', 'macosx_11_0_x86_64', 'macosx_12_0_x86_64', 'macosx_13_0_x86_64'],
  'win32-x64': ['win_amd64'],
  'linux-x64': ['manylinux2014_x86_64', 'manylinux_2_17_x86_64', 'manylinux_2_28_x86_64'],
};

const requested = (process.env.NODUS_LOCK_TARGETS ?? Object.keys(TARGETS).join(',')).split(',').map(value => value.trim()).filter(Boolean);
const pythons = (process.env.NODUS_LOCK_PYTHONS ?? spec.pythonVersions?.join(',') ?? '3.10,3.11,3.12,3.13').split(',').map(value => value.trim()).filter(Boolean);

/** Everything installed must come from the one host the package is allowed to reach. A
 *  lock that names anywhere else is not installable, so it is refused here rather than at
 *  the first person who tries. */
const ALLOWED_HOST = 'files.pythonhosted.org';

const requirementFor = (entry) => {
  const name = entry.metadata?.name;
  const version = entry.metadata?.version;
  if (!name || !version) throw new Error('pip reported an artifact with no name or version.');
  return `${name}==${version}`;
};

async function sizeOf(url) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (!Number.isInteger(length) || length < 1) throw new Error(`${url} did not report a usable size.`);
  return length;
}

function resolve(target, pythonVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-runtime-lock-'));
  try {
    const report = path.join(dir, 'report.json');
    const platforms = TARGETS[target].flatMap(tag => ['--platform', tag]);
    const abi = `cp${pythonVersion.replace('.', '')}`;
    // `--dry-run` resolves without downloading; `--report` is where the exact artifact each
    // requirement resolved to is written, URL and digest included. `--only-binary :all:`
    // keeps source distributions out: a sdist would have to be built on the user's machine,
    // which is neither pinned nor reproducible.
    execFileSync(python, [
      '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--no-input',
      '--report', report, '--target', path.join(dir, 'target'),
      ...platforms, '--python-version', pythonVersion, '--abi', abi,
      '--only-binary', ':all:', ...spec.requirements,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return JSON.parse(fs.readFileSync(report, 'utf8')).install ?? [];
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

let written = 0;
for (const target of requested) {
  if (!TARGETS[target]) throw new Error(`Unknown target: ${target}`);
  for (const pythonVersion of pythons) {
    const install = resolve(target, pythonVersion);
    if (!install.length) throw new Error(`${target} on Python ${pythonVersion} resolved to nothing.`);

    const packages = [];
    for (const entry of install) {
      const url = entry.download_info?.url;
      const sha256 = entry.download_info?.archive_info?.hashes?.sha256;
      if (typeof url !== 'string' || new URL(url).protocol !== 'https:') throw new Error(`${requirementFor(entry)} did not resolve to an https artifact.`);
      if (new URL(url).host !== ALLOWED_HOST) throw new Error(`${requirementFor(entry)} resolves to ${new URL(url).host}, which this runtime is not permitted to reach.`);
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${requirementFor(entry)} was reported without a SHA-256.`);
      const name = decodeURIComponent(url.split('/').pop());
      if (!name.endsWith('.whl')) throw new Error(`${name} is not a wheel; a source distribution cannot be installed from a lock.`);
      packages.push({ name, requirement: requirementFor(entry), url, bytes: await sizeOf(url), sha256 });
    }

    const lock = {
      schemaVersion: 1,
      python: pythonVersion,
      platform: target,
      packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    };
    const out = path.join(root, 'plugins', id, 'runtimes', target);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `lock-${pythonVersion}.json`), `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`${target} / Python ${pythonVersion}: ${packages.length} wheel(s).`);
    written += 1;
  }
}
if (!written) throw new Error('No lock was written.');
