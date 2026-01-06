const { test: base, expect } = require('../fixtures/base');
const fs = require('fs');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { getLiberdusBalance, expectLiberdusBalanceToEqual } = require('../helpers/walletHelpers');
const networkParams = require('../helpers/networkParams');
const { newContext } = require('../helpers/toastHelpers');

const test = base.extend({
    users: async ({ browser, browserName }, use, testInfo) => {
        const ctxA = await newContext(browser);
        const ctxB = await newContext(browser);
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

test('QR Code: Receive from A, scan and send from B', async ({ users }, testInfo) => {
    const { a, b } = users;
    const qrAmount = '12.34';

    // check balance for both users in parallel
    const [userABalanceBefore, userBBalanceBefore] = await Promise.all([
        getLiberdusBalance(a.page),
        getLiberdusBalance(b.page)
    ]);

    // USER A: Generate Receive QR 
    await a.page.click('#switchToWallet');
    await a.page.click('#openReceiveModal');
    await expect(a.page.locator('#receiveModal')).toBeVisible();
    await a.page.fill('#receiveAmount', qrAmount);

    // Get base64 image from the QR
    const dataUrl = await a.page.$eval('#qrcode img', img => img.src);
    const base64 = dataUrl.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    // Save image to disk
    const qrPath = testInfo.outputPath('receive_qr.png');
    fs.writeFileSync(qrPath, buffer);
    try {
        // Close modal
        await a.page.click('#closeReceiveModal');

        // USER B: Upload and verify QR 
        await b.page.click('#switchToWallet');
        await b.page.click('#openSendAssetFormModal');
        await expect(b.page.locator('#sendAssetFormModal')).toBeVisible();

        const fileChooserPromise = b.page.waitForEvent('filechooser');
        await b.page.click('#uploadQRButton');
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(qrPath);

        // Expect fields to auto-populate
        await expect(b.page.locator('#sendToAddress')).toHaveValue(a.username);
        await expect(b.page.locator('#sendAmount')).toHaveValue(qrAmount);

        const usernameStatus = b.page.locator('#sendToAddressError');
        await expect(usernameStatus).toHaveText('found', { timeout: 10_000 });

        const sendButton = b.page.locator('#sendAssetFormModal button[type="submit"]');
        await expect(sendButton).toBeEnabled();

        await sendButton.click();

        // Confirm Transaction
        await expect(b.page.locator('#sendAssetConfirmModal')).toBeVisible();
        const confirmRecipient = await b.page.locator('#confirmRecipient').textContent();
        expect(confirmRecipient).toContain(a.username);
        const confirmAmount = await b.page.locator('#confirmAmount').textContent();
        expect(confirmAmount).toContain(qrAmount);
        await b.page.click('#confirmSendButton');

        // Check Transaction History
        await expect(b.page.locator('#historyModal')).toBeVisible();
        const firstTransaction = b.page.locator('#historyModal .transaction-item').first();
        const transactionAmount = await firstTransaction.locator('.transaction-amount').textContent();
        expect(transactionAmount).toContain(qrAmount);
        const transactionAddress = await firstTransaction.locator('.transaction-address').textContent();
        expect(transactionAddress).toContain(`To: ${a.username}`);
        await b.page.click('#closeHistoryModal');

        // expect balances to have changed by the amount sent using bignumber comparison at fixed 6 precision
        const expectedABalance = parseFloat(userABalanceBefore) + parseFloat(qrAmount);
        const expectedBBalance = parseFloat(userBBalanceBefore) - parseFloat(qrAmount) - networkParams.networkFeeLib;
        await expectLiberdusBalanceToEqual(a.page, expectedABalance.toFixed(6));
        await expectLiberdusBalanceToEqual(b.page, expectedBBalance.toFixed(6));
    } finally {
        // delete the QR file after test
        if (fs.existsSync(qrPath)) {
            fs.unlinkSync(qrPath);
        }
    }
});
