const { test, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const path = require('path');

async function backupAccount(page, backupFilePath, password = '') {
    await page.click('#toggleMenu');
    await expect(page.locator('#menuModal')).toBeVisible();
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
