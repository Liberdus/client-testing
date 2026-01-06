// liberdus.e2e.spec.js

const { test, expect } = require('../fixtures/base');
const { createAndSignInUser } = require('../helpers/userHelpers');
const { getLiberdusBalance } = require('../helpers/walletHelpers');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { generateUsername } = require('../helpers/userHelpers');
const networkParams = require('../helpers/networkParams');
const { newContext } = require('../helpers/toastHelpers');

test.describe('Multi User Tests', () => {

  test('should allow two users to message each other', async ({browserName, browser}) => {
    const user1 = generateUsername(browserName);
    const user2 = generateUsername(browserName);
    const msg1 = 'Hello from user1!';
    const msg2 = 'Hello from user2!';

    // Create two isolated contexts
    const ctx1 = await newContext(browser);
    const ctx2 = await newContext(browser);
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
    }
  });

  test('should receive toll on read and on reply', async ({browserName, browser}) => {
    const user1 = generateUsername(browserName);
    const user2 = generateUsername(browserName);
    const msg2 = 'Hello with toll!';
    // Add 1 wei (1e-18) to default toll using BigInt for full 18 decimal precision
    const defaultTollWei = BigInt(Math.round(networkParams.defaultTollUsd * 1e18));
    const tollWei = defaultTollWei + 1n;
    const tollStr = tollWei.toString().padStart(19, '0');
    const toll = (tollStr.slice(0, -18) || '0') + '.' + tollStr.slice(-18);
    // For balance calculations (UI shows 6 decimals), use the numeric value
    const tollNum = Number(tollWei) / 1e18;
    const tollInLib = tollNum / networkParams.stabilityFactor;

    // Create two isolated contexts
    const ctx1 = await newContext(browser);
    const ctx2 = await newContext(browser);
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
      await pg1.fill('#newTollAmountInput', toll);
      await pg1.click('#saveNewTollButton');
      await pg1.waitForTimeout(1_000);
      const tollText = await pg1.locator('#tollAmountUSD').textContent();
      expect(tollText.trim().startsWith(tollNum.toFixed(6))).toBeTruthy();
      // close out of toggle menu
      await pg1.click('#closeTollModal');
      await pg1.click('#closeSettings');

      // User1 Check wallet balance
      await pg1.click('#switchToWallet');
      await pg1.waitForSelector('#walletScreen.active', { timeout: 10_000 });
      await pg1.waitForTimeout(20_000);
      await pg1.click('#refreshBalance');
      const balanceBefore = await getLiberdusBalance(pg1);

      // User2 ➜ User1
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
      const readToll = (tollInLib / 2);
      const readTollAfterTax = readToll - (readToll * networkParams.networkTollTax); // 1% network fee on tolls

      const balanceBeforeNum = parseFloat(balanceBefore);
      let expectedBalance = balanceBeforeNum + readTollAfterTax - networkParams.networkFeeLib;
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
      const expectedFinalBalance = expectedBalance + readTollAfterTax - networkParams.networkFeeLib;
      // UI round to 6 decimal places
      expect(finalBalance).toEqual(expectedFinalBalance.toFixed(6));
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
