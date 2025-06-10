const { test: base, expect } = require('@playwright/test');
const { createAndSignInUser } = require('../helpers/userHelper');

exports.test = base.extend({
  page: async ({ browser, browserName }, use, testInfo) => {
    // Create a new context and page for each test
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('dialog', async dialog => {
      if (dialog.type() === 'beforeunload') {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });

    // Create a unique username per test, under 20 characters
    // Format: <b><t><r> where b=browser initial, t=timestamp (last 8 digits), r=random 10 digits
    const browserInitial = browserName[0];
    const timestamp = Date.now().toString().slice(-8);
    const rand = Math.floor(Math.random() * 1e10).toString().padStart(10, '0');
    const username = `${browserInitial}${timestamp}${rand}`.slice(0, 19);

    await createAndSignInUser(page, username);

    await use(page);

    await page.close();
    await context.close();
  }
});

exports.expect = expect;