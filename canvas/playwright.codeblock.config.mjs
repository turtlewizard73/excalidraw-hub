import { defineConfig } from '@playwright/test';

// Code-block browser tests against an already running canvas (+ plantuml-server), e.g. the
// sandbox stack: CANVAS_URL=http://canvas:3000. Destructive: clears that canvas. Never point at :3000.
export default defineConfig({
  testDir: './tests/codeblock',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 15000 },
  outputDir: './test-results/codeblock',
  use: {
    baseURL: process.env.CANVAS_URL || 'http://127.0.0.1:3001',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
