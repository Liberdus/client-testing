// liberdus.e2e.spec.js

const { test, expect } = require('../fixtures/newUserFixture');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');

let RECIPIENT;

test.describe('Tests requiring recipient user', () => {
  // Create the recipient user once before all tests
  test.beforeAll(async ({ browser, browserName }) => {
    const page = await browser.newPage();
    const recipientName = generateUsername(browserName);

    await createAndSignInUser(page, recipientName);
    RECIPIENT = recipientName;
    await page.close();
  });

  test('should open New Chat modal, start a chat, and send a message', async ({ page }) => {
    const recipient = RECIPIENT;

    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();

    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatus).toBe('found');

    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    await expect(page.locator('#chatModal')).toBeVisible();
    const testMessage = 'Hello from E2E test!'
    await page.fill('#chatModal .message-input', testMessage);
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

  test('should send LIB to contact with no memo, and check history', async ({ page }) => {
    const recipient = RECIPIENT;
    const amount = 20;

    // Open New Chat 
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatus).toBe('found');
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();
    await expect(page.locator('#chatModal')).toBeVisible();

    // Open Send Modal
    await expect(page.locator('#contactInfoModal')).toBeVisible();
    await expect(page.locator('#chatHeaderMenuButton')).toBeVisible();
    await page.click('#chatHeaderMenuButton');
    await expect(page.locator('.context-menu-option[data-action="pay"]')).toBeVisible();
    await page.click('.context-menu-option[data-action="pay"]');
    await expect(page.locator('#sendAssetFormModal')).toBeVisible();

    const usernameStatus = page.locator('#sendToAddressError');
    await expect(usernameStatus).toHaveText('found', { timeout: 10_000 });

    // Fill and Submit Send Form
    await page.fill('#sendAmount', amount.toString());
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
});

test('should navigate to Contacts and Wallet views', async ({ page }) => {
  await page.click('#switchToContacts');
  await expect(page.locator('#contactsScreen.active')).toBeVisible();
  await page.click('#switchToWallet');
  await expect(page.locator('#walletScreen.active')).toBeVisible();
  await page.click('#switchToChats');
  await expect(page.locator('#chatsScreen.active')).toBeVisible();
});

test('should sign out successfully', async ({ page }) => {
  // wait for UI animation
  await page.waitForTimeout(1000);
  await page.click('#toggleMenu');
  await expect(page.locator('#menuModal')).toBeVisible();
  await page.click('#handleSignOut');
  await expect(page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });
});

test('Should set toll', async ({ page }) => {
  const toll = 5;
  await page.click('#toggleSettings');
  await page.waitForSelector('#settingsModal', { timeout: 5_000 });
  await page.click('#openToll');
  await page.waitForSelector('#tollModal', { timeout: 5_000 });
  await page.fill('#newTollAmountInput', toll.toString());
  await page.click('#saveNewTollButton');
  await page.waitForTimeout(1_000);
  const tollText = await page.locator('#tollAmountUSD').textContent();
  expect(tollText.trim().startsWith(toll.toString())).toBeTruthy();
});

test('Should update profile', async ({ page, username }) => {
  const name = "Testername";
  const email = "tester@example.com";
  const phone = "5555555";
  const linkedin = "testerlinkedin";
  const x = "testerx";
  await page.locator('#toggleSettings').click();
  await page.locator('#openAccountForm').click();
  await page.locator('#name').fill(name);
  await page.locator('#email').fill(email);
  await page.locator('#phone').fill(phone);
  await page.locator('#linkedin').fill(linkedin);
  await page.locator('#x').fill(x);
  await page.locator('#accountModal button[type="submit"]').click();
  // wait for profile modal to close
  await page.waitForTimeout(2000);

  // Verify the profile was updated
  await page.getByText('Profile', { exact: true }).click();
  await expect(page.locator('#accountForm')).toMatchAriaSnapshot(`
    - textbox "Name": ${name}
    - textbox "Email": ${email}
    - textbox "Phone": ${phone}
    - textbox "LinkedIn": ${linkedin}
    - textbox "X-Twitter": ${x}
    `);
});
