const fs = require('fs');
const http = require('node:http');
const { test, expect } = require('../fixtures/base');
const { newContext } = require('../helpers/toastHelpers');
const { AccountSetup } = require('../helpers/accountSetup');
const { RecipientLookup } = require('../helpers/recipientLookup');
const { TestDiagnostics } = require('../helpers/testDiagnostics');

class HarnessPage {
  static lookup = `<span class="app-name">sender</span><input id="chatRecipient"><span id="chatRecipientError"></span>
    <form id="newChatForm"><button type="submit" disabled>Continue</button></form><script>
    chatRecipient.oninput = async () => {
      try {
        const response = await fetch('/address/' + chatRecipient.value);
        const result = await response.json();
        chatRecipientError.textContent = result.address ? 'found' : 'not found';
        document.querySelector('button').disabled = !result.address;
      } catch { chatRecipientError.textContent = 'not found'; }
    };</script>`;

  static registration = `<button id="createAccountButton">Create</button><div id="createAccountModal" style="display:none">
    <input id="newUsername"><span id="newUsernameAvailable"></span><form id="createAccountForm"><button type="submit">Register</button></form></div>
    <div id="chatsScreen" style="display:none"></div><span class="app-name"></span><script>
    createAccountButton.onclick = () => { createAccountModal.style.display = 'block'; createAccountModal.classList.add('active'); };
    newUsername.oninput = () => newUsernameAvailable.textContent = 'available';
    createAccountForm.onsubmit = async event => {
      event.preventDefault(); document.querySelector('button[type=submit]').disabled = true;
      const result = await fetch('/inject', { method:'POST', body:JSON.stringify({tx:JSON.stringify({type:'register', alias:newUsername.value, from:'a'.repeat(64), secret:'DO_NOT_CAPTURE'})}) }).then(r=>r.json());
      if (!result.success) { document.body.insertAdjacentHTML('beforeend','<div class="toast error show">Registration rejected</div>'); return; }
      document.body.insertAdjacentHTML('beforeend','<div class="toast loading show">Creating account...</div>');
      const receipt = await fetch('/transaction/' + result.txId).then(r=>r.json());
      if (receipt.transaction?.success) {
        chatsScreen.style.display = 'block'; chatsScreen.classList.add('active'); document.querySelector('.app-name').textContent = newUsername.value;
      }
    };</script>`;

  static async streamingServer() {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.flushHeaders();
      setTimeout(() => response.end(JSON.stringify({ address: 'streamed-recipient-address' })), 200);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  static async open(page, html) {
    await page.route('http://diagnostics.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('');
  }

  static report(info, name) {
    const attachment = info.attachments.find(item => item.name === name);
    expect(attachment).toBeTruthy();
    return JSON.parse(attachment.body ? attachment.body.toString() : fs.readFileSync(attachment.path, 'utf8'));
  }

  static async register(page, outcome) {
    await page.route('**/inject', route => route.fulfill({ json: { success: outcome !== 'rejected', txId: 'public-registration-id' } }));
    await page.route('**/transaction/*', async route => {
      if (outcome === 'stalled') return; // Deliberately leave the receipt request pending.
      if (outcome === 'success') await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ json: { transaction: outcome === 'success' ? { success: true } : null } });
    });
    await page.route('http://diagnostics.test/', route => route.fulfill({ contentType: 'text/html', body: this.registration }));
  }
}

test('slow lookup succeeds without retyping or substituting a backend result', async ({ page, diagnostics }) => {
  let requests = 0;
  await page.route('**/address/*', async route => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.fulfill({ json: { address: 'public-recipient-address' } });
  });
  await HarnessPage.open(page, HarnessPage.lookup);
  await RecipientLookup.fill(page, { username: 'recipient', address: 'public-recipient-address' });
  expect(requests).toBe(1);
  expect([...diagnostics.requests.values()][0].status).toBe(200);
});

