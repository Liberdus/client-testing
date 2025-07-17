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

        // Define 4 alternating messages
        const messages = [
            { from: 1, to: 2, content: `Message 1 from ${user1} to ${user2}` },
            { from: 2, to: 1, content: `Message 2 from ${user2} to ${user1}` },
            { from: 1, to: 2, content: `Message 3 from ${user1} to ${user2}` },
            { from: 2, to: 1, content: `Message 4 from ${user2} to ${user1}` }
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

    test('should save messages after both users explicitly sign out and sign back in', async ({ messageUsers }) => {
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            const expectedMessages = [
                messages[0].content,
                messages[1].content,
                messages[2].content,
                messages[3].content 
            ];

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

            // Explicitly check message count and content for user1
            const user1Messages = await user1.page.locator('#chatModal .messages-list .message').allTextContents();
            expect(user1Messages.length).toBe(expectedMessages.length);
            for (let i = 0; i < expectedMessages.length; i++) {
                expect(user1Messages[i]).toContain(expectedMessages[i]);
            }

            // Also verify user2's messages are still available
            await user2.page.click('#switchToChats');
            await expect(user2.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(user2.page.locator('#chatModal')).toBeVisible();

            // Explicitly check message count and content for user2
            const user2Messages = await user2.page.locator('#chatModal .messages-list .message').allTextContents();
            expect(user2Messages.length).toBe(expectedMessages.length);
            for (let i = 0; i < expectedMessages.length; i++) {
                expect(user2Messages[i]).toContain(expectedMessages[i]);
            }

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });

    test('should save messages after closing and reopening the page', async ({ messageUsers }) => {
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            const expectedMessages = [
                messages[0].content,
                messages[1].content,
                messages[2].content,
                messages[3].content 
            ];

            // Close both users' pages (but keep their contexts)
            await user1.page.close();
            await user2.page.close();

            // Open new pages in the same contexts for both users
            const newPage1 = await user1.context.newPage();
            const newPage2 = await user2.context.newPage();

            // After reopening, should be at welcome screen, click sign in for both users
            await newPage1.goto('');
            await newPage1.waitForSelector('#welcomeScreen', { timeout: 30_000 });
            await newPage1.click('#signInButton');
            await expect(newPage1.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            await newPage2.goto('');
            await newPage2.waitForSelector('#welcomeScreen', { timeout: 30_000 });
            await newPage2.click('#signInButton');
            await expect(newPage2.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            // Verify both sent and received messages persisted for user1 after reopening
            await newPage1.click('#switchToChats');
            await expect(newPage1.locator('#chatsScreen.active')).toBeVisible();
            const chatItem1 = newPage1.locator('.chat-name', { hasText: user2.username });
            await expect(chatItem1).toBeVisible({ timeout: 15_000 });
            await chatItem1.click();
            await expect(newPage1.locator('#chatModal')).toBeVisible();

            // Explicitly check message count and content for user1
            const user1Messages = await newPage1.locator('#chatModal .messages-list .message').allTextContents();
            expect(user1Messages.length).toBe(expectedMessages.length);
            for (let i = 0; i < expectedMessages.length; i++) {
                expect(user1Messages[i]).toContain(expectedMessages[i]);
            }

            // Also verify user2's messages are still available
            await newPage2.click('#switchToChats');
            await expect(newPage2.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = newPage2.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(newPage2.locator('#chatModal')).toBeVisible();

            // Explicitly check message count and content for user2
            const user2Messages = await newPage2.locator('#chatModal .messages-list .message').allTextContents();
            expect(user2Messages.length).toBe(expectedMessages.length);
            for (let i = 0; i < expectedMessages.length; i++) {
                expect(user2Messages[i]).toContain(expectedMessages[i]);
            }

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });

});
