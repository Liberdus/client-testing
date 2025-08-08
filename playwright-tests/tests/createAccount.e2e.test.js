// create-account-privatekey.e2e.test.js
const { test, expect } = require('@playwright/test');
const { generateUsername } = require('../helpers/userHelpers');
const { ethers } = require('ethers');

test.describe('Account creation with a private key', () => {
  test('should create account with a custom private key', async ({ page, browserName }) => {    
    // Generate a test private key using ethers
    const wallet = ethers.Wallet.createRandom();
    const privateKey = wallet.privateKey;
    const address = wallet.address;
    
    // Generate a unique username for this test
    const username = generateUsername(browserName);
    
    // Navigate to welcome screen
    await page.goto('', { waitUntil: 'networkidle' });
    await expect(page.locator('#welcomeScreen')).toBeVisible();
    
    // Open create account modal
    await expect(page.locator('#createAccountButton')).toBeVisible();
    await page.click('#createAccountButton');
    await expect(page.locator('#createAccountModal')).toBeVisible();
    
    // Enter username
    await page.locator('#newUsername').pressSequentially(username);
    await expect(page.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    
    // Open advanced options
    await page.locator('#toggleMoreOptions').click();
    await expect(page.locator('#togglePrivateKeyInput')).toBeVisible();
    
    // Enable private key input field
    await page.locator('#togglePrivateKeyInput').click();
    await expect(page.locator('#newPrivateKey')).toBeVisible();
    
    // Enter the generated private key
    await page.locator('#newPrivateKey').fill(privateKey);
    
    // Submit the form
    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    
    // Wait for account creation to complete
    await expect(page.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    await page.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    
    // Verify the username is displayed
    const appName = await page.locator('.app-name').textContent();
    await expect(appName.trim()).toBe(username);
    
    // Verify wallet address by opening My Info modal
    await page.click('.app-name');
    await expect(page.locator('#myInfoModal')).toBeVisible();
    
    // Get displayed wallet address from My Info modal and verify it matches our generated one
    const displayedAddress = await page.locator('#myInfoDisplayUsername').textContent();
    // Remove '0x' prefix from the generated address since it's not displayed in the UI
    const addressWithoutPrefix = address.slice(2).toLowerCase();
    expect(displayedAddress.toLowerCase()).toContain(addressWithoutPrefix);
  });
  
  test('should validate private key format', async ({ page, browserName }) => {
    // Generate a unique username for this test
    const username = generateUsername(browserName);
    
    // Navigate to welcome screen
    await page.goto('', { waitUntil: 'networkidle' });
    await expect(page.locator('#welcomeScreen')).toBeVisible();
    
    // Open create account modal
    await expect(page.locator('#createAccountButton')).toBeVisible();
    await page.click('#createAccountButton');
    await expect(page.locator('#createAccountModal')).toBeVisible();
    
    // Enter username
    await page.locator('#newUsername').pressSequentially(username);
    await expect(page.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    
    // Open advanced options
    await page.locator('#toggleMoreOptions').click();
    await expect(page.locator('#togglePrivateKeyInput')).toBeVisible();
    
    // Enable private key input field
    await page.locator('#togglePrivateKeyInput').click();
    await expect(page.locator('#newPrivateKey')).toBeVisible();
    
    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    
    // Test case 1: Invalid length error
    await page.locator('#newPrivateKey').fill('0x1234');
    await createBtn.click();
    await expect(page.locator('#newPrivateKeyError')).toBeVisible();
    await expect(page.locator('#newPrivateKeyError')).toContainText('Invalid length');
    
    // Test case 2: Invalid characters error
    await page.locator('#newPrivateKey').fill('0x' + 'g'.repeat(64));
    await createBtn.click();
    await expect(page.locator('#newPrivateKeyError')).toBeVisible();
    await expect(page.locator('#newPrivateKeyError')).toContainText('Invalid characters');

  });
});
