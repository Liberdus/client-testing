const { expect } = require('@playwright/test');


async function sendMessageTo(page, recipientUsername, message) {
  // Ensure we are on Chats screen
  await page.click('#switchToChats');
  await page.waitForSelector('#newChatButton', { state: 'visible' });
  await page.click('#newChatButton');
  await page.waitForSelector('#newChatModal', { state: 'visible' });
  await page.locator('#chatRecipient').sequentiallyPress(recipientUsername);
  await expect(page.locator('#chatRecipientError')).toHaveText('found');

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

  // Replace waitForFunction with expect for sent message
  const sentMsg = page.locator('#chatModal .messages-list .message.sent .message-content', { hasText: message });
  await expect(sentMsg).toBeVisible({ timeout: 15_000 });
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

module.exports = {
    sendMessageTo,
    checkReceivedMessage
};
