import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const outDir = 'dist';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'renderer'), { recursive: true });

/** 主进程和 preload 都是 Node/CJS：Electron 的 require 只认 CJS，sandbox preload 也一样 */
const nodeTarget = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  // ws 的这两个是可选原生加速模块，不存在时它自己会回落到纯 JS
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

await build({ ...nodeTarget, entryPoints: ['src/main/index.ts'], outfile: join(outDir, 'main/index.cjs') });
await build({ ...nodeTarget, entryPoints: ['src/main/preload.ts'], outfile: join(outDir, 'preload.cjs') });

await build({
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  entryPoints: ['src/renderer/main.tsx'],
  outfile: join(outDir, 'renderer/app.js'),
  sourcemap: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

cpSync('src/renderer/index.html', join(outDir, 'renderer/index.html'));
cpSync('src/renderer/styles.css', join(outDir, 'renderer/styles.css'));

console.log('构建完成：dist/main/index.cjs, dist/preload.cjs, dist/renderer/');
