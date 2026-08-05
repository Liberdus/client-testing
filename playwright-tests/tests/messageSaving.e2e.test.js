const { test: base, expect } = require('../fixtures/base');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLocalStorage, getUserAuthoredMessagesBetweenUsers } = require('../helpers/localStorageHelpers');
const { newContext } = require('../helpers/toastHelpers');

function expectStoredMessages(actualMessages, expectedMessages, ownerNumber) {
    const actual = actualMessages.map(message => ({
        content: message.message,
        direction: message.my ? 'sent' : 'received'
    }));
    const expected = expectedMessages.map(message => ({
        content: message.content,
        direction: message.from === ownerNumber ? 'sent' : 'received'
    }));

    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
}

async function expectRenderedMessages(page, expectedMessages, ownerNumber) {
    const messageBubbles = page.locator('#chatModal .messages-list .message:has(.message-content)');
    await expect(messageBubbles).toHaveCount(expectedMessages.length);

    for (let i = 0; i < expectedMessages.length; i++) {
        const expectedMessage = expectedMessages[i];
        const expectedDirection = expectedMessage.from === ownerNumber ? 'sent' : 'received';
        const messageBubble = messageBubbles.nth(i);

        await expect(messageBubble).toHaveClass(new RegExp(`\\b${expectedDirection}\\b`));
        await expect(messageBubble.locator('.message-content')).toContainText(expectedMessage.content);
    }
}

const test = base.extend({
    messageUsers: async ({ browserName, browser }, use) => {
        // Generate usernames
        const user1 = generateUsername(browserName);
        const user2 = generateUsername(browserName);

        // Create contexts and pages
        const ctx1 = await newContext(browser);
        const ctx2 = await newContext(browser);
        const pg1 = await ctx1.newPage();
        const pg2 = await ctx2.newPage();

        // Create both users
        await Promise.all([
            createAndSignInUser(pg1, user1),
            createAndSignInUser(pg2, user2)
        ]);

        // Define alternating messages
        const messages = [
            { from: 1, to: 2, content: `Message 1 from ${user1} to ${user2}` },
            { from: 2, to: 1, content: `Message 2 from ${user2} to ${user1}` }
        ];

        // Exchange messages
        for (const msg of messages) {
            const fromPage = msg.from === 1 ? pg1 : pg2;
            const toPage = msg.to === 1 ? pg1 : pg2;
            const fromUser = msg.from === 1 ? user1 : user2;
            const toUser = msg.to === 1 ? user1 : user2;

            await sendMessageTo(fromPage, toUser, msg.content);
            await checkReceivedMessage(toPage, fromUser, msg.content);
        }

        // Provide the setup to the test
        await use({
            users: {
                user1: {
                    username: user1,
                    context: ctx1,
                    page: pg1
                },
                user2: {
                    username: user2,
                    context: ctx2,
                    page: pg2
                }
            },
            messages
        });

        // Clean up after the test
        await ctx1.close();
        await ctx2.close();
    }
});

