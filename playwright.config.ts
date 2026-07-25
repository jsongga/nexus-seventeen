import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.STEWARD_E2E_PORT ?? 4_173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('STEWARD_E2E_PORT is invalid');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 30_000,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    // Never silently validate a stale preview that happens to own the port.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
