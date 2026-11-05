import '../fixtures/near-rpc.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { intentsActivity, intentsAssets, intentsDeposits, multichain } from '../near-assets.js';
import { installModalTransitionListeners } from '../lib.js';

const markup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const transitions = new Map();
const documentFixture = {
  elements: new Map(),
  addEventListener: (type, handler) => transitions.set(type, handler),
  getElementById(id) {
    assert.ok(this.elements.has(id), `Client markup is missing ${id}`);
    return this.elements.get(id);
  },
  createElement: tagName => new ElementFixture(tagName),
};
globalThis.document = documentFixture;
installModalTransitionListeners();

class ElementFixture {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.html = '';
    this.selection = '';
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    };
  }
  get innerHTML() { return this.html; }
  set innerHTML(html) {
    this.html = html;
    if (this.tagName !== 'SELECT') return;
    this.children = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .map(([, value, textContent]) => Object.assign(new ElementFixture('option'), { value, textContent }));
    this.selection = this.children[0]?.value || '';
  }
  get value() { return this.selection; }
  set value(value) {
    this.selection = this.tagName === 'SELECT' && !this.children.some(option => option.value === value) ? '' : value;
  }
  get options() { return this.children; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  emit(type, event = {}) { return this.listeners.get(type)?.(event); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren(...children) { this.html = ''; this.children = children; }
  append(...children) {
    this.children.push(...children);
    if (this.tagName === 'SELECT' && !this.selection) this.selection = this.children[0]?.value || '';
  }
  appendChild(child) { this.append(child); }
}

const TOKENS = [
  { assetId: 'nep141:nbtc.bridge.near', symbol: 'BTC', blockchain: 'near', decimals: 8, price: 100000 },
  { assetId: 'nep141:eth.omft.near', symbol: 'ETH', blockchain: 'eth', decimals: 18, price: 3000 },
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', blockchain: 'sol', decimals: 9, price: 100 },
  { assetId: 'nep141:xrp.omft.near', symbol: 'XRP', blockchain: 'xrp', decimals: 6, price: 2 },
  { assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', symbol: 'BNB', blockchain: 'bsc', decimals: 18, price: 500 },
  { assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', symbol: 'USDT', blockchain: 'eth', decimals: 6, price: 1 },
];
const ODD = { assetId: 'nep141:odd.omft.near', symbol: 'ODD', blockchain: 'base', decimals: 6, price: null };
const key = asset => `intents:${asset.assetId}`;

class AssetsModalFixture {
  constructor(t, { tokens = TOKENS, balances = {}, status = 'connected' } = {}) {
    documentFixture.elements = new Map([...markup.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)]
      .map(([, tagName, id]) => [id, new ElementFixture(tagName)]));
    this.controller = new multichain.constructor();
    this.settings = { heldBefore: [], hideEmpty: false };
    this.synced = [];
    this.controller.configure({
      getAccount: () => ({ keys: { address: 'a'.repeat(40) } }),
      getSettings: () => this.settings,
      saveSettings: settings => { this.settings = settings; },
      syncSelect: select => this.synced.push(select),
    });
    intentsAssets.activateAccount(`0x${'a'.repeat(40)}`);
    intentsAssets.tokens = tokens;
    intentsAssets.balances = balances;
    intentsAssets.status = status;
    intentsAssets.rebuildNetwork();
    this.modal = this.controller.assetsModal;
    this.modal.load();
    t.after(() => {
      for (const modal of [this.controller.assetModal.modal, this.controller.receiveModal.modal]) {
        transitions.get('transitionend')({ target: modal, propertyName: 'opacity' });
      }
      intentsAssets.reset();
    });
  }
  rows() {
    return [...this.modal.assetsList.innerHTML.matchAll(/data-asset-key="([^"]+)"/g)].map(([, assetKey]) => assetKey);
  }
  network() { return documentFixture.getElementById('multichainNetwork'); }
  chooseNetwork(value) {
    this.network().value = value;
    this.network().emit('change');
  }
  hideEmpty() {
    this.modal.hideEmpty.checked = true;
    this.modal.hideEmpty.emit('change');
  }
}

test('an empty wallet lists its six starter assets as rows without changing the portfolio', t => {
  const fixture = new AssetsModalFixture(t);
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  assert.equal(fixture.modal.assetsList.hidden, false);
  assert.equal(fixture.modal.empty.hidden, true);
  assert.equal(fixture.modal.totalBalance.textContent, '$0.00');
  assert.deepEqual(intentsAssets.getAssets(), []);
  assert.ok(fixture.synced.includes(fixture.network()), 'Custom dropdown stays synchronized');
});

test('the chain dropdown filters displayed chains and leaves the total unchanged', t => {
  const fixture = new AssetsModalFixture(t, { balances: { [TOKENS[0].assetId]: '100000000' } });
  fixture.modal.render();
  const total = fixture.modal.totalBalance.textContent;

  fixture.chooseNetwork('Bitcoin');
  assert.deepEqual(fixture.rows(), [key(TOKENS[0])], 'nBTC belongs under its displayed Bitcoin chain');
  assert.equal(fixture.modal.totalBalance.textContent, total);
  fixture.chooseNetwork('Ethereum');
  assert.deepEqual(new Set(fixture.rows()), new Set([key(TOKENS[1]), key(TOKENS[5])]));
  assert.equal(fixture.modal.totalBalance.textContent, total);
});

test('held assets outside the starter list remain visible and duplicate rows are omitted', t => {
  const fixture = new AssetsModalFixture(t, {
    tokens: [...TOKENS, ODD],
    balances: { [TOKENS[2].assetId]: '1250000000', [ODD.assetId]: '5000000' },
  });
  fixture.modal.render();

  assert.equal(fixture.rows().length, 7);
  assert.equal(new Set(fixture.rows()).size, 7);
  assert.ok(fixture.rows().includes(key(ODD)));
  assert.match(fixture.modal.assetsList.innerHTML, /1\.25/);
  const total = fixture.modal.totalBalance.textContent;
  fixture.hideEmpty();
  assert.deepEqual(new Set(fixture.rows()), new Set([key(TOKENS[2]), key(ODD)]));
  assert.equal(fixture.modal.totalBalance.textContent, total);
  assert.equal(fixture.settings.hideEmpty, true);
});

test('hiding empty rows gives an empty result without removing chain choices', t => {
  const fixture = new AssetsModalFixture(t);
  fixture.modal.render();
  fixture.hideEmpty();

  assert.deepEqual(fixture.rows(), []);
  assert.equal(fixture.modal.empty.hidden, false);
  assert.ok(fixture.network().options.some(option => option.value === 'Ethereum'));
  assert.equal(fixture.modal.totalBalance.textContent, '$0.00');
});

test('unknown balances show placeholders rather than zero amounts', t => {
  const fixture = new AssetsModalFixture(t, { balances: null, status: 'unavailable' });
  fixture.modal.render();

  assert.equal(fixture.rows().length, 6);
  const amounts = [...fixture.modal.assetsList.innerHTML.matchAll(/class="multichain-row-amount"[^>]*>([^<]*)</g)]
    .map(([, amount]) => amount.trim());
  assert.equal(amounts.length, 6);
  assert.ok(amounts.every(amount => /[-—–]/.test(amount) && !/\b0\b/.test(amount)));
  assert.equal(fixture.modal.totalBalance.textContent, '$ -');
  assert.match(fixture.modal.statusLine.textContent, /unavailable/i);
});

test('an unavailable refresh keeps previously read amounts and totals visible', t => {
  const fixture = new AssetsModalFixture(t, {
    balances: { [TOKENS[2].assetId]: '1250000000' },
    status: 'unavailable',
  });
  fixture.modal.render();

  assert.match(fixture.modal.assetsList.innerHTML, /1\.25 SOL/);
  assert.equal(fixture.modal.totalBalance.textContent, '$125.00');
  assert.match(fixture.modal.statusLine.textContent, /unavailable/i);
  fixture.chooseNetwork('Solana');
  assert.deepEqual(fixture.rows(), [key(TOKENS[2])]);
  assert.equal(fixture.modal.totalBalance.textContent, '$125.00');
});

test('a removed selected chain falls back to all available assets', t => {
  const fixture = new AssetsModalFixture(t);
  fixture.modal.render();
  fixture.chooseNetwork('Bitcoin');
  intentsAssets.tokens = TOKENS.filter(token => token !== TOKENS[0]);
  intentsAssets.rebuildNetwork();
  fixture.modal.render();

  assert.equal(fixture.network().value, 'all');
  assert.equal(fixture.rows().length, 5);
});

for (const balances of [{}, null]) {
  test(`a catalog row with ${balances === null ? 'unknown' : 'zero'} balance opens details with Deposit available`, async t => {
    const fixture = new AssetsModalFixture(t, { balances, status: balances === null ? 'unavailable' : 'connected' });
    fixture.controller.assetModal.load();
    const activityAssets = [];
    t.mock.method(intentsActivity, 'forAsset', async (_account, asset) => {
      activityAssets.push(asset.key);
      return { entries: [], depositsUnavailable: false };
    });
    const deposit = fixture.controller.receiveModal;
    deposit.load();
    const requestedAssets = [];
    t.mock.method(intentsDeposits, 'requestDepositTarget', async (_accountId, assetId) => {
      requestedAssets.push(assetId);
      return { address: 'synthetic-deposit-address' };
    });
    t.mock.method(deposit, 'render', () => {});
    t.mock.method(deposit, 'startWatching', () => {});
    fixture.modal.render();
    fixture.modal.assetsList.emit('click', {
      target: { closest: () => ({ dataset: { assetKey: key(TOKENS[0]) } }) },
    });
    await new Promise(setImmediate);

    const detail = fixture.controller.assetModal;
    assert.equal(detail.assetKey, key(TOKENS[0]));
    assert.match(detail.title.textContent, /BTC.*Bitcoin/);
    if (balances === null) {
      assert.match(detail.amount.textContent, /—/);
      assert.equal(detail.value.textContent, '$ -');
    } else {
      assert.equal(detail.amount.textContent, '0 BTC');
      assert.equal(detail.value.textContent, '$0.00');
    }
    assert.equal(detail.sendButton.disabled, true);
    assert.equal(detail.withdrawButton.disabled, true);
    assert.equal(detail.swapButton.disabled, true);
    assert.equal(detail.receiveButton.disabled, false);
    assert.deepEqual(activityAssets, [key(TOKENS[0])]);
    transitions.get('transitionend')({ target: detail.modal, propertyName: 'opacity' });
    await detail.receiveButton.emit('click');
    assert.equal(deposit.assetKey, key(TOKENS[0]));
    assert.match(deposit.title.textContent, /Deposit BTC.*Bitcoin/);
    assert.deepEqual(requestedAssets, [TOKENS[0].assetId]);
  });
}

test('the deposit picker remains available without overview action controls', async t => {
  const fixture = new AssetsModalFixture(t);
  t.mock.method(intentsDeposits, 'loadBridgeTokens', async () => {});
  t.mock.method(intentsDeposits, 'isDepositable', assetId => assetId === TOKENS[0].assetId);
  const pickers = [];
  t.mock.method(fixture.controller.tokenPicker, 'open', options => pickers.push(options));
  const deposits = [];
  t.mock.method(fixture.controller.receiveModal, 'open', assetKey => deposits.push(assetKey));

  await fixture.controller.startDeposit();

  assert.equal(pickers.length, 1);
  assert.equal(pickers[0].accepts({ assetId: TOKENS[0].assetId }), true);
  assert.equal(pickers[0].accepts({ assetId: ODD.assetId }), false);
  pickers[0].onPick(key(TOKENS[0]));
  assert.deepEqual(deposits, [key(TOKENS[0])]);
});
