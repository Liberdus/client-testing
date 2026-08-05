const { expect } = require("@playwright/test");

async function createUser(page, username) {
    await page.goto('', { waitUntil: 'networkidle' });
    await expect(page.locator('#welcomeScreen')).toBeVisible();
    await expect(page.locator('#createAccountButton')).toBeVisible();
    await page.click('#createAccountButton');
    await expect(page.locator('#createAccountModal')).toBeVisible();
    await page.locator('#newUsername').pressSequentially(username);
    await expect(page.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
}

// Helper to create and sign in a new user
async function createAndSignInUser(page, username) {
    await createUser(page, username);
    // expect loading toast to appear
    await expect(page.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    // wait for the loading toast to disappear
    await page.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    const appName = await page.locator('.app-name').textContent();
    await expect(appName.trim()).toBe(username);
}

function signInAccountCard(page, username) {
    return page.locator(`#signInAccountList .sign-in-account-item[data-username="${username}"]`);
}

async function unlockDevice(page, password) {
    const unlockModal = page.locator('#unlockModal.active');
    await expect(unlockModal).toBeVisible();
    await unlockModal.locator('#password').fill(password);
    await unlockModal.locator('#unlockForm button[type="submit"]').click();
    await expect(unlockModal).not.toBeVisible();
}

async function signInWithAccountCard(page, username, options = {}) {
    const { expectedAccountUsernames = [username], lockPassword = '' } = options;

    await expect(page.locator('#welcomeScreen')).toBeVisible();
    const signInButton = page.locator('#signInButton');
    await expect(signInButton).toBeVisible();
    await signInButton.click();

    if (lockPassword) {
        await unlockDevice(page, lockPassword);
    }

    if (expectedAccountUsernames.length > 1) {
        for (const accountUsername of expectedAccountUsernames) {
            await expect(signInAccountCard(page, accountUsername)).toBeVisible();
        }
        await signInAccountCard(page, username).click();
    }

    await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.app-name')).toHaveText(username);
}

// creates a unique username based on the browser name and current timestamp
function generateUsername(browserName) {
    const browserInitial = browserName[0];
    const timestamp = Date.now().toString().slice(-8);
    const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    return `${browserInitial}${timestamp}${rand}`; // Total: 1 + 8 + 6 = 15 characters
}

module.exports = {
    createAndSignInUser,
    generateUsername,
    createUser,
    signInWithAccountCard,
    unlockDevice
};
