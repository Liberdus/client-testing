const { test: base, expect } = require('@playwright/test');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { sendMessageTo } = require('../helpers/messageHelpers');


/**
 * Sets the browser context to offline mode and waits for UI indicators
 * to confirm the offline state has been properly applied and displayed to the user.
 * 
 * @param {BrowserContext} context - The Playwright browser context to set offline
 * @param {Page} page - The Playwright page to verify offline indicators on
 * @returns {Promise<void>} - Resolves when offline mode is confirmed with UI indicators
 * @throws {Error} - If offline indicators don't appear within the timeout period (40s)
 */
async function setUserOfflineAndWaitForIndicator(context, page) {
    await context.setOffline(true);
    await expect(page.locator('#offlineIndicator')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('#offlineIndicator')).toHaveText('Offline');
    await expect(page.locator('.toast.offline')).toBeVisible();
}

/**
 * Verifies that a button is properly disabled in offline mode
 * @param {Locator} buttonLocator - The Playwright locator for the button element
 */
async function expectButtonDisabledOffline(buttonLocator) {
    await expect(buttonLocator).toBeDisabled();
    await expect(buttonLocator).toHaveClass(/offline-disabled/);
}

// Base test fixture with single user
const test = base.extend({
    user: async ({ browser, browserName }, use) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const username = generateUsername(browserName);

        await createAndSignInUser(page, username);

        await use({ page, username, context });

        // Close context when done
        await context.close();
    },

    // fixture for two users with separate contexts
    twoUsers: async ({ browser, browserName }, use) => {
        // Create first user and context
        const context1 = await browser.newContext();
        const page1 = await context1.newPage();
        const username1 = generateUsername(browserName);

        // Create second user and context
        const context2 = await browser.newContext();
        const page2 = await context2.newPage();
        const username2 = generateUsername(browserName);

        await Promise.all([
            createAndSignInUser(page1, username1),
            createAndSignInUser(page2, username2)
        ]);

        // Provide both users to the test
        await use({
            user1: { page: page1, username: username1, context: context1 },
            user2: { page: page2, username: username2, context: context2 }
        });

        // Clean up both contexts
        await context1.close();
        await context2.close();
    }
});

