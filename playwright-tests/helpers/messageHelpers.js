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
  await page.type('#chatModal .message-input', message);
  await page.click('#handleSendMessage');
  await page.waitForTimeout(3_000);

  // If an error toast appears, fail fast
  if (await page.locator('.toast.error.show').count()) {
    const errText = await page.locator('.toast.error.show').textContent();
    throw new Error(`Error toast displayed after sending message: ${errText}`);
  }

  // Replace waitForFunction with expect for sent message
  const sentMsg = page.locator('#chatModal .messages-list .message.sent .message-content', { hasText: message });
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
  await chatItem.click();
  await expect(page.locator('#chatModal')).toBeVisible();
  await expect(page.locator('.message.received .message-content', { hasText: message })).toBeVisible({ timeout: 30_000 });
  await page.click('#closeChatModal');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
}

module.exports = {
  sendMessageTo,
  checkReceivedMessage
};
