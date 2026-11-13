const { test: base, expect } = require('../fixtures/base');
const {
    generateUsername,
    createAndSignInUser,
    signInWithAccountCard,
    unlockDevice,
    waitForLockUpdate
} = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');

async function lockAccount(page, password) {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await waitForLockUpdate(page, 'Password updated');
}

async function signOut(page) {
    await page.click('#handleSignOutSettings');
    await expect(page.locator('#welcomeScreen')).toBeVisible();
}

// Create a test fixture for a locked user account
const test = base.extend({
    lockedUser: async ({ browser, browserName }, use) => {
        // Create browser context
        const ctx = await newContext(browser);
        const page = await ctx.newPage();
        const username = generateUsername(browserName);
        const password = 'password';
        
        try {
            // Create and sign in the user
            await createAndSignInUser(page, username);
            
            // Lock the account
            await lockAccount(page, password);
            
            // Provide the fixture data
            await use({ page, ctx, username, password });
        } finally {
            await ctx.close();
        }
    }
});

test('Lock and Unlock Account', async ({ browser, browserName}) => {
    // 1 create a user
    const username = generateUsername(browserName);
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const password = 'password';
    
    try {
        await createAndSignInUser(page, username);

        // 2 lock the account
        await lockAccount(page, password);

        // 3 sign out
        await signOut(page);

        // 4 sign in with the locked account
        await signInWithAccountCard(page, username, { lockPassword: password });
    } finally {
        await ctx.close();
    }
});

test('Should not unlock with wrong password', async ({ lockedUser }) => {
    const { page, password } = lockedUser;
    
    // Sign out
    await signOut(page);

    // Attempt to sign in with wrong password
    await page.click('#signInButton');
    await expect(page.locator('#unlockModal')).toBeVisible();
    await page.fill('#password', password + 'wrong');
    await page.click('#unlockForm button[type="submit"]');
    await expect(page.locator('.toast.error.show', { hasText: /invalid password/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unlockModal.active')).toBeVisible();
});

test('Change Lock Password', async ({ lockedUser }) => {
    const { page, username, password } = lockedUser;

    // 3 change the password
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    await page.click('#changePasswordButton');
    const newPassword = 'newPassword';
    await page.fill('#oldPassword', password);
    await page.fill('#newPassword', newPassword);
    await page.fill('#confirmNewPassword', newPassword);
    await page.click('#lockForm button[type="submit"]');
    await waitForLockUpdate(page, 'Password updated');

    // 4 sign out
    await signOut(page);

    // 5 sign in with the new password
    await signInWithAccountCard(page, username, { lockPassword: newPassword });
});

test('Remove Lock', async ({ lockedUser }) => {
    const { page, username, password } = lockedUser;

    // 3 sign out
    await signOut(page);

    // 4 sign in with the locked account
    await signInWithAccountCard(page, username, { lockPassword: password });

    // 5 remove the password
    await page.click('#toggleSettings');
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    await page.click('#removeLockButton');
    await page.fill('#oldPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await waitForLockUpdate(page, 'Password removed');

    // 6 sign out
    await signOut(page);

    // 7 sign in without a password
    await signInWithAccountCard(page, username);
});

test('Should require unlock before creating new account when locked', async ({ lockedUser }) => {
    const { page, password } = lockedUser;
    
    // Sign out to get to welcome screen
    await signOut(page);
    
    // Attempt to create new account
    await page.click('#createAccountButton');
    
    // The app prompts for the device password before creating an account.
    await unlockDevice(page, password);
    
    // After unlock, create account modal should appear
    await expect(page.locator('#createAccountModal.active')).toBeVisible({ timeout: 5000 });
});

test('Should require unlock before restoring account when locked', async ({ lockedUser }) => {
    const { page, password } = lockedUser;
    
    // Sign out to get to welcome screen
    await signOut(page);
    
    // Attempt to restore account
    await page.click('#openWelcomeMenu');
    
    // The app prompts for the device password before opening the welcome menu.
    await unlockDevice(page, password);
    
    await page.click('#welcomeOpenRestore');
    await expect(page.locator('#importModal.active')).toBeVisible({ timeout: 5000 });
});
