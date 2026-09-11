// Generates a platform-specific dependency lock for a package's Python runtime.
//
// Must run on a machine matching the target, because wheels differ per platform and per
// interpreter. What it produces is the complete resolved set, each wheel pinned by URL,
// size and SHA-256, so the user's machine installs exactly these bytes with
// `--no-index --require-hashes` and never resolves anything from an index.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const [id, runtimeId = 'alphagenome'] = process.argv.slice(2);
if (!id) throw new Error('Usage: node scripts/build-runtime-lock.mjs <plugin-id> [runtime-id]');

const spec = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'runtimes', `${runtimeId}.requirements.json`), 'utf8'));
const target = process.env.NODUS_PLUGIN_TARGET ?? `${process.platform}-${process.arch}`;
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');

const version = execFileSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
if (Number(version.split('.')[1]) < 10 || Number(version.split('.')[0]) < 3) throw new Error(`Python ${version} is older than the declared minimum.`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-runtime-lock-'));
try {
  // `pip download` resolves once, here, and reports where each artifact came from.
  execFileSync(python, ['-m', 'pip', 'download', '--dest', dir, '--report', path.join(dir, 'report.json'), '--no-input', ...spec.requirements], { stdio: 'inherit' });

  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const packages = [];
  for (const entry of report.install ?? []) {
    const url = entry.download_info?.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`${entry.metadata?.name} did not resolve to an https artifact.`);
    const name = decodeURIComponent(url.split('/').pop());
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`pip reported ${name} but did not download it.`);
    const bytes = fs.readFileSync(file);
    packages.push({ name, url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!packages.length) throw new Error('The resolution produced no artifacts.');

  const lock = { schemaVersion: 1, python: version, platform: target, packages: packages.sort((a, b) => a.name.localeCompare(b.name)) };
  const out = path.join(root, 'plugins', id, 'runtimes', target);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Locked ${packages.length} artifact(s) for ${target} on Python ${version}.`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
