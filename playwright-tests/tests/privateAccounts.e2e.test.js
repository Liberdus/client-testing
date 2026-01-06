const { test, expect } = require('../fixtures/newUserFixture');
const { test: base } = require('../fixtures/base');
const { generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');

base('private account can be created successfully', async ({ page, browserName }) => {
  const username = generateUsername(browserName);

  await page.goto('', { waitUntil: 'networkidle' });
  await expect(page.locator('#welcomeScreen')).toBeVisible();
  await expect(page.locator('#createAccountButton')).toBeVisible();
  await page.click('#createAccountButton');
  await expect(page.locator('#createAccountModal')).toBeVisible();

  // enter username
  await page.locator('#newUsername').pressSequentially(username);
  await expect(page.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });

  // reveal and enable private account option
  await page.locator('#toggleMoreOptions').click();
  await expect(page.locator('#togglePrivateAccount')).toBeVisible();
  await page.locator('#togglePrivateAccount').click();

  const createBtn = page.locator('#createAccountForm button[type="submit"]');
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  // wait for creation to finish
  await expect(page.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
  await page.waitForSelector('.toast.loading.show', { state: 'detached' });
  await expect(page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

  const appName = await page.locator('.app-name').textContent();
  await expect(appName.trim()).toBe(username);
});

test('private/public chat restrictions enforced', async ({ browser, browserName }) => {
  const ctxPrivate = await newContext(browser);
  const ctxPublic = await newContext(browser);
  const pagePrivate = await ctxPrivate.newPage();
  const pagePublic = await ctxPublic.newPage();

  const privateUser = generateUsername(browserName);
  const publicUser = generateUsername(browserName);

  try {
    // Create private account
    await pagePrivate.goto('', { waitUntil: 'networkidle' });
    await pagePrivate.click('#createAccountButton');
    await pagePrivate.locator('#newUsername').pressSequentially(privateUser);
    await expect(pagePrivate.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    await pagePrivate.locator('#toggleMoreOptions').click();
    await pagePrivate.locator('#togglePrivateAccount').click();
    await pagePrivate.locator('#createAccountForm button[type="submit"]').click();
    await expect(pagePrivate.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    await pagePrivate.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(pagePrivate.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    // Create public account
    await pagePublic.goto('', { waitUntil: 'networkidle' });
    await pagePublic.click('#createAccountButton');
    await pagePublic.locator('#newUsername').pressSequentially(publicUser);
    await expect(pagePublic.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    // do NOT toggle private account
    await pagePublic.locator('#createAccountForm button[type="submit"]').click();
    await expect(pagePublic.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    await pagePublic.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(pagePublic.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    // Private tries to start chat with Public --> should get private-specific error
    await pagePrivate.click('#newChatButton');
    await expect(pagePrivate.locator('#newChatModal')).toBeVisible();
    await pagePrivate.fill('#chatRecipient', publicUser);
    await pagePrivate.waitForTimeout(2_000);
    const recipientStatusP = await pagePrivate.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatusP).toBe('found');
    const continueBtnP = pagePrivate.locator('#newChatForm button[type="submit"]');
    await expect(continueBtnP).toBeEnabled();
    await continueBtnP.click();
    await expect(pagePrivate.locator('text=Private accounts can only chat with other private accounts.')).toBeVisible();

    // Public tries to start chat with Private --> should get public-specific error
    await pagePublic.click('#newChatButton');
    await expect(pagePublic.locator('#newChatModal')).toBeVisible();
    await pagePublic.fill('#chatRecipient', privateUser);
    await pagePublic.waitForTimeout(2_000);
    const recipientStatusPub = await pagePublic.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatusPub).toBe('found');
    const continueBtnPub = pagePublic.locator('#newChatForm button[type="submit"]');
    await expect(continueBtnPub).toBeEnabled();
    await continueBtnPub.click();
    await expect(pagePublic.locator('text=Public accounts can only chat with other public accounts.')).toBeVisible();

  } finally {
    await ctxPrivate.close();
    await ctxPublic.close();
  }
});

test('private/public transfer shows error toast', async ({ browser, browserName }) => {
  const ctxPrivate = await newContext(browser);
  const ctxPublic = await newContext(browser);
  const pagePrivate = await ctxPrivate.newPage();
  const pagePublic = await ctxPublic.newPage();

  const privateUser = generateUsername(browserName);
  const publicUser = generateUsername(browserName);

  try {
    // Create private account
    await pagePrivate.goto('', { waitUntil: 'networkidle' });
    await pagePrivate.click('#createAccountButton');
    await pagePrivate.locator('#newUsername').pressSequentially(privateUser);
    await expect(pagePrivate.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    await pagePrivate.locator('#toggleMoreOptions').click();
    await pagePrivate.locator('#togglePrivateAccount').click();
    await pagePrivate.locator('#createAccountForm button[type="submit"]').click();
    await expect(pagePrivate.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    await pagePrivate.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(pagePrivate.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    // Create public account
    await pagePublic.goto('', { waitUntil: 'networkidle' });
    await pagePublic.click('#createAccountButton');
    await pagePublic.locator('#newUsername').pressSequentially(publicUser);
    await expect(pagePublic.locator('#newUsernameAvailable')).toHaveText('available', { timeout: 10_000 });
    // leave as public
    await pagePublic.locator('#createAccountForm button[type="submit"]').click();
    await expect(pagePublic.locator('.toast.loading.show')).toBeVisible({ timeout: 20_000 });
    await pagePublic.waitForSelector('.toast.loading.show', { state: 'detached' });
    await expect(pagePublic.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    // From private user's wallet, open send form and submit 1 LIB to public user
    await pagePrivate.click('#switchToWallet');
    await pagePrivate.click('#openSendAssetFormModal');
    await expect(pagePrivate.locator('#sendAssetFormModal')).toBeVisible();
    await pagePrivate.fill('#sendToAddress', publicUser);
    await pagePrivate.fill('#sendAmount', '1');
    await expect(pagePrivate.locator('#sendToAddressError')).toHaveText('found', { timeout: 10_000 });

    const sendButton = pagePrivate.locator('#sendAssetFormModal button[type="submit"]');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Error toast should appear on form submission
    await expect(pagePrivate.locator('text=Private accounts can only send to other private accounts.')).toBeVisible({ timeout: 10_000 });

    // Now verify the same error appears when the public account tries to send to the private account
    await pagePublic.click('#switchToWallet');
    await pagePublic.click('#openSendAssetFormModal');
    await expect(pagePublic.locator('#sendAssetFormModal')).toBeVisible();
    await pagePublic.fill('#sendToAddress', privateUser);
    await pagePublic.fill('#sendAmount', '1');
    await expect(pagePublic.locator('#sendToAddressError')).toHaveText('found', { timeout: 10_000 });

    const sendButtonPub = pagePublic.locator('#sendAssetFormModal button[type="submit"]');
    await expect(sendButtonPub).toBeEnabled();
    await sendButtonPub.click();

    // Error toast should appear on form submission
    await expect(pagePublic.locator('text=Public accounts can only send to other public accounts.')).toBeVisible({ timeout: 10_000 });

  } finally {
    await ctxPrivate.close();
    await ctxPublic.close();
  }
});


