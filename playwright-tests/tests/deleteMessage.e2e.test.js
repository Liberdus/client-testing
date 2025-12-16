const { test: base, expect } = require('@playwright/test');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');


const test = base.extend({
    messageUsers: async ({ browserName, browser }, use) => {
        // Generate usernames
        const user1 = generateUsername(browserName);
        const user2 = generateUsername(browserName);

        // Create contexts and pages
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const pg1 = await ctx1.newPage();
        const pg2 = await ctx2.newPage();

        // Create both users
        await Promise.all([
            createAndSignInUser(pg1, user1),
            createAndSignInUser(pg2, user2)
        ]);

        // Provide the setup to the test
        await use({
            users: {
                user1: { username: user1, context: ctx1, page: pg1 },
                user2: { username: user2, context: ctx2, page: pg2 }
            }
        });

        // Clean up after the test
        await ctx1.close();
        await ctx2.close();
    }
});

test.describe('Delete Message Tests', () => {

    test('Should delete a sent locally', async ({ messageUsers }) => {
        const { users: { user1, user2 } } = messageUsers;
        const message = `Hello from ${user1.username} -> ${user2.username} ${Date.now()}`;

        // Send a message from user1 to user2
        await sendMessageTo(user1.page, user2.username, message);
        await checkReceivedMessage(user2.page, user1.username, message);

        // Open the chat as sender and click the sent message to open context menu
        await user1.page.click('#switchToChats');
        const chatItem = user1.page.locator('.chat-name', { hasText: user2.username });
        await expect(chatItem).toBeVisible({ timeout: 15_000 });
        await chatItem.click();
        await expect(user1.page.locator('#chatModal')).toBeVisible();

        const sentMsg = user1.page.locator('#chatModal .messages-list .message.sent .message-content', { hasText: message });
        await expect(sentMsg).toBeVisible({ timeout: 15_000 });

        // Click to open context menu
        await sentMsg.click();

        // Both options should be visible for sent messages
        const deleteForMe = user1.page.locator('#messageContextMenu').locator('text="Delete for me"');
        await expect(deleteForMe).toBeVisible({ timeout: 10_000 });

        // Click Delete for me and verify message is replaced
        user1.page.on('dialog', dialog => dialog.accept());
        await deleteForMe.click();

        const deletedSent = user1.page.locator('#chatModal .messages-list .message.sent .message-content.deleted-content', { hasText: 'Deleted on this device' });
        await expect(deletedSent).toBeVisible({ timeout: 15_000 });

        // Close chat modal
        await user1.page.click('#closeChatModal');
    });

    test('Should delete received message locally', async ({ messageUsers }) => {
        const { users: { user1, user2 } } = messageUsers;
        const message = `Hi back from ${user2.username} -> ${user1.username} ${Date.now()}`;

        // Send a message from user2 to user1
        await sendMessageTo(user2.page, user1.username, message);
        await checkReceivedMessage(user1.page, user2.username, message);

        // Open the chat as recipient and click the received message to open context menu
        await user1.page.click('#switchToChats');
        const chatItem = user1.page.locator('.chat-name', { hasText: user2.username });
        await expect(chatItem).toBeVisible({ timeout: 15_000 });
        await chatItem.click();
        await expect(user1.page.locator('#chatModal')).toBeVisible();

        const receivedMsg = user1.page.locator('#chatModal .messages-list .message.received .message-content', { hasText: message });
        await expect(receivedMsg).toBeVisible({ timeout: 15_000 });

        // Click to open context menu
        await receivedMsg.click();

        // Only Delete for me should be visible
        const deleteForMe = user1.page.locator('#messageContextMenu').locator('text="Delete for me"');
        const deleteForAll = user1.page.locator('#messageContextMenu').locator('text="Delete for all"');
        await expect(deleteForMe).toBeVisible({ timeout: 10_000 });
        await expect(deleteForAll).not.toBeVisible();

        // Click Delete for me and verify message is replaced
        user1.page.on('dialog', dialog => dialog.accept());
        await deleteForMe.click();
        const deletedReceived = user1.page.locator('#chatModal .messages-list .message.received .message-content.deleted-content', { hasText: 'Deleted on this device' });
        await expect(deletedReceived).toBeVisible({ timeout: 15_000 });

        // Close chat modal
        await user1.page.click('#closeChatModal');
    });

    test('Should delete message for all', async ({ messageUsers }) => {
        const { users: { user1, user2 } } = messageUsers;
        const message = `Erase me ${Date.now()}`;

        // Send message from user2 to user1 to ensure no toll for user1
        await sendMessageTo(user2.page, user1.username, message);
        await checkReceivedMessage(user1.page, user2.username, message);

        // Send message from user1 to user2
        await sendMessageTo(user1.page, user2.username, message);
        await checkReceivedMessage(user2.page, user1.username, message);

        // Open chat as sender and click the sent message to open context menu
        await user1.page.click('#switchToChats');
        const chatItem1 = user1.page.locator('.chat-name', { hasText: user2.username });
        await expect(chatItem1).toBeVisible({ timeout: 15_000 });
        await chatItem1.click();
        await expect(user1.page.locator('#chatModal')).toBeVisible();

        const sentMsg = user1.page.locator('#chatModal .messages-list .message.sent .message-content', { hasText: message });
        await expect(sentMsg).toBeVisible({ timeout: 15_000 });
        await sentMsg.click();

        // Click Delete for all
        const deleteForAll = user1.page.locator('#messageContextMenu').locator('text="Delete for all"');
        await expect(deleteForAll).toBeVisible({ timeout: 10_000 });

        user1.page.on('dialog', dialog => dialog.accept())
        await deleteForAll.click();

        // Expect a toast indicating the delete request was sent
        const deleteToast = user1.page.locator('.toast.success.show', { hasText: 'Delete request sent' });
        await expect(deleteToast).toBeVisible({ timeout: 30_000 });

        // Wait for the transaction to be processed and for the message to be replaced on sender side
        const deletedOnSender = user1.page.locator('#chatModal .messages-list .message.sent .message-content.deleted-content', { hasText: 'Deleted for all' });
        await expect(deletedOnSender).toBeVisible({ timeout: 60_000 });

        // Now check the recipient side shows a different message indicating it was deleted by sender
        await user2.page.click('#switchToChats');
        const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
        await expect(chatItem2).toBeVisible({ timeout: 15_000 });
        await chatItem2.click();
        await expect(user2.page.locator('#chatModal')).toBeVisible();

        const deletedOnRecipient = user2.page.locator('#chatModal .messages-list .message.received .message-content', { hasText: 'Deleted by sender' });
        await expect(deletedOnRecipient).toBeVisible({ timeout: 60_000 });
    });

});
