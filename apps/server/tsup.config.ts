import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/seed.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // The shared workspace package is TypeScript source: inline it. Everything else stays external.
  noExternal: ['@board/shared'],
});
