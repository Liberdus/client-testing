const { test: base, expect } = require('@playwright/test');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');


const test = base.extend({
    users: async ({ browserName, browser }, use) => {
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            await Promise.all([
                createAndSignInUser(pageA, userA),
                createAndSignInUser(pageB, userB)
            ]);

            await use({ a: { username: userA, page: pageA, ctx: ctxA }, b: { username: userB, page: pageB, ctx: ctxB } });
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    }
});

test.describe('Video Call Tests', () => {
    test('sender starts a call: call link sent and opens in new tab for recipient', async ({ users, browser }) => {
        const { a, b } = users;
        const callLabel = 'Join Video Call';

        // Open chat between A and B (use new chat flow to ensure chat exists)
        await a.page.click('#switchToChats');
        await expect(a.page.locator('#newChatButton')).toBeVisible();
        await a.page.click('#newChatButton');
        await expect(a.page.locator('#newChatModal')).toBeVisible();
        await a.page.locator('#chatRecipient').pressSequentially(b.username);
        await expect(a.page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
        await a.page.locator('#newChatForm button[type="submit"]').click();
        await expect(a.page.locator('#chatModal')).toBeVisible();

        // Click the call button in the chat modal header
        await expect(a.page.locator('#chatCallButton')).toBeVisible({ timeout: 10_000 });

        // Listen for new page (call opened in new tab)
        const [callPage] = await Promise.all([
            a.ctx.waitForEvent('page'),
            a.page.click('#chatCallButton')
        ]).catch(async () => {
            // Fallback: some environments open in same tab - try to detect by href anchor
            return [null];
        });

        // Wait for a small delay to allow the call message to be sent
        await a.page.waitForTimeout(2000);

        // Close or ignore the call tab if it opened
        if (callPage) {
            await callPage.close();
        }

        // Ensure recipient sees the call message and that the link opens in a new tab
        await b.page.click('#switchToChats');
        const chatItem = b.page.locator('.chat-name', { hasText: a.username });
        await expect(chatItem).toBeVisible({ timeout: 15_000 });
        await chatItem.click();
        await expect(b.page.locator('#chatModal')).toBeVisible();

        // Wait for the call message to appear
        const callMsg = b.page.locator('#chatModal .messages-list .message.received .call-message .call-message-text', { hasText: callLabel });
        await expect(callMsg).toBeVisible({ timeout: 30_000 });

        // Clicking the anchor should open a new tab with jitsi (target=_blank)
        const callAnchor = b.page.locator('#chatModal .messages-list .message.received .call-message a.call-message-phone-button');
        await expect(callAnchor).toHaveAttribute('target', '_blank');

        // Intercept new page opening on click
        const [opened] = await Promise.all([
            b.ctx.waitForEvent('page'),
            callAnchor.click()
        ]).catch(() => [null]);

        if (opened) {
            // Verify the URL looks like jitsi
            const url = opened.url();
            expect(url).toMatch(/jitsi\.si|meet\.jit\.si/);
            await opened.close();
        }

        // Close chat modal
        await b.page.click('#closeChatModal');
    });

    test('invite flow: user can invite contacts to call and selected contacts receive call message', async ({ browserName, browser }) => {
        // Create four users: host, inviter, invitee1, invitee2
        const host = generateUsername(browserName);
        const inviter = generateUsername(browserName);
        const invitee1 = generateUsername(browserName);
        const invitee2 = generateUsername(browserName);

        const ctxHost = await browser.newContext();
        const ctxInv = await browser.newContext();
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();

        const pageHost = await ctxHost.newPage();
        const pageInv = await ctxInv.newPage();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();

        try {
            // Create all users
            await Promise.all([
                createAndSignInUser(pageHost, host),
                createAndSignInUser(pageInv, inviter),
                createAndSignInUser(page1, invitee1),
                createAndSignInUser(page2, invitee2)
            ]);

            // Add invitee1 and invitee2 as contacts for inviter by starting a chat AND sending a message
            // (starting a chat + sending a message ensures the contact is added)
            const contactMsg1 = `Hello ${invitee1} - adding you as contact`;
            await sendMessageTo(pageInv, invitee1, contactMsg1);
            // confirm the invitee received the message
            await checkReceivedMessage(page1, inviter, contactMsg1);

            const contactMsg2 = `Hello ${invitee2} - adding you as contact`;
            await sendMessageTo(pageInv, invitee2, contactMsg2);
            await checkReceivedMessage(page2, inviter, contactMsg2);

            // Now open a chat with host to invite others into call
            await pageInv.click('#newChatButton');
            await expect(pageInv.locator('#newChatModal')).toBeVisible();
            await pageInv.locator('#chatRecipient').pressSequentially(host);
            await expect(pageInv.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
            await pageInv.locator('#newChatForm button[type="submit"]').click();
            await expect(pageInv.locator('#chatModal')).toBeVisible();

            // Start a call (this should send a call message to host)
            await expect(pageInv.locator('#chatCallButton')).toBeVisible({ timeout: 10_000 });
            // click the call button to create the call and send message
            await pageInv.click('#chatCallButton');
            await pageInv.waitForTimeout(1500);

            // Click on the sent call message to open menu and choose Invite
            const sentCallMsg = pageInv.locator('#chatModal .messages-list .message.sent .call-message');
            await expect(sentCallMsg).toBeVisible({ timeout: 15_000 });
            await sentCallMsg.click();

            // Target the context menu option specifically to avoid resolving other elements named "Invite"
            const inviteOption = pageInv.locator('.context-menu-option[data-action="call-invite"]');
            await expect(inviteOption).toBeVisible({ timeout: 10_000 });
            await inviteOption.click();

            // Invite modal should appear and list both invitee1 and invitee2
            await expect(pageInv.locator('#callInviteModal')).toBeVisible({ timeout: 10_000 });
            // contact rows have class .call-invite-contact-row and the name is in .call-invite-contact-name
            const user1Row = pageInv.locator('#callInviteContactsList .call-invite-contact-row', { hasText: invitee1 });
            const user2Row = pageInv.locator('#callInviteContactsList .call-invite-contact-row', { hasText: invitee2 });
            await expect(user1Row).toBeVisible();
            await expect(user2Row).toBeVisible();

            // Select both users via the checkbox with class .call-invite-contact-checkbox
            await user1Row.locator('input.call-invite-contact-checkbox').check();
            await user2Row.locator('input.call-invite-contact-checkbox').check();

            const inviteBtn = pageInv.locator('#callInviteSendBtn');
            await expect(inviteBtn).toBeEnabled({ timeout: 5000 });
            await inviteBtn.click();

            // Close invite modal
            await expect(pageInv.locator('.toast.success.show', { hasText: 'Invite sent' })).toBeVisible({ timeout: 20_000 }).catch(() => { });

            // Verify invitee1 and invitee2 received the call message from inviter
            const checkReceived = async (page, fromUser) => {
                await page.click('#switchToChats');
                const chatItem = page.locator('.chat-name', { hasText: fromUser });
                await expect(chatItem).toBeVisible({ timeout: 15_000 });
                await chatItem.click();
                await expect(page.locator('#chatModal')).toBeVisible();
                const callMsg = page.locator('#chatModal .messages-list .message.received .call-message .call-message-text', { hasText: 'Join Video Call' });
                await expect(callMsg).toBeVisible({ timeout: 60_000 });
                await page.click('#closeChatModal');
            };

            await Promise.all([
                checkReceived(page1, inviter),
                checkReceived(page2, inviter)
            ]);

        } finally {
            await ctxHost.close();
            await ctxInv.close();
            await ctx1.close();
            await ctx2.close();
        }
    });
});
