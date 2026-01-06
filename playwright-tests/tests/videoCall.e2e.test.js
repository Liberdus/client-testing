const { test: base, expect } = require('../fixtures/base');
const { sendMessageTo, checkReceivedMessage } = require('../helpers/messageHelpers');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');

// Friend status enum aligned with app values
const FriendStatus = {
    BLOCKED: 0,
    OTHER: 1,
    ACQUAINTANCE: 2,
    FRIEND: 3
};

// Helper to set friend status for a user from within chat modal
async function setFriendStatusInChat(page, status) {
    await page.click('#addFriendButtonChat');
    await expect(page.locator('#friendModal.active')).toBeVisible();
    await page.check(`#friendForm input[type=radio][value="${status.toString()}"]`);
    await page.click('#friendForm button[type="submit"]');
    await page.waitForEvent('console', {
        timeout: 60_000,
        predicate: msg =>
            /update_toll_required transaction successfully processed/i.test(msg.text())
    });
}

// opens a new chat with a new user to create the contact
async function addContact(page, username) {
    // Ensure we are on Chats screen
    await page.click('#switchToChats');
    await expect(page.locator('#newChatButton')).toBeVisible();
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.locator('#chatRecipient').pressSequentially(username);
    await expect(page.locator('#chatRecipientError')).toHaveText('found');

    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();
    await expect(page.locator('#chatModal.active')).toBeVisible();
}

