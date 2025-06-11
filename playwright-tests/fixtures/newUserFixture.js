const { test: base, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');

exports.test = base.extend({
  username: async ({ browserName }, use) => {
    const username = generateUsername(browserName);
    await use(username);
  },
  page: async ({ browser, username }, use, testInfo) => {
    // Attach the username to the test report for easy access
    await testInfo.attach('username.txt', {
        body: username,
        contentType: 'text/plain',
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('dialog', async dialog => {
      if (dialog.type() === 'beforeunload') {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
    await createAndSignInUser(page, username);

    await use(page);

    await page.close();
    await context.close();
  }
});

exports.expect = expect;