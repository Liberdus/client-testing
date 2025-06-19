const { test: base, expect } = require('@playwright/test');
const { createUser, generateUsername } = require('../helpers/userHelpers');

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

test('should not allow duplicate username creation', async ({ users }) => {
    const { a, b } = users;
    // create two users with the same username
    await Promise.all([
        createUser(a.page, a.username),
        createUser(b.page, a.username)
    ]);
    const errorMessageLocator = '.toast.error.show';
    const errorMsgRegex = /this alias is already taken/i;

    // Wait until at least ONE page shows the .toast.error.show element.
    await expect.poll(async () => {
        const errA = await a.page.locator(errorMessageLocator, { hasText: errorMsgRegex }).isVisible();
        const errB = await b.page.locator(errorMessageLocator, { hasText: errorMsgRegex }).isVisible();
        return errA || errB;
    }, { timeout: 30_000 }).toBeTruthy();

    // Optional: make sure *both* pages didn’t error out
    const [errA, errB] = await Promise.all([
        a.page.locator(errorMessageLocator, { hasText: errorMsgRegex }).isVisible(),
        b.page.locator(errorMessageLocator, { hasText: errorMsgRegex }).isVisible()
    ]);
    expect(errA && errB).toBeFalsy();   // exactly one should fail
});