test.describe('Offline Tests', () => {
    test('should toggle offline indicator visibility when offline', async ({ user }) => {
        const { page, context } = user;
        const offlineIndicator = page.locator('#offlineIndicator');
        // expect offline indicator  to not show initially
        await expect(offlineIndicator).not.toBeVisible();

        // Set browser to offline mode
        await setUserOfflineAndWaitForIndicator(context, page);

        // Set browser back online
        await context.setOffline(false);

        // expect online toast
        const onlineToast = page.locator('.toast.online');
        await expect(onlineToast).toBeVisible({ timeout: 15_000 });
        await expect(onlineToast).toHaveText("You're back online!");
        await expect(offlineIndicator).not.toBeVisible();
    });

    test('should be able to sign in while offline', async ({ user }) => {
        const { context, username } = user;

        // Create a new page in the same context
        const page = await context.newPage();
        try {
            // go to the app base url
            await page.goto('');
            await expect(page.locator('#welcomeScreen')).toBeVisible();

            // Set browser to offline mode
            await context.setOffline(true);
            // wait 30 seconds (no offline indicator to wait for on welcome screen)
            await page.waitForTimeout(30_000);

            // Should have sign in button
            const signInButton = page.locator('#signInButton');
            await expect(signInButton).toBeVisible();

            // Click sign in button
            await signInButton.click();

            // expect chat screen to be visible
            await expect(page.locator('#chatsScreen.active')).toBeVisible();
            await expect(page.locator('#header .app-name')).toHaveText(username);
            await expect(page.locator('#offlineIndicator')).toBeVisible();
        } finally {
            await page.close();
        }
    });

    test('should disable creating new user when offline', async ({ user }) => {
        const { page, context } = user;
        // Navigate to welcome screen
        await page.goto('');
        await expect(page.locator('#welcomeScreen')).toBeVisible();

        // Set browser to offline mode
        await context.setOffline(true);
        // wait 30 seconds (no offline indicator to wait for on welcome screen)
        await page.waitForTimeout(30_000);

        await page.locator('#createAccountButton').click();

        await expectButtonDisabledOffline(page.locator('#createAccountForm button[type="submit"]'));
    });

    test('should disable message sending when offline but should save drafts', async ({ twoUsers }) => {
        const { user1, user2 } = twoUsers;

        // First, have user1 start a chat with user2 while online
        await sendMessageTo(user1.page, user2.username, 'Hello user2!');

        // Now set user1 offline
        await setUserOfflineAndWaitForIndicator(user1.context, user1.page);

        await user1.page.locator('.chat-name', { hasText: user2.username }).click();

        // Attempt to send a message
        const messageInput = user1.page.locator('#chatModal .message-input');
        await messageInput.fill('This message should not be sendable');

        // Send button should be disabled
        await expectButtonDisabledOffline(user1.page.locator('#handleSendMessage'));

        // close chat to trigger draft save
        await user1.page.locator('#closeChatModal').click();

        // wait for chat screen to be visible (prevents race condition)
        await expect(user1.page.locator('#chatsScreen.active')).toBeVisible();

        // sign out to trigger save
        await user1.page.locator('#toggleMenu').click();
        await user1.page.locator('#handleSignOut').click();

        // user1 opens a new page to check if the draft is saved
        const draftPage = await user1.context.newPage();
        try {
            await user1.context.setOffline(false);
            await draftPage.goto(''); // this fails in webkit when offline, so we set it online first
            await user1.context.setOffline(true);
            await draftPage.locator('#signInButton').click();
            await draftPage.locator('.chat-name', { hasText: user2.username }).click();

            // Verify the draft is saved
            const draftInput = draftPage.locator('#chatModal .message-input');
            await expect(draftInput).toHaveValue('This message should not be sendable');
        } finally {
            await draftPage.close();
        }

    });

    test('should disable asset sending when offline', async ({ twoUsers }) => {
        const { user1, user2 } = twoUsers;
        const { page, context } = user1;

        // Navigate to wallet screen while online
        await page.locator('#switchToWallet').click();
        await expect(page.locator('#walletScreen.active')).toBeVisible();

        // Set user offline
        await setUserOfflineAndWaitForIndicator(context, page);

        // Click on send assets button
        await page.locator('#openSendAssetFormModal').click();

        // Fill in recipient info
        await page.locator('#sendToAddress').fill(user2.username);

        // Enter amount
        await page.locator('#sendAmount').fill('1');

        // Verify submit button is disabled
        await expectButtonDisabledOffline(page.locator('#sendForm button[type="submit"]'));
    });

    test('should disable changing friend status when offline', async ({ twoUsers }) => {
        const { user1, user2 } = twoUsers;
        const { page, context } = user1;

        // First, have user1 start a chat with user2 while online
        await sendMessageTo(page, user2.username, 'Hello user2!');

        // Set user1 offline
        await setUserOfflineAndWaitForIndicator(context, page);

        await page.click('#switchToContacts');
        await expect(page.locator('#contactsScreen.active')).toBeVisible();

        // Open User2's contact
        await page.locator('#contactsList .chat-name', { hasText: user2.username }).click();
        await expect(page.locator('#contactInfoModal')).toBeVisible();

        // Try to change friend status
        await page.locator('#addFriendButtonContactInfo').click();
        await expect(page.locator('#friendModal.active')).toBeVisible();

        // Verify friend status options remain read-only while offline
        const friendOptions = page.locator('#friendForm input[type=radio]');
        const optionCount = await friendOptions.count();
        for (let i = 0; i < optionCount; i++) {
            await expect(friendOptions.nth(i)).toBeDisabled();
        }

        // Verify save button is disabled
        await expectButtonDisabledOffline(page.locator('#friendForm button[type="submit"]'));
    });

    test('should disable changing toll when offline', async ({ user }) => {
        const { page, context } = user;

        // Set user offline
        await setUserOfflineAndWaitForIndicator(context, page);

        // Navigate to settings
        await page.locator('#toggleSettings').click();
        await expect(page.locator('#settingsModal')).toBeVisible();

        // Open toll modal
        await page.locator('#openToll').click();
        await expect(page.locator('#tollModal')).toBeVisible();

        // Try to set a new toll value
        await page.locator('#newTollAmountInput').fill('10');

        // Verify save button is disabled
        await expectButtonDisabledOffline(page.locator('#saveNewTollButton'));
    });

    // enabled profile updating from toggle menu
    test('should enable profile updating when offline', async ({ user }) => {
        const { page, context } = user;

        // Set user offline
        await setUserOfflineAndWaitForIndicator(context, page);

        // Navigate to settings
        await page.locator('#toggleSettings').click();
        await expect(page.locator('#settingsModal')).toBeVisible();

        // Open profile modal
        await page.locator('#openAccountForm').click();
        await expect(page.locator('#accountModal.active')).toBeVisible();

        // Try to change profile name
        const newName = 'New Name';
        await page.locator('#name').fill(newName);

        // Verify save button is enabled
        const submitButton = page.locator('#accountForm button[type="submit"]');
        await expect(submitButton).toBeEnabled();
        await submitButton.click();

        // Verify the profile was updated
        await page.getByText('Profile', { exact: true }).click();
        await expect(page.locator('#accountForm #name')).toHaveValue(newName);
    });

    test('should disable validator staking when offline', async ({ user }) => {
        const { page, context } = user;

        // Set user offline
        await setUserOfflineAndWaitForIndicator(context, page);

        // Navigate to menu 
        await page.locator('#toggleMenu').click();
        await expect(page.locator('#menuModal')).toBeVisible();

        // Open validator modal
        await page.locator('#openValidator').click();
        await expect(page.locator('#validatorModal')).toBeVisible();

        // Open stake modal
        await page.locator('#openStakeModal').click();
        await expect(page.locator('#stakeForm')).toBeVisible();

        // Verify stake button is disabled
        await expectButtonDisabledOffline(page.locator('#submitStake'));
    });

    // TODO:
    // unstake validator when offline
});
