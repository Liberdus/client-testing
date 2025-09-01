const { test, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const path = require('path');

async function backupAccount(page, backupFilePath, password = '') {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openBackupForm');
    await expect(page.locator('#backupModal')).toBeVisible();

    if (password) {
        await page.fill('#backupPassword', password);
        await page.fill('#backupPasswordConfirm', password);
    }

    const downloadPromise = page.waitForEvent('download');
    await page.click('#backupForm button[type="submit"]');
    const download = await downloadPromise;
    await download.saveAs(backupFilePath);
}

async function restoreAccount(page, backupFilePath, password = '') {
    await page.goto('');
    await expect(page.locator('#welcomeScreen')).toBeVisible();
    await page.click('#importAccountButton');
    await expect(page.locator('#importModal')).toBeVisible();

    await page.setInputFiles('#importFile', backupFilePath);

    if (password) {
        await page.fill('#importPassword', password);
    }
    await page.on('dialog', async dialog => {
        await dialog.accept();
    });
    await page.click('#importForm button[type="submit"]');
}

// New helpers for lock & sign out to support additional tests
async function setLock(page, password) {
    // Opens lock modal from settings and sets a device lock password
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    // If change / remove buttons exist we always perform a fresh set (simple path)
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });
}

async function signOut(page) {
    // Uses settings sign out button (aligns with other tests) then waits for welcome screen
    await page.click('#handleSignOutSettings');
    await expect(page.locator('#welcomeScreen')).toBeVisible();
}

// Profile helpers
async function openProfileModal(page) {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openAccountForm');
    await expect(page.locator('#accountModal.active')).toBeVisible();
}

async function updateProfileName(page, newName) {
    await openProfileModal(page);
    await page.fill('#name', newName);
    await page.click('#accountForm button[type="submit"]');
    // wait for toast
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#closeSettings');
}

async function getProfileName(page) {
    await openProfileModal(page);
    const value = await page.inputValue('#name');
    await page.click('#closeAccountForm');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#closeSettings');
    return value.trim();
}

test.describe('Account Backup and Restore', () => {
    let username;
    let backupFilePath;

    test.beforeEach(async ({ browserName }) => {
        username = generateUsername(browserName);
    });

    test('should backup and restore an account without a password', async ({ page, browser }, testInfo) => {
        backupFilePath = testInfo.outputPath(path.join('backups', `${username}-no-password.json`));

        // Create user and backup account
        await createAndSignInUser(page, username);
        await backupAccount(page, backupFilePath);
        await page.context().close();

        // Restore in a new context
        const newContext = await browser.newContext();
        try {
            const newPage = await newContext.newPage();
            await newPage.goto('');
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            // expect create account and restore account buttons to be visible but not sign in button
            await expect(newPage.locator('#createAccountButton')).toBeVisible();
            await expect(newPage.locator('#importAccountButton')).toBeVisible();
            await expect(newPage.locator('#signInButton')).not.toBeVisible();
            await restoreAccount(newPage, backupFilePath);

            // Sign in to the restored account
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            await newPage.click('#signInButton');

            await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(newPage.locator('.app-name')).toHaveText(username);
        } finally {
            await newContext.close();
        }
    });

    test('should backup and restore an account with a password', async ({ page, browser }, testInfo) => {
        const password = 'supersecretpassword123';
        backupFilePath = testInfo.outputPath(path.join('backups', `${username}-with-password.json`));

        // Create user and backup account with password
        await createAndSignInUser(page, username);
        await backupAccount(page, backupFilePath, password);
        await page.context().close();

        // Restore in a new context
        const newContext = await browser.newContext();
        try {
            const newPage = await newContext.newPage();
            await newPage.goto('');
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            // expect create account and restore account buttons to be visible but not sign in button
            await expect(newPage.locator('#createAccountButton')).toBeVisible();
            await expect(newPage.locator('#importAccountButton')).toBeVisible();
            await expect(newPage.locator('#signInButton')).not.toBeVisible();


            await restoreAccount(newPage, backupFilePath, password);

            // Sign in to the restored account
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            await newPage.click('#signInButton');

            // Verify restoration
            await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(newPage.locator('.app-name')).toHaveText(username);
        } finally {
            await newContext.close();
        }
    });

    test('should require matching password confirmation before enabling backup submit button', async ({ page }) => {
        // Create and sign in user
        await createAndSignInUser(page, username);

        // Navigate to backup modal
        await page.click('#toggleSettings');
        await expect(page.locator('#settingsModal')).toBeVisible();
        await page.click('#openBackupForm');
        await expect(page.locator('#backupModal')).toBeVisible();

        // Submit button should be enabled initially (for no password case)
        const submitButton = page.locator('#backupForm button[type="submit"]');
        await expect(submitButton).toBeEnabled();

        // Enter password without confirmation - button should be disabled
        await page.fill('#backupPassword', 'password123');
        await expect(submitButton).toBeDisabled();

        // Enter different confirmation - button should remain disabled
        await page.fill('#backupPasswordConfirm', 'differentPassword');
        await expect(submitButton).toBeDisabled();

        // Enter matching confirmation - button should be enabled
        await page.fill('#backupPasswordConfirm', 'password123');
        await expect(submitButton).toBeEnabled();

        // Clear both fields - button should be enabled (for no password case)
        await page.fill('#backupPassword', '');
        await page.fill('#backupPasswordConfirm', '');
        await expect(submitButton).toBeEnabled();
    });
});

