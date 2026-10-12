import { defineConfig, devices } from '@playwright/test';

// Two complete stacks share one Postgres + Redis:   web-a -> server-a     web-b -> server-b
// so "two browsers editing one board" also proves cross-instance sync through the real UI.
const ports = { serverA: 3101, serverB: 3102, webA: 5181, webB: 5182 };
export const E2E = {
  webA: `http://localhost:${ports.webA}`,
  webB: `http://localhost:${ports.webB}`,
};

const server = (port: number, id: string) => ({
  command: 'npx tsx apps/server/src/index.ts',
  url: `http://localhost:${port}/health`,
  env: { PORT: String(port), INSTANCE_ID: id },
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
  stdout: 'pipe' as const,
});
const web = (port: number, apiPort: number) => ({
  command: 'npm run dev -w apps/web',
  url: `http://localhost:${port}`,
  env: { WEB_PORT: String(port), VITE_API_TARGET: `http://localhost:${apiPort}` },
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
});

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', viewport: { width: 1280, height: 760 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 760 } } }],
  webServer: [
    server(ports.serverA, 'server-a'),
    server(ports.serverB, 'server-b'),
    web(ports.webA, ports.serverA),
    web(ports.webB, ports.serverB),
  ],
});
