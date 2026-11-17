const { expect } = require('@playwright/test');
const { WALLET_BALANCE_REFRESH_ERROR, dismissStickyWalletRefreshError } = require('./toastHelpers');

const CHAT_OPEN_TIMEOUT = 15_000;

async function openNewChat(page, recipientUsername) {
  await page.click('#switchToChats');
  await page.locator('#newChatButton').click();
  const newChatModal = page.locator('#newChatModal.active');
  await expect(newChatModal).toBeVisible();
  await newChatModal.locator('#chatRecipient').fill(recipientUsername);
  await expect(newChatModal.locator('#chatRecipientError')).toHaveText('found', { timeout: CHAT_OPEN_TIMEOUT });

  const continueButton = newChatModal.locator('#newChatForm button[type="submit"]');
  await expect(continueButton).toBeEnabled({ timeout: CHAT_OPEN_TIMEOUT });
  await continueButton.click({ timeout: CHAT_OPEN_TIMEOUT });

  const chatModal = page.locator('#chatModal.active');
  await expect(chatModal).toBeVisible({ timeout: CHAT_OPEN_TIMEOUT });
  return chatModal;
}

async function sendMessageTo(page, recipientUsername, message) {
  const chatModal = await openNewChat(page, recipientUsername);
  // Allow background toll lookups and new-contact status updates time to settle.
  // This is a timing mitigation, not confirmation that either request succeeded.
  await page.waitForTimeout(10_000);
  await chatModal.locator('.message-input').pressSequentially(message, { timeout: 15_000 });
  // Reconnecting can trigger a background wallet refresh while Send is waiting to become enabled.
  const errorToasts = page.locator('#toastContainer .toast.error', {
    hasNotText: WALLET_BALANCE_REFRESH_ERROR,
  });
  const previousErrorIds = await errorToasts.evaluateAll(toasts => toasts.map(toast => toast.id));
  await chatModal.locator('#handleSendMessage').click({ timeout: 15_000 });
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
  await dismissStickyWalletRefreshError(page);
  await chatItem.click({ timeout: 15_000 });
  await expect(page.locator('#chatModal')).toBeVisible();
  await expect(page.locator('.message.received .message-content', { hasText: message })).toBeVisible({ timeout: 30_000 });
  await page.click('#closeChatModal');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
}

module.exports = {
  openNewChat,
  sendMessageTo,
  checkReceivedMessage
};
