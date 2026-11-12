import '../fixtures/near-rpc.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ChatPaymentPanel, intentsActivity, intentsAssets, intentsDeposits, multichain } from '../near-assets.js';
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
    this.value = '';
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      replace: (oldName, newName) => classes.delete(oldName) && Boolean(classes.add(newName)),
      contains: name => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    };
  }
  get innerHTML() { return this.html; }
  set innerHTML(html) { this.html = html; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  emit(type, event = {}) { return this.listeners.get(type)?.(event); }
  focus() {}
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren(...children) { this.html = ''; this.children = children; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
}

const TOKENS = [
  { assetId: 'nep141:nbtc.bridge.near', symbol: 'BTC', blockchain: 'near', decimals: 8, price: 100000 },
  { assetId: 'nep141:eth.omft.near', symbol: 'ETH', blockchain: 'eth', decimals: 18, price: 3000 },
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', blockchain: 'sol', decimals: 9, price: 100 },
  { assetId: 'nep141:xrp.omft.near', symbol: 'XRP', blockchain: 'xrp', decimals: 6, price: 2 },
  { assetId: 'nep141:bnb.omdep.near', symbol: 'BNB', blockchain: 'bsc', decimals: 18, price: 500 },
  { assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', symbol: 'USDT', blockchain: 'eth', decimals: 6, price: 1 },
];
const ODD = { assetId: 'nep141:odd.omft.near', symbol: 'ODD', blockchain: 'base', decimals: 6, price: null };
const DEPRECATED_BNB = {
  assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
  symbol: 'BNB(DEPRECATED)', blockchain: 'bsc', decimals: 18, price: 500,
};
const key = asset => `intents:${asset.assetId}`;
const renderedKeys = element =>
  [...element.innerHTML.matchAll(/data-asset-key="([^"]+)"/g)].map(([, assetKey]) => assetKey);
const selectRow = (list, asset) => {
  assert.ok(renderedKeys(list).includes(key(asset)), `Missing row for ${asset.assetId}`);
  return list.emit('click', { target: { closest: () => ({ dataset: { assetKey: key(asset) } }) } });
};

function captureDeposits(t, deposit) {
  const requests = [];
  deposit.load();
  t.mock.method(intentsDeposits, 'requestDepositTarget', async (_accountId, assetId) => {
    requests.push(assetId);
    return { address: 'synthetic-deposit-address' };
  });
  t.mock.method(deposit, 'render', () => {});
  t.mock.method(deposit, 'startWatching', () => {});
  return requests;
}

class AssetsModalFixture {
  constructor(t, {
    tokens = TOKENS, balances = {}, status = 'connected', heldBefore = [],
    controller = new multichain.constructor(),
  } = {}) {
    documentFixture.elements = new Map([...markup.matchAll(/<([a-z]+)([^>]*\bid="([^"]+)"[^>]*)>/g)]
      .map(([, tagName, attributes, id]) => [id, Object.assign(new ElementFixture(tagName), {
        hidden: /\shidden(?:\s|$|=)/.test(attributes),
        disabled: /\sdisabled(?:\s|$|=)/.test(attributes),
      })]));
    for (const [, id, label] of markup.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)<\/button>/g)) {
      documentFixture.getElementById(id).textContent = label.trim();
    }
    this.controller = controller;
    this.settings = { heldBefore: [...heldBefore], hideEmpty: false };
    this.controller.configure({
      getAccount: () => ({ keys: { address: 'a'.repeat(40) } }),
      getSettings: () => this.settings,
      saveSettings: settings => { this.settings = settings; },
    });
    intentsAssets.activateAccount(`0x${'a'.repeat(40)}`);
    intentsAssets.tokens = tokens;
    intentsAssets.balances = balances;
    intentsAssets.status = status;
    intentsAssets.rebuildNetwork();
    this.modal = this.controller.assetsModal;
    this.modal.load();
    t.after(() => {
      for (const modal of [this.controller.assetModal.modal, this.controller.receiveModal.modal, this.controller.tokenPicker.modal]) {
        transitions.get('transitionend')({ target: modal, propertyName: 'opacity' });
      }
      intentsAssets.reset();
    });
  }
  rows() {
    return renderedKeys(this.modal.assetsList);
  }
  catalogButton() {
    // The previous hook lets these checks exercise the same entry point on the baseline.
    return documentFixture.elements.get('multichainOtherAssets')
      || documentFixture.getElementById('multichainDepositAnother');
  }
  hideEmpty() {
    this.modal.hideEmpty.checked = true;
    this.modal.hideEmpty.emit('change');
  }
}

test('an empty wallet lists current BNB among its six starters without changing the portfolio', t => {
  const fixture = new AssetsModalFixture(t, { tokens: [...TOKENS, DEPRECATED_BNB] });
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  assert.equal(fixture.modal.assetsList.hidden, false);
  assert.equal(fixture.modal.empty.hidden, true);
  assert.equal(fixture.modal.totalBalance.textContent, '$0.00');
  assert.deepEqual(intentsAssets.getAssets(), []);
});

test('deprecated BNB appears in the overview while held and leaves it when the balance reaches zero', t => {
  const fixture = new AssetsModalFixture(t, {
    tokens: [...TOKENS, DEPRECATED_BNB],
    balances: { [DEPRECATED_BNB.assetId]: '1000000000000000000' },
    heldBefore: [DEPRECATED_BNB.assetId],
  });
  fixture.modal.render();

  assert.ok(fixture.rows().includes(key(DEPRECATED_BNB)));
  assert.match(fixture.modal.assetsList.innerHTML, /1 BNB\(DEPRECATED\)/);
  fixture.hideEmpty();
  assert.deepEqual(fixture.rows(), [key(DEPRECATED_BNB)]);

  fixture.modal.hideEmpty.checked = false;
  fixture.modal.hideEmpty.emit('change');
  intentsAssets.balances = { [DEPRECATED_BNB.assetId]: '0' };
  intentsAssets.rebuildNetwork();
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  assert.equal(intentsAssets.getAsset(key(DEPRECATED_BNB)).rawAmount, '0');
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

test('a nonstarter remains visible for one raw unit, then leaves the overview at zero without erasing history', t => {
  const fixture = new AssetsModalFixture(t, {
    tokens: [...TOKENS, ODD],
    balances: { [ODD.assetId]: '1' },
  });
  intentsAssets.rememberHeld();
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set([...TOKENS, ODD].map(key)));
  assert.deepEqual(fixture.settings.heldBefore, [ODD.assetId]);

  intentsAssets.balances = { [ODD.assetId]: '0' };
  intentsAssets.rebuildNetwork();
  const history = intentsAssets.getAssets();
  const settings = structuredClone(fixture.settings);
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  assert.equal(intentsAssets.getAssets(), history, 'Overview filtering leaves discovery rows intact');
  assert.equal(intentsAssets.getAsset(key(ODD)).rawAmount, '0');
  assert.deepEqual(fixture.settings, settings, 'Overview filtering preserves heldBefore');
});

test('an unknown balance does not add a formerly held nonstarter to the starter rows', t => {
  const fixture = new AssetsModalFixture(t, {
    tokens: [...TOKENS, ODD],
    balances: null,
    status: 'unavailable',
    heldBefore: [ODD.assetId],
  });
  fixture.modal.render();

  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  assert.equal(intentsAssets.getAsset(key(ODD)).rawAmount, '0');
  assert.deepEqual(fixture.settings.heldBefore, [ODD.assetId]);
});

test('hiding empty rows gives an empty result', t => {
  const fixture = new AssetsModalFixture(t);
  fixture.modal.render();
  fixture.hideEmpty();

  assert.deepEqual(fixture.rows(), []);
  assert.equal(fixture.modal.empty.hidden, false);
  assert.equal(fixture.modal.assetsList.hidden, true);
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
  assert.deepEqual(new Set(fixture.rows()), new Set(TOKENS.map(key)));
  fixture.hideEmpty();
  assert.deepEqual(fixture.rows(), [key(TOKENS[2])]);
  assert.equal(fixture.modal.totalBalance.textContent, '$125.00');
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
    const requestedAssets = captureDeposits(t, deposit);
    fixture.modal.render();
    selectRow(fixture.modal.assetsList, TOKENS[0]);
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
    assert.equal(detail.depositButton.disabled, false);
    assert.deepEqual(activityAssets, [key(TOKENS[0])]);
    transitions.get('transitionend')({ target: detail.modal, propertyName: 'opacity' });
    await detail.depositButton.emit('click');
    assert.equal(deposit.assetKey, key(TOKENS[0]));
    assert.match(deposit.title.textContent, /Deposit BTC.*Bitcoin/);
    assert.deepEqual(requestedAssets, [TOKENS[0].assetId]);
  });
}

for (const scenario of [
  { name: 'empty wallet', balances: {} },
  { name: 'funded wallet', balances: { [TOKENS[0].assetId]: '100000000' } },
  { name: 'empty wallet with Hide empty leaving no rows', balances: {}, hideEmpty: true, overview: [] },
  { name: 'funded wallet with Hide empty', balances: { [TOKENS[0].assetId]: '100000000' }, hideEmpty: true, overview: [TOKENS[0]] },
]) {
  test(`Other assets opens the selected asset detail for ${scenario.name}`, async t => {
    const sameSymbol = { ...ODD, assetId: 'nep141:odd-ethereum.omft.near', blockchain: 'eth' };
    const unsupported = { ...ODD, assetId: 'nep141:unsupported.omft.near', symbol: 'NOPE' };
    const superseded = { ...TOKENS[0], assetId: 'nep141:btc.omft.near' };
    const fixture = new AssetsModalFixture(t, {
      tokens: [...TOKENS, ODD, sameSymbol, unsupported, superseded],
      balances: scenario.balances,
    });
    const { assetModal: detail, receiveModal: deposit, tokenPicker: picker } = fixture.controller;
    detail.load();
    picker.load();
    t.mock.method(intentsActivity, 'forAsset', async () => ({ entries: [], depositsUnavailable: false }));
    t.mock.method(intentsDeposits, 'loadBridgeTokens', async () => {});
    t.mock.method(intentsDeposits, 'isDepositable', assetId => assetId !== unsupported.assetId);
    const requestedAssets = captureDeposits(t, deposit);
    fixture.modal.render();
    if (scenario.hideEmpty) fixture.hideEmpty();
    const overviewRows = fixture.rows();
    const settings = structuredClone(fixture.settings);
    const history = intentsAssets.getAssets();
    assert.ok(!overviewRows.includes(key(ODD)), 'The never-held nonstarter is absent from the overview');
    if (scenario.overview) assert.deepEqual(new Set(overviewRows), new Set(scenario.overview.map(key)));
    assert.equal(fixture.modal.assetsList.hidden, overviewRows.length === 0);

    const button = fixture.catalogButton();
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    await button.emit('click');
    await new Promise(setImmediate);

    assert.equal(picker.isActive(), true, 'The overview event opens the real picker');
    const expected = new Set([...TOKENS, ODD, sameSymbol].map(key));
    const pickerRows = renderedKeys(picker.results);
    assert.deepEqual(new Set(pickerRows), expected, 'Bridge-supported assets appear across all chains');
    assert.equal(pickerRows.length, expected.size, 'Catalog rows are not duplicated');
    transitions.get('transitionend')({ target: picker.modal, propertyName: 'opacity' });
    await selectRow(picker.results, ODD);

    assert.equal(detail.isActive(), true, 'Picking a never-held asset opens its details');
    assert.equal(detail.assetKey, key(ODD));
    assert.equal(detail.title.textContent, 'ODD - Base - NEAR');
    assert.equal(deposit.isActive(), false);
    assert.deepEqual(requestedAssets, [], 'Choosing an asset does not request a deposit address');
    assert.equal(button.textContent, 'Other assets');
    assert.equal(picker.title.textContent, 'Other assets');
    assert.equal(picker.isActive(), false);
    transitions.get('transitionend')({ target: detail.modal, propertyName: 'opacity' });
    await detail.depositButton.emit('click');
    assert.equal(deposit.isActive(), true);
    assert.equal(deposit.title.textContent, 'Deposit ODD (Base)');
    assert.deepEqual(requestedAssets, [ODD.assetId], 'Deposit uses the selected asset and network');
    assert.deepEqual(fixture.rows(), overviewRows);
    assert.deepEqual(fixture.settings, settings);
    assert.equal(intentsAssets.getAssets(), history);
  });
}

test('the chat Send empty state still opens the dedicated Deposit picker and goes directly to Deposit', async t => {
  const fixture = new AssetsModalFixture(t, { tokens: [...TOKENS, ODD], controller: multichain });
  const { assetModal: detail, receiveModal: deposit, tokenPicker: picker } = fixture.controller;
  detail.load();
  picker.load();
  t.mock.method(intentsAssets, 'refresh', async () => intentsAssets.getAssets());
  t.mock.method(intentsDeposits, 'loadBridgeTokens', async () => {});
  t.mock.method(intentsDeposits, 'isDepositable', () => true);
  const requestedAssets = captureDeposits(t, deposit);
  const chat = new ChatPaymentPanel();
  const account = { keys: { address: 'a'.repeat(40) } };
  chat.configure({ getAccount: () => account });
  await chat.open('b'.repeat(40), 'recipient');
  assert.equal(chat.isActive(), true);
  assert.equal(chat.empty.hidden, false);
  transitions.get('transitionend')({ target: chat.modal, propertyName: 'opacity' });

  documentFixture.getElementById('chatSendReceive').emit('click');
  await new Promise(setImmediate);
  assert.equal(chat.isActive(), false);
  assert.equal(picker.isActive(), true);
  assert.equal(picker.title.textContent, 'Deposit');
  transitions.get('transitionend')({ target: picker.modal, propertyName: 'opacity' });
  await selectRow(picker.results, ODD);

  assert.equal(detail.isActive(), false);
  assert.equal(deposit.isActive(), true);
  assert.equal(deposit.title.textContent, 'Deposit ODD (Base)');
  assert.deepEqual(requestedAssets, [ODD.assetId]);
});

test('overlapping Deposit and Other assets requests share a catalog load and use the latest route', async t => {
  const fixture = new AssetsModalFixture(t, { tokens: [...TOKENS, ODD] });
  const { controller } = fixture;
  const { assetModal: detail, receiveModal: deposit, tokenPicker: picker } = controller;
  detail.load();
  picker.load();
  t.mock.method(intentsActivity, 'forAsset', async () => ({ entries: [], depositsUnavailable: false }));
  t.mock.method(intentsDeposits, 'isDepositable', () => true);
  const requestedAssets = captureDeposits(t, deposit);
  let finishCatalog;
  const pending = new Promise(resolve => { finishCatalog = resolve; });
  const loadCatalog = t.mock.method(intentsDeposits, 'loadBridgeTokens', () => pending);

  const depositRequest = controller.startDeposit();
  const otherAssetsRequest = fixture.catalogButton().emit('click');
  finishCatalog();
  await Promise.all([depositRequest, otherAssetsRequest]);

  assert.equal(loadCatalog.mock.callCount(), 1);
  assert.equal(picker.isActive(), true);
  assert.equal(picker.title.textContent, 'Other assets');
  transitions.get('transitionend')({ target: picker.modal, propertyName: 'opacity' });
  await selectRow(picker.results, ODD);
  assert.equal(detail.isActive(), true);
  assert.equal(detail.title.textContent, 'ODD - Base - NEAR');
  assert.equal(deposit.isActive(), false);
  assert.deepEqual(requestedAssets, []);
});

test('a failed catalog load allows Other assets to retry', async t => {
  const fixture = new AssetsModalFixture(t);
  const picker = fixture.controller.tokenPicker;
  picker.load();
  t.mock.method(intentsDeposits, 'isDepositable', () => true);
  const loadCatalog = t.mock.method(intentsDeposits, 'loadBridgeTokens', async () => {});
  loadCatalog.mock.mockImplementationOnce(async () => { throw new Error('Synthetic bridge failure'); });
  t.mock.method(console, 'warn', () => {});

  await fixture.catalogButton().emit('click');
  assert.equal(picker.isActive(), false);
  assert.match(fixture.modal.statusLine.textContent, /Try again/);

  await fixture.catalogButton().emit('click');
  assert.equal(loadCatalog.mock.callCount(), 2);
  assert.equal(picker.isActive(), true);
  assert.equal(picker.title.textContent, 'Other assets');
});
