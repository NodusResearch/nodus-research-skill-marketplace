// Builds the Legalize capability package: one bundled worker, the manifests it declares,
// and a deterministic archive. Nothing is fetched at install time and nothing is resolved
// from a registry on the user's machine.
import { buildPlugin } from '../../scripts/build-plugin.mjs';

export default [await buildPlugin({
  root: new URL('.', import.meta.url).pathname,
  entries: { 'capabilities/legal/worker.js': 'src/worker.js' },
})];
