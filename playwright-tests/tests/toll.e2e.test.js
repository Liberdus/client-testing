const { test: base, expect } = require('../fixtures/base');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLiberdusBalance, expectLiberdusBalanceToEqual } = require('../helpers/walletHelpers');
const networkParams = require('../helpers/networkParams');
const { fundUserFromPage } = require('../helpers/send-create');
const { sendMessageTo } = require('../helpers/messageHelpers');
const { newContext } = require('../helpers/toastHelpers');

// Constants
const TOLL_USD = networkParams.defaultTollUsd + 0.01;
const FriendStatus = {
    BLOCKED: 0,
    OTHER: 1,
    ACQUAINTANCE: 2,
    FRIEND: 3
};

async function setToll(page, amount) {
    await page.click('#toggleSettings');
    await expect(page.locator('#settingsModal')).toBeVisible();
    await page.click('#openToll');
    await expect(page.locator('#tollModal')).toBeVisible();
    const amountStr = amount.toString();
    console.log(`Setting toll to ${amountStr} USD`);
    await page.fill('#newTollAmountInput', amountStr);
    await page.click('#saveNewTollButton');
    await page.waitForEvent('console', {
        timeout: 60_000,
        predicate: msg =>
            /toll transaction successfully processed/i.test(msg.text())
    });
    await page.click('#closeTollModal');
    await page.click('#closeSettings');
}

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

const test = base.extend({
    users: async ({ browser, browserName }, use) => {
        const ctxA = await newContext(browser);
        const ctxB = await newContext(browser);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);

        try {
            await Promise.all([
                createAndSignInUser(pageA, userA),
                createAndSignInUser(pageB, userB)
            ]);

            // Fund User A with 35 LIB
            await fundUserFromPage(pageA, userA, 35);

            // Get initial balances
            const balanceA = parseFloat(await getLiberdusBalance(pageA));
            const balanceB = parseFloat(await getLiberdusBalance(pageB));

            await use({
                a: { username: userA, page: pageA, ctx: ctxA, balance: balanceA },
                b: { username: userB, page: pageB, ctx: ctxB, balance: balanceB },
            });
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    }
});

[
    { name: 'Acquaintance', friendStatus: FriendStatus.ACQUAINTANCE },
    { name: 'Friend', friendStatus: FriendStatus.FRIEND },
].forEach(({ name, friendStatus }) => {
    test(`Toll is charged for messages, then refunded on ${name}`, async ({ users }) => {
        const { a, b } = users;

        // User B sets toll in USD in the UI
        await setToll(b.page, TOLL_USD);
        const tollInLib = TOLL_USD / networkParams.stabilityFactor;
        await a.page.click('#switchToChats');

        let tollText = '';
        const maxAttempts = 3;

        // reopen chat until new toll is displayed
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // ─ Start a new-chat flow
            await expect(a.page.locator('#newChatButton')).toBeVisible();
            await a.page.click('#newChatButton');

            await expect(a.page.locator('#newChatModal')).toBeVisible();
            await a.page.locator('#chatRecipient').fill(b.username);
            await expect(a.page.locator('#chatRecipientError')).toHaveText('found');

            const continueBtn = a.page.locator('#newChatForm button[type="submit"]');
            await expect(continueBtn).toBeEnabled();
            await continueBtn.click();

            await expect(a.page.locator('#chatModal')).toBeVisible();

            // ─ Check toll label
            tollText = (await a.page.locator('#tollValue').textContent()).trim();
            if (tollText.startsWith(`${TOLL_USD.toFixed(6)}`)) break;        // continue test

            // close modal and try again
            await a.page.click('#closeChatModal');
            await expect(a.page.locator('#newChatButton')).toBeVisible();

            if (attempt === maxAttempts) {
                throw new Error(`Toll label never showed "Toll: ${TOLL_USD}" after ${maxAttempts} attempts (last text: "${tollText}")`);
            }
        }

        // User A sends 3 messages to B
        for (let i = 0; i < 3; i++) {
            await a.page.type('#chatModal .message-input', `msg ${i + 1}`);
            await a.page.click('#handleSendMessage');
            await a.page.waitForTimeout(3_000);

            // If an error toast appears, fail fast
            if (await a.page.locator('.toast.error.show').count()) {
                const errText = await a.page.locator('.toast.error.show').textContent();
                throw new Error(`Error toast displayed after sending message: ${errText}`);
            }

            // Replace waitForFunction with expect for sent message
            const sentMsg = a.page.locator('.message.sent .message-content', { hasText: `msg ${i + 1}` });
            await expect(sentMsg).toBeVisible({ timeout: 15_000 });
        }

        await a.page.click('#closeChatModal');
        await expect(a.page.locator('#newChatButton')).toBeVisible();

        // Wait for balances to update
        await a.page.click('#switchToWallet');
        await a.page.click('#refreshBalance');
        await expect(a.page.locator('#walletScreen.active')).toBeVisible();
        let expectedBalance = a.balance;
        expectedBalance -= (tollInLib * 3);
        expectedBalance -= (networkParams.networkFeeLib * 4); // 3 messages + 1 for creating contact

        await expectLiberdusBalanceToEqual(a.page, expectedBalance.toFixed(6));

        // User B sets User A's status to Acquaintance
        await setFriendStatus(b.page, a.username, friendStatus);

        // Wait for refund to process
        await a.page.click('#refreshBalance');
        await a.page.waitForTimeout(5_000);

        // User A's balance should be refunded 5*3
        const expectedAfterRefund = expectedBalance + (tollInLib * 3);
        await expectLiberdusBalanceToEqual(a.page, expectedAfterRefund.toFixed(6));
    });
});



test('Toll is charged when sender has blocked recipient', async ({ users }) => {
    const { a, b } = users;

    // User B sets toll in USD
    await setToll(b.page, TOLL_USD);
    const tollInLib = TOLL_USD / networkParams.stabilityFactor;

    await sendMessageTo(a.page, b.username, 'Hello B!');
    let expectedBalance = a.balance - tollInLib - networkParams.networkFeeLib * 2;
    await expectLiberdusBalanceToEqual(a.page, expectedBalance.toFixed(6));


    await setFriendStatus(a.page, b.username, FriendStatus.BLOCKED);
    expectedBalance -= networkParams.networkFeeLib;
    // User A sends a message to B
    await sendMessageTo(a.page, b.username, 'Hello B Blocked!');
    expectedBalance -= tollInLib + networkParams.networkFeeLib;

    // Check A's balance
    await expectLiberdusBalanceToEqual(a.page, expectedBalance.toFixed(6));
});
