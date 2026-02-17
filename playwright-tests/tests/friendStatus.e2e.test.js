const { test: base, expect } = require('../fixtures/base');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLiberdusBalance } = require('../helpers/walletHelpers');
const { sendMessageTo } = require('../helpers/messageHelpers');
const networkParams = require('../helpers/networkParams');
const { newContext } = require('../helpers/toastHelpers');

// Constants
const NETWORK_FEE = networkParams.networkFeeLib;
// Add 1 wei (1e-18) to default toll using BigInt for full 18 decimal precision
const defaultTollWei = BigInt(Math.round(networkParams.defaultTollUsd * 1e18));
const tollWei = defaultTollWei + 1n;
const tollStr = tollWei.toString().padStart(19, '0');
const TOLL = (tollStr.slice(0, -18) || '0') + '.' + tollStr.slice(-18);
const TOLL_NUM = Number(tollWei) / 1e18;
const DEFAULT_TOLL = networkParams.defaultTollLib;

// enum for friend status
const FriendStatus = {
    BLOCKED: 0,
    OTHER: 1,
    CONNECTION: 2
};

async function setFriendStatus(page, username, status) {
    await page.click('#switchToContacts');
    await expect(page.locator('#contactsScreen.active')).toBeVisible();
    await page.locator('#contactsList .chat-name', { hasText: username }).click();
    await expect(page.locator('#contactInfoModal.active')).toBeVisible();
    await page.click('#addFriendButtonContactInfo');
    await expect(page.locator('#friendModal.active')).toBeVisible();
    await page.check(`#friendForm input[type=radio][value="${status.toString()}"]`);
    await page.click('#friendForm button[type="submit"]');
    await page.waitForEvent('console', {
        timeout: 60_000,
        predicate: msg =>
            /update_toll_required transaction successfully processed/i.test(msg.text())
    });
    await page.click('#closeContactInfoModal');
}

async function setToll(page, amount) {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openToll');
    await expect(page.locator('#tollModal')).toBeVisible();
    // amount can be a string (full precision) or number
    await page.fill('#newTollAmountInput', typeof amount === 'string' ? amount : amount.toString());
    await page.click('#saveNewTollButton');
    await page.waitForEvent('console', {
        timeout: 60_000,
        predicate: msg =>
            /toll transaction successfully processed/i.test(msg.text())
    });
    await page.click('#closeTollModal');
    await page.click('#closeSettings');
}

/**
 * Opens the friend modal for the given username and returns the current friend status value.
 * Closes the modals after retrieving the value.
 * @param {import('@playwright/test').Page} page
 * @param {string} username
 * @returns {Promise<number>} The current friend status value
 */
async function getCurrentFriendStatus(page, username) {
    await page.click('#switchToContacts');
    await expect(page.locator('#contactsScreen.active')).toBeVisible();
    await page.locator('#contactsList .chat-name', { hasText: username }).click();
    await expect(page.locator('#contactInfoModal.active')).toBeVisible();
    await page.click('#addFriendButtonContactInfo');
    await expect(page.locator('#friendModal.active')).toBeVisible();
    const checked = await page.locator('#friendForm input[type=radio]:checked').getAttribute('value');
    await page.click('#closeFriendModal');
    await page.click('#closeContactInfoModal');
    return Number(checked);
}

const test = base.extend({
    users: async ({ browser, browserName }, use, testInfo) => {
        const ctxA = await newContext(browser);
        const ctxB = await newContext(browser);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);
        let balanceA = networkParams.defaultBalance;
        let balanceB = networkParams.defaultBalance;

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
            balanceB -= NETWORK_FEE; // B pays network fee for sending message
            balanceB -= NETWORK_FEE; // B pays network fee for update_toll_required
            balanceB -= DEFAULT_TOLL; // B pays default toll for sending message
            // wait for User A to receive the message
            await pageA.click('#switchToChats');
            await expect(
                pageA.locator('#chatList .chat-name', { hasText: userB })
            ).toBeVisible({ timeout: 15_000 });
            // User A sets a toll
            await setToll(pageA, TOLL);
            balanceA -= NETWORK_FEE; // A pays network fee for setting toll
            await use({
                a: { username: userA, page: pageA, ctx: ctxA, balance: balanceA },
                b: { username: userB, page: pageB, ctx: ctxB, balance: balanceB },
            });
        } finally {
            // Ensure we close the pages and contexts even if test fails
            await ctxA.close();
            await ctxB.close();
        }
    }
});