// -------------------------------------------------------------
// New scenarios for welcome-screen restore with overwrite/lock
// -------------------------------------------------------------

test.describe('Welcome Screen Restore - New Behavior', () => {
    test('should require backup account lock password when restoring locked backup', async ({ page, browser, browserName }, testInfo) => {
        const username = generateUsername(browserName);
        const lockPassword = 'deviceLockPw1!';
        const backupFilePath = testInfo.outputPath(path.join('backups', `${username}-locked-backup.json`));

        // Create user & set device lock, then backup (no explicit backup password)
        await createAndSignInUser(page, username);
        await setLock(page, lockPassword);
        await page.click('#openBackupForm');
        await expect(page.locator('#backupModal')).toBeVisible();
        await page.click('#backupAllAccounts');
        const downloadPromise = page.waitForEvent('download');
        await page.click('#backupForm button[type="submit"]');
        const download = await downloadPromise;
        await download.saveAs(backupFilePath);
        await page.context().close();

        // Restore in a new context
        const restoreCtx = await browser.newContext();
        try {
            const restorePage = await restoreCtx.newPage();
            await restorePage.goto('');
            await expect(restorePage.locator('#welcomeScreen')).toBeVisible();
            await restorePage.click('#importAccountButton');
            await expect(restorePage.locator('#importModal')).toBeVisible();
            await restorePage.setInputFiles('#importFile', backupFilePath);

            await restorePage.fill('#backupAccountLock', lockPassword);
            restorePage.on('dialog', dialog => dialog.accept());
            await restorePage.click('#importForm button[type="submit"]');

            // After restore expect to remain on welcome screen and be able to sign in
            await expect(restorePage.locator('#welcomeScreen')).toBeVisible();
            await restorePage.click('#signInButton');
            await expect(restorePage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(restorePage.locator('.app-name')).toHaveText(username);
        } finally {
            await restoreCtx.close();
        }
    });

    test('should re-encrypt imported accounts with new device lock password', async ({ browser, browserName }, testInfo) => {
        // Device A: create locked backup
        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const usernameA = generateUsername(browserName);
        const lockA = 'LockAPass!';
        const backupFilePath = testInfo.outputPath(path.join('backups', `${usernameA}-reencrypt.json`));
        try {
            await createAndSignInUser(pageA, usernameA);
            await setLock(pageA, lockA);
            await pageA.click('#openBackupForm');
            await expect(pageA.locator('#backupModal')).toBeVisible();
            await pageA.click('#backupAllAccounts');
            const downloadPromise = pageA.waitForEvent('download');
            await pageA.click('#backupForm button[type="submit"]');
            const download = await downloadPromise;
            await download.saveAs(backupFilePath);
        } finally {
            await ctxA.close();
        }

        // Device B: create existing account & its own lock, then restore backup from A
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        const existingUsername = generateUsername(browserName);
        const lockB = 'LockBPass!';
        try {
            await createAndSignInUser(pageB, existingUsername);
            await setLock(pageB, lockB);
            await pageB.click('#handleSignOutSettings');
            await expect(pageB.locator('#welcomeScreen')).toBeVisible();

            // Start restore
            await pageB.click('#importAccountButton');
            await pageB.fill('#password', lockB);
            await pageB.click('#unlockForm button[type="submit"]');
            await expect(pageB.locator('#importModal')).toBeVisible();
            // wait 1 second
            await pageB.waitForTimeout(1000);
            await pageB.setInputFiles('#importFile', backupFilePath);
            await pageB.fill('#backupAccountLock', lockA); // provide original backup lock
            pageB.on('dialog', dialog => dialog.accept());
            await pageB.click('#importForm button[type="submit"]');
            await expect(pageB.locator('#welcomeScreen')).toBeVisible();

            // Attempt unlock with old password (should fail)
            await pageB.click('#signInButton');
            await expect(pageB.locator('#unlockModal.active')).toBeVisible();

            // Unlock with new device password
            await pageB.fill('#password', lockB);
            await pageB.click('#unlockForm button[type="submit"]')

            // verify imported account present in dropdown (union of accounts)
            const dropdown = pageB.locator('#username');
            await expect(dropdown).toContainText(usernameA);
            await expect(dropdown).toContainText(existingUsername);
        } finally {
            await ctxB.close();
        }
    });

    test('should restore without overwrite keeping local profile changes (name unchanged)', async ({ browser, browserName }, testInfo) => {
        const username = generateUsername(browserName);
        const originalName = 'Original Name';
        const modifiedName = 'Modified Name';
        const backupFilePath = testInfo.outputPath(path.join('backups', 'no-overwrite-profile.json'));

        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await createAndSignInUser(page, username);
            // Set original profile name
            await updateProfileName(page, originalName);

            // Backup current state (go to welcome first)
            await page.goto('');
            await page.click('#openBackupModalButton');
            await expect(page.locator('#backupModal')).toBeVisible();
            const dl1 = page.waitForEvent('download');
            await page.click('#backupForm button[type="submit"]');
            const download = await dl1; await download.saveAs(backupFilePath);

            // Modify profile locally
            await page.click('#signInButton');
            await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await updateProfileName(page, modifiedName);

            // sign out
            await page.click('#toggleSettings');
            await page.click('#handleSignOutSettings');
            await expect(page.locator('#welcomeScreen')).toBeVisible();

            // Restore WITHOUT overwrite
            await page.click('#importAccountButton');
            await page.setInputFiles('#importFile', backupFilePath);
            page.on('dialog', dialog => dialog.accept());
            await page.click('#importForm button[type="submit"]');
            await expect(page.locator('#welcomeScreen')).toBeVisible();

            // Sign in & verify name stayed modified (local change preserved)
            await page.click('#signInButton');
            await expect(page.locator('#chatsScreen.active')).toBeVisible();
            const current = await getProfileName(page);
            expect(current).toBe(modifiedName);
        } finally { await ctx.close(); }
    });

    test('should overwrite conflicting profile data when checkbox checked (name reverted to backup)', async ({ browser, browserName }, testInfo) => {
        const username = generateUsername(browserName);
        const originalName = 'Original Namerevert';
        const modifiedName = 'Locally Changedname';
        const backupFilePath = testInfo.outputPath(path.join('backups', 'with-overwrite-profile.json'));

        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await createAndSignInUser(page, username);
            await updateProfileName(page, originalName);

            // Backup state
            await page.goto('');
            await page.click('#openBackupModalButton');
            await expect(page.locator('#backupModal')).toBeVisible();
            const dl1 = page.waitForEvent('download');
            await page.click('#backupForm button[type="submit"]');
            const download = await dl1; await download.saveAs(backupFilePath);

            // Modify profile locally
            await page.click('#signInButton');
            await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await updateProfileName(page, modifiedName);
            
            // sign out
            await page.click('#toggleSettings');
            await page.click('#handleSignOutSettings');
            await expect(page.locator('#welcomeScreen')).toBeVisible();

            // Restore WITH overwrite
            await page.click('#importAccountButton');
            await page.setInputFiles('#importFile', backupFilePath);
            await page.check('#overwriteAccountsCheckbox');
            page.on('dialog', dialog => dialog.accept());
            await page.click('#importForm button[type="submit"]');
            await expect(page.locator('#welcomeScreen')).toBeVisible();

            // Sign in & verify name reverted to original from backup
            await page.click('#signInButton');
            await expect(page.locator('#chatsScreen.active')).toBeVisible();
            const current = await getProfileName(page);
            expect(current).toBe(originalName);
        } finally { await ctx.close(); }
    });
});

