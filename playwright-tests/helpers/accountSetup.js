const { expect } = require('@playwright/test');
const { TestDiagnostics } = require('./testDiagnostics');

class AccountSetup {
  // Covers navigation, username lookup and several confirmation cycles, while leaving
  // most of the five-minute scenario budget available for assertions and diagnostics.
  static timeout = 90_000;

  constructor(page, username) {
    this.page = page;
    this.username = username;
    this.started = Date.now();
    this.stage = 'open-create-account';
    this.diagnostics = TestDiagnostics.current();
    this.diagnostics.identify(page, { username, registrationStartedAt: this.started });
  }

  remaining() {
    const timeout = AccountSetup.timeout - (Date.now() - this.started);
    if (timeout <= 0) throw new Error('Account setup deadline exceeded');
    return timeout;
  }

  async submit() {
    const { page, username } = this;
    await page.goto('', { waitUntil: 'domcontentloaded', timeout: this.remaining() });
    await page.locator('#createAccountButton').click({ timeout: this.remaining() });
    await expect(page.locator('#createAccountModal')).toBeVisible({ timeout: this.remaining() });
    this.stage = 'username-availability';
    await page.locator('#newUsername').pressSequentially(username, { timeout: this.remaining() });
    await expect(page.locator('#newUsernameAvailable')).toHaveText('available', { timeout: Math.min(10_000, this.remaining()) });
    this.stage = 'submit-registration';
    await page.locator('#createAccountForm button[type="submit"]').click({ timeout: this.remaining() });
  }

  async run() {
    try {
      await this.submit();
      this.stage = 'registration-confirmation';
      // Success is stable signed-in UI and the intended account, not a transient toast.
      await this.page.waitForFunction(username => {
        const errors = [...document.querySelectorAll('.toast.error.show')];
        if (errors.length) throw new Error(`Registration error: ${errors.map(el => el.textContent).join('; ')}`);
        const chats = document.querySelector('#chatsScreen.active');
        const name = document.querySelector('.app-name');
        return chats?.getClientRects().length > 0 && getComputedStyle(chats).visibility === 'visible' &&
          name?.getClientRects().length > 0 && getComputedStyle(name).visibility === 'visible' && name.textContent.trim() === username;
      }, this.username, { timeout: this.remaining() });
      const request = [...this.diagnostics.requests.values()].find(entry => entry.transaction?.username === this.username);
      const identity = { username: this.username, address: request?.transaction.address, registrationStartedAt: this.started, signedInAt: Date.now() };
      this.diagnostics.identify(this.page, identity);
      this.diagnostics.details.push({ kind: 'registration-complete', ...identity });
      return identity;
    } catch (cause) {
      const detail = { kind: 'account-setup-failure', username: this.username, stage: this.stage, elapsedMs: Date.now() - this.started };
      this.diagnostics.details.push(detail);
      await this.diagnostics.capturePage(this.page, this.stage);
      await this.diagnostics.attach('account-setup-failure');
      throw new Error(`Account setup failed for ${this.username} at ${this.stage} after ${detail.elapsedMs}ms (deadline ${AccountSetup.timeout}ms): ${cause.message}`, { cause });
    }
  }
}

module.exports = { AccountSetup };
