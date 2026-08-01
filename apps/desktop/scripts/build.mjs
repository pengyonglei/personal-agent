import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(desktopDirectory, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await Promise.all([
  build({
    entryPoints: [resolve(desktopDirectory, 'src/main.ts')],
    outfile: resolve(outputDirectory, 'main.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['electron'],
    sourcemap: true,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
  }),
  build({
    entryPoints: [resolve(desktopDirectory, 'src/preload.ts')],
    outfile: resolve(outputDirectory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  }),
]);
