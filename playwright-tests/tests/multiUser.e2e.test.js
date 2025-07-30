// liberdus.e2e.spec.js

const { test, expect } = require('@playwright/test');
const { createAndSignInUser } = require('../helpers/userHelpers');
const { getLiberdusBalance } = require('../helpers/walletHelpers');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { generateUsername } = require('../helpers/userHelpers');

// ─────── Logging utility ────────────────────────────────────────
const log = (msg) => console.log(`[E2E TEST] ${msg}`);

// Constants
const NETWORK_FEE = 0.1; // Default network fee for transactions
const NETWORK_TOLL_TAX = 0.01; // 1% network fee on tolls

test.describe('Multi User Tests', () => {

  test('should allow two users to message each other', async ({browserName, browser}) => {
    log('Test: Two-user messaging scenario');

    const user1 = generateUsername(browserName);
    const user2 = generateUsername(browserName);
    const msg1 = 'Hello from user1!';
    const msg2 = 'Hello from user2!';

    // Create two isolated contexts
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const pg1  = await ctx1.newPage();
    const pg2  = await ctx2.newPage();
    try {
      // Create users
      await Promise.all([
          createAndSignInUser(pg1, user1),
          createAndSignInUser(pg2, user2)
      ]);

      // User2 ➜ User1
      await sendMessageTo(pg2, user1, msg2);
      await checkReceivedMessage(pg1, user2, msg2);

      // User1 ➜ User2
      await sendMessageTo(pg1, user2, msg1);
      await checkReceivedMessage(pg2, user1, msg1);
    } finally {
      await ctx1.close();
      await ctx2.close();
      log('Two-user messaging test completed.');
    }
  });

  test('should receive toll on read and on reply', async ({browserName, browser}) => {
    log('Test: Wallet toll increases on message receipt');
    const user1 = generateUsername(browserName);
    const user2 = generateUsername(browserName);
    const msg2 = 'Hello with toll!';
    const toll = 3; // Set toll amount

    // Create two isolated contexts
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const pg1  = await ctx1.newPage();
    const pg2  = await ctx2.newPage();

    try{
      // User 1 signup
      await pg1.goto("", { waitUntil: 'networkidle' });
      await createAndSignInUser(pg1, user1);

      // User 2 signup
      await pg2.goto("", { waitUntil: 'networkidle' });
      await createAndSignInUser(pg2, user2);

      // Wait a bit so backend knows both users
      await pg1.waitForTimeout(5_000);

      // User 1 set toll
      await pg1.click('#toggleSettings');
      await pg1.waitForSelector('#settingsModal', { timeout: 5_000 });
      await pg1.click('#openToll');
      await pg1.waitForSelector('#tollModal', { timeout: 5_000 });
      await pg1.fill('#newTollAmountInput', toll.toString());
      await pg1.click('#saveNewTollButton');
      await pg1.waitForTimeout(1_000);
      const tollText = await pg1.locator('#tollAmountLIB').textContent();
      expect(tollText.trim().startsWith(toll.toString())).toBeTruthy();
      // close out of toggle menu
      await pg1.click('#closeTollModal');
      await pg1.click('#closeSettings');

      // User1 Check wallet balance
      await pg1.click('#switchToWallet');
      await pg1.waitForSelector('#walletScreen.active', { timeout: 10_000 });
      await pg1.waitForTimeout(20_000);
      await pg1.click('#refreshBalance');
      const balanceBefore = await getLiberdusBalance(pg1);
      log(`User1 initial balance: ${balanceBefore}`);

      // User2 ➜ User1
      log(`User2 (${user2}) sending message to User1 (${user1})`);
      await sendMessageTo(pg2, user1, msg2);

      // User1: Wait for message, then check wallet balance
      await pg1.waitForTimeout(10_000);
      await checkReceivedMessage(pg1, user2, msg2);
      
      // User1 checks wallet balance after sending message 
      await pg1.click('#switchToWallet');
      await pg1.waitForSelector('#walletScreen.active', { timeout: 10_000 });
      await pg1.waitForTimeout(20_000);
      await pg1.click('#refreshBalance');
      const balanceAfter = await getLiberdusBalance(pg1);
      
      // Only half the toll is received on read minus the 1% network fee on tolls
      const readToll = (toll / 2);
      const readTollAfterTax = readToll - (readToll * NETWORK_TOLL_TAX); // 1% network fee on tolls

      const balanceBeforeNum = parseFloat(balanceBefore);
      let expectedBalance = balanceBeforeNum + readTollAfterTax - NETWORK_FEE;
      // UI round to 6 decimal places
      expect(balanceAfter.toString()).toEqual(expectedBalance.toFixed(6));

      // reply to message to get the other half of the toll
      const replyMsg = 'Replying to get the other half of the toll';
      await sendMessageTo(pg1, user2, replyMsg);
      await pg2.waitForTimeout(10_000);
      await checkReceivedMessage(pg2, user1, replyMsg);

      // User1 check wallet balance again for the second half of the toll
      await pg1.click('#switchToWallet');
      await expect(pg1.locator('#walletScreen.active')).toBeVisible();
      await pg1.waitForTimeout(20_000);
      await pg1.click('#refreshBalance');
      const finalBalance = await getLiberdusBalance(pg1);
      const expectedFinalBalance = expectedBalance + readTollAfterTax - NETWORK_FEE;
      // UI round to 6 decimal places
      expect(finalBalance).toEqual(expectedFinalBalance.toFixed(6));
    } finally {
      await ctx1.close();
      await ctx2.close();
      log('Wallet toll test completed.');
    }
  });
});
