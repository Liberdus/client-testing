const { test: base, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLiberdusBalance, expectLiberdusBalanceToEqual } = require('../helpers/walletHelpers');
const networkParams = require('../helpers/networkParams');

// Setup test fixture with two users
const test = base.extend({
  users: async ({ browser, browserName }, use, testInfo) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const userA = generateUsername(browserName);
    const userB = generateUsername(browserName);

    // Attach both usernames to the report
    await testInfo.attach('test-users.json', {
      body: JSON.stringify({ userA, userB }, null, 2),
      contentType: 'application/json'
    });

    try {
      // Create both users in parallel
      await Promise.all([
        createAndSignInUser(pageA, userA),
        createAndSignInUser(pageB, userB)
      ]);

      // Get initial balances
      const [balanceA, balanceB] = await Promise.all([
        getLiberdusBalance(pageA),
        getLiberdusBalance(pageB)
      ]);

      await use({
        a: { 
          username: userA, 
          page: pageA, 
          ctx: ctxA,
          balance: parseFloat(balanceA)
        },
        b: { 
          username: userB, 
          page: pageB, 
          ctx: ctxB,
          balance: parseFloat(balanceB)
        }
      });
    } finally {
      // Ensure we close the pages and contexts even if test fails
      await ctxA.close();
      await ctxB.close();
    }
  }
});

test.describe('Transfer Tests', () => {
  test('should send transfer without memo and verify receipt', async ({ users }) => {
    const { a, b } = users;
    const amount = 5.25; // Transfer amount
    
    // Track expected balances
    let expectedBalanceA = a.balance - amount - networkParams.networkFeeLib;
    let expectedBalanceB = b.balance + amount;

    // User A opens wallet and prepares send form
    await a.page.click('#switchToWallet');
    await a.page.click('#openSendAssetFormModal');
    await expect(a.page.locator('#sendAssetFormModal')).toBeVisible();
    
    // Fill send form
    await a.page.fill('#sendToAddress', b.username);
    await a.page.fill('#sendAmount', amount.toString());
    
    // Wait for username validation
    await expect(a.page.locator('#sendToAddressError')).toHaveText('found', { timeout: 10_000 });
    
    // Submit form
    const sendButton = a.page.locator('#sendAssetFormModal button[type="submit"]');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    
    // Confirm transaction
    await expect(a.page.locator('#sendAssetConfirmModal')).toBeVisible();
    const confirmRecipient = await a.page.locator('#confirmRecipient').textContent();
    expect(confirmRecipient).toContain(b.username);
    const confirmAmount = await a.page.locator('#confirmAmount').textContent();
    expect(confirmAmount).toContain(amount.toString());
    await a.page.click('#confirmSendButton');
    
    // Check transaction history modal appears
    await expect(a.page.locator('#historyModal')).toBeVisible();
    const firstTransaction = a.page.locator('#historyModal .transaction-item').first();
    const transactionAmount = await firstTransaction.locator('.transaction-amount').textContent();
    expect(transactionAmount).toContain(amount.toString());
    const transactionAddress = await firstTransaction.locator('.transaction-address').textContent();
    expect(transactionAddress).toContain(`To: ${b.username}`);
    await a.page.click('#closeHistoryModal');
    
    // Verify sender's balance has been updated
    await expectLiberdusBalanceToEqual(a.page, expectedBalanceA.toFixed(6), 30_000);
    
    // Verify recipient received the funds
    await expectLiberdusBalanceToEqual(b.page, expectedBalanceB.toFixed(6), 30_000);
    
    // Check that recipient sees the transfer message in chat
    await b.page.click('#switchToChats');
    await expect(b.page.locator('#chatsScreen.active')).toBeVisible();
    
    // Look for chat from sender
    const chatItem = b.page.locator('.chat-name', { hasText: a.username });
    await expect(chatItem).toBeVisible({ timeout: 15_000 });
    
    // Open the chat
    await chatItem.click();
    await expect(b.page.locator('#chatModal')).toBeVisible();
    
    // Verify the transfer message is visible
    const transferMsg = b.page.locator('.message.received.payment-info .payment-amount');
    await expect(transferMsg).toBeVisible({ timeout: 15_000 });
    await expect(transferMsg).toContainText(amount.toString());
  });

  test('should send transfer with memo and verify receipt', async ({ users }) => {
    const { a, b } = users;
    const amount = 1 + networkParams.defaultTollLib; // Transfer amount
    const memo = "Payment for lunch";
    
    // Track expected balances
    let expectedBalanceA = a.balance - amount - networkParams.networkFeeLib;
    let expectedBalanceB = b.balance + amount;

    // User A opens wallet and prepares send form
    await a.page.click('#switchToWallet');
    await a.page.click('#openSendAssetFormModal');
    await expect(a.page.locator('#sendAssetFormModal')).toBeVisible();
    
    // Fill send form with memo
    await a.page.fill('#sendToAddress', b.username);
    await a.page.fill('#sendAmount', amount.toString());
    await a.page.fill('#sendMemo', memo);
    
    // Wait for username validation
    await expect(a.page.locator('#sendToAddressError')).toHaveText('found', { timeout: 10_000 });
    
    // Submit form
    const sendButton = a.page.locator('#sendAssetFormModal button[type="submit"]');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    
    // Confirm transaction
    await expect(a.page.locator('#sendAssetConfirmModal')).toBeVisible();
    const confirmRecipient = await a.page.locator('#confirmRecipient').textContent();
    expect(confirmRecipient).toContain(b.username);
    const confirmAmount = await a.page.locator('#confirmAmount').textContent();
    expect(confirmAmount).toContain(amount.toString());
    const confirmMemo = await a.page.locator('#confirmMemo').textContent();
    expect(confirmMemo).toContain(memo);
    await a.page.click('#confirmSendButton');
    
    // Check transaction history modal appears
    await expect(a.page.locator('#historyModal')).toBeVisible();
    const firstTransaction = a.page.locator('#historyModal .transaction-item').first();
    const transactionAmount = await firstTransaction.locator('.transaction-amount').textContent();
    expect(transactionAmount).toContain(amount.toString());
    const transactionAddress = await firstTransaction.locator('.transaction-address').textContent();
    expect(transactionAddress).toContain(`To: ${b.username}`);
    await a.page.click('#closeHistoryModal');
    
    // Verify sender's balance has been updated
    await expectLiberdusBalanceToEqual(a.page, expectedBalanceA.toFixed(6), 30_000);
    
    // Verify recipient received the funds
    await expectLiberdusBalanceToEqual(b.page, expectedBalanceB.toFixed(6), 30_000);
    
    // Check that recipient sees the transfer message in chat
    await b.page.click('#switchToChats');
    await expect(b.page.locator('#chatsScreen.active')).toBeVisible();
    
    // Look for chat from sender
    const chatItem = b.page.locator('.chat-name', { hasText: a.username });
    await expect(chatItem).toBeVisible({ timeout: 15_000 });
    
    // Open the chat
    await chatItem.click();
    await expect(b.page.locator('#chatModal')).toBeVisible();
    
    // Verify the transfer message is visible
    const transferMsg = b.page.locator('.message.received.payment-info .payment-amount');
    await expect(transferMsg).toBeVisible({ timeout: 15_000 });
    await expect(transferMsg).toContainText(amount.toString());
    
    // Verify the memo is visible
    const memoElement = b.page.locator('.message.received.payment-info .payment-memo');
    await expect(memoElement).toBeVisible({ timeout: 15_000 });
    await expect(memoElement).toContainText(memo);
  });
});