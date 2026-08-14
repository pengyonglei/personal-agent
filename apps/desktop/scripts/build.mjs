import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(desktopDirectory, 'dist');
const production = process.argv.includes('--production');

await rm(outputDirectory, { recursive: true, force: true });
await Promise.all([
  build({
    entryPoints: [resolve(desktopDirectory, 'src/main.ts')],
    outfile: resolve(outputDirectory, 'main.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // electron-updater 为 CJS 且保持真实 node_modules 依赖（由 electron-builder 打进安装包），
    // 运行时经 __require（createRequire）加载，避免 ESM/CJS interop 问题
    external: ['electron', 'electron-updater'],
    minify: production,
    sourcemap: !production,
    banner: {
      // esbuild's ESM CommonJS shim looks specifically for a `require` binding.
      // Keep __require as an alias for the explicit electron-updater load in main.ts.
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); const __require = require;",
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
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  }),
]);
