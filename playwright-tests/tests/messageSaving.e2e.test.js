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

test.describe('Message Persistence Tests', () => {

    test('should persist messages after both users explicitly sign out and sign back in', async ({ messageUsers }) => {
        // messageUsers fixture already set up the users and exchanged messages
        const { users: { user1, user2 }, messages } = messageUsers;

        try {
            // Get expected messages for each user
            const expectedUser1Messages = [
                messages[0].content, // sent
                messages[1].content, // received
                messages[2].content, // sent
                messages[3].content  // received
            ];
            const expectedUser2Messages = [
                messages[0].content, // received
                messages[1].content, // sent
                messages[2].content, // received
                messages[3].content  // sent
            ];

            // Step 3: Explicitly sign out both users
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

            // Step 4: Sign back in as both users (should automatically sign in from localStorage)
            // Sign in user1
            await user1.page.click('#signInButton');
            await expect(user1.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

            // Sign in user2
            await user2.page.click('#signInButton');
            await expect(user2.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });


            // Step 5: Verify both sent and received messages persisted for user1 after sign out and sign in
            await user1.page.click('#switchToChats');
            await expect(user1.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem1 = user1.page.locator('.chat-name', { hasText: user2.username });
            await expect(chatItem1).toBeVisible({ timeout: 15_000 });
            await chatItem1.click();
            await expect(user1.page.locator('#chatModal')).toBeVisible();

            // Explicitly check message count and content for user1
            const user1Messages = await user1.page.locator('#chatModal .messages-list .message').allTextContents();
            expect(user1Messages.length).toBe(expectedUser1Messages.length);
            for (let i = 0; i < expectedUser1Messages.length; i++) {
                expect(user1Messages[i]).toContain(expectedUser1Messages[i]);
            }

            // Step 6: Also verify user2's messages are still available
            await user2.page.click('#switchToChats');
            await expect(user2.page.locator('#chatsScreen.active')).toBeVisible();
            const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
            await expect(chatItem2).toBeVisible({ timeout: 15_000 });
            await chatItem2.click();
            await expect(user2.page.locator('#chatModal')).toBeVisible();

            // Explicitly check message count and content for user2
            const user2Messages = await user2.page.locator('#chatModal .messages-list .message').allTextContents();
            expect(user2Messages.length).toBe(expectedUser2Messages.length);
            for (let i = 0; i < expectedUser2Messages.length; i++) {
                expect(user2Messages[i]).toContain(expectedUser2Messages[i]);
            }

        } finally {
            await user1.context.close();
            await user2.context.close();
        }
    });

    // test('should persist messages when closing and reopening browser without signing out', async ({ messageUsers, browserName, browser }) => {
    //     // messageUsers fixture already set up the users and exchanged messages
    //     const { users: { user1, user2 }, messages } = messageUsers;

    //     try {

    //         // Step 3: Close pages only (simulating closing the browser tab without signing out)
    //         await pg1.close();
    //         await pg2.close();

    //         // Step 4: Create new pages in the same contexts (preserving localStorage)
    //         pg1 = await ctx1.newPage();
    //         pg2 = await ctx2.newPage();

    //         // Step 5: Navigate to the app (should show welcome screen first)
    //         await pg1.goto('', { waitUntil: 'networkidle' });
    //         await pg2.goto('', { waitUntil: 'networkidle' });

    //         // Step 6: Verify each user sees welcome screen first
    //         await expect(pg1.locator('#welcomeScreen')).toBeVisible({ timeout: 20_000 });
    //         await expect(pg2.locator('#welcomeScreen')).toBeVisible({ timeout: 20_000 });

    //         // Step 7: Click sign in button for both users (should automatically sign in from localStorage)
    //         await pg1.click('#signInButton');
    //         await pg2.click('#signInButton');

    //         // Step 8: Verify users are now on the chat screen
    //         await expect(pg1.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    //         const appName1 = await pg1.locator('.app-name').textContent();
    //         expect(appName1.trim()).toBe(user1.username);

    //         await expect(pg2.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    //         const appName2 = await pg2.locator('.app-name').textContent();
    //         expect(appName2.trim()).toBe(user2.username);

    //         // Step 9: Verify all messages persisted for user1 (both sent and received)
    //         // Open the chat with user2 for user1
    //         await pg1.click('#switchToChats');
    //         await expect(pg1.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem1 = pg1.locator('.chat-name', { hasText: user2.username });
    //         await expect(chatItem1).toBeVisible({ timeout: 15_000 });
    //         await chatItem1.click();
    //         await expect(pg1.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user1
    //         await expect(pg1.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.sent: "${messages[0].content}"
    //             - message.received: "${messages[1].content}"
    //             - message.sent: "${messages[2].content}"
    //             - message.received: "${messages[3].content}"
    //         `);
    //         await pg1.click('#closeChatModal');

    //         // Verify all messages persisted for user2
    //         await pg2.click('#switchToChats');
    //         await expect(pg2.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem2 = pg2.locator('.chat-name', { hasText: user1.username });
    //         await expect(chatItem2).toBeVisible({ timeout: 15_000 });
    //         await chatItem2.click();
    //         await expect(pg2.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user2
    //         await expect(pg2.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.received: "${messages[0].content}"
    //             - message.sent: "${messages[1].content}"
    //             - message.received: "${messages[2].content}"
    //             - message.sent: "${messages[3].content}"
    //         `);
    //         await pg2.click('#closeChatModal');

    //     } catch (error) {
    //         throw error;
    //     }
    // });

    // test('should persist messages after browser refresh', async ({ messageUsers }) => {
    //     // messageUsers fixture already set up the users and exchanged messages
    //     const { users: { user1, user2 }, messages } = messageUsers;

    //     try {

    //         // Refresh browsers for both users
    //         await user1.page.reload({ waitUntil: 'networkidle' });
    //         await user2.page.reload({ waitUntil: 'networkidle' });

    //         // Verify both users are still logged in
    //         await expect(user1.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    //         await expect(user2.page.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    //         // Verify both sent and received messages persisted for user1 after refresh
    //         await user1.page.click('#switchToChats');
    //         await expect(user1.page.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem1 = user1.page.locator('.chat-name', { hasText: user2.username });
    //         await expect(chatItem1).toBeVisible({ timeout: 15_000 });
    //         await chatItem1.click();
    //         await expect(user1.page.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user1
    //         await expect(user1.page.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.sent: "${messages[0].content}"
    //             - message.received: "${messages[1].content}"
    //             - message.sent: "${messages[2].content}"
    //             - message.received: "${messages[3].content}"
    //         `);
    //         await user1.page.click('#closeChatModal');

    //         // Verify both sent and received messages persisted for user2 after refresh
    //         await user2.page.click('#switchToChats');
    //         await expect(user2.page.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem2 = user2.page.locator('.chat-name', { hasText: user1.username });
    //         await expect(chatItem2).toBeVisible({ timeout: 15_000 });
    //         await chatItem2.click();
    //         await expect(user2.page.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user2
    //         await expect(user2.page.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.received: "${messages[0].content}"
    //             - message.sent: "${messages[1].content}"
    //             - message.received: "${messages[2].content}"
    //             - message.sent: "${messages[3].content}"
    //         `);
    //         await pg2.click('#closeChatModal');

    //     } catch (error) {
    //         throw error;
    //     }
    // });

    // test('should add new messages to existing conversation after page reload', async ({ messageUsers }) => {
    //     // messageUsers fixture already set up the users and exchanged messages
    //     const { users: { user1, user2 }, messages } = messageUsers;
    //     const newMsgAfterReload = 'New message after page reload';

    //     try {

    //         // Close pages only (keeping the contexts with localStorage)
    //         await user1.page.close();
    //         await user2.page.close();

    //         // Create new pages in the same contexts
    //         pg1 = await user1.context.newPage();
    //         pg2 = await user2.context.newPage();

    //         // Navigate back to the app
    //         await pg1.goto('', { waitUntil: 'networkidle' });
    //         await pg2.goto('', { waitUntil: 'networkidle' });

    //         // Verify welcome screen appears first
    //         await expect(pg1.locator('#welcomeScreen')).toBeVisible({ timeout: 20_000 });
    //         await expect(pg2.locator('#welcomeScreen')).toBeVisible({ timeout: 20_000 });

    //         // Click sign in button (should automatically sign in from localStorage)
    //         await pg1.click('#signInButton');
    //         await pg2.click('#signInButton');

    //         // Verify users are now on chat screen
    //         await expect(pg1.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });
    //         await expect(pg2.locator('#chatsScreen')).toBeVisible({ timeout: 20_000 });

    //         // Send new message after reload
    //         await sendMessageTo(pg2, user1.username, newMsgAfterReload);

    //         // Verify all messages exist in the conversation for both users

    //         // Open chat for user1
    //         await pg1.click('#switchToChats');
    //         await expect(pg1.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem1 = pg1.locator('.chat-name', { hasText: user2.username });
    //         await expect(chatItem1).toBeVisible({ timeout: 15_000 });
    //         await chatItem1.click();
    //         await expect(pg1.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user1, including the new message
    //         await expect(pg1.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.sent: "${messages[0].content}"
    //             - message.received: "${messages[1].content}"
    //             - message.sent: "${messages[2].content}"
    //             - message.received: "${messages[3].content}"
    //             - message.received: "${newMsgAfterReload}"
    //         `);
    //         await pg1.click('#closeChatModal');

    //         // Open chat for user2
    //         await pg2.click('#switchToChats');
    //         await expect(pg2.locator('#chatsScreen.active')).toBeVisible();
    //         const chatItem2 = pg2.locator('.chat-name', { hasText: user1.username });
    //         await expect(chatItem2).toBeVisible({ timeout: 15_000 });
    //         await chatItem2.click();
    //         await expect(pg2.locator('#chatModal')).toBeVisible();

    //         // Use toMatchAriaSnapshot to check all messages for user2, including the new message
    //         await expect(pg2.locator('#chatModal .messages-list')).toMatchAriaSnapshot(`
    //             - message.received: "${messages[0].content}"
    //             - message.sent: "${messages[1].content}"
    //             - message.received: "${messages[2].content}"
    //             - message.sent: "${messages[3].content}"
    //             - message.sent: "${newMsgAfterReload}"
    //         `);
    //         await pg2.click('#closeChatModal');

    //     } catch (error) {
    //         throw error;
    //     }
    // });
});