test.describe('Message Saving Tests', () => {

    test('should save messages on sign out', async ({ messageUsers }) => {
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            // Explicitly sign out both users
            // Sign out user1
            await user1.page.click('#toggleMenu');
            await expect(user1.page.locator('#menuModal')).toBeVisible();
            await user1.page.click('#handleSignOut');
            await expect(user1.page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });

            // Sign out user2
            await user2.page.click('#toggleMenu');
            await expect(user2.page.locator('#menuModal')).toBeVisible();
            await user2.page.click('#handleSignOut');
            await expect(user2.page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });

            // Check that messages ARE present in localStorage after signing out
            const user1LocalStorage = await getLocalStorage(user1.page);
            const user2LocalStorage = await getLocalStorage(user2.page);
            const storedUser1Messages = getUserAuthoredMessagesBetweenUsers(
                user1LocalStorage,
                user1.username,
                user2.username
            );
            const storedUser2Messages = getUserAuthoredMessagesBetweenUsers(
                user2LocalStorage,
                user2.username,
                user1.username
            );

            // When signing out, messages should still be in localStorage
            expectStoredMessages(storedUser1Messages, messages, 1);
            expectStoredMessages(storedUser2Messages, messages, 2);

            // Sign back in as both users (should automatically sign in from localStorage)
            // Sign in user1
            await user1.page.click('#signInButton');
            await expect(user1.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            // Sign in user2
            await user2.page.click('#signInButton');
            await expect(user2.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });


            // Verify both sent and received messages persisted for user1 after sign out and sign in
            await user1.page.click('#switchToChats');
            await expect(user1.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem1 = user1.page.locator('.chat-name', { hasText: user2.username });
            await expect(chatItem1).toBeVisible({ timeout: 15_000 });
            await chatItem1.click();
            await expect(user1.page.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(user1.page, messages, 1);

            // Also verify user2's messages are still available
            await user2.page.click('#switchToChats');
            await expect(user2.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(user2.page.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(user2.page, messages, 2);

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });

    test('should save messages when browser is closed', async ({ messageUsers }) => {
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            // Close both users' pages (but keep their contexts)
            await user1.page.close();
            await user2.page.close();

            // Open new pages in the same contexts for both users
            const newPage1 = await user1.context.newPage();
            const newPage2 = await user2.context.newPage();

            // After reopening, should be at welcome screen
            await newPage1.goto('');
            await newPage1.waitForSelector('#welcomeScreen', { timeout: 30_000 });
            await newPage2.goto('');
            await newPage2.waitForSelector('#welcomeScreen', { timeout: 30_000 });

            // Check that messages remain in localStorage before signing in
            const user1LocalStorage = await getLocalStorage(newPage1);
            const user2LocalStorage = await getLocalStorage(newPage2);
            const storedUser1Messages = getUserAuthoredMessagesBetweenUsers(
                user1LocalStorage,
                user1.username,
                user2.username
            );
            const storedUser2Messages = getUserAuthoredMessagesBetweenUsers(
                user2LocalStorage,
                user2.username,
                user1.username
            );
            expectStoredMessages(storedUser1Messages, messages, 1);
            expectStoredMessages(storedUser2Messages, messages, 2);

            // Now click sign in for both users
            await newPage1.click('#signInButton');
            await expect(newPage1.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            await newPage2.click('#signInButton');
            await expect(newPage2.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            // Verify both sent and received messages persisted for user1 after reopening
            await newPage1.click('#switchToChats');
            await expect(newPage1.locator('#chatsScreen.active')).toBeVisible();
            const chatItem1 = newPage1.locator('.chat-name', { hasText: user2.username });
            await expect(chatItem1).toBeVisible({ timeout: 15_000 });
            await chatItem1.click();
            await expect(newPage1.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(newPage1, messages, 1);

            // Also verify user2's messages are still available
            await newPage2.click('#switchToChats');
            await expect(newPage2.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = newPage2.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(newPage2.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(newPage2, messages, 2);

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });

    test('should save messages after refreshing the page', async ({ messageUsers }) => {
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            // Refresh both users' pages
            await user1.page.reload();
            await expect(user1.page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });

            await user2.page.reload();
            await expect(user2.page.locator('#welcomeScreen')).toBeVisible({ timeout: 30_000 });

            // Check that messages ARE present in localStorage after refreshing
            const user1LocalStorage = await getLocalStorage(user1.page);
            const user2LocalStorage = await getLocalStorage(user2.page);
            const storedUser1Messages = getUserAuthoredMessagesBetweenUsers(
                user1LocalStorage,
                user1.username,
                user2.username
            );
            const storedUser2Messages = getUserAuthoredMessagesBetweenUsers(
                user2LocalStorage,
                user2.username,
                user1.username
            );
            expectStoredMessages(storedUser1Messages, messages, 1);
            expectStoredMessages(storedUser2Messages, messages, 2);

            // sign in
            await user1.page.click('#signInButton');
            await expect(user1.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
            await user2.page.click('#signInButton');
            await expect(user2.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            // Verify both sent and received messages persisted for user1 after refresh
            const chatItem1 = user1.page.locator('.chat-name', { hasText: user2.username });
            await expect(chatItem1).toBeVisible({ timeout: 15_000 });
            await chatItem1.click();
            await expect(user1.page.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(user1.page, messages, 1);

            // Also verify user2's messages are still available
            await expect(user2.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(user2.page.locator('#chatModal')).toBeVisible();

            await expectRenderedMessages(user2.page, messages, 2);

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });
});
