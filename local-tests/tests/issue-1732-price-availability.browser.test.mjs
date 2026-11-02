// Standalone real-client browser regression; no shared local-tests runner is required.
// WEB_CLIENT_ROOT=/absolute/client PLAYWRIGHT_ROOT=/absolute/client-testing/playwright-tests \
//   node local-tests/tests/issue-1732-price-availability.browser.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureSource = String.raw`
import { intentsAssets as priceTestIntents } from './near-assets.js';
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
window.__signings = 0; window.__broadcasts = 0; window.__balanceQueries = 0;
signObj = async () => { __signings++; throw Error('Offline fixture forbids signing'); };
postAssetTransfer = async () => { __broadcasts++; throw Error('Offline fixture forbids broadcasts'); };
let priceTestBalance = 250n * wei;
queryNetwork = async path => {
  if (!path.endsWith('/balance')) throw Error('Unexpected offline query: ' + path);
  __balanceQueries++;
  return { balance: priceTestBalance };
};
window.__prices = {
  async configure() {
    window.LIBERDUS_ONECLICK_BASE_URL = location.origin + '/fixture/oneclick';
    window.LIBERDUS_NEAR_RPC_URL = location.origin + '/fixture/near';
    window.LIBERDUS_WALLET_PROBE_BASE_URL = location.origin + '/fixture/evm';
    parameters.current.defaultTollUsdStr = '0';
    myAccount = { username: 'synthetic', keys: { address: 'a'.repeat(40) }, netid: network.netid };
    myData = newDataRecord(myAccount);
    priceTestIntents.tokenCatalogTtlMs = 0;
    priceTestIntents.balanceCacheTtlMs = 0;
    evmAssets.discovery.cacheTtlMs = 0;
    evmAssets.transactions.send = async () => { __signings++; throw Error('Offline fixture forbids EVM signing'); };
    evmAssets.transactions.broadcast = async () => { __broadcasts++; throw Error('Offline fixture forbids EVM broadcasts'); };
    chatPaymentPanel.run = async () => { __signings++; throw Error('Offline fixture forbids multichain signing'); };
    isOnline = true; walletScreen.firstTimeLoad = false;
    myData.wallet.timestamp = getCorrectedTimestamp();
    myData.wallet.balanceUpdatedAt = getCorrectedTimestamp();
    myData.wallet.overviewUpdatedAt = getCorrectedTimestamp();
    welcomeScreen.close(); header.open(); footer.open(); header.setText('synthetic');
    await header.updateAvatar(); chatsScreen.close(); contactsScreen.close();
    setFirstTimeTipShown('testnetWarning'); walletScreen.open();
    footer.walletButton.classList.add('active'); footer.newChatButton.classList.remove('visible');
    evmAssets.assetsModal.networkSelect.value = 'ethereum';
    this.setNativeState('all'); updateUIForConnectivity(); await this.refresh();
  },
  setNativeState(state) {
    priceTestBalance = (state === 'zero' ? 0n : 250n) * wei;
    parameters.current.stabilityFactorStr = ['all', 'price-zero', 'zero'].includes(state) ? '0.005' : '';
  },
  async refresh() {
    myData.wallet.timestamp = 0;
    await walletScreen.updateWalletView();
    multichain.assetsModal.render();
    evmAssets.assetsModal.renderBalances();
  },
  snapshot() {
    return {
      multichainStatus: priceTestIntents.getStatus(), evmStatus: evmAssets.getStatus(),
      amounts: priceTestIntents.getAssets().map(asset => [asset.tokenSymbol, asset.tokenAmount]).sort(),
      evmAmounts: evmAssets.getNetwork('ethereum').assets.map(asset => [asset.tokenSymbol, asset.tokenAmount]).sort(),
      native: document.querySelector('#assetsList .wallet-native-quantity').textContent,
      signings: __signings, broadcasts: __broadcasts, balanceQueries: __balanceQueries,
    };
  }
};
`;

/** Actual app and discovery/rendering services; only read-only transport is synthetic. */
export class PriceBrowserFixture {
  constructor({ root, viewport, output, recordVideo = false }) {
    assert.ok(isAbsolute(root || ''), 'Set absolute WEB_CLIENT_ROOT');
    this.root = root; this.viewport = viewport; this.output = output; this.recordVideo = recordVideo;
    this.stage = 'all'; this.lastAvailability = 'all'; this.requests = { tokens: 0, near: 0, evm: 0 };
    this.external = []; this.errors = [];
  }

  availability() { return this.stage === 'balance-error' ? this.lastAvailability : this.stage; }

  tokens() {
    const state = this.availability();
    return [
      { assetId: 'nep141:usdc.near', decimals: 6, blockchain: 'near', symbol: 'USDC', price: state === 'price-zero' ? 0 : ['some', 'all', 'zero'].includes(state) ? 1 : null },
      { assetId: 'nep141:sol.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: state === 'price-zero' ? 0 : ['all', 'zero'].includes(state) ? 150 : null },
    ];
  }

  portfolio() {
    const state = this.availability(), zero = state === 'zero', pricedZero = state === 'price-zero';
    const ethKnown = ['all', 'zero', 'price-zero'].includes(state);
    const usdcKnown = ['all', 'some', 'zero', 'price-zero'].includes(state);
    return { complete: true, chains: [{ networkId: 'ethereum', chainId: 1, chain: 'Ethereum' }], tokens: [
      { networkId: 'ethereum', chainId: 1, tokenName: 'Ethereum', tokenSymbol: 'ETH', tokenType: 'native', contractAddress: null,
        tokenAmount: zero ? '0' : '0.001', rawAmount: zero ? '0' : '1000000000000000', tokenDecimals: 18,
        tokenPriceUsd: pricedZero ? '0' : ethKnown ? '3000' : state === 'invalid' ? 'not-a-price' : null,
        tokenValueUsd: zero || pricedZero ? '0' : ethKnown ? '3' : state === 'invalid' ? 'not-a-value' : null, logoUrl: './fixture/eth.svg' },
      { networkId: 'ethereum', chainId: 1, tokenName: 'USD Coin', tokenSymbol: 'USDC', tokenType: 'erc20', contractAddress: '0x' + 'b'.repeat(40),
        tokenAmount: zero ? '0' : '4.58', rawAmount: zero ? '0' : '4580000', tokenDecimals: 6,
        tokenPriceUsd: pricedZero ? '0' : usdcKnown ? '1' : null,
        tokenValueUsd: zero || pricedZero ? '0' : usdcKnown ? '4.58' : null, logoUrl: './fixture/usdc.svg' },
    ] };
  }

  async handle(request, response) {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const logos = {
        '/fixture/eth.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#677590"/><path d="M20 6 12 21 20 26 28 21ZM12 24 20 35 28 24 20 29Z" fill="white"/></svg>',
        '/fixture/usdc.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#2f80c9"/><text x="20" y="27" text-anchor="middle" fill="white" font-family="sans-serif" font-size="24">$</text></svg>',
      };
      if (logos[path]) return response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(logos[path]);
      if (path === '/fixture/oneclick/tokens') {
        this.requests.tokens++;
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify(this.tokens()));
      }
      if (path === '/fixture/near') {
        this.requests.near++;
        let body = ''; for await (const chunk of request) body += chunk;
        const query = JSON.parse(body);
        assert.equal(query.method, 'query'); assert.equal(query.params.account_id, 'intents.near');
        const method = query.params.method_name;
        assert.ok(['current_salt', 'mt_batch_balance_of'].includes(method), 'Only read-only synthetic queries');
        if (this.stage === 'balance-error' && method === 'mt_batch_balance_of') return response.writeHead(503).end('{}');
        const args = JSON.parse(Buffer.from(query.params.args_base64, 'base64').toString());
        const value = method === 'current_salt' ? '252812b3' : args.token_ids.map(id => this.stage === 'zero' ? '0' : id.includes('usdc') ? '4580000' : '1000000000');
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }));
      }
      if (path === '/fixture/evm/') {
        this.requests.evm++;
        if (this.stage === 'balance-error') return response.writeHead(503).end('{}');
        response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify(this.portfolio()));
      }
      const file = resolve(this.root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      assert.ok(file.startsWith(this.root + sep));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
      const data = file === resolve(this.root, 'app.js') ? this.app : await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(data);
    } catch (error) {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  }

  async start() {
    await mkdir(this.output, { recursive: true });
    const source = await readFile(resolve(this.root, 'app.js'), 'utf8');
    this.app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixtureSource;
    this.server = createServer(this.handle.bind(this));
    await new Promise(done => this.server.listen(0, '127.0.0.1', done));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    const companion = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const require = createRequire(resolve(process.env.PLAYWRIGHT_ROOT || resolve(companion, 'playwright-tests'), 'package.json'));
    const { chromium } = require('playwright');
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ viewport: this.viewport, isMobile: this.viewport.width <= 420, hasTouch: this.viewport.width <= 420,
      reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Chicago', serviceWorkers: 'block',
      ...(this.recordVideo ? { recordVideo: { dir: this.output, size: this.viewport } } : {}) });
    await this.context.route('**/*', route => {
      if (route.request().url().startsWith(this.origin + '/')) return route.continue();
      // Empty-holding receive chips use public chain logos; keep their transport offline too.
      if (route.request().url() === 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png') {
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#677590"/><text x="20" y="26" text-anchor="middle" fill="white" font-family="sans-serif" font-size="20">S</text></svg>' });
      }
      this.external.push(route.request().url()); return route.abort();
    });
    this.page = await this.context.newPage();
    this.page.on('pageerror', error => this.errors.push(error.message));
    await this.page.goto(this.origin);
    await this.page.waitForFunction(() => window.__fixtureReady);
    await this.page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await this.page.evaluate(() => __prices.configure());
    return this;
  }

  async setState(state) {
    if (state !== 'balance-error') this.lastAvailability = state;
    this.stage = state;
    await this.page.evaluate(state => __prices.setNativeState(state), this.availability());
  }

  async apply(state) { await this.setState(state); await this.page.evaluate(() => __prices.refresh()); }
  async close() { await this.context?.close(); await this.browser?.close(); if (this.server?.listening) await new Promise(done => this.server.close(done)); }
}

class PriceAvailabilityChecks {
  constructor(fixture) { this.fixture = fixture; this.page = fixture.page; }

  async value(valueSelector, statusSelector, text, caption) {
    const value = this.page.locator(valueSelector), status = this.page.locator(statusSelector);
    assert.equal((await value.textContent()).trim(), text, valueSelector);
    assert.equal((await status.textContent()).trim(), caption, statusSelector);
    if (text === '$ -') {
      const rgb = (await value.evaluate(element => getComputedStyle(element).color)).match(/[\d.]+/g).map(Number);
      assert.ok(rgb[0] > rgb[1] * 1.5 && rgb[0] > rgb[2] * 1.5, `${valueSelector}: unavailable amount is red`);
    } else {
      assert.equal(await value.evaluate(element => element.classList.contains('wallet-price-unavailable')), false);
      const rgb = (await value.evaluate(element => getComputedStyle(element).color)).match(/[\d.]+/g).map(Number);
      assert.ok(!(rgb[0] > rgb[1] * 1.5 && rgb[0] > rgb[2] * 1.5), 'Known and partial amounts clear stale unavailable coloring');
    }
    if (caption) {
      const amountBox = await value.boundingBox(), captionBox = await status.boundingBox();
      // Hidden screens have no bounds yet; their actual display is checked after navigation.
      if (amountBox && captionBox) assert.ok(captionBox.y >= amountBox.y + amountBox.height - 1, 'Caption follows its USD amount');
    }
  }

  async bounds(selector) {
    const rows = await this.page.locator(selector).evaluateAll(elements => elements.map(row => {
      const rect = element => element?.getBoundingClientRect().toJSON();
      const name = row.querySelector('.asset-info,.wallet-asset-summary-label,.multichain-row-main');
      const value = row.querySelector('.asset-balance,.wallet-value-stack,.multichain-row-values');
      return { row: rect(row), name: rect(name), value: rect(value), nameText: name?.textContent,
        nameScroll: name?.scrollWidth, nameWidth: name?.clientWidth, nameOverflow: name && name.scrollWidth > name.clientWidth + 1 };
    }));
    if (rows.some(row => row.nameOverflow)) await this.capture('layout-failure');
    for (const { row, name, value, nameOverflow, nameText, nameScroll, nameWidth } of rows) {
      if (!row.width || !name || !value) continue;
      assert.ok(name.right <= value.left + 1 || name.bottom <= value.top + 1, `Name/value columns overlap: ${JSON.stringify({ row, name, value })}`);
      assert.ok(!nameOverflow, `Asset name/rate does not overflow into its valuation: ${JSON.stringify({ nameText, nameScroll, nameWidth, name, value })}`);
      assert.ok(value.left >= row.left - 1 && value.right <= row.right + 1, 'Amount/caption stays inside row');
    }
    assert.ok(await this.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow');
  }

  async capture(name) {
    if (await this.page.locator('#assetsModal.active').count()) await this.page.locator('#closeAssetsModal').hover();
    await this.page.screenshot({ path: resolve(this.fixture.output, `${this.fixture.viewport.width}-${name}.png`), animations: 'disabled' });
  }

  async run() {
    const f = this.fixture;
    for (const [state, multiTotal, evmTotal, libTotal, caption] of [
      ['none', '$ -', '$ -', '$ -', 'prices unavailable'],
      ['some', '$4.58', '$4.58', '$ -', 'some prices unavailable'],
      ['all', '$154.58', '$7.58', '$1.25', ''],
    ]) {
      await f.apply(state);
      const snapshot = await this.page.evaluate(() => __prices.snapshot());
      assert.deepEqual(snapshot.amounts, [['SOL', '1'], ['USDC', '4.58']]);
      assert.deepEqual(snapshot.evmAmounts, [['ETH', '0.001'], ['USDC', '4.58']]);
      assert.equal(snapshot.native, '250 LIB');
      await this.value('#multichainSummaryValue', '#multichainSummaryStatus', multiTotal, caption);
      await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', evmTotal, caption);
      await this.value('.wallet-native-usd', '#assetsList .wallet-price-status', libTotal, libTotal === '$ -' ? 'prices unavailable' : '');
      await this.bounds('#assetsList .asset-item,#walletScreen .wallet-asset-summary');
      await this.capture(`wallet-${state}`);
      await this.page.locator('#multichainSummary').click();
      await this.page.locator('#multichainModal.is-transition-complete').waitFor();
      await this.value('#multichainTotalBalance', '#multichainPriceStatus', multiTotal, caption);
      const sol = this.page.locator('#multichainAssetsList .multichain-asset-button').filter({ hasText: 'SOL' });
      assert.match(await sol.locator('.multichain-row-usd').textContent(), state === 'all' ? /\$150\.00/ : /\$ -/);
      assert.equal(await sol.locator('.wallet-price-status').count(), state === 'all' ? 0 : 1);
      await this.bounds('#multichainAssetsList .multichain-asset-button');
      await this.capture(`multichain-${state}`);
      await this.page.locator('#closeMultichainModal').click();
      await this.page.locator('#evmAssetsSummary').click();
      await this.page.locator('#assetsModal.is-transition-complete').waitFor();
      await this.value('#assetsTotalBalance', '#assetsPriceStatus', evmTotal, caption);
      assert.equal(await this.page.locator('#assetsModal .balance-amount').evaluate(element => getComputedStyle(element, '::before').content), 'none', 'EVM hero must not render a second currency prefix');
      const eth = this.page.locator('#connectedAssetsList [data-asset-key="ethereum:native:ETH"]');
      assert.match(await eth.locator('.asset-balance').textContent(), /0\.001 ETH/);
      if (state !== 'all') assert.match(await eth.locator('.asset-balance .wallet-price-status').textContent(), /prices unavailable/);
      await this.bounds('#connectedAssetsList .connected-asset-button');
      await this.capture(`evm-${state}`);
      await this.page.locator('#closeAssetsModal').click();
    }
    await f.apply('none');
    await f.apply('balance-error');
    const retained = await this.page.evaluate(() => __prices.snapshot());
    assert.equal(retained.multichainStatus, 'unavailable'); assert.equal(retained.evmStatus, 'unavailable');
    assert.deepEqual(retained.amounts, [['SOL', '1'], ['USDC', '4.58']]);
    assert.deepEqual(retained.evmAmounts, [['ETH', '0.001'], ['USDC', '4.58']]);
    assert.match(await this.page.locator('#multichainStatus').textContent(), /Balances are unavailable/);
    assert.equal(await this.page.locator('#multichainPriceStatus').textContent(), 'prices unavailable');
    await f.apply('all');
    await this.value('#multichainSummaryValue', '#multichainSummaryStatus', '$154.58', '');
    await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', '$7.58', '');
    await this.value('.wallet-native-usd', '#assetsList .wallet-price-status', '$1.25', '');
    await f.apply('balance-error');
    await this.value('#multichainSummaryValue', '#multichainSummaryStatus', '$154.58', '');
    await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', '$7.58', '');
    assert.match(await this.page.locator('#multichainStatus').textContent(), /Balances are unavailable/);
    assert.equal(await this.page.locator('#multichainPriceStatus').textContent(), '', 'Retained known values do not become a price outage');
    await f.apply('all');
    await f.apply('invalid');
    await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', '$ -', 'prices unavailable');
    await this.value('.wallet-native-usd', '#assetsList .wallet-price-status', '$ -', 'prices unavailable');
    await f.apply('price-zero');
    await this.value('#multichainSummaryValue', '#multichainSummaryStatus', '$0.00', '');
    await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', '$0.00', '');
    await f.apply('zero');
    await this.value('#multichainSummaryValue', '#multichainSummaryStatus', '$0.00', '');
    await this.value('#evmAssetsSummaryValue', '#evmAssetsSummaryStatus', '$0.00', '');
    await this.value('.wallet-native-usd', '#assetsList .wallet-price-status', '$0.00', '');
    assert.deepEqual(f.external, [], 'No external services or account data');
    assert.deepEqual(f.errors, [], 'No uncaught client errors');
    const counters = await this.page.evaluate(() => __prices.snapshot());
    assert.equal(counters.signings, 0); assert.equal(counters.broadcasts, 0);
    assert.ok(Object.values(f.requests).every(count => count > 0) && counters.balanceQueries > 0, 'Exercise real refresh transports');
  }

  static async runAll() {
    for (const viewport of [{ width: 320, height: 900 }, { width: 420, height: 940 }, { width: 1100, height: 1000 }]) {
      const fixture = new PriceBrowserFixture({ root: process.env.WEB_CLIENT_ROOT, viewport,
        output: process.env.PRICE_CAPTURE_DIR || '/tmp/issue-1732-price-captures' });
      try { await fixture.start(); await new PriceAvailabilityChecks(fixture).run(); }
      finally { await fixture.close(); }
      console.log(`PASS ${viewport.width}: actual Wallet/Multichain/EVM none/partial/all/zero/invalid/error/recovery, unchanged quantities and row bounds; zero external/signing/broadcast`);
    }
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await PriceAvailabilityChecks.runAll();
