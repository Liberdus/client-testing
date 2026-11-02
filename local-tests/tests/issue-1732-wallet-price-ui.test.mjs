// Standalone offline render coverage; no account, signing, or external requests.
// WEB_CLIENT_ROOT=/absolute/client/checkout node local-tests/tests/issue-1732-wallet-price-ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the implementation checkout');
const root = process.env.WEB_CLIENT_ROOT;
globalThis.fetch = async () => { throw new Error('Unexpected external request'); };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { location: { href: 'https://client.example/', origin: 'https://client.example' } };
const lib = await import(pathToFileURL(join(root, 'lib.js')));
const { evmAssets } = await import(pathToFileURL(join(root, 'evm-assets.js')));
const { formatDisplayAmount } = await import(pathToFileURL(join(root, 'near-assets.js')));

class ElementFixture {
  constructor() {
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = 'all';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  removeAttribute() {}
  setAttribute() {}
  replaceChildren() { this.innerHTML = ''; }
}

class EvmFixture {
  constructor() {
    this.controller = evmAssets;
    this.controller.discovery.reset();
    this.controller.summaryValue = new ElementFixture();
    this.controller.summaryStatus = new ElementFixture();
    this.controller.populateNetworkSelect = () => {};
    this.modal = this.controller.assetsModal;
    for (const field of ['totalBalance', 'priceStatus', 'connectionSummary', 'assetsList', 'networkSelect']) {
      this.modal[field] = new ElementFixture();
    }
    this.modal.networkSelect.value = 'ethereum';
  }

  token(symbol = 'ETH', amount = '1', price = null) {
    return {
      networkId: 'ethereum', chainId: 1, tokenSymbol: symbol, tokenName: symbol,
      contractAddress: symbol === 'ETH' ? null : `0x${'1'.repeat(40)}`,
      tokenType: symbol === 'ETH' ? 'native' : 'erc20', tokenDecimals: 18,
      rawAmount: String(BigInt(amount) * 10n ** 18n), tokenAmount: amount,
      tokenPriceUsd: price, tokenValueUsd: price === null ? null : String(Number(amount) * price),
    };
  }

  render(tokens, status = 'connected') {
    this.controller.discovery.portfolio = tokens === null ? null : {
      complete: true, chains: [{ networkId: 'ethereum', chainId: 1 }], tokens,
    };
    this.controller.discovery.status = status;
    this.controller.renderSummary();
    this.modal.renderBalances();
  }

  check(value, caption = '', unavailable = false) {
    for (const node of [this.controller.summaryValue, this.modal.totalBalance]) {
      assert.equal(node.textContent, value);
      assert.equal(node.style.color || '', unavailable ? 'var(--danger-color)' : '');
    }
    for (const node of [this.controller.summaryStatus, this.modal.priceStatus]) {
      assert.equal(node.textContent, caption);
    }
  }
}

class NativeFixture {
  constructor() {
    this.price = null;
    const app = readFileSync(join(root, 'app.js'), 'utf8');
    const start = app.indexOf('\nclass WalletScreen {');
    const end = app.indexOf('\nconst walletScreen =', start);
    const helperStart = app.indexOf('\nfunction isLibAsset(');
    const helperEnd = app.indexOf('\nasync function updateAssetPricesIfNeeded(', helperStart);
    assert.ok(start >= 0 && end > start && helperEnd > helperStart);
    const account = { keys: { address: 'a'.repeat(40) } };
    this.data = { wallet: { assets: [this.asset(2n)] } };
    const environment = {
      ...lib, formatDisplayAmount, myAccount: account, myData: this.data,
      wei: 10n ** 18n, isOnline: false, getStabilityFactor: () => this.price,
      getCorrectedTimestamp: () => 123_000,
      multichain: { updateSummary: async () => true },
      evmAssets: { refresh: async () => {}, getStatus: () => 'connected' },
      console: { error() {}, warn() {} },
    };
    const harness = new Function(...Object.keys(environment), `
      ${app.slice(helperStart, helperEnd)}
      ${app.slice(start, end)}
      return { screen: new WalletScreen(), switchAccount(account, data) { myAccount = account; myData = data; } };
    `)(...Object.values(environment));
    this.screen = harness.screen;
    this.switchAccount = harness.switchAccount;
    this.screen.assetsList = new ElementFixture();
    this.screen.firstTimeLoad = false;
    this.screen.updateWalletBalances = async () => true;
  }

