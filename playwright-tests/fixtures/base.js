/**
 * Base test fixture that auto-closes specific toasts.
 * All test files should import { test, expect } from this module
 * instead of from '@playwright/test'.
 */
const { test: baseTest, expect } = require('@playwright/test');
const { toastCloserScript } = require('../helpers/toastHelpers');
const { TestDiagnostics } = require('../helpers/testDiagnostics');

// Extend base test to override context fixture
const test = baseTest.extend({
  diagnostics: [async ({ browser }, use) => {
    const diagnostics = TestDiagnostics.current();
    for (const context of browser.contexts()) diagnostics.observeContext(context);
    await use(diagnostics);
    await diagnostics.finish();
  }, { auto: true }],
  context: async ({ browser, diagnostics }, use) => {
    const context = await browser.newContext();
    await context.addInitScript(toastCloserScript);
    diagnostics.observeContext(context);
    await use(context);
    await diagnostics.close([context], null);
  },
});

module.exports = { test, expect };
