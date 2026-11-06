import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, isAbsolute, resolve, sep } from 'node:path';

// Resolve the repository's pinned browser dependency without a separate test package.
const require = createRequire(new URL('../../playwright-tests/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root && isAbsolute(root), 'Set WEB_CLIENT_ROOT to the absolute client checkout.');
const output = '/tmp/issue-1880-near-receive';

// Run the real application and DOM with synthetic balances. No account is created,
// and every external request and all signing/broadcast entry points are blocked.
const fixture = String.raw`
const syntheticNear = await import('./near-assets.js');
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
window.__signings = 0;
window.__broadcasts = 0;
postAssetTransfer = async () => { window.__broadcasts++; throw Error('Fixture forbids broadcasting'); };
signObj = async () => { window.__signings++; throw Error('Fixture forbids signing'); };
queryNetwork = async (path) => {
  if (path.endsWith('/balance')) return { balance: 1000n * wei };
  throw Error('Unexpected synthetic query: ' + path);
};
window.__fixture = {
  nativeSend: sendAssetFormModal,
  multichain,
  configure(username = 'receiver', address = 'a'.repeat(40)) {
    parameters.current.stabilityFactorStr = '0.2';
    parameters.current.transactionFeeUsdStr = '0.01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.minTollUsdStr = '0';
    myAccount = { username, keys: { address }, netid: network.netid };
    myData = newDataRecord(myAccount);
    myData.wallet.assets[0].balance = 1000n * wei;
    myData.wallet.assets[0].price = 0.2;
    const discovery = syntheticNear.intentsAssets;
    discovery.activateAccount(intentsAccountIdForAddress(address));
    discovery.tokens = [
      { assetId: 'nep141:bsc.omft.near', decimals: 18, blockchain: 'bsc', symbol: 'BNB', price: 600 },
      { assetId: 'nep141:usdc.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1 },
    ];
    discovery.balances = { 'nep141:bsc.omft.near': '2000000000000000000', 'nep141:usdc.omft.near': '10000000' };
    discovery.rebuildNetwork();
    discovery.status = 'connected';
    discovery.refresh = async () => discovery.getNetwork();
    syntheticNear.intentsActivity.configure({ fetchDeposits: async () => [], listPayments: () => [], getOrders: () => [] });
    syntheticNear.intentsDeposits.loadBridgeTokens = async () => [];
    syntheticNear.intentsDeposits.requestDepositTarget = async () => ({
      address: '0x' + 'd'.repeat(40), chain: 'bsc', chainName: 'BNB Chain', assetName: 'BNB', minDepositRaw: '0', siblings: 0,
    });
    chatPaymentPanel.run = async () => { window.__signings++; throw Error('Fixture forbids multichain signing'); };
    isOnline = true;
    welcomeScreen.close(); header.open(); footer.open(); walletScreen.screen.classList.add('active');
  },
  openAsset(id = 'nep141:bsc.omft.near') { multichain.assetModal.open('intents:' + id); },
  installBack() {
    history.pushState({ state: 1 }, '', '.');
    window.addEventListener('popstate', handleBrowserBackButton, { once: true });
  },
  switchAccount() {
    multichain.reset();
    this.configure('seconduser', 'c'.repeat(40));
  },
};
`;

class ReceiveRegression {
  async start() {
    const source = await readFile(resolve(root, 'app.js'), 'utf8');
    this.app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise(done => this.server.listen(0, '127.0.0.1', done));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await mkdir(output, { recursive: true });
  }

  async serve(request, response) {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html')));
      assert.ok(path.startsWith(root + sep));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
      response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      response.end(path === resolve(root, 'app.js') ? this.app : await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  }

  async decode(page, displayed = false) {
    const screenshot = displayed ? (await page.locator('#multichainRequestQr img').screenshot()).toString('base64') : null;
    return page.evaluate(async screenshot => {
      const image = screenshot ? new Image() : document.querySelector('#multichainRequestQr img');
      if (screenshot) image.src = 'data:image/png;base64,' + screenshot;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const uri = qr.decodeQR({ data: pixels.data, width: pixels.width, height: pixels.height });
      if (!uri.startsWith('liberdus://')) throw Error('Missing payment URI');
      const bytes = Uint8Array.from(atob(uri.slice('liberdus://'.length)), char => char.charCodeAt(0));
      return { uri, data: JSON.parse(new TextDecoder().decode(bytes)) };
    }, screenshot);
  }

  async openReceive(page) {
    await page.locator('#multichainAssetReceive').click();
    await page.locator('#multichainRequestModal.active.is-transition-complete').waitFor();
    await page.locator('#multichainRequestQr img').waitFor();
  }

  async layout(page, name) {
    const address = await page.locator('#multichainRequestAddress').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const style = getComputedStyle(element);
      return {
        lines: range.getClientRects().length,
        textWidth: range.getBoundingClientRect().width,
        availableWidth: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    });
    assert.equal(address.lines, 1, `${name}: the complete address stays on one line`);
    assert.ok(address.textWidth <= address.availableWidth + 1, `${name}: the complete address fits without clipping`);
    const rects = await page.locator('#multichainRequestModal').evaluate(modal => {
      const measured = [modal, ...modal.querySelectorAll('.address-container, input, textarea, img, .address-copy-button')];
      return measured.map(element => {
        const { left, right, width, height } = element.getBoundingClientRect();
        return { id: element.id || element.tagName, left, right, width, height, viewport: innerWidth };
      });
    });
    for (const rect of rects) {
      assert.ok(rect.width > 0 && rect.height > 0, `${name}: ${rect.id} has dimensions`);
      assert.ok(rect.left >= -1 && rect.right <= rect.viewport + 1, `${name}: ${rect.id} fits horizontally`);
    }
    await page.screenshot({ path: `${output}/receive-${name}.png`, fullPage: true });
  }

  async runViewport(viewport) {
    const context = await this.browser.newContext({ viewport: { width: viewport.width, height: 900 }, colorScheme: viewport.colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.__copied.push(text) }, configurable: true });
    });
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(this.origin + '/')) return route.continue();
      if (route.request().resourceType() === 'image') {
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#888"/></svg>' });
      }
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    try {
      await page.goto(this.origin);
      await page.waitForFunction(() => window.__fixtureReady === true);
      await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
      await page.evaluate(() => __fixture.configure());
      await page.evaluate(() => __fixture.openAsset());
      await page.locator('#multichainAssetModal.active.is-transition-complete').waitFor();
      const groups = page.locator('#multichainAssetModal .multichain-action-groups section');
      assert.equal(await groups.count(), 2, 'external and internal actions have separate groups');
      assert.deepEqual(await groups.nth(0).locator('button').allTextContents().then(values => values.map(value => value.trim())), ['Deposit', 'Withdraw']);
      assert.deepEqual(await groups.nth(1).locator('button').allTextContents().then(values => values.map(value => value.trim())), ['Receive', 'Send', 'Swap']);
      await page.screenshot({ path: `${output}/asset-${viewport.name}.png`, fullPage: true });

      await page.locator('#multichainAssetDeposit').click();
      await page.locator('#multichainReceiveModal.active.is-transition-complete').waitFor();
      assert.equal(await page.locator('#multichainReceiveBody [data-copy]').first().getAttribute('data-copy'), '0x' + 'd'.repeat(40), 'Deposit retains the external bridge destination');
      assert.equal(await page.locator('#multichainRequestModal.active').count(), 0);
      await page.locator('#closeMultichainReceiveModal').click();

      await this.openReceive(page);
      assert.match(await page.locator('#multichainRequestTitle').textContent(), /BNB/);
      assert.equal(await page.locator('#multichainRequestSymbol').textContent(), 'BNB');
      assert.equal(await page.locator('#multichainRequestAddress').textContent(), '0x' + 'a'.repeat(40));
      assert.equal(await page.locator('#multichainRequestUsername').textContent(), 'receiver');
      const expected = { t: 'intents', address: '0x' + 'a'.repeat(40), u: 'receiver', i: 'nep141:bsc.omft.near', s: 'BNB' };
      assert.deepEqual((await this.decode(page)).data, expected);
      await page.locator('#copyMultichainRequestAddress').focus();
      await page.keyboard.press('Enter');
      await page.locator('#copyMultichainRequestUsername').focus();
      await page.keyboard.press('Space');
      assert.deepEqual(await page.evaluate(() => __copied), [expected.address, expected.u]);
      await page.locator('#multichainRequestAmount').fill('0.000000000000000001');
      await page.locator('#multichainRequestMemo').fill('Lunch 🍕 café\nThank you');
      await page.waitForTimeout(400);
      const request = await this.decode(page);
      assert.deepEqual(request.data, { ...expected, a: '0.000000000000000001', m: 'Lunch 🍕 café\nThank you' });
      await page.locator('#multichainRequestMemo').fill('漢'.repeat(140));
      assert.deepEqual((await this.decode(page, true)).data, { ...expected, a: request.data.a, m: '漢'.repeat(140) }, 'the displayed QR remains readable at the full Unicode memo limit');
      await page.locator('#multichainRequestMemo').fill(request.data.m);
      await this.layout(page, viewport.name);
      await page.locator('#multichainRequestAmount').fill('');
      await page.locator('#multichainRequestMemo').fill('');
      await page.waitForTimeout(400);
      assert.deepEqual((await this.decode(page)).data, expected);
      await page.locator('#multichainRequestAmount').fill('0');
      assert.equal(await page.locator('#multichainRequestQr img').count(), 0, 'zero amount does not produce a misleading request');
      assert.ok(await page.locator('#multichainRequestStatus').textContent());
      await page.locator('#multichainRequestAmount').fill('0.0000000000000000001');
      assert.equal(await page.locator('#multichainRequestQr img').count(), 0, 'excess token precision is rejected');
      await page.locator('#multichainRequestAmount').fill('');
      await page.locator('#closeMultichainRequestModal').click();
      await page.waitForFunction(() => !document.querySelector('#multichainRequestModal').classList.contains('active'));
      assert.equal(await page.locator('#multichainAssetModal.active').count(), 1);

      await this.openReceive(page);
      assert.equal(await page.locator('#multichainRequestAmount').inputValue(), '');
      await page.evaluate(() => __fixture.installBack());
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector('#multichainRequestModal').classList.contains('active'));
      assert.equal(await page.locator('#multichainAssetModal.active').count(), 1);

      await page.evaluate(() => __fixture.openAsset('nep141:usdc.omft.near'));
      await this.openReceive(page);
      assert.equal(await page.locator('#multichainRequestSymbol').textContent(), 'USDC');
      assert.deepEqual((await this.decode(page)).data, { ...expected, i: 'nep141:usdc.omft.near', s: 'USDC' });
      await page.locator('#multichainRequestMemo').fill('Must not survive account switch');
      await page.evaluate(() => __fixture.switchAccount());
      assert.equal(await page.locator('#multichainRequestModal.active').count(), 0);
      await page.evaluate(() => __fixture.openAsset());
      await this.openReceive(page);
      assert.deepEqual((await this.decode(page)).data, { ...expected, address: '0x' + 'c'.repeat(40), u: 'seconduser' });
      assert.equal(await page.locator('#multichainRequestMemo').inputValue(), '');

      // The existing LIB reader must not interpret this deferred request as LIB.
      const unsupportedRequest = await this.decode(page);
      await page.evaluate(() => {
        __fixture.multichain.requestModal.close();
        __fixture.multichain.assetModal.close();
      });
      await page.locator('#openSendAssetFormModal').click();
      await page.locator('#sendAssetFormModal.active.is-transition-complete').waitFor();
      await page.evaluate(uri => __fixture.nativeSend.fillFromQR(uri), unsupportedRequest.uri);
      assert.equal(await page.locator('#chatSendModal.active').count(), 0);
      assert.equal(await page.locator('#sendAssetFormModal.active').count(), 1);
      assert.equal(await page.locator('#sendToAddress').inputValue(), '');
      assert.equal(await page.locator('#sendAmount').inputValue(), '');
      assert.equal(await page.locator('#sendMemo').inputValue(), '');

      assert.equal(await page.evaluate(() => __signings), 0);
      assert.equal(await page.evaluate(() => __broadcasts), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`PASS ${viewport.name}: grouped actions, actual QR round trip, copy, header/browser Back, asset/account reset, unsupported LIB request rejection, responsive geometry; zero signing/broadcasts/unmocked external requests`);
    } finally {
      await context.close();
    }
  }

  async close() {
    await this.browser?.close();
    if (this.server) await new Promise(done => this.server.close(done));
  }
}

const regression = new ReceiveRegression();
try {
  await regression.start();
  await regression.runViewport({ name: 'desktop-light', width: 1100, colorScheme: 'light' });
  await regression.runViewport({ name: 'mobile-dark-preference', width: 360, colorScheme: 'dark' });
  await regression.runViewport({ name: 'narrow-mobile', width: 320, colorScheme: 'light' });
  console.log(`Screenshots: ${output}`);
} finally {
  await regression.close();
}