  asset(amount) {
    return { id: 'liberdus', name: 'Liberdus', symbol: 'LIB', balance: amount * 10n ** 18n };
  }

  async render() {
    await this.screen.updateWalletView();
    return this.screen.assetsList.innerHTML;
  }
}

test('EVM values distinguish wholly unavailable prices from a priced subtotal and recover cleanly', () => {
  const h = new EvmFixture();
  h.render([h.token()]);
  h.check('$ -', 'prices unavailable', true);
  assert.match(h.modal.assetsList.innerHTML, /1 ETH/);
  assert.match(h.modal.assetsList.innerHTML, /\$ -/);
  assert.match(h.modal.assetsList.innerHTML, /prices unavailable/);
  h.render([h.token('ETH', '1', 100), h.token('USDC', '2')]);
  h.check('$100.00', 'some prices unavailable');
  assert.match(h.modal.assetsList.innerHTML, /2 USDC/);
  h.render([h.token('ETH', '1', 100), h.token('USDC', '2', 1)]);
  h.check('$102.00');
  assert.doesNotMatch(h.modal.assetsList.innerHTML, /prices unavailable|\$ -/);
});

test('EVM zero holdings and explicit zero prices remain normal valuations', () => {
  const h = new EvmFixture();
  h.render([h.token('ETH', '0')]);
  h.check('$0.00');
  assert.match(h.modal.assetsList.innerHTML, /\$0\.00/);
  h.render([h.token('ETH', '1', 0)]);
  h.check('$0.00');
  assert.doesNotMatch(h.modal.assetsList.innerHTML, /prices unavailable|\$ -/);
});

test('EVM discovery rejects malformed USD fields instead of coercing them into priced zeroes', () => {
  const h = new EvmFixture();
  for (const invalid of [null, undefined, '', '   ', true, false, {}, [], NaN, Infinity, -1]) {
    h.render([{ ...h.token(), tokenPriceUsd: invalid, tokenValueUsd: invalid }]);
    h.check('$ -', 'prices unavailable', true);
    assert.match(h.modal.assetsList.innerHTML, /1 ETH/);
    assert.match(h.modal.assetsList.innerHTML, /prices unavailable/);
  }
  h.render([{ ...h.token(), tokenPriceUsd: '0', tokenValueUsd: '0' }]);
  h.check('$0.00');
  assert.doesNotMatch(h.modal.assetsList.innerHTML, /prices unavailable|\$ -/);
});

test('EVM balance failures and account switches do not retain a partial-price caption', () => {
  const h = new EvmFixture();
  h.render([h.token('ETH', '1', 100), h.token('USDC', '2')]);
  h.check('$100.00', 'some prices unavailable');
  h.controller.reset();
  h.check('$ -');
  h.controller.discovery.activateAddress(`0x${'b'.repeat(40)}`);
  h.render(null, 'unavailable');
  h.check('$ -', 'balances unavailable', true);
  assert.match(h.modal.connectionSummary.textContent, /unavailable/i);
  h.render([h.token('ETH', '0')]);
  h.check('$0.00');
});

test('native wallet rows preserve LIB quantity while unavailable pricing recovers', async () => {
  const h = new NativeFixture();
  let html = await h.render();
  assert.match(html, />2 LIB</);
  assert.match(html, /\$ -/);
  assert.match(html, /prices unavailable/);
  h.price = 5;
  html = await h.render();
  assert.match(html, />2 LIB</);
  assert.match(html, /\$10\.00/);
  assert.doesNotMatch(html, /prices unavailable|\$ -/);
  h.price = null;
  html = await h.render();
  assert.match(html, /\$ -/);
});

test('native known-zero and account replacement clear stale holding values', async () => {
  const h = new NativeFixture();
  await h.render();
  const next = { wallet: { assets: [h.asset(0n)] } };
  h.switchAccount({ keys: { address: 'b'.repeat(40) } }, next);
  let html = await h.render();
  assert.match(html, />0 LIB</);
  assert.match(html, /\$0\.00/);
  h.price = 5;
  html = await h.render();
  assert.doesNotMatch(html, /prices unavailable|\$ -/);
});
