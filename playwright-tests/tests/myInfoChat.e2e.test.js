const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { checkReceivedMessage } = require('../helpers/messageHelpers');

const test = base.extend({
    users: async ({ browser, browserName }, use, testInfo) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const userA = generateUsername(browserName);
        const userB = generateUsername(browserName);

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
                b: { username: userB, page: pageB, ctx: ctxB }
            });
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    }
});

test('My Info QR: start chat via uploaded QR', async ({ users }, testInfo) => {
    const { a, b } = users;
    const qrPath = testInfo.outputPath('my_info_qr.png');
    const message = 'Hello from QR chat';

    const myInfoModal = a.page.locator('#myInfoModal');
    const myInfoQR = myInfoModal.locator('#myInfoQR img');

    await a.page.click('.app-name');
    await expect(myInfoModal).toBeVisible({ timeout: 15_000 });
    await expect(myInfoQR).toBeVisible({ timeout: 15_000 });

    const dataUrl = await myInfoQR.evaluate(img => img.getAttribute('src'));
    if (!dataUrl) {
        throw new Error('QR code did not provide a data URL');
    }
    const base64 = dataUrl.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(qrPath, buffer);

    try {
        await a.page.click('#closeMyInfoModal');

        await b.page.click('#switchToChats');
        await b.page.click('#newChatButton');
        await expect(b.page.locator('#newChatModal')).toBeVisible({ timeout: 10_000 });

        const fileChooserPromise = b.page.waitForEvent('filechooser');
        await b.page.click('#newChatUploadQRButton');
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(qrPath);

        const chatRecipient = b.page.locator('#chatRecipient');
        await expect(chatRecipient).toHaveValue(a.username, { timeout: 10_000 });
        await expect(b.page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });

        const continueButton = b.page.locator('#newChatForm button[type="submit"]');
        await expect(continueButton).toBeEnabled();
        await continueButton.click();

        const chatModal = b.page.locator('#chatModal');
        await expect(chatModal).toBeVisible({ timeout: 15_000 });
        await expect(chatModal).toContainText(a.username, { timeout: 15_000 });

        await b.page.type('#chatModal .message-input', message);
        await b.page.click('#handleSendMessage');
        await expect(chatModal.locator('.message.sent .message-content', { hasText: message })).toBeVisible({ timeout: 15_000 });
        await b.page.click('#closeChatModal');
        await expect(b.page.locator('#newChatButton')).toBeVisible({ timeout: 10_000 });

        await checkReceivedMessage(a.page, b.username, message);
    } finally {
        if (fs.existsSync(qrPath)) {
            fs.unlinkSync(qrPath);
        }
    }
});
