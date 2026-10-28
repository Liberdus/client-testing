// Setup: npm ci --prefix playwright-tests
// Browser: (cd playwright-tests && npx playwright install chromium)
// Run: WEB_CLIENT_ROOT=/absolute/client/checkout node local-tests/tests/issue-1848-intents-receipts.browser.test.mjs
// Uses synthetic in-memory accounts and stored verdicts; no live verification or transfers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../../playwright-tests/package.json', import.meta.url));
const { chromium } = require('playwright');
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to an absolute implementation checkout');

class IntentsReceiptFixture {
  async start() {
    this.root = resolve(clientRoot);
    const source = await readFile(resolve(this.root, 'app.js'), 'utf8');
    const readyMarker = '  welcomeScreen.lastItem.focus();';
    assert.ok(source.includes(readyMarker), 'Client boot-ready marker is required');
    this.app = source.replace(readyMarker, `${readyMarker} window.__fixtureReady = true;`) + '\n' + this.bootstrap();
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((done, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done); });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.browser = await chromium.launch({ headless: true });
  }

  bootstrap() {
    return String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
queryNetwork = async path => path.endsWith('/balance') ? { balance: 0n } : ({ toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } });
// Remote verification is a synthetic module boundary; the production DOM updater stays real.
verifyVisibleChatPayments = async () => {};
saveState = () => {};
window.__forbiddenCalls = [];
signObj = async () => { window.__forbiddenCalls.push('signing'); throw Error('Fixture forbids signing'); };
injectTx = async () => { window.__forbiddenCalls.push('broadcasting'); throw Error('Fixture forbids broadcasting'); };
isOnline = true;
window.__receiptFixture = {
  async configure(options = {}) {
    this.address = 'b4e8e9102722caed4743b3715c814de077758f01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.tollTimeout = 86400000;
    parameters.current.stabilityFactorStr = '0.008';
    myAccount = { username: 'jordan', keys: { address: 'a'.repeat(40) }, netid: network.netid };
    myData = newDataRecord(myAccount);
    const at = Date.UTC(2026, 9, 28, 15, 28);
    const payment = (my, index) => ({
      type: INTENTS_CHAT_MESSAGE_TYPE, my, message: '', timestamp: at + index * 60000, txid: String(index + 1).repeat(64),
      paymentVerified: options.state || 'settled',
      payment: {
        type: INTENTS_CHAT_MESSAGE_TYPE,
        assetId: my ? 'nep141:sol.omft.near' : 'nep141:nbtc.bridge.near',
        symbol: my ? 'SOL' : 'BTC', chainName: my ? 'Solana' : 'Bitcoin',
        amount: my ? (options.screenshot ? '1.25' : '1.234567891') : '0.000025', decimals: my ? 9 : 8,
        intentHash: 'SyntheticIntentsReceipt' + index,
        ...(my && options.note !== undefined ? { note: options.note } : {}),
        ...(my && options.transaction ? { transactionHash: '8LKE47o44ybZQR9ozLyDnvMDTh4Ao5ipy2mJWsYByG5Q' } : {}),
      },
      ...(my && options.edited ? { edited: true, edited_timestamp: at + 90000 } : {}),
    });
    let messages = [payment(false, 0), payment(true, 1)].reverse();
    if (options.legacy) Object.assign(messages[0].payment, { chainName: '', assetId: '', intentHash: '', transactionHash: '' });
    if (options.knownTypes || options.evmVariant || options.evmPair) messages = [
      { type: 'transfer', my: false, amount: 1000000000000000000n, symbol: 'LIB', message: 'Native note', timestamp: at, txid: '3'.repeat(64) },
      { type: EVM_CHAT_MESSAGE_TYPE, my: true, message: '', timestamp: at + 60000, txid: '4'.repeat(64), paymentVerified: 'settled', payment: {
        type: EVM_CHAT_MESSAGE_TYPE, version: 1, chainId: 1, networkId: 'ethereum', transactionHash: '0x' + '5'.repeat(64),
        from: '0x' + 'a'.repeat(40), to: '0x' + this.address, assetKind: 'native', contractAddress: null,
        rawAmount: '25000000000000000', decimals: 18, symbol: 'ETH', note: 'EVM note',
      } },
    ].reverse();
    if (options.evmVariant) {
      const variants = {
        base: { chainId: 8453, networkId: 'base' },
        bnb: { chainId: 56, networkId: 'bsc', symbol: 'BNB' },
        usdc: { assetKind: 'erc20', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', rawAmount: '25500000', decimals: 6, symbol: 'USDC' },
      };
      if (!variants[options.evmVariant]) throw Error('Unknown synthetic EVM variant');
      Object.assign(messages[0].payment, variants[options.evmVariant]);
    }
    if (options.evmPair) {
      const sent = messages[0];
      const received = { ...sent, my: false, timestamp: at, txid: '3'.repeat(64), payment: {
        ...sent.payment, transactionHash: '0x' + '3'.repeat(64), from: sent.payment.to, to: sent.payment.from,
      } };
      delete received.payment.note;
      Object.assign(sent.payment, { rawAmount: '50000000000000000', note: 'Lunch reimbursement.\nReceipt: https://example.com/receipts/team-lunch' });
      messages = [sent, received];
    }
    myData.contacts[this.address] = {
      address: this.address, username: 'alice', name: 'Alice Morgan', messages,
      toll: 0n, tollUnit: 'LIB', tollRequiredToSend: 0, tollRequiredToReceive: 0,
      friend: 2, unread: 0, timestamp: at, useAvatar: 'identicon', lastChatOpenTs: at + 120000,
    };
    welcomeScreen.close(); header.open(); footer.open();
    await chatModal.open(this.address);
    document.querySelectorAll('.toast').forEach(toast => hideToast(toast.id));
  },
  async setState(state) {
    window.__fixtureVerdicts = { SyntheticIntentsReceipt1: state };
    intentsPaymentVerifications.delete('SyntheticIntentsReceipt1');
    document.querySelector('[data-intent-hash="SyntheticIntentsReceipt1"]').dataset.verified = 'pending';
    await verifyPaymentBubbles();
  },
  largestFont() {
    chatSettingsModal.setSliderValue(chatSettingsModal.maxFontSizePx);
    chatSettingsModal.handleSliderInput();
    chatSettingsModal.save();
  },
  rerender() { chatModal.appendChatModal(false, true); },
};
`;
  }

  async serve(request, response) {
    try {
      const pathname = new URL(request.url, this.origin).pathname;
      const path = resolve(this.root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
      assert.ok(path.startsWith(this.root + sep));
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      let body = path === resolve(this.root, 'app.js') ? this.app : await readFile(path);
      if (path === resolve(this.root, 'near-assets.js')) {
        body = body.toString() + '\nverifyTransferClaim = async payment => ({ state: globalThis.__fixtureVerdicts?.[payment.intentHash] || "settled" });\n';
      }
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }

  async open(t, options = {}, viewport = { width: 390, height: 844 }) {
    const context = await this.browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Chicago', serviceWorkers: 'block' });
    const external = [];
    const errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(this.origin + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => {
      const forbidden = await page.evaluate(() => window.__forbiddenCalls);
      await context.close();
      assert.deepEqual(forbidden, [], 'No signing or broadcasting');
      assert.deepEqual(external, [], 'No external requests');
      assert.deepEqual(errors, [], 'No client errors');
    });
    await page.goto(this.origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(options => window.__receiptFixture.configure(options), options);
    await page.locator('#chatModal.is-transition-complete').waitFor();
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    return page;
  }

  async close() {
    await this.browser?.close();
    if (this.server?.listening) await new Promise(done => this.server.close(done));
  }

  async assertLogo(container, filename) {
    const logo = container.locator('.payment-receipt-heading .payment-receipt-logo');
    assert.equal(await logo.count(), 1);
    await logo.evaluate(image => image.decode());
    const image = await logo.evaluate(image => {
      const box = image.getBoundingClientRect();
      return { source: image.src, alt: image.getAttribute('alt'), width: image.width, height: image.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, renderedWidth: box.width, renderedHeight: box.height };
    });
    assert.equal(image.source, `${this.origin}/media/${filename}`);
    assert.equal(image.alt, '', 'Receipt icons are decorative beside the payment heading');
    assert.equal(image.width, 20);
    assert.equal(image.height, 20);
    assert.equal(image.renderedWidth, 20);
    assert.equal(image.renderedHeight, 20);
    assert.ok(image.naturalWidth > 0 && image.naturalHeight > 0, 'The local asset loaded');
  }

  async screenshot(page, filename) {
    await mkdir(process.env.RECEIPT_ICON_SCREENSHOTS, { recursive: true });
    await page.waitForFunction(() => !document.querySelector('.toast'));
    const visible = await page.locator('#chatModal .message').evaluateAll(messages => messages.every(message => {
      const box = message.getBoundingClientRect();
      const container = message.closest('.messages-container').getBoundingClientRect();
      return box.top >= container.top && box.bottom <= container.bottom;
    }));
    assert.equal(visible, true, 'Both screenshot receipts must be fully visible');
    await page.screenshot({ path: resolve(process.env.RECEIPT_ICON_SCREENSHOTS, filename), animations: 'disabled' });
  }
}

const fixture = new IntentsReceiptFixture();
before(() => fixture.start());
after(() => fixture.close());

test('Intents receipts show direction, exact amounts, safe notes and only available details', async t => {
  const hostile = '<img src=x onerror="window.__injected=1"> <script>window.__injected=1</script> https://example.com/' + 'x'.repeat(35);
  const page = await fixture.open(t, { note: hostile, transaction: true, edited: true });
  const received = page.locator('.message.received .intents-payment-receipt');
  const sent = page.locator('.message.sent .intents-payment-receipt');
  assert.equal(await received.locator('.intents-payment-label').textContent(), 'Payment received');
  assert.equal(await sent.locator('.intents-payment-label').first().textContent(), 'Payment sent');
  assert.match(await received.locator('.intents-payment-amount').textContent(), /\+0\.000025 BTC/);
  assert.match(await sent.locator('.intents-payment-amount').textContent(), /−1\.2345 SOL/);
  assert.equal(await sent.locator('.intents-payment-amount').getAttribute('title'), '1.234567891 SOL');
  assert.equal(await received.locator('[aria-label="Payment note"]').count(), 0);
  assert.equal(await sent.locator('[aria-label="Payment note"] .intents-payment-note').textContent(), hostile);
  assert.equal(await sent.locator('[aria-label="Payment note"] img, [aria-label="Payment note"] script').count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  assert.equal(await sent.locator('.message-time').count(), 1);
  assert.equal(await page.locator('.message.sent .message-edited-label').count(), 1);
  const details = sent.locator('details');
  await details.locator('summary').click();
  const rows = await details.locator('dl > div').evaluateAll(rows => rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent.trim()]));
  assert.deepEqual(rows.map(([label]) => label), ['Amount', 'Network', 'Asset', 'Intent', 'Transaction']);
  assert.equal(rows[0][1], '1.234567891 SOL');
  assert.ok(rows.every(([, value]) => value.length));
  assert.equal(await details.locator('a').count(), 0, 'Hashes remain text without an established explorer');
  await page.evaluate(() => window.__receiptFixture.configure({ legacy: true }));
  const legacyLabels = await page.locator('.message.sent details dt').allTextContents();
  assert.deepEqual(legacyLabels, ['Amount']);
});

test('Stored verification updates retain message and intent identities for every status', async t => {
  const page = await fixture.open(t);
  await page.evaluate(() => {
    window.__originalReceipt = document.querySelector('[data-intent-hash="SyntheticIntentsReceipt1"]');
    const details = window.__originalReceipt.querySelector('details');
    if (details) details.open = true;
  });
  const statuses = { unchecked: 'Checking…', pending: 'Confirming…', settled: 'Confirmed', failed: 'Not confirmed', expired: 'Too old to check', unverifiable: 'Could not check yet' };
  for (const [state, label] of Object.entries(statuses)) {
    await page.evaluate(state => window.__receiptFixture.setState(state), state);
    const bubble = page.locator('#chatModal .message.sent');
    assert.equal(await bubble.getAttribute('data-txid'), '2'.repeat(64));
    const receipt = bubble.locator('.intents-payment-message');
    assert.equal(await receipt.getAttribute('data-intent-hash'), 'SyntheticIntentsReceipt1');
    assert.equal(await receipt.getAttribute('data-verified'), state);
    assert.equal(await receipt.locator('.intents-payment-verified').textContent(), label);
    assert.equal(await bubble.locator('.message-time').count(), 1);
    assert.equal(await page.evaluate(() => window.__originalReceipt === document.querySelector('[data-intent-hash="SyntheticIntentsReceipt1"]')), true);
    if (await receipt.locator('details').count()) assert.equal(await receipt.locator('details').getAttribute('open'), '');
  }
});

test('Real Reply actions preview the signed payment and target the original message', async t => {
  const page = await fixture.open(t, { note: 'Project expenses' });
  for (const direction of ['received', 'sent']) {
    await page.locator(`.message.${direction} .intents-payment-amount`).click();
    await page.locator('#messageContextMenu [data-action="reply"]').click();
    const preview = await page.locator('#replyToMessage').inputValue();
    assert.equal(await page.locator('#replyToTxId').inputValue(), (direction === 'received' ? '1' : '2').repeat(64));
    if (direction === 'sent') assert.match(preview, /^−1\.2345 SOL.*Project expenses/);
    else assert.match(preview, /\+0\.000025 BTC/);
    assert.doesNotMatch(preview, /Payment (?:received|sent|details)|Confirmed|SyntheticIntents|nep141:/);
    await page.locator('#replyPreviewClose').click();
  }
});

test('Payment details toggle with the keyboard without opening the message context menu', async t => {
  const page = await fixture.open(t, { transaction: true });
  const details = page.locator('.message.sent .intents-payment-details');
  const summary = details.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await details.getAttribute('open'), '');
  assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
  await page.keyboard.press('Space');
  assert.equal(await details.getAttribute('open'), null);
  await summary.click();
  await details.locator('dd').last().click();
  assert.equal(await page.locator('#messageContextMenu').isVisible(), false);
  await page.evaluate(() => window.__receiptFixture.rerender());
  assert.equal(await page.locator('#chatModal .message.sent .intents-payment-details').getAttribute('open'), '');
  assert.equal(await page.locator('#chatModal .message.received .intents-payment-details').getAttribute('open'), null);
  assert.equal(await page.locator('#chatModal .message.sent .intents-payment-message').getAttribute('data-intent-hash'), 'SyntheticIntentsReceipt1');
});

test('Receipts wrap long notes and details at 320px, 390px and desktop with the largest chat font', async t => {
  for (const width of [320, 390, 1100]) {
    const page = await fixture.open(t, { note: 'https://example.com/' + 'unbroken'.repeat(15), transaction: true }, { width, height: 1000 });
    await page.evaluate(() => window.__receiptFixture.largestFont());
    await page.locator('.message.sent details summary').click();
    const geometry = await page.locator('.intents-payment-receipt').evaluateAll(receipts => receipts.map(receipt => {
      const bubble = receipt.closest('.message');
      const box = bubble.getBoundingClientRect();
      return { left: box.left, right: box.right, scrollWidth: bubble.scrollWidth, clientWidth: bubble.clientWidth, fontSize: getComputedStyle(receipt.querySelector('.intents-payment-amount')).fontSize };
    }));
    assert.equal(geometry.length, 2);
    assert.ok(geometry.every(box => box.left >= 0 && box.right <= width && box.scrollWidth <= box.clientWidth + 1), JSON.stringify({ width, geometry }));
    assert.ok(geometry.every(box => parseFloat(box.fontSize) >= 30));
  }
});

test('Native LIB and EVM receipts retain their separate headings, notes, details and one timestamp', async t => {
  const page = await fixture.open(t, { knownTypes: true });
  const lib = page.locator('.lib-payment-message');
  const evm = page.locator('.evm-payment-message');
  assert.equal(await lib.locator('.lib-payment-label').first().textContent(), 'Payment received');
  assert.equal(await lib.locator('.payment-amount').textContent(), '1 LIB');
  assert.equal(await lib.locator('.payment-memo').textContent(), 'Native note');
  assert.equal(await lib.locator('.lib-payment-details summary').textContent(), 'Payment details');
  assert.equal(await lib.locator('.message-time').count(), 1);
  assert.equal(await evm.locator('.evm-payment-label').first().textContent(), 'Payment sent');
  assert.equal(await evm.locator('.intents-payment-amount').textContent(), '−0.025 ETH');
  assert.equal(await evm.locator('.intents-payment-note').textContent(), 'EVM note');
  assert.equal(await evm.locator('.evm-payment-details summary').textContent(), 'Payment details');
  assert.equal(await evm.locator('.message-time').count(), 1);
  assert.equal(await page.locator('.intents-payment-receipt').count(), 0);
});

test('Receipt headers load decorative local NEAR logos and native ETH logos on Ethereum and Base', async t => {
  const near = await fixture.open(t, { screenshot: true, note: 'Project expenses.\nReceipt: https://example.com/receipts/project-2026-10-28' });
  for (const direction of ['received', 'sent']) {
    await fixture.assertLogo(near.locator(`#chatModal .message.${direction} .intents-payment-receipt`), 'near_logo.png');
  }
  if (process.env.RECEIPT_ICON_SCREENSHOTS) await fixture.screenshot(near, 'near-after.png');

  for (const variant of ['ethereum', 'base', 'usdc', 'bnb']) {
    const page = await fixture.open(t, variant === 'ethereum' ? { knownTypes: true } : { evmVariant: variant });
    const evm = page.locator('.evm-payment-message');
    if (variant === 'ethereum' || variant === 'base') await fixture.assertLogo(evm, 'ethereum_logo.png');
    else assert.equal(await evm.locator('.payment-receipt-logo').count(), 0, 'ERC20 USDC and native BNB do not use the ETH asset logo');
  }
  const evmPair = await fixture.open(t, { evmPair: true });
  for (const direction of ['received', 'sent']) {
    await fixture.assertLogo(evmPair.locator(`.message.${direction} .evm-payment-message`), 'ethereum_logo.png');
  }
  if (process.env.RECEIPT_ICON_SCREENSHOTS) await fixture.screenshot(evmPair, 'evm-after.png');
});
