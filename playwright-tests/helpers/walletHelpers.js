// Helper to get Liberdus asset balance from wallet
async function getLiberdusBalance(page) {
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

export {
    getLiberdusBalance
};
