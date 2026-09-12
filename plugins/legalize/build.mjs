// Builds the Legalize capability package: one bundled worker, the manifests it declares,
// and a deterministic archive. Nothing is fetched at install time and nothing is resolved
// from a registry on the user's machine.
import { buildPlugin } from '../../scripts/build-plugin.mjs';
import { fileURLToPath } from 'node:url';

export default [await buildPlugin({
  // `fileURLToPath`, not `.pathname`: on Windows the latter is `/C:/…` and every path
  // built from it points somewhere that does not exist.
  root: fileURLToPath(new URL('.', import.meta.url)),
  entries: { 'capabilities/legal/worker.js': 'src/worker.js' },
})];
