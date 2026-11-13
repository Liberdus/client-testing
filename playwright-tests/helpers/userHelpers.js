const { expect } = require("@playwright/test");

const SIGN_IN_AFTER_REGISTRATION_TIMEOUT = 90_000;

async function waitForWelcomeScreen(page) {
    // A fresh profile can reload for a version update before revealing the welcome screen.
    await expect(page.locator('#welcomeScreen:not(.is-booting)')).toBeVisible({ timeout: 30_000 });
}

async function createUser(page, username) {
    await page.goto('', { waitUntil: 'domcontentloaded' });
    await waitForWelcomeScreen(page);
    await page.locator('#welcomeScreen #createAccountButton').click();
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

    let outcome;
    try {
        const result = await page.waitForFunction(expectedUsername => {
            const chats = document.querySelector('#chatsScreen.active');
            const name = document.querySelector('#header .app-name');
            if (chats?.getClientRects().length && getComputedStyle(chats).visibility === 'visible' &&
                name?.getClientRects().length && getComputedStyle(name).visibility === 'visible' &&
                name.textContent.trim() === expectedUsername) {
                return 'signed-in';
            }

            const setupError = /^(account creation failed|error injecting transaction|failed to fetch network parameters, try again later|unable to sign in right now)/i;
            for (const toast of document.querySelectorAll('.toast.error.show')) {
                const match = toast.textContent.trim().match(setupError);
                if (match) return match[0];
            }
            return null;
        }, username, { timeout: SIGN_IN_AFTER_REGISTRATION_TIMEOUT });
        outcome = await result.jsonValue();
    } catch (cause) {
        const creating = await page.locator('.toast.loading.show')
            .filter({ hasText: /^Creating account\.{3}$/ }).isVisible().catch(() => false);
        const state = creating ? ' The app still shows "Creating account...".' : '';
        const deadline = cause.name === 'TimeoutError' ? ` within ${SIGN_IN_AFTER_REGISTRATION_TIMEOUT / 1000}s` : '';
        throw new Error(`Failed to sign in as ${username}${deadline} after submitting account registration.${state}`, { cause });
    }

    if (outcome !== 'signed-in') {
        throw new Error(`Account setup failed for ${username}. The app reported "${outcome}".`);
    }
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

    await waitForWelcomeScreen(page);
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
    unlockDevice,
    waitForWelcomeScreen
};
