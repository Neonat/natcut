import { defineConfig, devices } from '@playwright/test';
import { buildDevConfig } from './scripts/dev-config.mjs';

const lan = process.env.NATCUT_E2E_LAN === '1';
const { visitorOrigin } = buildDevConfig({ lan });

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: visitorOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: lan ? 'node scripts/dev.mjs --lan' : 'node scripts/dev.mjs',
    url: visitorOrigin,
    env: lan ? {} : { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'natcut-rehearsal.test' },
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
