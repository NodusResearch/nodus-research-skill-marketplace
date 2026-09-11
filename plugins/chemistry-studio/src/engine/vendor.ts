import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Where the package's own native dependencies live.
 *
 *  RDKit carries WebAssembly and node-tikzjax carries a TeX distribution; neither can be
 *  flattened into a JavaScript bundle, so both travel inside the archive under `vendor/`
 *  and are required from there. A package has no `node_modules` to fall back on, which is
 *  the point: it cannot pick up a different copy from the machine it is installed on. */

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, '..', '..', 'vendor');
const vendorRequire = createRequire(path.join(vendorRoot, 'index.cjs'));

export function requireVendored<T>(name: string): T {
  try { return vendorRequire(name) as T; }
  catch (error) {
    throw new Error(`Chemistry Studio is missing its bundled ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const vendorPath = (...segments: string[]) => path.join(vendorRoot, ...segments);
