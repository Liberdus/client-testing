// Helper to get Liberdus asset balance from wallet
async function getLiberdusBalance(page) {
    await page.click('#refreshBalance');
    const assetRows = await page.$$('#assetsList > div');
    for (const row of assetRows) {
        const name = await row.$eval('.asset-info > .asset-name', el => el.textContent.trim()).catch(() => '');
        if (name === 'Liberdus') {
            const balanceText = await page.locator('.asset-balance').evaluate(el => {
                // Get only the text content before the <span>
                return el.childNodes[0].textContent.trim();
            });
            return balanceText;
        }
    }
    throw new Error('Liberdus asset not found in wallet');
}

export {
    getLiberdusBalance
};
