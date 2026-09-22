import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
const shared = { absWorkingDir: root, bundle: true, format: 'esm', target: 'es2023', sourcemap: false, logLevel: 'info' };
if (!process.argv.includes('--worker')) {
  await build({ ...shared, entryPoints: ['src/node.ts'], outfile: resolve(dist, 'node.js'), platform: 'node', target: 'node24' });
  await build({ ...shared, entryPoints: ['src/app.ts'], outfile: resolve(dist, 'app.js'), platform: 'browser' });
  // Both protocols must bundle without host-specific imports. Tests use Node
  // bundles so the repository needs no TypeScript runtime loader.
  for (const name of ['cache', 'logging']) {
    const portable = await build({ ...shared, entryPoints: [`src/${name}.ts`], outfile: resolve(dist, `${name}.js`), platform: 'browser', metafile: true });
    for (const output of Object.values(portable.metafile.outputs)) {
      if (output.imports.some(item => item.external)) throw new Error('Persistence protocols must not depend on external runtime modules');
    }
    await build({ ...shared, entryPoints: [`src/${name}.test.ts`], outfile: resolve(dist, `${name}.test.js`), platform: 'node', target: 'node24' });
  }
}
const worker = await build({ ...shared, entryPoints: ['src/worker.ts'], outfile: resolve(dist, 'worker.js'), platform: 'browser', metafile: true });
for (const output of Object.values(worker.metafile.outputs)) {
  if (output.imports.some(item => item.external)) throw new Error('Worker bundle must not depend on external Node/runtime modules');
}
const code = await readFile(resolve(dist, 'worker.js'), 'utf8');
if (/\beval\s*\(|\b(?:new\s+)?Function\s*\(/.test(code)) {
  throw new Error('Worker bundle contains dynamic code generation; schema validation must remain precompiled');
}
