const { test, expect } = require('@playwright/test');
const { generateUsername, createAndSignInUser } = require('../helpers/userHelpers');


test('Lock and Unlock Account', async ({ browser, browserName}) => {
    // 1 create a user
    const username = generateUsername(browserName);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await createAndSignInUser(page, username);

    // 2 lock the account
    await page.click('#toggleMenu');
    await expect(page.locator('#menuModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    const password = 'password';
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });

    // 3 sign out
    await page.click('#handleSignOut');
    await expect(page.locator('#welcomeScreen')).toBeVisible();

    // 4 sign in with the locked account
    await page.click('#signInButton');
    await expect(page.locator('#unlockModal')).toBeVisible();
    await page.fill('#password', password);
    await page.click('#unlockForm button[type="submit"]');
    await expect(page.locator('#header .app-name')).toHaveText(username);
});

test('Should not unlock with wrong password', async ({ browser, browserName}) => {
    // 1 create a user
    const username = generateUsername(browserName);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await createAndSignInUser(page, username);

    // 2 lock the account
    await page.click('#toggleMenu');
    await expect(page.locator('#menuModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    const password = 'password';
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });

    // 3 sign out
    await page.click('#handleSignOut');
    await expect(page.locator('#welcomeScreen')).toBeVisible();

    // 4 attempt to sign with wrong password
    await page.click('#signInButton');
    await expect(page.locator('#unlockModal')).toBeVisible();
    await page.fill('#password', password + 'wrong');
    await page.click('#unlockForm button[type="submit"]');
    await expect(page.locator('.toast.error.show', { hasText: /invalid password/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unlockModal.active')).toBeVisible();
});

test('Change Lock Password', async ({ browser, browserName}) => {
    // 1 create a user
    const username = generateUsername(browserName);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await createAndSignInUser(page, username);

    // 2 lock the account
    await page.click('#toggleMenu');
    await expect(page.locator('#menuModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    const password = 'password';
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });

    // 3 change the password
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    const newPassword = 'newPassword';
    await page.fill('#oldPassword', password);
    await page.fill('#newPassword', newPassword);
    await page.fill('#confirmNewPassword', newPassword);
    await page.click('#lockForm button[type="submit"]');

    // 4 sign out
    await page.click('#handleSignOut');
    await expect(page.locator('#welcomeScreen')).toBeVisible();

    // 5 sign in with the new password
    await page.click('#signInButton');
    await expect(page.locator('#unlockModal')).toBeVisible();
    await page.fill('#password', newPassword);
    await page.click('#unlockForm button[type="submit"]');
    await expect(page.locator('#header .app-name')).toHaveText(username);
});

test('Remove Lock', async ({ browser, browserName}) => {
    // 1 create a user
    const username = generateUsername(browserName);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await createAndSignInUser(page, username);

    // 2 lock the account
    await page.click('#toggleMenu');
    await expect(page.locator('#menuModal')).toBeVisible();
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    const password = 'password';
    await page.fill('#newPassword', password);
    await page.fill('#confirmNewPassword', password);
    await page.click('#lockForm button[type="submit"]');
    await expect(page.locator('.toast.success.show')).toBeVisible({ timeout: 15_000 });

    // 3 sign out
    await page.click('#handleSignOut');
    await expect(page.locator('#welcomeScreen')).toBeVisible();

    // 4 sign in with the locked account
    await page.click('#signInButton');
    await expect(page.locator('#unlockModal')).toBeVisible();
    await page.fill('#password', password);
    await page.click('#unlockForm button[type="submit"]');
    await expect(page.locator('#header .app-name')).toHaveText(username);

    // 5 remove the password
    await page.click('#toggleMenu');
    await page.click('#openLockModal');
    await expect(page.locator('#lockModal')).toBeVisible();
    await page.fill('#oldPassword', password);
    await expect(page.locator('#lockForm button[type="submit"]')).toHaveText('Remove Password');
    await page.click('#lockForm button[type="submit"]');

    // 6 sign out
    await page.click('#handleSignOut');
    await expect(page.locator('#welcomeScreen')).toBeVisible();

    // 7 sign in without a password
    await page.click('#signInButton');
    await expect(page.locator('#header .app-name')).toHaveText(username);
});