// Helper to create and sign in a new user
async function createAndSignInUser(page, username) {
    await page.goto('', { waitUntil: 'networkidle' });
    // Try both welcomeScreen and createAccountButton for compatibility
    try {
        await page.waitForSelector('#welcomeScreen', { state: 'visible', timeout: 30_000 });
    } catch {
        await page.waitForSelector('#createAccountButton', { state: 'visible', timeout: 30_000 });
    }
    await page.click('#createAccountButton');
    await page.waitForSelector('#createAccountModal', { state: 'visible' });
    await page.fill('#newUsername', username);
    await page.waitForTimeout(3_000);
    const usernameStatus = await page.locator('#newUsernameAvailable').textContent().catch(() => '');
    if (usernameStatus !== 'available') {
        throw new Error(`Username "${username}" not available: ${usernameStatus}`);
    }
    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    await page.waitForSelector('#createAccountForm button[type="submit"]:enabled');
    await createBtn.click();
    await page.waitForSelector('#chatsScreen', { state: 'visible', timeout: 30_000 });
    const appName = await page.locator('.app-name').textContent();
    if (appName.trim() !== username) throw new Error('App name in header does not match username');
}

module.exports = {
    createAndSignInUser,
};