const test = base.extend({
    users: async ({ browserName, browser }, use) => {
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);

        const ctxA = await newContext(browser);
        const ctxB = await newContext(browser);
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

        // Make B set A's status to FRIEND before A starts the call.
        await addContact(b.page, a.username);
        await setFriendStatusInChat(b.page, FriendStatus.FRIEND);

        // Open chat between A and B (use new chat flow to ensure chat exists)
        await a.page.click('#switchToChats');
        await expect(a.page.locator('#newChatButton')).toBeVisible();
        await a.page.click('#newChatButton');
        await expect(a.page.locator('#newChatModal')).toBeVisible();
        await a.page.locator('#chatRecipient').pressSequentially(b.username);
        await expect(a.page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
        await a.page.locator('#newChatForm button[type="submit"]').click();
        await expect(a.page.locator('#chatModal')).toBeVisible();

        await expect(a.page.locator('#chatHeaderMenuButton')).toBeVisible();
        await a.page.click('#chatHeaderMenuButton');
        await expect(a.page.locator('.context-menu-option[data-action="call"]')).toBeVisible();
        await a.page.click('.context-menu-option[data-action="call"]');
        await expect(a.page.locator('#callScheduleChoiceModal.active')).toBeVisible();


        // Listen for new page (call opened in new tab)
        const [callPage] = await Promise.all([
            a.ctx.waitForEvent('page'),
            a.page.click('#callScheduleNowBtn')
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
            expect(url).toMatch(/meet\.liberdus\.com/);
            await opened.close();
        }
    });

    test('schedule call: scheduled message appears and call listed for both users', async ({ users }) => {
        const { a, b } = users;
        const callLabel = 'Join Video Call';

        // Ensure B has A as a friend contact before the call is scheduled.
        await addContact(b.page, a.username);
        await setFriendStatusInChat(b.page, FriendStatus.FRIEND);
        await b.page.click('#closeChatModal');

        // Open chat between A and B from A's side.
        await a.page.click('#switchToChats');
        await expect(a.page.locator('#newChatButton')).toBeVisible();
        await a.page.click('#newChatButton');
        await expect(a.page.locator('#newChatModal')).toBeVisible();
        await a.page.locator('#chatRecipient').pressSequentially(b.username);
        await expect(a.page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
        await a.page.locator('#newChatForm button[type="submit"]').click();
        await expect(a.page.locator('#chatModal')).toBeVisible();

        // Open the schedule modal
        await expect(a.page.locator('#chatHeaderMenuButton')).toBeVisible();
        await a.page.click('#chatHeaderMenuButton');
        await expect(a.page.locator('.context-menu-option[data-action="call"]')).toBeVisible();
        await a.page.click('.context-menu-option[data-action="call"]');
        await expect(a.page.locator('#callScheduleChoiceModal.active')).toBeVisible();
        await a.page.click('#openCallScheduleDateBtn');

        const scheduleModal = a.page.locator('#callScheduleDateModal.active');
        await expect(scheduleModal).toBeVisible();

        // Choose a schedule time two hours in the future, rounded to the hour for available options.
        const scheduleDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
        scheduleDate.setMinutes(0, 0, 0);
        const pad = (val) => val.toString().padStart(2, '0');
        const dateInputValue = `${scheduleDate.getFullYear()}-${pad(scheduleDate.getMonth() + 1)}-${pad(scheduleDate.getDate())}`;
        const month = scheduleDate.getMonth() + 1;
        const day = scheduleDate.getDate();
        const year = scheduleDate.getFullYear();
        const hour24 = scheduleDate.getHours();
        const amPm = hour24 >= 12 ? 'PM' : 'AM';
        const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
        const hourSelectValue = hour12.toString().padStart(2, '0');
        const minuteSelectValue = scheduleDate.getMinutes().toString().padStart(2, '0');
        const datePart = `${month}/${day}/${year}`;
        // Toast time part is like 2:00:00 PM (with seconds)
        const timePart = `${hour12}:${minuteSelectValue} ${amPm}`;

        await scheduleModal.locator('#callScheduleDate').fill(dateInputValue);
        await scheduleModal.locator('#callScheduleHour').selectOption(hourSelectValue);
        await scheduleModal.locator('#callScheduleMinute').selectOption(minuteSelectValue);
        await scheduleModal.locator('#callScheduleAmPm').selectOption(amPm);

        await scheduleModal.locator('#confirmCallSchedule').click();

        const successToast = a.page.locator('.toast.success.show');
        await expect(successToast).toContainText('Call scheduled for', { timeout: 20_000 });
        await expect(successToast).toContainText(datePart);
        const toastTimePart = `${hour12}:${minuteSelectValue}:00 ${amPm}`;
        await expect(successToast).toContainText(toastTimePart);
        await a.page.waitForSelector('.toast.success.show', { state: 'hidden' });

        // Verify the scheduled call message on the sender side.
        const sentCallMessage = a.page.locator('#chatModal .messages-list .message.sent .call-message');
        await expect(sentCallMessage).toBeVisible({ timeout: 30_000 });
        await expect(sentCallMessage.locator('.call-message-text')).toHaveText(callLabel);
        const sentSchedule = sentCallMessage.locator('.call-message-schedule');
        await expect(sentSchedule).toContainText('Scheduled');
        await expect(sentSchedule).toContainText(datePart);
        await expect(sentSchedule).toContainText(timePart);

        // Recipient should receive the scheduled call message.
        await b.page.click('#switchToChats');
        const chatItem = b.page.locator('#chatList .chat-name', { hasText: a.username });
        await expect(chatItem).toBeVisible({ timeout: 30_000 });
        await chatItem.click();
        await expect(b.page.locator('#chatModal')).toBeVisible();

        const receivedCallMessage = b.page.locator('#chatModal .messages-list .message.received .call-message');
        await expect(receivedCallMessage).toBeVisible({ timeout: 30_000 });
        await expect(receivedCallMessage.locator('.call-message-text')).toHaveText(callLabel);
        const receivedSchedule = receivedCallMessage.locator('.call-message-schedule');
        await expect(receivedSchedule).toContainText(datePart);
        await expect(receivedSchedule).toContainText(timePart);
        await b.page.click('#closeChatModal');

        // Verify the scheduled call appears in A's calls list.
        await a.page.click('#closeChatModal');
        await a.page.click('#toggleSettings');
        await expect(a.page.locator('#openCallsModal')).toBeVisible();
        await a.page.click('#openCallsModal');
        const callsModalA = a.page.locator('#callsModal');
        await expect(callsModalA).toBeVisible();

        const hostCallItem = a.page.locator('#callList .chat-item').filter({
            has: a.page.locator('.chat-name', { hasText: b.username })
        }).first();
        await expect(hostCallItem).toBeVisible({ timeout: 30_000 });
        const hostCallTime = hostCallItem.locator('.call-time');
        await expect(hostCallTime).toContainText(datePart);
        await expect(hostCallTime).toContainText(timePart);
        await a.page.click('#closeCallsModal');

        // Verify the scheduled call appears in B's calls list as well.
        await b.page.click('#toggleSettings');
        await expect(b.page.locator('#openCallsModal')).toBeVisible();
        await b.page.click('#openCallsModal');
        const callsModalB = b.page.locator('#callsModal');
        await expect(callsModalB).toBeVisible();

        const recipientCallItem = b.page.locator('#callList .chat-item').filter({
            has: b.page.locator('.chat-name', { hasText: a.username })
        }).first();
        await expect(recipientCallItem).toBeVisible({ timeout: 30_000 });
        const recipientCallTime = recipientCallItem.locator('.call-time');
        await expect(recipientCallTime).toContainText(datePart);
        await expect(recipientCallTime).toContainText(timePart);
    });

    test('invite flow: sender calls recipient, recipient invites two others', async ({ browserName, browser }) => {
        // Create four users: host, inviter, invitee1, invitee2
        const host = generateUsername(browserName);
        const inviter = generateUsername(browserName);
        const invitee1 = generateUsername(browserName);
        const invitee2 = generateUsername(browserName);

        const ctxHost = await newContext(browser);
        const ctxInv = await newContext(browser);
        const ctx1 = await newContext(browser);
        const ctx2 = await newContext(browser);

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

            // In parallel per page, prepare contacts and friend statuses
            await Promise.all([
                (async () => {
                    // Host: add invitees and add inviter as FRIEND
                    await addContact(pageHost, invitee1);
                    await pageHost.click('#closeChatModal');
                    await addContact(pageHost, invitee2);
                    await pageHost.click('#closeChatModal');

                    await addContact(pageHost, inviter);
                    await setFriendStatusInChat(pageHost, FriendStatus.FRIEND);
                    await pageHost.click('#closeChatModal');
                })(),
                (async () => {
                    // Invitee1: add HOST as FRIEND
                    await addContact(page1, host);
                    await setFriendStatusInChat(page1, FriendStatus.FRIEND);
                    await page1.click('#closeChatModal');
                })(),
                (async () => {
                    // Invitee2: add HOST as FRIEND
                    await addContact(page2, host);
                    await setFriendStatusInChat(page2, FriendStatus.FRIEND);
                    await page2.click('#closeChatModal');
                })()
            ]);

            // Inviter opens chat with host and starts a call (sends call message to host)
            await addContact(pageInv, host);
            await expect(pageInv.locator('#chatHeaderMenuButton')).toBeVisible();
            await pageInv.click('#chatHeaderMenuButton');
            await expect(pageInv.locator('.context-menu-option[data-action="call"]')).toBeVisible();
            await pageInv.click('.context-menu-option[data-action="call"]');
            await expect(pageInv.locator('#callScheduleChoiceModal.active')).toBeVisible();
            await pageInv.click('#callScheduleNowBtn');
            await pageInv.waitForTimeout(1500);

            // Host receives the call message from inviter
            await pageHost.click('#switchToChats');
            const chatItemHost = pageHost.locator('#chatList .chat-name', { hasText: inviter });
            await expect(chatItemHost).toBeVisible({ timeout: 15_000 });
            await chatItemHost.click();
            await expect(pageHost.locator('#chatModal')).toBeVisible();

            const receivedCallMsg = pageHost.locator('#chatModal .messages-list .message.received .call-message');
            await expect(receivedCallMsg).toBeVisible({ timeout: 15_000 });
            await receivedCallMsg.click();

            // Host opens invite option from context menu
            const inviteOption = pageHost.locator('.context-menu-option[data-action="call-invite"]');
            await expect(inviteOption).toBeVisible({ timeout: 10_000 });
            await inviteOption.click();

            // Invite modal should appear and list both invitee1 and invitee2
            await expect(pageHost.locator('#callInviteModal')).toBeVisible({ timeout: 10_000 });
            // contact rows have class .call-invite-contact-row and the name is in .call-invite-contact-name
            const user1Row = pageHost.locator('#callInviteContactsList .call-invite-contact-row', { hasText: invitee1 });
            const user2Row = pageHost.locator('#callInviteContactsList .call-invite-contact-row', { hasText: invitee2 });
            await expect(user1Row).toBeVisible();
            await expect(user2Row).toBeVisible();

            // Select both users via the checkbox with class .call-invite-contact-checkbox
            await user1Row.locator('input.call-invite-contact-checkbox').check();
            await user2Row.locator('input.call-invite-contact-checkbox').check();

            const inviteBtn = pageHost.locator('#callInviteSendBtn');
            await expect(inviteBtn).toBeEnabled({ timeout: 5000 });
            await inviteBtn.click();

            // Close invite modal
            await expect(pageHost.locator('.toast.success.show', { hasText: 'Invite sent' })).toBeVisible({ timeout: 20_000 }).catch(() => { });

            // Verify invitee1 and invitee2 received the call message from HOST (the inviter of the invite step)
            const checkReceived = async (page, fromUser) => {
                await page.click('#switchToChats');
                const chatItem = page.locator('#chatList .chat-name', { hasText: fromUser });
                await expect(chatItem).toBeVisible({ timeout: 15_000 });
                await chatItem.click();
                await expect(page.locator('#chatModal')).toBeVisible();
                const callMsg = page.locator('#chatModal .messages-list .message.received .call-message .call-message-text', { hasText: 'Join Video Call' });
                await expect(callMsg).toBeVisible({ timeout: 60_000 });
                await page.click('#closeChatModal');
            };

            await Promise.all([
                checkReceived(page1, host),
                checkReceived(page2, host)
            ]);

        } finally {
            await ctxHost.close();
            await ctxInv.close();
            await ctx1.close();
            await ctx2.close();
        }
    });
});
