// Runs the package's deterministic Python fixtures; no user's reaction index is needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = path.join(root, 'plugins/chemistry-studio/test');
const python = process.env.NODUS_CHEMISTRY_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
for (const name of fs.readdirSync(tests).filter(name => /^test_.*\.py$/.test(name)).sort()) {
  execFileSync(python, ['-I', path.join(tests, name)], { stdio: 'inherit', timeout: 120000 });
}
