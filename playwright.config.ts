import { defineConfig, devices } from '@playwright/test';

const e2eOrigin = 'http://127.0.0.1:41731';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 30_000,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: e2eOrigin,
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
    command: 'npm run dev -- --host 127.0.0.1 --port 41731 --strictPort',
    url: e2eOrigin,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
