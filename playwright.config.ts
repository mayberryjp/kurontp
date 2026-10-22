import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:18000', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1050 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'python -m kuro',
    url: 'http://127.0.0.1:18000/health',
    reuseExistingServer: false,
    env: {
      API_LISTEN_ADDRESS: '127.0.0.1', API_PORT: '18000',
      NTP_LISTEN_ADDRESS: '127.0.0.1', NTP_PORT: '10124',
      NTP_ALLOWED_NETWORKS: '127.0.0.0/8',
      NTP_UPSTREAMS: '127.0.0.1', NTP_UPSTREAM_PORT: '9', NTP_UPSTREAM_TIMEOUT: '0.1',
      DATABASE_PATH: 'data/e2e.sqlite3', ADMIN_TOKEN: 'e2e-test-token',
    },
  },
});