[
    { name: 'with password', password: 'testpassword123' },
    { name: 'without password', password: '' }
].forEach(({ name, password }) => {
    test(`should backup and restore multiple accounts ${name}`, async ({ page, browser, browserName }, testInfo) => {
        const backupFilePath = testInfo.outputPath(path.join('backups', `${name}.json`));
        const username1 = generateUsername(browserName);
        const username2 = generateUsername(browserName);
        // Create first user
        await createAndSignInUser(page, username1);

        // Create second user
        await createAndSignInUser(page, username2);

        // Backup all accounts from welcome screen
        await page.goto('');
        await expect(page.locator('#welcomeScreen')).toBeVisible();
        await page.click('#openBackupModalButton');
        await expect(page.locator('#backupModal')).toBeVisible();
        if (password) {
            await page.fill('#backupPassword', password);
            await page.fill('#backupPasswordConfirm', password);
        }
        const downloadPromise = page.waitForEvent('download');
        await page.click('#backupForm button[type="submit"]');
        const download = await downloadPromise;
        await download.saveAs(backupFilePath);
        await page.context().close();

        // Restore in a new context
        const newContext = await browser.newContext();
        try {
            const newPage = await newContext.newPage();
            await restoreAccount(newPage, backupFilePath, password);

            // After restoring, expect to be on the welcome screen with a sign-in button
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            await expect(newPage.locator('#signInButton')).toBeVisible();

            // Click sign in and verify both accounts are in the dropdown
            await newPage.click('#signInButton');
            const userDropdown = newPage.locator('#username');
            await expect(userDropdown).toContainText(username1);
            await expect(userDropdown).toContainText(username2);

            // Sign in as first user and verify
            await userDropdown.selectOption(username1);
            await newPage.click('#signInForm button[type="submit"]');
            await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(newPage.locator('.app-name')).toHaveText(username1);
        } finally {
            await newContext.close();
        }
    });
});

