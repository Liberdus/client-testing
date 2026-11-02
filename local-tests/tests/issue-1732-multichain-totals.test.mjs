// Standalone offline test while companion main has no local-tests/run.mjs.
// WEB_CLIENT_ROOT=/absolute/client/checkout node --test local-tests/tests/issue-1732-multichain-totals.test.mjs
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the implementation checkout');

class PortfolioFixture {
  constructor() {
    this.tokens = [
      { assetId: 'nep141:usdc.near', decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1 },
      { assetId: 'nep141:sol.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 100 },
    ];
    this.balances = ['2500000', '1000000000'];
    this.catalogFails = false;
    this.balancesFail = false;
    this.saved = new Map();
    this.heldBefore = [];
  }

  async fetch(url, options = {}) {
    if (String(url).endsWith('/tokens')) {
      return this.catalogFails ? new Response('', { status: 503 }) : Response.json(this.tokens);
    }
    const request = JSON.parse(options.body || '{}');
    assert.equal(request.method, 'query', 'Only synthetic read-only RPC calls are allowed');
    assert.equal(request.params.account_id, 'intents.near');
    const method = request.params.method_name;
    assert.ok(['current_salt', 'mt_batch_balance_of'].includes(method), `Unexpected RPC: ${method}`);
    if (method === 'mt_batch_balance_of' && this.balancesFail) return new Response('', { status: 503 });
    const value = method === 'current_salt' ? '252812b3' : this.balances;
    return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
  }

  reset(service) {
    service.reset();
    service.tokens = [];
    service.tokensFetchedAt = 0;
    this.catalogFails = false;
    this.balancesFail = false;
    this.heldBefore = [];
    this.saved.clear();
    this.balances = ['2500000', '1000000000'];
    this.tokens.forEach(token => { token.price = token.symbol === 'USDC' ? 1 : 100; });
  }
}

class ElementFixture {
  constructor() {
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
  }
  removeAttribute() {}
  setAttribute() {}
  replaceChildren() { this.innerHTML = ''; }
}

const fixture = new PortfolioFixture();
globalThis.fetch = fixture.fetch.bind(fixture);
globalThis.localStorage = {
  getItem: key => fixture.saved.get(key) ?? null,
  setItem: (key, value) => fixture.saved.set(key, value),
};
const { intentsAssets, multichain } = await import(pathToFileURL(join(process.env.WEB_CLIENT_ROOT, 'near-assets.js')));
multichain.configure({
  getAccount: () => ({ keys: { address: 'a'.repeat(40) } }),
  getSettings: () => ({ heldBefore: fixture.heldBefore, hideEmpty: false }),
  saveSettings: settings => { fixture.heldBefore = settings.heldBefore; },
});
intentsAssets.tokenCatalogTtlMs = 0;
multichain.summaryValue = new ElementFixture();
const modal = multichain.assetsModal;
for (const field of ['totalBalance', 'caption', 'assetsList', 'statusLine', 'sendButton', 'listHead', 'hideEmpty', 'empty', 'quick']) {
  modal[field] = new ElementFixture();
}

class TotalsAssertion {
  static async check(text, unavailable) {
    modal.render();
    await multichain.updateSummary();
    for (const element of [modal.totalBalance, multichain.summaryValue]) {
      assert.equal(element.textContent, text);
      assert.equal(element.style.color || '', unavailable ? 'var(--danger-color)' : '');
    }
  }

  static quantities() {
    assert.match(modal.assetsList.innerHTML, /multichain-row-amount">2\.5</);
    assert.match(modal.assetsList.innerHTML, /multichain-row-amount">1</);
  }
}

test('Multichain dollar valuation availability', async t => {
  t.mock.method(console, 'warn', () => {});
  await t.test('catalog fallback, failed balances, and recovery preserve quantities and update both totals', async () => {
    fixture.reset(intentsAssets);
    await intentsAssets.refresh({ force: true });
    await TotalsAssertion.check('$102.50', false);
    fixture.catalogFails = true;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getStatus(), 'unpriced');
    await TotalsAssertion.check('$0.00', true);
    TotalsAssertion.quantities();
    fixture.balancesFail = true;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getStatus(), 'unavailable');
    await TotalsAssertion.check('$0.00', true);
    TotalsAssertion.quantities();
    fixture.catalogFails = fixture.balancesFail = false;
    await intentsAssets.refresh({ force: true });
    await TotalsAssertion.check('$102.50', false);
    TotalsAssertion.quantities();
  });

  await t.test('a failed balance refresh cannot make retained unpriced holdings look valued', async () => {
    fixture.reset(intentsAssets);
    await intentsAssets.refresh({ force: true });
    // Drop the in-memory catalog to exercise the persisted fallback too.
    intentsAssets.tokens = [];
    fixture.catalogFails = true;
    await intentsAssets.refresh({ force: true });
    fixture.balancesFail = true;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getStatus(), 'unavailable');
    await TotalsAssertion.check('$0.00', true);
    TotalsAssertion.quantities();
  });

  await t.test('one unpriced nonzero holding invalidates a partially priced total', async () => {
    fixture.reset(intentsAssets);
    fixture.tokens[1].price = null;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getStatus(), 'connected');
    await TotalsAssertion.check('$0.00', true);
    TotalsAssertion.quantities();
  });

  await t.test('a known zero stays normal even with unpriced remembered rows', async () => {
    fixture.reset(intentsAssets);
    fixture.balances = ['0', '0'];
    await intentsAssets.refresh({ force: true });
    await TotalsAssertion.check('$0.00', false);
    fixture.heldBefore = fixture.tokens.map(token => token.assetId);
    fixture.catalogFails = true;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getAssets().length, 2);
    await TotalsAssertion.check('$0.00', false);
  });

  await t.test('an initial failed balance read has an unavailable total', async () => {
    fixture.reset(intentsAssets);
    fixture.balancesFail = true;
    await intentsAssets.refresh({ force: true });
    await TotalsAssertion.check('$0.00', true);
    multichain.reset();
    assert.equal(multichain.summaryValue.style.color, '');
    modal.renderLoading();
    assert.equal(modal.totalBalance.style.color, '');
  });

  await t.test('a failed refresh retains the last usable valuation', async () => {
    fixture.reset(intentsAssets);
    await intentsAssets.refresh({ force: true });
    fixture.balancesFail = true;
    await intentsAssets.refresh({ force: true });
    assert.equal(intentsAssets.getStatus(), 'unavailable');
    await TotalsAssertion.check('$102.50', false);
    TotalsAssertion.quantities();
  });

  await t.test('an explicit zero price is a usable valuation', async () => {
    fixture.reset(intentsAssets);
    fixture.tokens.forEach(token => { token.price = 0; });
    await intentsAssets.refresh({ force: true });
    await TotalsAssertion.check('$0.00', false);
    TotalsAssertion.quantities();
  });
});
