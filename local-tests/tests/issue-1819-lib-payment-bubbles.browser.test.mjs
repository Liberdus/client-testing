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
  explorerUrl() { return network.explorerUrl; },
  renderWithoutExplorer() {
    const explorerUrl = network.explorerUrl;
    delete network.explorerUrl;
    chatModal.appendChatModal(false, true);
    network.explorerUrl = explorerUrl;
  },
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
    const errors = [], external = [], explorerNavigations = [];
    const explorerBase = 'https://dev.liberdus.com:3035';
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      if (url.startsWith(explorerBase + '/transaction/') && /^[0-9a-f]{64}$/.test(url.slice(url.lastIndexOf('/') + 1))) {
        explorerNavigations.push(url);
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic native explorer</title>' });
      }
      external.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(() => __fixture.configure());
    assert.equal((await page.evaluate(() => __fixture.explorerUrl()) || '').replace(/\/+$/, ''), explorerBase, 'The selected Devnet configuration provides its native explorer');
    await page.evaluate(() => __fixture.openChat());
    await page.locator('#chatModal.is-transition-complete').waitFor();
    const cards = page.locator('.message.payment-info');
    assert.equal(await cards.count(), 5);
    assert.equal(await cards.locator('.lib-payment-heading img').count(), 5, 'Each native payment has one local logo beside its label');
    await page.waitForFunction(() => [...document.querySelectorAll('.lib-payment-heading img')].every(image => image.complete && image.naturalWidth > 0));
    const assertHeadingGeometry = async () => {
      const geometry = await cards.evaluateAll(elements => elements.map(element => {
        const receipt = element.querySelector('.lib-payment-message');
        const heading = receipt.querySelector('.lib-payment-heading');
        const logo = heading.querySelector('img');
        const label = heading.querySelector('.lib-payment-label');
        const amount = receipt.querySelector('.payment-header');
        const direction = amount.querySelector('.payment-direction');
        const network = receipt.querySelector('.lib-payment-network');
        const note = receipt.querySelector('.lib-payment-note');
        const rect = node => { const { left, top, right, width, height } = node.getBoundingClientRect(); return { left, top, right, width, height }; };
        return { logo: rect(logo), label: rect(label), amount: rect(amount), direction: rect(direction), network: rect(network), note: note && rect(note), receipt: rect(receipt),
          source: new URL(logo.currentSrc).pathname };
      }));
      for (const measured of geometry) {
        assert.equal(measured.source, '/media/liberdus_logo_50.png');
        assert.ok(Math.abs(measured.logo.width - 20) < 0.5 && Math.abs(measured.logo.height - 20) < 0.5, JSON.stringify(measured));
        assert.ok(measured.logo.right <= measured.label.left, 'The logo sits beside the label');
        assert.ok(Math.abs(measured.logo.top + measured.logo.height / 2 - measured.label.top - measured.label.height / 2) < 1, 'Logo and label share a centered heading row');
        for (const block of [measured.amount, measured.direction, measured.network, measured.note].filter(Boolean)) {
          assert.ok(Math.abs(block.left - measured.receipt.left) < 1, 'Amount, network and Note panel retain the receipt left edge: ' + JSON.stringify(measured));
        }
        assert.ok(Math.abs(measured.amount.width - measured.receipt.width) < 1, 'Amount header retains full receipt width');
      }
    };
    const queriesBefore = await page.evaluate(() => __fixtureQueries.length);
    const fontSize = () => cards.first().locator('.payment-amount').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => __fixture.setFont(20));
    const regularFont = await fontSize();
    await page.evaluate(() => __fixture.setFont(30));
    assert.ok(await fontSize() > regularFont, 'Native receipt amount honors the chat font size preference');
    await assertHeadingGeometry();
    const enlarged = await cards.locator('.lib-payment-message').evaluateAll(elements => elements.map(element => ({ client: element.clientWidth, scroll: element.scrollWidth })));
    assert.ok(enlarged.every(size => size.scroll <= size.client + 1), JSON.stringify(enlarged));
    await page.evaluate(() => __fixture.clearToasts());
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    await page.screenshot({ path: `${output}/largest-font-${viewport.name}.png`, fullPage: true });
    await page.evaluate(() => __fixture.setFont(16));
    await assertHeadingGeometry();
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
      const transaction = details.locator('a');
      assert.equal(await transaction.count(), 1);
      const transactionUrl = `${explorerBase}/transaction/${txid}`;
      assert.equal(await transaction.getAttribute('href'), transactionUrl);
      assert.equal(await transaction.getAttribute('target'), '_blank');
      assert.equal(await transaction.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await transaction.getAttribute('aria-label'), `View transaction ${txid} in block explorer`);
      assert.ok((await transaction.innerText()).includes('↗'));
      if (txid.startsWith('5') || txid.startsWith('4')) {
        const popupReady = context.waitForEvent('page');
        if (mobile) await transaction.tap(); else await transaction.click();
        const popup = await popupReady;
        await popup.waitForLoadState('domcontentloaded');
        assert.equal(popup.url(), transactionUrl);
        await popup.close();
        assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      }
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
    await page.evaluate(() => __fixture.renderWithoutExplorer());
    assert.equal(await cards.locator('.lib-payment-details a').count(), 0, 'Missing explorer configuration renders a plain full hash');
    assert.equal(await cards.locator('.lib-payment-details code').count(), 5);
    await page.evaluate(() => __fixture.rerender());
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
    await sent.locator('.lib-payment-details code').scrollIntoViewIfNeeded();
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
    assert.deepEqual(external, []);
    assert.equal(explorerNavigations.length, 2);
    console.log(`PASS ${viewport.name} ${viewport.width}px: 5 native LIB receipts, local 20px heading logos, aligned full-width amount/network/Note panels at 16px and 30px fonts, exact/tiny amounts, safe notes, one timestamp, details toggles/rerender, native full-hash explorer links/popups and plain fallback, Copy/Reply/Edit and failed retry, no broadcasts. Synthetic explorer navigations: ${explorerNavigations.length}; unexpected external requests: ${external.length}`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
