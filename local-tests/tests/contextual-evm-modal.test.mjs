import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evmAssets } from '../evm-assets.js';
import { installModalTransitionListeners } from '../lib.js';

const markup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const transitionListeners = new Map();
globalThis.document = {
  addEventListener: (type, listener) => transitionListeners.set(type, listener),
};
globalThis.window = { LIBERDUS_WALLET_PROBE_BASE_URL: 'https://probe.invalid' };
globalThis.qr = { encodeQR: () => new Uint8Array() };
installModalTransitionListeners();

class ElementFixture {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.children = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    };
  }
  addEventListener() {}
  setCustomValidity() {}
  reset() {}
  replaceChildren() {}
  appendChild() {}
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new ElementFixture());
    return this.children.get(selector);
  }
}

class ContextualModalFixture {
  constructor(t, mode) {
    globalThis.document = this;
    this.mode = mode;
    this.elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new ElementFixture()]));
    this.account = { keys: { address: 'a'.repeat(40) } };
    this.controller = new evmAssets.constructor();
    this.toasts = [];
    this.controller.configure({ getAccount: () => this.account, showToast: (...args) => this.toasts.push(args) });
    this.controller.discovery.activateAddress(`0x${this.account.keys.address}`);
    this.controller.discovery.portfolio = this.portfolio('1.25');
    this.modal = mode === 'send' ? this.controller.sendModal : this.controller.receiveModal;
    this.modal.load();
    this.assetKey = this.controller.getNetwork('bsc').assets[0].key;
    this.requests = [];
    this.response = new Promise(resolve => { this.resolveResponse = resolve; });
    t.mock.method(globalThis, 'fetch', (url) => {
      this.requests.push({ url, active: this.modal.modal.classList.contains('active'), label: this.modal.assetLabel.textContent });
      return this.response;
    });
    t.after(() => {
      this.modal.close();
      transitionListeners.get('transitionend')({ target: this.modal.modal, propertyName: 'opacity' });
    });
  }

  getElementById(id) {
    assert.ok(this.elements.has(id), `Client markup is missing ${id}`);
    return this.elements.get(id);
  }

  createElement() { return new ElementFixture(); }

  portfolio(amount) {
    return { complete: true, chains: [{ networkId: 'bsc', chainId: 56 }], tokens: [{
      networkId: 'bsc', chainId: 56, tokenType: 'native', contractAddress: null,
      tokenSymbol: 'BNB', tokenName: 'BNB', tokenAmount: amount, tokenDecimals: 18,
    }] };
  }

  open(assetKey = this.assetKey) {
    const options = { networkId: 'bsc', assetKey };
    return this.mode === 'send'
      ? this.controller.openContextualSend(options)
      : this.controller.openContextualReceive(options);
  }

  async finishRefresh() {
    this.resolveResponse({ ok: true, json: async () => this.portfolio('2.5') });
    await new Promise(setImmediate);
  }
}

for (const mode of ['send', 'receive']) {
  test(`${mode} opens dedicated controls with fixed context before fetching remote balances`, async t => {
    const fixture = new ContextualModalFixture(t, mode);
    const { modal } = fixture;
    fixture.getElementById('balanceSymbol').textContent = 'LIB';
    fixture.getElementById('receiveBalanceSymbol').textContent = 'LIB';

    assert.equal(fixture.open(), true);
    assert.equal(modal.balanceSymbol.textContent, 'BNB');
    assert.equal(modal.assetLabel.textContent, 'BNB · BNB Smart Chain');
    assert.equal(fixture.getElementById('sendAssetFormModal').classList.contains('active'), false);
    assert.equal(fixture.getElementById('receiveModal').classList.contains('active'), false);
    assert.equal(fixture.getElementById('balanceSymbol').textContent, 'LIB');
    assert.equal(fixture.getElementById('receiveBalanceSymbol').textContent, 'LIB');
    assert.deepEqual(fixture.requests, [{
      url: `https://probe.invalid/?wallet=0x${fixture.account.keys.address}`,
      active: true, label: 'BNB · BNB Smart Chain',
    }]);
    if (mode === 'send') assert.equal(modal.balanceAmount.textContent, '1.25 BNB');
    else assert.equal(modal.createQRPaymentData().n, 'bsc');

    await fixture.finishRefresh();
    if (mode === 'send') assert.equal(modal.balanceAmount.textContent, '2.5 BNB');
    else {
      assert.equal(modal.session.asset.tokenAmount, '2.5');
      assert.equal(modal.createQRPaymentData().i, fixture.assetKey);
      assert.equal(modal.displayAddress.textContent, `0x${fixture.account.keys.address}`);
    }
  });

  test(`${mode} ignores an in-flight refresh after its contextual session closes`, async t => {
    const fixture = new ContextualModalFixture(t, mode);
    assert.equal(fixture.open(), true);
    const session = fixture.modal.session;
    fixture.modal.close();
    await fixture.finishRefresh();
    assert.equal(fixture.modal.session, null);
    assert.equal(fixture.modal.modal.classList.contains('active'), false);
    if (mode === 'send') assert.equal(fixture.modal.balanceAmount.textContent, '1.25 BNB');
    else assert.equal(session.asset.tokenAmount, '1.25');
    assert.deepEqual(fixture.toasts, []);
  });

  test(`${mode} refuses a missing contextual asset before opening or requesting a refresh`, t => {
    const fixture = new ContextualModalFixture(t, mode);
    assert.equal(fixture.open('missing-asset'), false);
    assert.equal(fixture.modal.modal.classList.contains('active'), false);
    assert.equal(fixture.modal.session, null);
    assert.deepEqual(fixture.requests, []);
    assert.match(fixture.toasts[0][0], /asset is no longer available/);
  });
}