test.describe('Friend Status E2E', () => {

    test('Should have default statuses Other for User A and Connection for User B', async ({ users }) => {
        const { a, b } = users;

        const [checkedA, checkedB] = await Promise.all([
            getCurrentFriendStatus(a.page, b.username),
            getCurrentFriendStatus(b.page, a.username)
        ]);
        expect(checkedA).toBe(FriendStatus.OTHER);
        expect(checkedB).toBe(FriendStatus.CONNECTION);
    });

    test('Block: User A blocks User B, B cannot message', async ({ users }) => {
        const { a, b } = users;

        // User A blocks User B
        await setFriendStatus(a.page, b.username, FriendStatus.BLOCKED);

        // User B should not be able to send a message
        // go to contacts tab and back to refresh chat list
        await b.page.click('#switchToChats');
        await b.page.locator('#chatList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#chatModal')).toBeVisible();
        await expect(b.page.locator('#tollValue')).toHaveText('blocked');
        await b.page.locator('#chatModal .message-input').fill('blocked msg');
        await b.page.click('#handleSendMessage');
        // expect an error toast to appear ignore inner text
        await expect(b.page.locator('.toast.error.show', { hasText: /You are blocked by this user/i })).toBeVisible({ timeout: 10_000 });
    });

    test('Block: User A blocks User B, B cannot send money', async ({ users }) => {
        const { a, b } = users;
        // User A blocks User B
        await setFriendStatus(a.page, b.username, FriendStatus.BLOCKED);
        // User B tries to send money to User A
        await b.page.click('#switchToWallet');
        await b.page.click('#openSendAssetFormModal');
        await expect(b.page.locator('#sendAssetFormModal')).toBeVisible();
        await b.page.fill('#sendToAddress', a.username);
        await b.page.fill('#sendAmount', '10');
        expect(b.page.locator('#sendAssetFormModal button[type="submit"]')).toBeDisabled();
    });


    test('Connection: B initial toll refunded, no toll for B msg to A', async ({ users }) => {
        const { a, b } = users;
        let expectedBalanceA = a.balance;
        let expectedBalanceB = b.balance;

        // User A sets status to Connection
        await setFriendStatus(a.page, b.username, FriendStatus.CONNECTION);
        expectedBalanceA -= NETWORK_FEE; // A pays network fee for setting friend status
        expectedBalanceB += DEFAULT_TOLL; // toll refunded to B

        // User B sends message
        await b.page.click('#switchToChats');
        await b.page.locator('#chatList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#chatModal')).toBeVisible();
        const msgFromB = 'Connection msg';
        await b.page.type('#chatModal .message-input', msgFromB);
        await b.page.click('#handleSendMessage');
        await b.page.click('#closeChatModal');
        expectedBalanceB -= NETWORK_FEE; // B pays network fee for sending message

        // User A receives message
        await a.page.click('#switchToChats');
        await a.page.locator('#chatList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#chatModal')).toBeVisible();
        await expect(a.page.locator('#chatModal .messages-list .message.received')).toHaveCount(2, { timeout: 15000 });
        // close chat modal to send read receipt
        await a.page.click('#closeChatModal');

        await expect(async () => {
            const actualBalanceA = await getLiberdusBalance(a.page);
            expect(actualBalanceA).toEqual(expectedBalanceA.toFixed(6));
        }).toPass({ timeout: 30000 });
        // User B should have paid only the network fee for sending the message and gets the original toll back
        await expect(async () => {
            const actualBalanceB = await getLiberdusBalance(b.page);
            expect(actualBalanceB).toEqual(expectedBalanceB.toFixed(6));
        }).toPass({ timeout: 30000 });
    });

    test('Connection: A fills profile, sets status Connection, B sees full profile', async ({ users }) => {
        const { a, b } = users;
        const name = "Testername";
        const linkedin = "testerlinkedin";
        const x = "testerx";

        // User B checks A's profile before any updates
        await b.page.click('#switchToContacts');
        await expect(b.page.locator('#contactsScreen.active')).toBeVisible();
        await b.page.locator('#contactsList .chat-name', { hasText: a.username }).click();
        await expect(b.page.locator('#contactInfoModal.active')).toBeVisible();
        // Check that profile fields are not entered
        await expect(b.page.locator("#contactInfoUsername")).toHaveText(a.username);
        await expect(b.page.locator("#contactInfoName")).toHaveText('Not Entered');
        await expect(b.page.locator("#contactInfoProvidedName")).not.toBeVisible();
        await expect(b.page.locator("#contactInfoLinkedin")).not.toBeVisible();
        await expect(b.page.locator("#contactInfoX")).not.toBeVisible();
        await b.page.click('#closeContactInfoModal');


        // User A fills out profile
        await a.page.click('#toggleSettings');
        await a.page.locator('#openAccountForm').click();
        await a.page.fill('#name', name);
        await a.page.fill('#linkedin', linkedin);
        await a.page.fill('#x', x);
        await a.page.click('#accountModal button[type="submit"]');
        await a.page.click('#closeSettings');

        // Set friend status to Connection
        await setFriendStatus(a.page, b.username, FriendStatus.CONNECTION);

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
        await expect(b.page.locator('#chatModal .messages-list .message.received')).toHaveCount(1, { timeout: 15000 });

        // User B opens contact info for A and sees full profile
        await b.page.click('.chat-user-info');
        await expect(b.page.locator("#contactInfoUsername")).toHaveText(a.username);
        await expect(b.page.locator("#contactInfoProvidedName")).toHaveText(name);
        await expect(b.page.locator("#contactInfoLinkedin")).toHaveText(linkedin);
        await expect(b.page.locator("#contactInfoX")).toHaveText(x);
    });

    test('Connection -> Other: Message fails if status changed to require toll', async ({ users }) => {
        const { a, b } = users;

        // User A opens chat with B and types a message but does not send
        await a.page.click('#switchToChats');
        await a.page.locator('#chatList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#chatModal')).toBeVisible();
        await a.page.fill('#chatModal .message-input', 'pending message');

        // User B sets User A's status to OTHER
        await setFriendStatus(b.page, a.username, FriendStatus.OTHER);

        // User A tries to send the message
        await a.page.click('#handleSendMessage');

        // Expect an error toast to appear for User A
        await expect(a.page.locator('.toast.error.show', { hasText: 'toll' })).toBeVisible({ timeout: 15_000 });
    });

    test('Connection -> Blocked: Message fails if blocked', async ({ users }) => {
        const { a, b } = users;

        // User A opens chat with B and types a message but does not send
        await a.page.click('#switchToChats');
        await a.page.locator('#chatList .chat-name', { hasText: b.username }).click();
        await expect(a.page.locator('#chatModal')).toBeVisible();
        await a.page.fill('#chatModal .message-input', 'pending message');

        // User B sets User A's status to BLOCKED
        await setFriendStatus(b.page, a.username, FriendStatus.BLOCKED);

        // User A tries to send the message
        await a.page.click('#handleSendMessage');

        // Expect an error toast to appear for User A
        await expect(a.page.locator('.toast.error.show', { hasText: 'blocked' })).toBeVisible({ timeout: 15_000 });
        // Check that the message is marked as failed
        await expect(a.page.locator('.message.sent', { hasText: 'pending message' })).toHaveAttribute('data-status', 'failed');
    });

    test('Send LIB: status changed to OTHER before submit, error and form persists', async ({ users }) => {
        const { a, b } = users;
        const sendAmount = '1';
        const memo = 'test memo 123';
        // Calculate toll in LIB with full precision using BigInt
        const tollInLibWei = tollWei * BigInt(1e18) / BigInt(Math.round(networkParams.stabilityFactor * 1e18));
        const tollInLibStr = tollInLibWei.toString().padStart(19, '0');
        const tollInLibFull = (tollInLibStr.slice(0, -18) || '0') + '.' + tollInLibStr.slice(-18);
        const tollInLib6 = Number(tollInLibFull).toFixed(6); // 6 decimals for tollMemo display

        // User A opens wallet and prepares send form
        await a.page.click('#switchToWallet');
        await a.page.click('#openSendAssetFormModal');
        await expect(a.page.locator('#sendAssetFormModal')).toBeVisible();
        await a.page.fill('#sendToAddress', b.username);
        await a.page.fill('#sendAmount', sendAmount);
        await a.page.fill('#sendMemo', memo);

        // expect #tollMemo to contain Toll: free
        await expect(a.page.locator('#tollMemo')).toHaveText(/^toll: free/i);

        // Wait for username validation
        await expect(a.page.locator('#sendToAddressError')).toHaveText('found', { timeout: 10_000 });

        // Before A submits, B changes A's status to OTHER
        await setFriendStatus(b.page, a.username, FriendStatus.OTHER);
        await setToll(b.page, TOLL);

        // A submits the send form
        const sendButton = a.page.locator('#sendAssetFormModal button[type="submit"]');
        await expect(sendButton).toBeEnabled();
        await sendButton.click();

        // A gets confirmation modal, submits again
        await expect(a.page.locator('#sendAssetConfirmModal')).toBeVisible();
        await a.page.click('#confirmSendButton');

        // Should get error toast - full 18 decimal precision
        await expect(a.page.locator('.toast.error.show', { hasText: new RegExp(`${tollInLibFull.replace('.', '\\.')}\\s*LIB`, 'i') })).toBeVisible({ timeout: 10_000 });

        // Close confirmation modal if still open
        if (await a.page.locator('#sendAssetConfirmModal').isVisible()) {
            await a.page.click('#closeSendAssetConfirmModal');
        }

        // Should return to send asset modal with same values
        await expect(a.page.locator('#sendAssetFormModal')).toBeVisible();
        await expect(a.page.locator('#sendToAddress')).toHaveValue(b.username);
        await expect(a.page.locator('#sendAmount')).toHaveValue(sendAmount);
        await expect(a.page.locator('#sendMemo')).toHaveValue(memo);
        await expect(a.page.locator('#tollMemo')).toHaveText(new RegExp(`${tollInLib6.replace('.', '\\.')}\\s*LIB`, 'i'));
    });
});
