const { defineConfig } = require('@playwright/test');

// Offline tests of the test harness itself; no network setup or real accounts.
module.exports = defineConfig({
  testDir: './harness-tests',
  retries: 1,
  workers: 1,
  timeout: 20_000,
  reporter: [['list'], ['json', { outputFile: './test-results/diagnostics-report.json' }]],
  outputDir: './test-results/diagnostics',
  use: { baseURL: 'http://diagnostics.test/', headless: true, trace: 'retain-on-failure' },
});
