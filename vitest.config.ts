import react from '@vitejs/plugin-react';
import { defaultExclude, defineConfig } from 'vitest/config';

const integration = '**/*.int.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/**/*.test.ts'],
          exclude: [integration, '**/node_modules/**', ...defaultExclude],
        },
      },
      {
        // React components: rendered into jsdom and driven the way a person would.
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['apps/web/test/**/*.test.tsx'],
          setupFiles: ['apps/web/test/setup.ts'],
        },
        plugins: [react()],
      },
      {
        test: {
          name: 'integration',
          include: [`{apps,packages}/${integration}`],
          exclude: ['**/node_modules/**'],
          globalSetup: ['apps/server/test/globalSetup.ts'],
          // Tests share one Postgres + Redis, so run files one at a time.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
