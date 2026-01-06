/**
 * Base test fixture that auto-closes specific toasts.
 * All test files should import { test, expect } from this module
 * instead of from '@playwright/test'.
 */
const { test: baseTest, expect } = require('@playwright/test');
const { toastCloserScript } = require('../helpers/toastHelpers');

// Extend base test to override context fixture
const test = baseTest.extend({
  context: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript(toastCloserScript);
    await use(context);
    await context.close();
  },
});

module.exports = { test, expect };
