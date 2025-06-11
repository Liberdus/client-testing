const { test: base, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLiberdusBalance } = require('../helpers/walletHelpers');
const { sendMessageTo } = require('../helpers/messageHelpers');

// Constants
const NETWORK_FEE = 0.1; // Default network fee for transactions
const TOLL = 10;

const test = base.extend({
    users: async ({ browser, browserName }, use, testInfo) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);

        // Attach both usernames to the report
        await testInfo.attach('test-users.json', {
            body: JSON.stringify({ userA, userB }, null, 2),
            contentType: 'application/json'
        });

        try {
            await Promise.all([
                createAndSignInUser(pageA, userA),
                createAndSignInUser(pageB, userB)
            ]);
            // User B starts chat and messages user A
            await sendMessageTo(pageB, userA, 'init chat from B');
            // wait for User A to receive the message
            await pageA.click('#switchToChats');
            await expect(
                pageA.locator('#chatList .chat-name', { hasText: userB })
            ).toBeVisible({ timeout: 15_000 });
            // User A sets a toll
            await pageA.click('#toggleMenu');
            await expect(pageA.locator('#menuModal')).toBeVisible({ timeout: 5_000 });
            await pageA.click('#openToll');
            await expect(pageA.locator('#tollModal')).toBeVisible({ timeout: 5_000 });
            await pageA.fill('#newTollAmountInput', TOLL.toString());
            await pageA.click('#saveNewTollButton');
            await pageA.click('#closeTollModal');
            await pageA.click('#closeMenu');
            await use({
                a: { username: userA, page: pageA, ctx: ctxA },
                b: { username: userB, page: pageB, ctx: ctxB },
            });
        } finally {
            // Ensure we close the pages and contexts even if test fails
            await ctxA.close();
            await ctxB.close();
        }
    }
});

