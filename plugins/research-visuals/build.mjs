import { buildPlugin } from '../../scripts/build-plugin.mjs';
import { fileURLToPath } from 'node:url';
export default [await buildPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), entries: { 'capabilities/cartography/worker.js': 'src/maps.js', 'capabilities/images/worker.js': 'src/images.js' } })];
