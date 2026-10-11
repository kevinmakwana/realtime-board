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
