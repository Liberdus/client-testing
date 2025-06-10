// liberdus.e2e.spec.js

const { test, expect } = require('@playwright/test');
const { createAndSignInUser } = require('../helpers/userHelper');

// ─────── Logging utility ────────────────────────────────────────
const log = (msg) => console.log(`[E2E TEST] ${msg}`);

// Constants
const NETWORK_FEE = 0.1; // Default network fee for transactions
const NETWORK_TOLL_TAX = 0.01; // 1% network fee on tolls

// ─────── Helper utilities ─────────────────────

async function sendMessageTo(page, recipientUsername, message) {
  // Ensure we are on Chats screen
  await page.click('#switchToChats');
  await page.waitForSelector('#newChatButton', { state: 'visible', timeout: 10_000 });
  await page.click('#newChatButton');
  await page.waitForSelector('#newChatModal', { state: 'visible' });
  await page.type('#chatRecipient', recipientUsername);
  await page.waitForTimeout(3_000);

  const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
  if (recipientStatus !== 'found') {
    throw new Error(`Recipient "${recipientUsername}" not found or error: ${recipientStatus}`);
  }

  const continueBtn = page.locator('#newChatForm button[type="submit"]');
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  await page.waitForSelector('#chatModal', { state: 'visible', timeout: 15_000 });
  await page.type('#chatModal .message-input', message);
  await page.click('#handleSendMessage');
  await page.waitForTimeout(3_000);

  // If an error toast appears, fail fast
  if (await page.locator('.toast.error.show').count()) {
    const errText = await page.locator('.toast.error.show').textContent();
    throw new Error(`Error toast displayed after sending message: ${errText}`);
  }

  await page.waitForFunction(
    text => {
      const msgs = document.querySelectorAll('#chatModal .messages-list .message.sent .message-content');
      return Array.from(msgs).some(m => m.textContent.includes(text));
    },
    message,
    { timeout: 15_000 }
  );
  await page.click('#closeChatModal');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
}

async function checkReceivedMessage(page, senderUsername, message) {
  // switch to Chats screen
  await page.click('#switchToChats');
  await expect(page.locator('#chatsScreen.active')).toBeVisible();
  // Updated selector to match chat item by username text
  const chatItem = page.locator(
    '#chatList > li > div.chat-content > div.chat-header > div.chat-name',
    { hasText: senderUsername }
  );
  await expect(chatItem).toBeVisible({ timeout: 15_000 });
  await chatItem.click();
  await page.waitForSelector('#chatModal', { state: 'visible', timeout: 15_000 });
  await page.waitForFunction(
    text => {
      const msgs = document.querySelectorAll('#chatModal .messages-list .message.received .message-content');
      return Array.from(msgs).some(m => m.textContent.includes(text));
    },
    message,
    { timeout: 15_000 }
  );
  await page.click('#closeChatModal');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
}

// Helper to get Liberdus asset balance from wallet
async function getLiberdusBalance(page) {
  const assetRows = await page.$$('#assetsList > div');
  for (const row of assetRows) {
    const name = await row.$eval('.asset-info > .asset-name', el => el.textContent.trim()).catch(() => '');
    if (name === 'Liberdus') {
      const balanceText = await page.locator('.asset-balance').evaluate(el => {
        // Get only the text content before the <span>
        return el.childNodes[0].textContent.trim();
      }); 
      return balanceText;
    }
  }
  throw new Error('Liberdus asset not found in wallet');
}

test.describe('Multi User Tests', () => {

  test('should allow two users to message each other', async ({browserName, browser}) => {
    test.setTimeout(5 * 60 * 1000);
    log('Test: Two-user messaging scenario');

    const user1 = `${browserName}e2e1${Date.now().toString().slice(-6)}`;
    const user2 = `${browserName}e2e2${Date.now().toString().slice(-6)}`;
    const msg1 = 'Hello from user1!';
    const msg2 = 'Hello from user2!';

    // Create two isolated contexts
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const pg1  = await ctx1.newPage();
    const pg2  = await ctx2.newPage();
    try {
      // User 1 signup
      await pg1.goto("", { waitUntil: 'networkidle' });
      await createAndSignInUser(pg1, user1);

      // User 2 signup
      await pg2.goto("", { waitUntil: 'networkidle' });
      await createAndSignInUser(pg2, user2);

      // Wait a bit so backend knows both users
      await pg1.waitForTimeout(5_000);

      // User2 ➜ User1
      await sendMessageTo(pg2, user1, msg2);
      await pg1.waitForTimeout(5_000);
      await checkReceivedMessage(pg1, user2, msg2);

      // User1 ➜ User2
      await sendMessageTo(pg1, user2, msg1);
      await pg2.waitForTimeout(5_000);
      await checkReceivedMessage(pg2, user1, msg1);
    } finally {
      await ctx1.close();
      await ctx2.close();
      log('Two-user messaging test completed.');
    }
  });

  test('should receive toll on read and on reply', async ({browserName, browser}) => {
    test.setTimeout(10 * 60 * 1000);
    log('Test: Wallet toll increases on message receipt');
    const user1 = `${browserName}tolla${Date.now().toString().slice(-6)}`;
    const user2 = `${browserName}tollb${Date.now().toString().slice(-6)}`;
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
      await pg1.click('#toggleMenu');
      await pg1.waitForSelector('#menuModal', { timeout: 5_000 });
      await pg1.click('#openToll');
      await pg1.waitForSelector('#tollModal', { timeout: 5_000 });
      await pg1.fill('#newTollAmountInput', toll.toString());
      await pg1.click('#saveNewTollButton');
      await pg1.waitForTimeout(1_000);
      const tollText = await pg1.locator('#tollAmountLIB').textContent();
      expect(tollText.trim().startsWith(toll.toString())).toBeTruthy();
      // close out of toggle menu
      await pg1.click('#closeTollModal');
      await pg1.click('#closeMenu');

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
      await pg1.waitForSelector('#walletScreen.active', { timeout: 10_000 });
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