test('attempt zero retains lookup, popup and pre-close evidence when retry passes', async ({ browser, page, diagnostics }, info) => {
  const context = await newContext(browser);
  const recipientPage = await context.newPage();
  diagnostics.identify(recipientPage, { role: 'recipient', username: 'recipient' });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Recipient</h1>' }));
  await recipientPage.goto('http://diagnostics.test/recipient');
  const popupPromise = recipientPage.waitForEvent('popup');
  await recipientPage.evaluate(() => window.open('/popup'));
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await popup.evaluate(() => { console.error('popup diagnostic marker'); });
  await page.route('**/address/*', route => route.fulfill({ status: info.retry === 0 ? 503 : 200, json: info.retry === 0 ? { error: 'temporary lookup failure', privateKey: 'DO_NOT_CAPTURE' } : { address: 'public-recipient-address' } }));
  await HarnessPage.open(page, HarnessPage.lookup);
  try {
    await RecipientLookup.fill(page, { username: 'recipient', signedInAt: Date.now() });
  } finally {
    await diagnostics.capturePage(recipientPage, 'recipient-before-close');
    await recipientPage.close();
    await context.close();
  }
});

for (const outcome of ['success', 'rejected', 'missing', 'stalled']) {
  test(`account setup ${outcome} is bounded and preserves registration evidence`, async ({ page, diagnostics }, info) => {
    const deadline = AccountSetup.timeout;
    AccountSetup.timeout = 1_000;
    try {
      await HarnessPage.register(page, outcome);
      const setup = new AccountSetup(page, 'testaccount').run();
      if (outcome === 'success') {
        expect((await setup).username).toBe('testaccount');
        return;
      }
      await expect(setup).rejects.toThrow(/testaccount at registration-confirmation/);
      const report = HarnessPage.report(info, 'account-setup-failure');
      expect(report.details.some(item => item.kind === 'account-setup-failure' && item.elapsedMs < 3_000)).toBe(true);
      const inject = report.requests.find(item => item.url.endsWith('/inject'));
      expect(inject.transaction.username).toBe('testaccount');
      expect(JSON.stringify(report)).not.toContain('DO_NOT_CAPTURE');
      expect(report.captures[0].state.createModalVisible).toBe(true);
      if (outcome === 'missing') expect(report.requests.find(item => item.url.includes('/transaction/')).body.transaction).toBeNull();
      if (outcome === 'stalled') expect(report.requests.find(item => item.url.includes('/transaction/')).outcome).toBe('pending');
      if (outcome === 'rejected') expect(report.captures[0].state.toasts).toContain('Registration rejected');
      const originalError = new Error('original setup error');
      await diagnostics.close([{ close: async () => { throw new Error('simulated cleanup failure'); } }], originalError);
      expect(diagnostics.errors.some(item => item.kind === 'cleanup-error')).toBe(true);
    } finally { AccountSetup.timeout = deadline; }
  });
}

test('report waits for a response body after headers arrive', async ({ page, diagnostics }, info) => {
  const server = await HarnessPage.streamingServer();
  const url = `http://127.0.0.1:${server.address().port}/address/recipient`;
  try {
    await HarnessPage.open(page, HarnessPage.lookup);
    const response = page.waitForResponse(url);
    await page.evaluate(url => { void fetch(url); }, url);
    await response;
    await diagnostics.attach('streaming-response');
    const report = HarnessPage.report(info, 'streaming-response');
    expect(report.requests.find(item => item.url === url).body.address).toBe('streamed-recipient-address');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('transport errors are distinct from HTTP responses', async ({ page, diagnostics }) => {
  await page.route('**/address/*', route => route.abort('connectionrefused'));
  await HarnessPage.open(page, HarnessPage.lookup);
  await page.fill('#chatRecipient', 'recipient');
  await expect(page.locator('#chatRecipientError')).toHaveText('not found');
  const request = [...diagnostics.requests.values()][0];
  expect(request.outcome).toBe('transport-error');
  expect(request.error).toContain('ERR_CONNECTION_REFUSED');
  expect(request.status).toBeUndefined();
});


test.describe('recipient setup in beforeAll', () => {
  test.beforeAll(async ({ browser }, info) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    const diagnostics = TestDiagnostics.current();
    diagnostics.identify(page, { role: 'recipient' });
    const deadline = AccountSetup.timeout;
    AccountSetup.timeout = 1_000;
    let setupError;
    try {
      await HarnessPage.register(page, info.retry === 0 ? 'missing' : 'success');
      await new AccountSetup(page, 'hookrecipient').run();
    } catch (error) {
      setupError = error;
      throw error;
    } finally {
      AccountSetup.timeout = deadline;
      const resources = [context];
      if (setupError) resources.push({ close: async () => { throw new Error('simulated hook cleanup error'); } });
      await diagnostics.close(resources, setupError);
    }
  });

  test('recovers on a fresh attempt without masking hook setup failure', async () => {});
});
