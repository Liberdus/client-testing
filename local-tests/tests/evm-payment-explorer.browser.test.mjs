import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serveOnly = process.argv.includes('--serve');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const fixtureSource = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
window.__fixtureQueries = [];
queryNetwork = async (...args) => { window.__fixtureQueries.push(args); return { toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } }; };
updateAssetPricesIfNeeded = async () => {};
isOnline = false;
window.__fixture = {
  evmAssets, chatModal,
  clearToasts() { document.querySelectorAll('.toast').forEach(toast => hideToast(toast.id)); },
  configure() {
    const owner = 'a'.repeat(40);
    const recipient = 'b'.repeat(40);
    myAccount = { username: 'sender', keys: { address: owner }, netid: network.netid };
    parameters.current.defaultTollUsdStr = '0';
    myData = newDataRecord(myAccount);
    myData.contacts[recipient] = { address: recipient, username: 'recipient', messages: [],
      toll: 0n, tollUnit: 'LIB', tollRequiredToSend: 0, tollRequiredToReceive: 0, friend: 2,
      unread: 0, timestamp: 0, useAvatar: 'identicon' };
    this.recipient = recipient;
    this.makePayment = (chainId, hashDigit, incoming = false) => ({
      type: 'evm_transfer', version: 1, chainId,
      networkId: ({ 1: 'ethereum', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 8453: 'base' })[chainId] || 'unknown',
      transactionHash: '0x' + hashDigit.repeat(64), from: '0x' + (incoming ? recipient : owner),
      to: '0x' + (incoming ? owner : recipient), assetKind: 'native', contractAddress: null,
      rawAmount: '1000000000000000', decimals: 18, symbol: ({ 56: 'BNB', 137: 'POL' })[chainId] || 'ETH',
    });
    this.records = [
      { kind: 'outgoing', payment: this.makePayment(1, '1'), assetState: 'pending', messageState: 'none', broadcastState: 'accepted', checkAttempts: 20 },
      { kind: 'outgoing', payment: this.makePayment(56, '2'), assetState: 'reverted', messageState: 'none', broadcastState: 'accepted', checkAttempts: 0, username: 'recipient' },
      { kind: 'outgoing', payment: this.makePayment(137, '3'), assetState: 'unknown', messageState: 'none', broadcastState: 'nonce_used', checkAttempts: 20 },
      { kind: 'outgoing', payment: this.makePayment(99999, '4'), assetState: 'pending', messageState: 'none', broadcastState: 'accepted', checkAttempts: 20 },
    ];
    this.records.forEach(record => { record.networkId = record.payment.networkId; });
    myData.evmPayments = this.records;
    this.recoveryCalls = [];
    evmAssets.checkPayment = async payment => { this.recoveryCalls.push(['check', payment.transactionHash]); };
    evmAssets.reviewPayment = async (payment, recipient) => { this.recoveryCalls.push(['review', payment.transactionHash, recipient]); };
    evmAssets.discovery.refresh = async () => evmAssets.getEvmCatalog();
    welcomeScreen.close();
    header.open(); footer.open(); walletScreen.screen.classList.add('active');
  },
  async openChat() {
    evmAssets.assetsModal.close();
    evmAssets.discovery.reset();
    myData.evmPayments = [];
    myData.contacts[this.recipient].messages = [
      [1, '5', false, 'pending'], [56, '6', true, 'failed'], [137, '7', false, 'unverifiable'],
      [42161, '8', true, 'unchecked'], [10, '9', true, 'settled'], [8453, 'a', true, 'settled'],
      [99999, 'b', true, 'unchecked'], [56, 'c', false, 'pending'], [56, 'd', true, 'settled'],
      [10, 'e', true, 'expired'],
    ].map(([chainId, digit, incoming, verified], index) => ({ type: 'evm_transfer',
      payment: { ...this.makePayment(chainId, digit, incoming), ...(['c', 'd'].includes(digit)
        ? { assetKind: 'erc20', contractAddress: '0x55d398326f99059ff775485246999027b3197955',
          symbol: 'USDT', decimals: 18, rawAmount: '25500000000000000000', note: 'Lunch\nThanks <3' } : {}) }, my: !incoming,
      timestamp: Date.now() - index * 1000, txid: digit.repeat(64), paymentVerified: verified,
      ...(verified === 'failed' ? { paymentReverted: true } : {}),
    }));
    await chatModal.open(this.recipient);
  },
  async showTokenChat() {
    myData.contacts[this.recipient].messages = myData.contacts[this.recipient].messages.filter(message => message.payment.symbol === 'USDT');
    await chatModal.open(this.recipient);
  },
};
`;
const app = appSource.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixtureSource + (serveOnly ? `
(async () => {
  while (!window.__fixtureReady || !document.querySelector('#bootSplash.hidden')) await new Promise(resolve => setTimeout(resolve, 20));
  __fixture.configure();
  await __fixture.openChat();
  await __fixture.showTokenChat();
  const received = myData.contacts[__fixture.recipient].messages.find(message => !message.my);
  delete received.payment.note;
  chatModal.appendChatModal(false, true);
  const rerender = document.createElement('button');
  rerender.id = 'fixture-rerender';
  rerender.textContent = 'Test chat rerender';
  rerender.style.cssText = 'position:fixed;top:12px;left:12px;z-index:20000';
  rerender.addEventListener('click', () => { chatModal.appendChatModal(false, true); rerender.remove(); });
  document.body.append(rerender);
  document.body.dataset.fixtureReady = 'true';
})().catch(console.error);
` : '');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) throw Error('Outside repository');
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (serveOnly) {
  console.log(`Fixture ready at ${origin}`);
  await new Promise(resolve => process.once('SIGINT', resolve));
  await new Promise(resolve => server.close(resolve));
  process.exit(0);
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 740 }]) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Chicago' });
    await context.addInitScript(() => {
      window.__displayFetchCalls = [];
      const originalFetch = window.fetch;
      window.fetch = (...args) => { window.__displayFetchCalls.push(String(args[0])); return originalFetch(...args); };
    });
    const errors = [];
    const external = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      external.push(url);
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted explorer</title>' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.stack || error.message); console.error('PAGEERROR', error.message, error.stack); });
    page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(() => __fixture.configure());
    await page.locator('#evmAssetsSummary').click();
    await page.locator('#assetsModal.is-transition-complete').waitFor();
    const recovery = page.locator('.evm-payment-pending-row');
    assert.equal(await recovery.count(), 4);
    const firstHash = '0x' + '1'.repeat(64);
    const firstLink = recovery.nth(0).locator('.evm-payment-transaction a');
    assert.equal(await firstLink.getAttribute('href'), `https://etherscan.io/tx/${firstHash}`);
    assert.equal(await firstLink.getAttribute('title'), firstHash);
    assert.equal(await firstLink.textContent(), `0x${'1'.repeat(8)}…${'1'.repeat(8)}`);
    assert.equal(await firstLink.getAttribute('rel'), 'noopener noreferrer');
    assert.match(await recovery.nth(0).innerText(), /To 0xbbbbbb…bbbbbb/);
    assert.match(await recovery.nth(1).innerText(), /Transfer failed/);
    assert.match(await recovery.nth(2).innerText(), /Outcome unavailable/);
    assert.equal(await recovery.nth(3).locator('.evm-payment-transaction a').count(), 0);
    assert.equal(await recovery.nth(3).locator('.evm-payment-transaction span').getAttribute('title'), '0x' + '4'.repeat(64));
    const popupPromise = context.waitForEvent('page');
    if (mobile) await firstLink.tap(); else await firstLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), `https://etherscan.io/tx/${firstHash}`);
    await popup.close();
    assert.deepEqual(await page.evaluate(() => __fixture.recoveryCalls), []);
    await recovery.nth(0).getByRole('button', { name: 'Check again', exact: true }).click();
    await recovery.nth(1).getByRole('button', { name: 'Retry transfer', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => __fixture.recoveryCalls.map(call => call[0])), ['check', 'review']);
    const recoveryOverflow = await recovery.locator('.evm-payment-transaction').evaluateAll(elements => elements.map(el => ({ client: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right })));
    assert.ok(recoveryOverflow.every(size => size.scroll <= size.client + 1 && size.right <= viewport.width), JSON.stringify(recoveryOverflow));
    await page.evaluate(() => __fixture.clearToasts());
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    await page.screenshot({ path: `/tmp/evm-explorer-recovery-${viewport.name}.png`, fullPage: true });
    await page.evaluate(() => __fixture.openChat());
    await page.locator('#chatModal.is-transition-complete').waitFor();
    const cards = page.locator('.evm-payment-message');
    assert.equal(await cards.count(), 10);
    const hosts = { 1: 'etherscan.io', 56: 'bscscan.com', 137: 'polygonscan.com', 42161: 'arbiscan.io', 10: 'optimistic.etherscan.io', 8453: 'basescan.org' };
    for (const [id, host] of Object.entries(hosts)) {
      const anchor = page.locator(`.evm-payment-message[data-evm-payment^="${id}:"] .evm-payment-details a[href*="/tx/"]`);
      assert.ok(await anchor.count() >= 1);
      for (const link of await anchor.all()) {
        assert.equal(new URL(await link.getAttribute('href')).host, host);
        assert.match(await link.getAttribute('title'), /^0x[0-9a-f]{64}$/);
        assert.ok((await link.getAttribute('aria-label')).includes(await link.getAttribute('title')));
      }
    }
    assert.equal(await page.locator('.evm-payment-message[data-evm-payment^="99999:"] .evm-payment-details a').count(), 0);
    assert.equal(await page.evaluate(() => __fixture.evmAssets.getPayments().length), 0);
    assert.equal(await page.evaluate(() => __fixture.evmAssets.discovery.portfolio), null);
    const beforeQueries = await page.evaluate(() => ({ queries: __fixtureQueries.length, fetches: __displayFetchCalls.length }));
    const expectedStatus = { pending: 'Confirming…', failed: 'Not confirmed', unverifiable: 'Could not check yet', unchecked: 'Checking…', settled: 'Confirmed', expired: 'Too old to check' };
    for (const card of await cards.all()) {
      const state = await card.getAttribute('data-verified');
      assert.equal((await card.locator('.intents-payment-verified').textContent()).trim(), expectedStatus[state]);
      const time = card.locator('.message-time');
      assert.equal(await time.count(), 1);
      assert.equal(await card.locator('.evm-payment-footer .message-time').count(), 1);
      const message = card.locator('..');
      assert.equal(await message.locator('.message-time').count(), 1);
      const timestamp = Number(await message.getAttribute('data-message-timestamp'));
      const expectedTime = await page.evaluate(timestamp => new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }), timestamp);
      assert.equal((await time.textContent()).trim(), expectedTime);
      const summary = card.locator('.evm-payment-details summary');
      const fullHash = (await card.getAttribute('data-evm-payment')).split(':')[1];
      const compactHash = `${fullHash.slice(0, 10)}…${fullHash.slice(-8)}`;
      const transactionCode = card.locator('code').filter({ hasText: fullHash });
      assert.equal(await transactionCode.count(), 1);
      assert.equal(await transactionCode.isVisible(), false);
      assert.ok(!(await card.innerText()).includes(compactHash), 'Collapsed cards must omit the abbreviated hash');
      if (mobile) await summary.tap(); else await summary.click();
      assert.equal(await card.locator('.evm-payment-details').getAttribute('open'), '');
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      assert.equal(await transactionCode.isVisible(), true);
      assert.equal(await transactionCode.textContent(), fullHash);
      assert.equal((await card.innerText()).split(fullHash).length - 1, 1, 'Expanded cards must display the full hash exactly once');
      assert.ok(!(await card.innerText()).includes(compactHash), 'Expanded cards must not repeat an abbreviated hash');
      const transactionLinks = card.locator('.evm-payment-details a[href*="/tx/"]');
      const unknownChain = (await card.getAttribute('data-evm-payment')).startsWith('99999:');
      assert.equal(await transactionLinks.count(), unknownChain ? 0 : 1);
      const openedOverflow = await card.locator('.evm-payment-details dd').evaluateAll(elements => elements.map(el => ({ client: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right })));
      assert.ok(openedOverflow.every(size => size.scroll <= size.client + 1 && size.right <= viewport.width), JSON.stringify(openedOverflow));
      const detailsText = card.locator('.evm-payment-details dt').last();
      if (mobile) await detailsText.tap(); else await detailsText.click();
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      if (mobile) await summary.tap(); else await summary.click();
      assert.equal(await card.locator('.evm-payment-details').getAttribute('open'), null);
    }
    for (const chainId of [42161, 56]) {
      const card = page.locator(`.evm-payment-message[data-evm-payment^="${chainId}:"]`).first();
      const summary = card.locator('.evm-payment-details summary');
      if (mobile) await summary.tap(); else await summary.click();
      const chatLink = card.locator('.evm-payment-details a[href*="/tx/"]');
      const expectedChatUrl = await chatLink.getAttribute('href');
      const chatPopupPromise = context.waitForEvent('page');
      if (mobile) await chatLink.tap(); else await chatLink.click();
      const chatPopup = await chatPopupPromise;
      await chatPopup.waitForLoadState();
      assert.equal(chatPopup.url(), expectedChatUrl);
      await chatPopup.close();
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
      if (mobile) await summary.tap(); else await summary.click();
    }
    const cardBody = page.locator('.evm-payment-message[data-evm-payment^="42161:"] .intents-payment-amount');
    await cardBody.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (mobile) await cardBody.tap(); else await cardBody.click();
    assert.equal(await page.locator('#messageContextMenu').isVisible(), true);
    await page.evaluate(() => __fixture.chatModal.closeAllContextMenus());
    assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
    const overflow = await cards.locator('.evm-payment-footer').evaluateAll(elements => elements.map(el => ({ client: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right })));
    assert.ok(overflow.every(size => size.scroll <= size.client + 1 && size.right <= viewport.width), JSON.stringify(overflow));
    assert.deepEqual(await page.evaluate(() => ({ queries: __fixtureQueries.length, fetches: __displayFetchCalls.length })), beforeQueries);
    await page.evaluate(() => __fixture.chatModal.appendChatModal(false, true));
    assert.deepEqual(await page.evaluate(() => ({ queries: __fixtureQueries.length, fetches: __displayFetchCalls.length })), beforeQueries);
    await page.evaluate(() => __fixture.showTokenChat());
    const tokens = page.locator('.evm-payment-message');
    assert.equal(await tokens.count(), 2);
    for (const token of await tokens.all()) {
      assert.equal(await token.locator('.evm-payment-unit').textContent(), 'USDT');
      assert.equal((await token.locator('.intents-payment-amount').textContent()).trim().replace(/\s+/g, ' '), `${await token.locator('..').getAttribute('class').then(classes => classes.includes('sent') ? '−' : '+')}25.5 USDT`);
      assert.equal((await token.locator('.intents-payment-note').textContent()).trim(), 'Lunch\nThanks <3');
      assert.equal(await token.locator('.evm-payment-contract').count(), 0);
      assert.equal(await token.locator('.evm-payment-note .evm-payment-label').textContent(), 'Note');
      assert.equal(await token.locator('.evm-payment-details code').first().textContent(), '0x55d398326f99059ff775485246999027b3197955');
      assert.equal(await token.locator('img').count(), 0);
    }
    await page.screenshot({ path: `/tmp/evm-refined-chat-${viewport.name}.png`, fullPage: true });
    const details = tokens.first().locator('.evm-payment-details');
    if (mobile) await details.locator('summary').tap(); else await details.locator('summary').click();
    assert.equal(await details.locator('code').first().textContent(), '0x55d398326f99059ff775485246999027b3197955');
    for (const link of await details.locator('a').all()) {
      const url = await link.getAttribute('href');
      assert.ok(url.startsWith('https://bscscan.com/token/') || url.startsWith('https://bscscan.com/tx/'));
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      const detailPopupPromise = context.waitForEvent('page');
      await link.click();
      const detailPopup = await detailPopupPromise;
      await detailPopup.waitForLoadState();
      assert.equal(detailPopup.url(), url);
      await detailPopup.close();
      assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
    }
    const detailOverflow = await details.locator('dd').evaluateAll(elements => elements.map(el => ({ client: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right })));
    assert.ok(detailOverflow.every(size => size.scroll <= size.client + 1 && size.right <= viewport.width), JSON.stringify(detailOverflow));
    assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
    const beforeDisclosureRerender = await page.evaluate(() => ({ queries: __fixtureQueries.length, fetches: __displayFetchCalls.length }));
    await page.evaluate(() => __fixture.chatModal.appendChatModal(false, true));
    assert.equal(await details.getAttribute('open'), '');
    assert.equal(await tokens.first().locator('.message-time').count(), 1);
    assert.deepEqual(await page.evaluate(() => ({ queries: __fixtureQueries.length, fetches: __displayFetchCalls.length })), beforeDisclosureRerender);
    assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
    await page.screenshot({ path: `/tmp/evm-refined-details-${viewport.name}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.name} ${viewport.width}px: 4 unchanged recovery rows, 10 native/ERC-20 chat cards, all 6 outcomes, exact single timestamps, full transaction hashes only once inside Payment details, native details toggle/selection, explorer popups and card menus, 6 chains with no portfolio/recovery, fallback and overflow. Display interactions/rerender added zero queries or fetches. Intercepted external requests: ${external.length}`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
