const { expect } = require("@playwright/test");

// Helper to create and sign in a new user
async function createAndSignInUser(page, username) {
    await page.goto('', { waitUntil: 'networkidle' });
    await expect(page.locator('#welcomeScreen')).toBeVisible();
    await expect(page.locator('#createAccountButton')).toBeVisible();
    await page.click('#createAccountButton');
    await expect(page.locator('#createAccountModal')).toBeVisible();
    await page.locator('#newUsername').pressSequentially(username);
    await expect(page.locator('#newUsernameAvailable')).toHaveText('available');
    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    // expect loading toast to appear
    await expect(page.locator('.toast.loading.show')).toBeVisible();
    // wait for the loading toast to disappear
    await page.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(page.locator('#chatsScreen')).toBeVisible();
    const appName = await page.locator('.app-name').textContent();
    await expect(appName.trim()).toBe(username);
    await expect(page.locator('#wsStatusIndicator.ws-green')).toBeVisible({ timeout: 10_000 });
}

// creates a unique username based on the browser name and current timestamp
function generateUsername(browserName) {
    const browserInitial = browserName[0];
    const timestamp = Date.now().toString().slice(-8);
    const rand = Math.floor(Math.random() * 1e10).toString().padStart(10, '0');
    return `${browserInitial}${timestamp}${rand}`.slice(0, 19);
}

module.exports = {
    createAndSignInUser,
    generateUsername
};
