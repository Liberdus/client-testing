// liberdus.e2e.spec.js

const { test, expect } = require('@playwright/test');

// ─────── Config ──────────────────────────────────────────────────
const APP_URL      = 'https://liberdus.com/dev';
const VIEWPORT     = { width: 430, height: 945 };

// ─────── Logging utility ────────────────────────────────────────
const log = (msg) => console.log(`[E2E TEST] ${msg}`);

// ─────── Dynamic test data ─────────────
const RECIPIENT = 'toad'; // Default recipient for tests

// Constants
const NETWORK_FEE = 0.1; // Default network fee for transactions
const NETWORK_TOLL_TAX = 0.01; // 1% network fee on tolls

// ─────── Helper utilities (ported verbatim) ─────────────────────
async function ensureSignedIn(page) {
  const isWelcomeVisible = await page.$eval(
    '#welcomeScreen',
    el => window.getComputedStyle(el).display !== 'none'
  ).catch(() => false);

  if (isWelcomeVisible) {
    log('Welcome screen detected, proceeding to sign in.');
    await page.waitForSelector('#signInButton', { state: 'visible', timeout: 10_000 });
    await page.click('#signInButton');
    log('Sign in button clicked.');
    // wait 1 second to connect to backend
    await page.waitForTimeout(5000);
    await page.waitForSelector('#chatsScreen', { state: 'visible', timeout: 20_000 });
    log('Signed in and chats screen is visible.');
  } else {
    log('Already signed in (welcome screen not visible).');
  }
}

async function createAndSignInUser(page, username) {
  await page.waitForSelector('#createAccountButton', { state: 'visible' });
  await page.click('#createAccountButton');
  await page.waitForSelector('#createAccountModal', { state: 'visible' });
  await page.type('#newUsername', username);
  await page.waitForTimeout(3_000);

  const usernameStatus = await page.locator('#newUsernameAvailable').textContent().catch(() => '');
  if (usernameStatus !== 'available') {
    throw new Error(`Username "${username}" not available: ${usernameStatus}`);
  }

  const createBtn = page.locator('#createAccountForm button[type="submit"]');
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  await page.waitForSelector('#welcomeScreen', { state: 'hidden', timeout: 300_000 });
  await page.waitForSelector('#chatsScreen',  { state: 'visible', timeout: 15_000 });

  const appName = await page.locator('.app-name').textContent();
  if (appName.trim() !== username) throw new Error('App name in header does not match username');
}

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

