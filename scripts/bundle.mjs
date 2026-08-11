// Santa-proof bundler: esbuild-wasm runs under node (no native binary to block).
import * as esbuild from 'esbuild-wasm';

// In Node, esbuild-wasm loads its own bundled esbuild.wasm; run in-process (no worker).
await esbuild.initialize({ worker: false });

const targets = [
  ['src/index.ts', 'dist/gsuite-mcp.cjs'],
  ['src/auth-cli.ts', 'dist/auth.cjs'],
];
for (const [entryPoint, outfile] of targets) {
  const t0 = Date.now();
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'warning',
  });
  console.log(`bundled ${outfile} in ${Date.now() - t0}ms`);
}
