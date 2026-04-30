const { test: base, expect } = require('../fixtures/base');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');
const networkParams = require('../helpers/networkParams');

const test = base.extend({
    user: async ({ browser, browserName }, use) => {
        const context = await newContext(browser);
        const page = await context.newPage();
        const username = generateUsername(browserName);

        await createAndSignInUser(page, username);

        await use({ page, username, context });

        await context.close();
    }
});

test('validator market price uses stability factor', async ({ user }) => {
    const { page } = user;

    await page.locator('#toggleMenu').click();
    await expect(page.locator('#menuModal')).toBeVisible();

    await page.locator('#openValidator').click();
    await expect(page.locator('#validatorModal')).toBeVisible();

    const expectedFactor = networkParams.stabilityFactor.toFixed(6);
    const expectedMarketPrice = `$${expectedFactor}`;

    await expect(page.locator('#validator-stability-factor')).toHaveText(expectedFactor, { timeout: 30_000 });
    await expect(page.locator('#validator-market-price')).toHaveText(expectedMarketPrice);
    await expect(page.locator('#validator-network-stake-usd')).toContainText('$');
    await expect(page.locator('#validator-network-stake-lib')).not.toHaveText('N/A');
});