[
    { name: 'with password', password: 'backupallpassword123' },
    { name: 'without password', password: '' }
].forEach(({ name, password }) => {
    test(`should backup all accounts from settings using the checkbox ${name}`, async ({ page, browser, browserName }, testInfo) => {
        const backupFilePath = testInfo.outputPath(path.join('backups', `settings-all-accounts-${name}.json`));
        const username1 = generateUsername(browserName);
        const username2 = generateUsername(browserName);
        
        // Create first user
        await createAndSignInUser(page, username1);

        // Create second user
        await createAndSignInUser(page, username2);

        // Sign in as the first user
        await page.goto('');
        await expect(page.locator('#welcomeScreen')).toBeVisible();
        await page.click('#signInButton');
        const userDropdown = page.locator('#username');
        await userDropdown.selectOption(username1);
        await page.click('#signInForm button[type="submit"]');
        await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
        
        // Open settings and backup modal
        await page.click('#toggleSettings');
        await expect(page.locator('#settingsModal')).toBeVisible();
        await page.click('#openBackupForm');
        await expect(page.locator('#backupModal')).toBeVisible();
        
        // Check the backup all accounts checkbox
        await page.check('#backupAllAccounts');
        
        // Set password for encryption if provided
        if (password) {
            await page.fill('#backupPassword', password);
            await page.fill('#backupPasswordConfirm', password);
        }
        
        // Backup all accounts
        const downloadPromise = page.waitForEvent('download');
        await page.click('#backupForm button[type="submit"]');
        const download = await downloadPromise;
        await download.saveAs(backupFilePath);
        await page.context().close();

        // Restore in a new context
        const newContext = await browser.newContext();
        try {
            const newPage = await newContext.newPage();
            await restoreAccount(newPage, backupFilePath, password);

            // After restoring, expect to be on the welcome screen with a sign-in button
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            await expect(newPage.locator('#signInButton')).toBeVisible();

            // Click sign in and verify both accounts are in the dropdown
            await newPage.click('#signInButton');
            const restoreUserDropdown = newPage.locator('#username');
            await expect(restoreUserDropdown).toContainText(username1);
            await expect(restoreUserDropdown).toContainText(username2);

            // Sign in as first user and verify
            await restoreUserDropdown.selectOption(username1);
            await newPage.click('#signInForm button[type="submit"]');
            await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(newPage.locator('.app-name')).toHaveText(username1);
            
            // Go back to welcome screen and sign in as second user
            await newPage.goto('');
            await expect(newPage.locator('#welcomeScreen')).toBeVisible();
            await newPage.click('#signInButton');
            await restoreUserDropdown.selectOption(username2);
            await newPage.click('#signInForm button[type="submit"]');
            await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
            await expect(newPage.locator('.app-name')).toHaveText(username2);
        } finally {
            await newContext.close();
        }
    });
});