// ─────── Test suite ─────────────────────────────────────────────
test.describe.serial('Smoke test', () => {
  let browser;
  let context;      // default context for single-page tests
  let page;

  test.beforeAll(async ({browser: pwBrowser}) => {
    log(`Launching browser for E2E tests against ${APP_URL}`);
    browser = pwBrowser;
    context = await browser.newContext({ viewport: VIEWPORT });
    page    = await context.newPage();

    // Auto-accept beforeunload dialogs
    page.on('dialog', async dialog => {
      log(`Dialog opened: ${dialog.type()} - "${dialog.message()}"`);
      if (dialog.type() === 'beforeunload') {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
  });

  test.afterAll(async () => {
    log('Closing browser after E2E tests.');
    await context.close();
  });

  test.beforeEach(async () => {
    log(`Navigating to ${APP_URL} for new test.`);
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await expect(page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });
  });

  // ── Individual tests ──────────────────────────────────────────
  test('should display the welcome screen correctly', async () => {
    log('Test: Welcome Screen Display');
    await expect(page.locator('#createAccountButton')).toBeVisible();
    await expect(page.locator('#createAccountButton')).toHaveText('Create Account');
    const networkName = await page.locator('#networkNameDisplay').textContent();
    expect(networkName.trim().length).toBeGreaterThan(0);
    log(`Network name displayed: ${networkName.trim()}`);
  });

  test('should open Create Account modal and attempt account creation', async ({browserName}) => {
    const browserSpecificUsername = `${browserName}test${Date.now().toString().slice(-6)}`;
    log(`Test: Account Creation Attempt with username: ${browserSpecificUsername}`);
    await page.click('#createAccountButton');
    // wait one second
    await page.waitForTimeout(1_000);
    await expect(page.locator('#createAccountModal')).toBeVisible();

    await page.type('#newUsername', browserSpecificUsername);
    log(`Typed username: ${browserSpecificUsername}`);
    await page.waitForTimeout(3_000);

    const usernameStatus = await page.locator('#newUsernameAvailable').textContent().catch(() => '');
    expect(usernameStatus).toBe('available');

    const createBtn = page.locator('#createAccountForm button[type="submit"]');
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    log('Clicked Create Account button.');

    await page.waitForSelector('#chatsScreen', { state: 'visible', timeout: 30_000 });
    const appName = await page.locator('.app-name').textContent();
    expect(appName.trim()).toBe(browserSpecificUsername);
    log(`App name in header updated to: ${appName.trim()}`);
  });

  // ── Nested (signed-in) tests ─────────────────────────────────
  test.describe('Tests requiring sign-in', () => {

    test.beforeEach(async () => {
      await ensureSignedIn(page);
    });

    test('should navigate to Contacts and Wallet views', async () => {
      log('Test: Navigation (Contacts, Wallet)');
      await page.click('#switchToContacts');
      await expect(page.locator('#contactsScreen.active')).toBeVisible();
      await page.click('#switchToWallet');
      await expect(page.locator('#walletScreen.active')).toBeVisible();
      await page.click('#switchToChats');
      await expect(page.locator('#chatsScreen.active')).toBeVisible();
    });

    test('should open New Chat modal, start a chat, and send a message', async () => {
      log('Test: New Chat and Send Message');
      const recipient = RECIPIENT;

      await page.click('#newChatButton');
      await expect(page.locator('#newChatModal')).toBeVisible();

      await page.type('#chatRecipient', recipient);
      await page.waitForTimeout(3_000);
      const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
      expect(recipientStatus).toBe('found');

      const continueBtn = page.locator('#newChatForm button[type="submit"]');
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();

      await expect(page.locator('#chatModal')).toBeVisible();
      const testMessage = 'Hello from E2E test!'
      await page.type('#chatModal .message-input', testMessage);
      await page.click('#handleSendMessage');
      await page.waitForTimeout(3_000);

      // Ensure message appears
      await page.waitForFunction(
        txt => [...document.querySelectorAll('#chatModal .messages-list .message.sent .message-content')]
          .some(m => m.textContent.includes(txt)),
        testMessage,
        { timeout: 15_000 }
      );

      await page.click('#closeChatModal');
      await expect(page.locator('#newChatButton')).toBeVisible();
    });

    test('should send LIB to contact with no memo, and check history', async () => {
        log('Test: Send LIB to Contact and Check History');
        const recipient = RECIPIENT;
        const amount = 20;

        // Go to Contacts Screen
        await page.click('#switchToContacts');
        await expect(page.locator('#contactsScreen.active')).toBeVisible();

        // Select Contact
        const contactItem = page.locator('#contactsList > li', {
            has: page.locator('.chat-header > div', { hasText: recipient })
        });
        await expect(contactItem).toBeVisible();
        await contactItem.click();

        // Open Send Modal
        await expect(page.locator('#contactInfoModal')).toBeVisible();
        await page.click('#contactInfoSendButton');
        await expect(page.locator('#sendAssetFormModal')).toBeVisible();

        // Fill and Submit Send Form
        await page.type('#sendAmount', amount.toString());
        await page.waitForTimeout(1_000);
        const sendButton = page.locator('#sendAssetFormModal button[type="submit"]');
        await expect(sendButton).toBeEnabled();
        await sendButton.click();

        // Confirm Transaction
        await expect(page.locator('#sendAssetConfirmModal')).toBeVisible();
        const confirmRecipient = await page.locator('#confirmRecipient').textContent();
        expect(confirmRecipient).toContain(recipient);
        const confirmAmount = await page.locator('#confirmAmount').textContent();
        expect(confirmAmount).toContain(amount.toString());
        await page.click('#confirmSendButton');

        // Check Transaction History 
        await expect(page.locator('#historyModal')).toBeVisible();
        const firstTransaction = page.locator('#historyModal .transaction-item').first();
        const transactionAmount = await firstTransaction.locator('.transaction-amount').textContent();
        expect(transactionAmount).toContain(amount.toString());
        const transactionAddress = await firstTransaction.locator('.transaction-address').textContent();
        expect(transactionAddress).toContain(`To: ${recipient}`);
    });


    test('should sign out successfully', async () => {
      log('Test: Sign Out');
      await page.click('#toggleMenu');
      await expect(page.locator('#menuModal')).toBeVisible();
      await page.click('#handleSignOut');
      await expect(page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });
    });
  });



});

test.describe('Multi User Tests', () => {

  test('should allow two users to message each other (separate contexts)', async ({browserName, browser}) => {
    test.setTimeout(5 * 60 * 1000);
    log('Test: Two-user messaging scenario');

    const user1 = `${browserName}e2e1${Date.now().toString().slice(-6)}`;
    const user2 = `${browserName}e2e2${Date.now().toString().slice(-6)}`;
    const msg1 = 'Hello from user1!';
    const msg2 = 'Hello from user2!';

    // Create two isolated contexts
    const ctx1 = await browser.newContext({ viewport: VIEWPORT });
    const ctx2 = await browser.newContext({ viewport: VIEWPORT });
    const pg1  = await ctx1.newPage();
    const pg2  = await ctx2.newPage();
    try {
      // User 1 signup
      await pg1.goto(APP_URL, { waitUntil: 'networkidle' });
      await createAndSignInUser(pg1, user1);

      // User 2 signup
      await pg2.goto(APP_URL, { waitUntil: 'networkidle' });
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

  test('should increase user1 wallet balance by toll when messaged by user2', async ({browserName, browser}) => {
    test.setTimeout(10 * 60 * 1000);
    log('Test: Wallet toll increases on message receipt');
    const user1 = `${browserName}tolla${Date.now().toString().slice(-6)}`;
    const user2 = `${browserName}tollb${Date.now().toString().slice(-6)}`;
    const msg2 = 'Hello with toll!';
    const toll = 3; // Set toll amount

    // Create two isolated contexts
    const ctx1 = await browser.newContext({ viewport: VIEWPORT });
    const ctx2 = await browser.newContext({ viewport: VIEWPORT });
    const pg1  = await ctx1.newPage();
    const pg2  = await ctx2.newPage();

    try{
      // User 1 signup
      await pg1.goto(APP_URL, { waitUntil: 'networkidle' });
      await createAndSignInUser(pg1, user1);

      // User 2 signup
      await pg2.goto(APP_URL, { waitUntil: 'networkidle' });
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