test.describe('Friend Status E2E', () => {
    test('Block: User A blocks User B, B cannot message', async ({ users }) => {
        const { a, b } = users;

        // User A blocks User B
        await a.page.click('#switchToContacts');
        await expect(a.page.locator('#contactsScreen.active')).toBeVisible();
        await a.page.locator('#contactsList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#contactInfoModal.active')).toBeVisible();
        await a.page.click('#addFriendButtonContactInfo');
        await expect(a.page.locator('#friendModal.active')).toBeVisible();
        await a.page.check('#friendForm input[type=radio][value="0"]');
        await a.page.click('#friendForm button[type="submit"]');
        await a.page.waitForTimeout(5_000); // wait for block to propagate
        await a.page.click('#closeContactInfoModal');
        // User B should not be able to send a message
        // go to contacts tab and back to refresh chat list
        await b.page.click('#switchToChats');
        await b.page.locator('#chatList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#chatModal')).toBeVisible();
        await expect(b.page.locator('#tollValue')).toHaveText('blocked');
        await b.page.locator('#chatModal .message-input').fill('blocked msg');
        await b.page.click('#handleSendMessage');
        // expect an error toast to appear ignore inner text
        const errorToast = await b.page.locator('.toast.error.show').textContent();
        expect(errorToast).toContain('You are blocked by this user');
    });

    test('Acquaintance: B sends message, A receives, only network fee charged', async ({ users }) => {
        const { a, b } = users;

        // User A sets status to Acquaintance
        await a.page.click('#switchToContacts');
        await expect(a.page.locator('#contactsScreen.active')).toBeVisible();
        await a.page.locator('#contactsList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#contactInfoModal.active')).toBeVisible();
        await a.page.click('#addFriendButtonContactInfo');
        await expect(a.page.locator('#friendModal.active')).toBeVisible();
        await a.page.check('#friendForm input[type=radio][value="2"]'); // Acquaintance
        await a.page.click('#friendForm button[type="submit"]');
        await a.page.click('#closeContactInfoModal');
        // Get balance for both users
        await a.page.click('#switchToWallet');
        const userABalanceBefore = await getLiberdusBalance(a.page);
        await b.page.click('#switchToWallet');
        const userBBalanceBefore = await getLiberdusBalance(b.page);

        // User B sends message
        await b.page.click('#switchToChats');
        await b.page.locator('#chatList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#chatModal')).toBeVisible();
        const msgFromB = 'acquaintance msg';
        await b.page.type('#chatModal .message-input', msgFromB);
        await b.page.click('#handleSendMessage');
        await b.page.click('#closeChatModal');

        // User A receives message
        await a.page.click('#switchToChats');
        await a.page.locator('#chatList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#chatModal')).toBeVisible();
        await expect(a.page.locator('#chatModal .messages-list .message.received')).toHaveCount(2, {timeout: 15000});
        // close chat modal to send read receipt
        await a.page.click('#closeChatModal');


        // User A checks balance after
        await a.page.click('#switchToWallet');
        const userABalanceAfter = await getLiberdusBalance(a.page);
        await b.page.click('#switchToWallet');
        const userBBalanceAfter = await getLiberdusBalance(b.page);
        // User A should have paid only the network fee for reading the message
        const expectedBalanceA = (userABalanceBefore - NETWORK_FEE).toFixed(6);
        expect(userABalanceAfter).toEqual(expectedBalanceA);
        // User B should have paid only the network fee for sending the message
        const expectedBalanceB = (userBBalanceBefore - NETWORK_FEE).toFixed(6);
        expect(userBBalanceAfter).toEqual(expectedBalanceB);
    });

    test('Friend: A fills profile, sets status Friend, B sees full profile', async ({ users }) => {
        const { a, b } = users;
        const name = a.username + 'Name';
        const email = a.username + '@example.com';
        const phone = '5555555555';
        const linkedin = a.username + 'LinkedIn';
        const x = a.username + 'X';

        // User A fills out profile
        await a.page.click('#toggleMenu');
        await a.page.getByText('Profile', { exact: true }).click();
        await a.page.fill('#name', name);
        await a.page.fill('#email', email);
        await a.page.fill('#phone', phone);
        await a.page.fill('#linkedin', linkedin);
        await a.page.fill('#x', x);
        await a.page.click('#accountModal button[type="submit"]');
        // await a.page.waitForTimeout(5_000);
        await a.page.click('#closeMenu');

        // Set friend status to Friend
        await a.page.click('#switchToContacts');
        await expect(a.page.locator('#contactsScreen.active')).toBeVisible();
        await a.page.locator('#contactsList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#contactInfoModal.active')).toBeVisible();
        await a.page.click('#addFriendButtonContactInfo');
        await expect(a.page.locator('#friendModal.active')).toBeVisible();
        await a.page.check('#friendForm input[type=radio][value="3"]'); // Friend
        await a.page.click('#friendForm button[type="submit"]');
        await a.page.click('#closeContactInfoModal');

        // User A sends a message so profile is sent
        await a.page.click('#switchToChats');
        await a.page.locator('#chatList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#chatModal')).toBeVisible();
        await a.page.fill('#chatModal .message-input', 'From A after profile update.');
        await a.page.click('#handleSendMessage');

        // User B opens chat and waits for message
        await b.page.click('#switchToChats');
        await b.page.locator('#chatList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#chatModal')).toBeVisible();
        await expect(b.page.locator('#chatModal .messages-list .message.received')).toHaveCount(1, {timeout: 15000});

        // User B opens contact info for A and sees full profile
        await b.page.click('.chat-user-info');
        await expect(b.page.locator("#contactInfoUsername")).toHaveText(a.username);
        await expect(b.page.locator("#contactInfoName")).toHaveText(name);
        await expect(b.page.locator("#contactInfoEmail")).toHaveText(email);
        await expect(b.page.locator("#contactInfoPhone")).toHaveText(phone);
        await expect(b.page.locator("#contactInfoLinkedin")).toHaveText(linkedin);
        await expect(b.page.locator("#contactInfoX")).toHaveText(x);
    });
});