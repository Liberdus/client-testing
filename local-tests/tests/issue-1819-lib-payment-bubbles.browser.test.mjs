import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = '/tmp/1819-lib-payment-bubbles';
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const fixture = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
isOnline = false;
window.__fixtureQueries = [];
window.__fixtureBroadcasts = 0;
queryNetwork = async (...args) => {
  window.__fixtureQueries.push(args);
  if (args[0].endsWith('/balance')) return { balance: 1000n * wei };
  return { toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } };
};
postAssetTransfer = async () => { window.__fixtureBroadcasts++; throw Error('Receipt fixture forbids broadcast'); };
signObj = async () => { throw Error('Receipt fixture forbids signing'); };
window.__fixture = {
  chatModal, sendAssetFormModal,
  configure() {
    const owner = 'a'.repeat(40), recipient = 'b'.repeat(40);
    myAccount = { username: 'sender', keys: { address: owner }, netid: network.netid };
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.tollTimeout = 86400000;
    myData = newDataRecord(myAccount);
    myData.contacts[recipient] = { address: recipient, username: 'recipient', messages: [],
      toll: 0n, tollUnit: 'LIB', tollRequiredToSend: 0, tollRequiredToReceive: 0, friend: 2,
      unread: 0, timestamp: 0, useAvatar: 'identicon' };
    this.recipient = recipient;
    const now = Date.now() - 60000;
    this.note = 'Lunch <3\nhttps://liberdus.com/';
    this.messages = [
      { my: true, amount: 2500000000000000000n, message: this.note, status: 'sent', edited: true },
      { my: false, amount: 1000000000000000001n, message: 'Thanks! <img src=x onerror=alert(1)>', edited: true, edited_timestamp: now + 1 },
      { my: true, amount: 1n, status: 'pending' },
      { my: false, amount: 10000000000000000000000000000000001n },
      { my: true, amount: 5000000000000000000n, message: 'Retry memo', status: 'failed' },
    ].map((message, index) => ({ ...message, timestamp: now - index * 1000, txid: String(index + 1).repeat(64) }));
    myData.contacts[recipient].messages = this.messages;
    myData.wallet.history = this.messages.filter(message => message.my).map(message => ({ ...message }));
    isOnline = true;
    updateUIForConnectivity();
    welcomeScreen.close(); header.open(); footer.open(); walletScreen.screen.classList.add('active');
    // The actual Copy handler still runs; replace only the browser clipboard boundary.
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copied.push(text) } });
  },
  async openChat() { await chatModal.open(this.recipient); },
  setFont(size) { chatSettingsModal.savedFontSizePx = size; chatSettingsModal.applyChatFontSize(); },
  clearToasts() { document.querySelectorAll('.toast').forEach(toast => hideToast(toast.id)); },
  clearComposer() {
    chatModal.cancelReply(); chatModal.cancelEdit(); chatModal.messageInput.blur();
    chatModal.messageInput.value = ''; chatModal.toggleSendButtonVisibility();
    document.querySelectorAll('.toast').forEach(toast => hideToast(toast.id));
  },
  rerender() { chatModal.appendChatModal(false, true); },
};
`;
const app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) throw Error('Outside client');
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 740 }]) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Chicago' });
    const errors = [], external = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      external.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(() => __fixture.configure());
    await page.evaluate(() => __fixture.openChat());
    await page.locator('#chatModal.is-transition-complete').waitFor();
    const cards = page.locator('.message.payment-info');
    assert.equal(await cards.count(), 5);
    const queriesBefore = await page.evaluate(() => __fixtureQueries.length);
    const fontSize = () => cards.first().locator('.payment-amount').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => __fixture.setFont(20));
    const regularFont = await fontSize();
    await page.evaluate(() => __fixture.setFont(30));
    assert.ok(await fontSize() > regularFont, 'Native receipt amount honors the chat font size preference');
    const enlarged = await cards.locator('.lib-payment-message').evaluateAll(elements => elements.map(element => ({ client: element.clientWidth, scroll: element.scrollWidth })));
    assert.ok(enlarged.every(size => size.scroll <= size.client + 1), JSON.stringify(enlarged));
    await page.evaluate(() => __fixture.clearToasts());
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    await page.screenshot({ path: `${output}/largest-font-${viewport.name}.png`, fullPage: true });
    await page.evaluate(() => __fixture.setFont(16));
    for (const card of await cards.all()) {
      const my = (await card.getAttribute('class')).includes('sent');
      assert.equal((await card.locator('.lib-payment-label').first().textContent()).trim(), `Payment ${my ? 'sent' : 'received'}`);
      assert.equal((await card.locator('.payment-direction').textContent()).trim(), my ? '-' : '+');
      assert.match(await card.innerText(), /Liberdus/);
      assert.equal(await card.locator('.message-time').count(), 1);
      assert.equal(await card.locator('[data-verified]').count(), 0);
      assert.ok(!/Confirmed|Checking|Confirming/.test(await card.innerText()));
      const status = await card.getAttribute('data-status');
      assert.equal(await card.locator('.lib-payment-status').count(), status === 'failed' ? 1 : 0);
      const details = card.locator('.lib-payment-details');
      const txid = await card.getAttribute('data-txid');
      assert.equal(await details.count(), 1);
      assert.equal(await details.getAttribute('open'), null);
      assert.equal(await details.locator('code').isVisible(), false);
      await details.locator('summary').click();
      assert.equal(await details.getAttribute('open'), '');
      assert.equal(await details.locator('code').textContent(), txid);
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      assert.equal(await details.locator('a').count(), 0);
      await details.locator('dt').last().click();
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      const sizes = await card.locator('.lib-payment-message').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, client: element.clientWidth, scroll: element.scrollWidth };
      });
      const overflowing = sizes.scroll > sizes.client + 1
        ? await card.locator('*').evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => ({ tag: element.tagName, class: element.className, client: element.clientWidth, scroll: element.scrollWidth, text: element.textContent.trim().slice(0, 80) }))) : [];
      assert.ok(sizes.left >= 0 && sizes.right <= viewport.width + 1 && sizes.scroll <= sizes.client + 1, JSON.stringify({ txid, sizes, overflowing }));
      if (status === 'failed') {
        const marker = await card.evaluate(element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element, '::after');
          return { right: rect.left + parseFloat(style.left) + parseFloat(style.marginLeft) + parseFloat(style.width), containerRight: element.closest('.messages-container').getBoundingClientRect().right };
        });
        assert.ok(marker.right <= marker.containerRight + 1 && marker.right <= viewport.width + 1, JSON.stringify(marker));
      }
      await details.locator('summary').click();
    }
    const card = digit => page.locator(`.message.payment-info[data-txid="${digit.repeat(64)}"]`);
    const sent = card('1'), incoming = card('2'), tiny = card('3'), huge = card('4'), failed = card('5');
    assert.equal(await sent.locator('.payment-memo').textContent(), 'Lunch <3\nhttps://liberdus.com/');
    assert.equal(await sent.locator('.payment-memo a').getAttribute('href'), 'https://liberdus.com/');
    assert.equal(await incoming.locator('.payment-memo img').count(), 0);
    assert.match(await incoming.locator('.payment-memo').textContent(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await incoming.locator('.edited-new-dot').count(), 1);
    assert.equal((await tiny.locator('.payment-amount').textContent()).trim(), '0.000000000000000001 LIB');
    assert.equal((await huge.locator('.payment-amount').textContent()).trim(), '10000000000000000 LIB');

    // A user's open disclosure survives the ordinary chat rerender.
    await sent.locator('.lib-payment-details summary').click();
    await page.evaluate(() => __fixture.rerender());
    assert.equal(await sent.locator('.lib-payment-details').getAttribute('open'), '');
    assert.equal(await sent.locator('.message-time').count(), 1);
    await page.screenshot({ path: `${output}/expanded-${viewport.name}.png`, fullPage: true });
    await sent.locator('.lib-payment-details summary').click();

    const openMenu = async target => {
      await page.evaluate(() => __fixture.clearComposer());
      await target.locator('.payment-header').scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await target.locator('.payment-header').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#messageContextMenu').isVisible(), true);
    };
    const option = action => page.locator(`#messageContextMenu [data-action="${action}"]`);
    await openMenu(sent);
    assert.equal(await option('copy').isVisible(), true);
    assert.equal(await option('edit').isVisible(), true);
    await option('copy').click();
    await page.waitForFunction(() => __copied.length === 1);
    assert.deepEqual(await page.evaluate(() => __copied), ['Lunch <3\nhttps://liberdus.com/']);
    await openMenu(sent);
    await option('reply').click();
    assert.equal(await page.locator('#replyToMessage').inputValue(), 'Lunch <3 https://liberdus.com/');
    await openMenu(sent);
    await option('edit').click();
    assert.equal(await page.locator('#chatModal .message-input').inputValue(), 'Lunch <3\nhttps://liberdus.com/');
    await openMenu(tiny);
    assert.equal(await option('copy').isVisible(), false);
    assert.equal(await option('edit').isVisible(), false);
    await option('reply').click();
    assert.match(await page.locator('#replyToMessage').inputValue(), /^-0\.000000000000000001 LIB · /);
    assert.equal(await page.evaluate(() => __fixtureQueries.length), queriesBefore, 'Receipt display, details, Copy, Reply and Edit add no network queries');
    await openMenu(failed);
    assert.equal(await option('edit-resend').isVisible(), true);
    assert.equal(await option('edit').isVisible(), false);
    await option('edit-resend').click();
    assert.equal(await page.evaluate(() => __fixture.sendAssetFormModal.retryTxIdInput.value), '5'.repeat(64));
    assert.equal(await page.evaluate(() => __fixture.sendAssetFormModal.memoInput.value), 'Retry memo');
    assert.equal(await page.evaluate(() => __fixture.sendAssetFormModal.amountInput.value), '5.000000000000000000');
    await page.evaluate(() => { __fixture.sendAssetFormModal.close(); __fixture.clearComposer(); });
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    assert.equal(await page.evaluate(() => __fixtureBroadcasts), 0);
    await page.screenshot({ path: `${output}/collapsed-${viewport.name}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.name} ${viewport.width}px: 5 native LIB receipts, exact/tiny amounts, safe labeled notes, one timestamp, native details toggles/rerender, Copy/Reply/Edit and failed retry, no broadcasts. Blocked external requests: ${external.length}`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
