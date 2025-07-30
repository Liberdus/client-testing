const { test, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const path = require('path');

async function backupAccount(page, backupFilePath, password = '') {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openExportForm');
    await expect(page.locator('#exportModal')).toBeVisible();

    if (password) {
        await page.fill('#exportPassword', password);
    }

    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportForm button[type="submit"]');
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
        await expect(page.locator('#exportModal')).toBeVisible();
        if (password) {
            await page.fill('#exportPassword', password);
        }
        const downloadPromise = page.waitForEvent('download');
        await page.click('#exportForm button[type="submit"]');
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
})