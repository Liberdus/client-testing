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

async function setLock(page, password) {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });
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


test.describe('Backup and Restore Scenarios', () => {
    test.describe('Single Account Basic', () => {
        let username;
        let backupFilePath;
        test.beforeEach(async ({ browserName }) => { username = generateUsername(browserName); });

        test('backup & restore without password', async ({ page, browser }, testInfo) => {
            backupFilePath = testInfo.outputPath(path.join('backups', `${username}-no-password.json`));
            await createAndSignInUser(page, username);
            await backupAccount(page, backupFilePath);
            await page.context().close();
            const newContext = await browser.newContext();
            try {
                const newPage = await newContext.newPage();
                await newPage.goto('');
                await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                await expect(newPage.locator('#createAccountButton')).toBeVisible();
                await expect(newPage.locator('#importAccountButton')).toBeVisible();
                await expect(newPage.locator('#signInButton')).not.toBeVisible();
                await restoreAccount(newPage, backupFilePath);
                await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                await newPage.click('#signInButton');
                await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await expect(newPage.locator('.app-name')).toHaveText(username);
            } finally { await newContext.close(); }
        });

        test('backup & restore with password', async ({ page, browser }, testInfo) => {
            const password = 'supersecretpassword123';
            backupFilePath = testInfo.outputPath(path.join('backups', `${username}-with-password.json`));
            await createAndSignInUser(page, username);
            await backupAccount(page, backupFilePath, password);
            await page.context().close();
            const newContext = await browser.newContext();
            try {
                const newPage = await newContext.newPage();
                await newPage.goto('');
                await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                await expect(newPage.locator('#createAccountButton')).toBeVisible();
                await expect(newPage.locator('#importAccountButton')).toBeVisible();
                await expect(newPage.locator('#signInButton')).not.toBeVisible();
                await restoreAccount(newPage, backupFilePath, password);
                await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                await newPage.click('#signInButton');
                await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await expect(newPage.locator('.app-name')).toHaveText(username);
            } finally { await newContext.close(); }
        });

        test('password confirmation enable/disable logic', async ({ page }) => {
            await createAndSignInUser(page, username);
            await page.click('#toggleSettings');
            await expect(page.locator('#settingsModal')).toBeVisible();
            await page.click('#openBackupForm');
            await expect(page.locator('#backupModal')).toBeVisible();
            const submitButton = page.locator('#backupForm button[type="submit"]');
            await expect(submitButton).toBeEnabled();
            await page.fill('#backupPassword', 'password123');
            await expect(submitButton).toBeDisabled();
            await page.fill('#backupPasswordConfirm', 'differentPassword');
            await expect(submitButton).toBeDisabled();
            await page.fill('#backupPasswordConfirm', 'password123');
            await expect(submitButton).toBeEnabled();
            await page.fill('#backupPassword', '');
            await page.fill('#backupPasswordConfirm', '');
            await expect(submitButton).toBeEnabled();
        });
    });

    // -----------------------------
    // Multi-Account Scenarios
    // -----------------------------
    test.describe('Multi-Account', () => {
        [
            { name: 'with password', password: 'testpassword123' },
            { name: 'without password', password: '' }
        ].forEach(({ name, password }) => {
            test(`backup & restore multiple accounts ${name}`, async ({ page, browser, browserName }, testInfo) => {
                const backupFilePath = testInfo.outputPath(path.join('backups', `${name}.json`));
                const username1 = generateUsername(browserName);
                const username2 = generateUsername(browserName);
                await createAndSignInUser(page, username1);
                await createAndSignInUser(page, username2);
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
                const download = await downloadPromise; await download.saveAs(backupFilePath);
                await page.context().close();
                const newContext = await browser.newContext();
                try {
                    const newPage = await newContext.newPage();
                    await restoreAccount(newPage, backupFilePath, password);
                    await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                    await expect(newPage.locator('#signInButton')).toBeVisible();
                    await newPage.click('#signInButton');
                    const userDropdown = newPage.locator('#username');
                    await expect(userDropdown).toContainText(username1);
                    await expect(userDropdown).toContainText(username2);
                    await userDropdown.selectOption(username1);
                    await newPage.click('#signInForm button[type="submit"]');
                    await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                    await expect(newPage.locator('.app-name')).toHaveText(username1);
                } finally { await newContext.close(); }
            });
        });

        [
            { name: 'with password', password: 'backupallpassword123' },
            { name: 'without password', password: '' }
        ].forEach(({ name, password }) => {
            test(`backup all accounts from settings ${name}`, async ({ page, browser, browserName }, testInfo) => {
                const backupFilePath = testInfo.outputPath(path.join('backups', `settings-all-accounts-${name}.json`));
                const username1 = generateUsername(browserName);
                const username2 = generateUsername(browserName);
                await createAndSignInUser(page, username1);
                await createAndSignInUser(page, username2);
                await page.goto('');
                await expect(page.locator('#welcomeScreen')).toBeVisible();
                await page.click('#signInButton');
                const userDropdown = page.locator('#username');
                await userDropdown.selectOption(username1);
                await page.click('#signInForm button[type="submit"]');
                await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await page.click('#toggleSettings');
                await expect(page.locator('#settingsModal')).toBeVisible();
                await page.click('#openBackupForm');
                await expect(page.locator('#backupModal')).toBeVisible();
                await page.check('#backupAllAccounts');
                if (password) {
                    await page.fill('#backupPassword', password);
                    await page.fill('#backupPasswordConfirm', password);
                }
                const downloadPromise = page.waitForEvent('download');
                await page.click('#backupForm button[type="submit"]');
                const download = await downloadPromise; await download.saveAs(backupFilePath);
                await page.context().close();
                const newContext = await browser.newContext();
                try {
                    const newPage = await newContext.newPage();
                    await restoreAccount(newPage, backupFilePath, password);
                    await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                    await newPage.click('#signInButton');
                    const restoreUserDropdown = newPage.locator('#username');
                    await expect(restoreUserDropdown).toContainText(username1);
                    await expect(restoreUserDropdown).toContainText(username2);
                    await restoreUserDropdown.selectOption(username1);
                    await newPage.click('#signInForm button[type="submit"]');
                    await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                    await expect(newPage.locator('.app-name')).toHaveText(username1);
                    await newPage.goto('');
                    await expect(newPage.locator('#welcomeScreen')).toBeVisible();
                    await newPage.click('#signInButton');
                    await restoreUserDropdown.selectOption(username2);
                    await newPage.click('#signInForm button[type="submit"]');
                    await expect(newPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                    await expect(newPage.locator('.app-name')).toHaveText(username2);
                } finally { await newContext.close(); }
            });
        });
    });

    // -----------------------------
    // Security & Lock Scenarios
    // -----------------------------
    test.describe('Security & Lock', () => {
        test('locked backup requires lock password', async ({ page, browser, browserName }, testInfo) => {
            const username = generateUsername(browserName);
            const lockPassword = 'deviceLockPw1!';
            const backupFilePath = testInfo.outputPath(path.join('backups', `${username}-locked-backup.json`));
            await createAndSignInUser(page, username);
            await setLock(page, lockPassword);
            await page.click('#openBackupForm');
            await expect(page.locator('#backupModal')).toBeVisible();
            await page.click('#backupAllAccounts');
            const downloadPromise = page.waitForEvent('download');
            await page.click('#backupForm button[type="submit"]');
            const download = await downloadPromise; await download.saveAs(backupFilePath);
            await page.context().close();
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
                await expect(restorePage.locator('#welcomeScreen')).toBeVisible();
                await restorePage.click('#signInButton');
                await expect(restorePage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await expect(restorePage.locator('.app-name')).toHaveText(username);
            } finally { await restoreCtx.close(); }
        });

        test('re-encrypt imported accounts with new device lock', async ({ browser, browserName }, testInfo) => {
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
                const download = await downloadPromise; await download.saveAs(backupFilePath);
            } finally { await ctxA.close(); }
            const ctxB = await browser.newContext();
            const pageB = await ctxB.newPage();
            const existingUsername = generateUsername(browserName);
            const lockB = 'LockBPass!';
            try {
                await createAndSignInUser(pageB, existingUsername);
                await setLock(pageB, lockB);
                await pageB.click('#handleSignOutSettings');
                await expect(pageB.locator('#welcomeScreen')).toBeVisible();
                await pageB.click('#importAccountButton');
                await pageB.fill('#password', lockB);
                await pageB.click('#unlockForm button[type="submit"]');
                await expect(pageB.locator('#importModal')).toBeVisible();
                await pageB.waitForTimeout(1000);
                await pageB.setInputFiles('#importFile', backupFilePath);
                await pageB.fill('#backupAccountLock', lockA);
                pageB.on('dialog', dialog => dialog.accept());
                await pageB.click('#importForm button[type="submit"]');
                await expect(pageB.locator('#welcomeScreen')).toBeVisible();
                await pageB.click('#signInButton');
                await expect(pageB.locator('#unlockModal.active')).toBeVisible();
                await pageB.fill('#password', lockB);
                await pageB.click('#unlockForm button[type="submit"]');
                const dropdown = pageB.locator('#username');
                await expect(dropdown).toContainText(usernameA);
                await expect(dropdown).toContainText(existingUsername);
            } finally { await ctxB.close(); }
        });
    });

    // -----------------------------
    // Overwrite Behavior (Profile conflicts)
    // -----------------------------
    test.describe('Overwrite Behavior', () => {
        test('restore without overwrite keeps local profile changes', async ({ browser, browserName }, testInfo) => {
            const username = generateUsername(browserName);
            const originalName = 'Original Name';
            const modifiedName = 'Modified Name';
            const backupFilePath = testInfo.outputPath(path.join('backups', 'no-overwrite-profile.json'));
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            try {
                await createAndSignInUser(page, username);
                await updateProfileName(page, originalName);
                await page.goto('');
                await page.click('#openBackupModalButton');
                await expect(page.locator('#backupModal')).toBeVisible();
                const dl1 = page.waitForEvent('download');
                await page.click('#backupForm button[type="submit"]');
                const download = await dl1; await download.saveAs(backupFilePath);
                await page.click('#signInButton');
                await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await updateProfileName(page, modifiedName);
                await page.click('#toggleSettings');
                await page.click('#handleSignOutSettings');
                await expect(page.locator('#welcomeScreen')).toBeVisible();
                await page.click('#importAccountButton');
                await page.setInputFiles('#importFile', backupFilePath);
                page.on('dialog', dialog => dialog.accept());
                await page.click('#importForm button[type="submit"]');
                await expect(page.locator('#welcomeScreen')).toBeVisible();
                await page.click('#signInButton');
                await expect(page.locator('#chatsScreen.active')).toBeVisible();
                const current = await getProfileName(page); expect(current).toBe(modifiedName);
            } finally { await ctx.close(); }
        });

        test('overwrite conflicting profile data reverts to backup', async ({ browser, browserName }, testInfo) => {
            const username = generateUsername(browserName);
            const originalName = 'Original Namerevert';
            const modifiedName = 'Locally Changedname';
            const backupFilePath = testInfo.outputPath(path.join('backups', 'with-overwrite-profile.json'));
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            try {
                await createAndSignInUser(page, username);
                await updateProfileName(page, originalName);
                await page.goto('');
                await page.click('#openBackupModalButton');
                await expect(page.locator('#backupModal')).toBeVisible();
                const dl1 = page.waitForEvent('download');
                await page.click('#backupForm button[type="submit"]');
                const download = await dl1; await download.saveAs(backupFilePath);
                await page.click('#signInButton');
                await expect(page.locator('#chatsScreen.active')).toBeVisible({ timeout: 15_000 });
                await updateProfileName(page, modifiedName);
                await page.click('#toggleSettings');
                await page.click('#handleSignOutSettings');
                await expect(page.locator('#welcomeScreen')).toBeVisible();
                await page.click('#importAccountButton');
                await page.setInputFiles('#importFile', backupFilePath);
                await page.check('#overwriteAccountsCheckbox');
                page.on('dialog', dialog => dialog.accept());
                await page.click('#importForm button[type="submit"]');
                await expect(page.locator('#welcomeScreen')).toBeVisible();
                await page.click('#signInButton');
                await expect(page.locator('#chatsScreen.active')).toBeVisible();
                const current = await getProfileName(page); expect(current).toBe(originalName);
            } finally { await ctx.close(); }
        });
    });
});