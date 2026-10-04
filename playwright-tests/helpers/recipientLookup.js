const { expect } = require('@playwright/test');
const { TestDiagnostics } = require('./testDiagnostics');

class RecipientLookup {
  static async fill(page, recipient) {
    const diagnostics = TestDiagnostics.current();
    diagnostics.observeContext(page.context());
    diagnostics.details.push({ kind: 'recipient-lookup', sender: await page.locator('.app-name').textContent(), recipient, startedAt: Date.now() });
    try {
      await page.fill('#chatRecipient', recipient.username);
      await expect(page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
      await expect(page.locator('#newChatForm button[type="submit"]')).toBeEnabled();
    } catch (error) {
      await diagnostics.capturePage(page, 'recipient-lookup');
      await diagnostics.attach('recipient-lookup-failure');
      throw error;
    }
  }
}

module.exports = { RecipientLookup };
