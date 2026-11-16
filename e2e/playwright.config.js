export default {
  testDir: '.',
  testMatch: '*.spec.js',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.HUB_URL, viewport: { width: 1500, height: 950 }, screenshot: 'only-on-failure',
    // Native runs (scripts/e2e.sh with E2E_RUNTIME=native) may point at an installed Chromium instead of Playwright's download.
    ...(process.env.CHROMIUM_PATH && { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }),
  },
};
