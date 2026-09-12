import { buildPlugin } from '../../scripts/build-plugin.mjs';
import { fileURLToPath } from 'node:url';
export default [await buildPlugin({root:fileURLToPath(new URL('.',import.meta.url)),entries:{'capabilities/mathematics/worker.js':'src/worker.js'}})];
