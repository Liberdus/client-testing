const { expect } = require('@playwright/test');

// Helper to get Liberdus asset balance from wallet
async function getLiberdusBalance(page) {
    await page.click('#switchToWallet');
    await expect(page.locator('#walletScreen.active')).toBeVisible();
    await page.click('#refreshBalance');
    // Find the asset row containing 'Liberdus'
    const assetRow = page.locator('#assetsList > div').filter({ hasText: 'Liberdus' }).first();
    // Find the balance element inside this row
    const balanceLocator = assetRow.locator('.asset-balance');
    const balanceText = await balanceLocator.evaluate(el => {
        // Get only the text content before the <span>
        return el.childNodes[0].textContent.trim();
    });
    return balanceText;
}

// Wait for Liberdus balance to equal expected value (as string or number), with timeout (ms)
async function expectLiberdusBalanceToEqual(page, expected, timeout = 30000) {
    await expect(async () => {
        const balance = await getLiberdusBalance(page);
        expect(balance).toEqual(expected.toString());
    }).toPass({ timeout });
}

export {
    getLiberdusBalance,
    expectLiberdusBalanceToEqual
};
