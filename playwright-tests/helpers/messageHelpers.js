const { expect } = require('@playwright/test');


async function sendMessageTo(page, recipientUsername, message) {
  // Ensure we are on Chats screen
  await page.click('#switchToChats');
  await expect(page.locator('#newChatButton')).toBeVisible();
  await page.click('#newChatButton');
  await expect(page.locator('#newChatModal')).toBeVisible();
  await page.locator('#chatRecipient').pressSequentially(recipientUsername);
  await expect(page.locator('#chatRecipientError')).toHaveText('found');

  const continueBtn = page.locator('#newChatForm button[type="submit"]');
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  await expect(page.locator('#chatModal')).toBeVisible();
  // Allow background toll lookups and new-contact status updates time to settle.
  // This is a timing mitigation, not confirmation that either request succeeded.
  await page.waitForTimeout(10_000);
  await page.type('#chatModal .message-input', message);
  const errorToasts = page.locator('#toastContainer .toast.error');
  const previousErrorIds = await errorToasts.evaluateAll(toasts => toasts.map(toast => toast.id));
  await page.click('#handleSendMessage');
  await page.waitForTimeout(3_000);

  // Ignore sticky errors that were already present before Send.
  const newError = await errorToasts.evaluateAll((toasts, previousIds) =>
    toasts.find(toast => !previousIds.includes(toast.id))?.textContent?.trim(), previousErrorIds
  );
  if (newError) {
    throw new Error(`Error toast displayed after sending message: ${newError}`);
  }

  // A rejected injection can still leave an optimistic message in the chat.
  const sentMsg = page.locator('#chatModal .messages-list .message.sent:not([data-status="failed"]) .message-content', {
    hasText: message,
  });
  await expect(sentMsg).toBeVisible({ timeout: 15_000 });
  await page.click('#closeChatModal');
  await expect(page.locator('#newChatButton')).toBeVisible();
}

async function checkReceivedMessage(page, senderUsername, message) {
  // switch to Chats screen
  await page.click('#switchToChats');
  await expect(page.locator('#chatsScreen.active')).toBeVisible();
  // Updated selector to match chat item by username text
  const chatItem = page.locator('.chat-name', { hasText: senderUsername });
  await expect(chatItem).toBeVisible({ timeout: 15_000 });
  // A sticky wallet refresh error can overlap the chat list.
  const balanceError = page.locator('#toastContainer .toast.error.show.sticky', {
    hasText: /^Error fetching balance\. Try again later\./,
  }).first();
  if (await balanceError.isVisible()) {
    await balanceError.locator('.toast-close-btn').click({ timeout: 5_000 });
  }
  await chatItem.click({ timeout: 15_000 });
  await expect(page.locator('#chatModal')).toBeVisible();
  await expect(page.locator('.message.received .message-content', { hasText: message })).toBeVisible({ timeout: 30_000 });
  await page.click('#closeChatModal');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
}

module.exports = {
  sendMessageTo,
  checkReceivedMessage
};
