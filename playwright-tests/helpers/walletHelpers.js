const { expect } = require('@playwright/test');

async function getLiberdusBalance(page) {
    await page.click('#switchToWallet');
    await expect(page.locator('#walletScreen.active')).toBeVisible();
    await page.click('#refreshBalance');
    await expect(page.locator('#walletBalanceUpdated')).not.toHaveText('Updating…', { timeout: 15_000 });

    const asset = page.locator('#assetsList .asset-item').filter({
        has: page.locator('.asset-name', { hasText: /^Liberdus$/ })
    });
    const quantity = asset.locator('.wallet-native-quantity');
    const text = (await quantity.innerText()).trim();
    const amount = text.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+LIB$/);
    const balance = Number(amount?.[1].replaceAll(',', ''));
    if (!Number.isFinite(balance)) {
        throw new Error(`Could not read the LIB balance from ${JSON.stringify(text)}`);
    }
    return balance;
}

async function expectLiberdusBalanceToEqual(page, expected, timeout = 30000) {
    expect(Number.isFinite(expected), 'Expected LIB balance must be a finite number').toBe(true);
    await expect(async () => {
        const balance = await getLiberdusBalance(page);
        // The wallet can truncate the starting and ending balances at six decimal places.
        const tolerance = 1e-6 + Number.EPSILON * Math.max(1, balance, expected);
        expect(Math.abs(balance - expected), `Expected ${expected} LIB, found ${balance} LIB`).toBeLessThanOrEqual(tolerance);
    }).toPass({ timeout });
}

module.exports = {
    getLiberdusBalance,
    expectLiberdusBalanceToEqual
};
