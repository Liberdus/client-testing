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

async function ensureLiberdusBalance(page, minimum) {
    let balance = await getLiberdusBalance(page);
    if (balance >= minimum) return balance;

    const faucet = page.getByRole('button', { name: 'Faucet', exact: true });
    const faucetResult = page.locator('.toast.show', {
        hasText: /^(?:Faucet (?:request successful|request failed|error|not available)|Balance exceeds 100 LIB|You must be online to request from faucet)/
    });
    await faucet.click();
    await expect(faucetResult).toBeVisible({ timeout: 30_000 });
    const result = await faucetResult.innerText();
    expect(result, 'Wallet Faucet response').toContain('Faucet request successful');

    await expect(async () => {
        balance = await getLiberdusBalance(page);
        expect(balance, 'LIB balance after the Faucet request').toBeGreaterThanOrEqual(minimum);
    }).toPass({ timeout: 60_000 });
    return balance;
}

module.exports = {
    getLiberdusBalance,
    expectLiberdusBalanceToEqual,
    ensureLiberdusBalance
};
