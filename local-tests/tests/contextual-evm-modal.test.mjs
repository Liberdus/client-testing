import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { evmAssets } from '../evm-assets.js';
import { installModalTransitionListeners } from '../lib.js';

const [markup, appSource] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
]);
const transitionListeners = new Map();
globalThis.document = {
  addEventListener: (type, listener) => transitionListeners.set(type, listener),
};
globalThis.window = { LIBERDUS_WALLET_PROBE_BASE_URL: 'https://probe.invalid' };
globalThis.qr = { encodeQR: () => new Uint8Array() };
installModalTransitionListeners();

class ElementFixture {
  constructor(ownerDocument, id) {
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.children = [];
    this.selectors = new Map();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    };
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, details = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...details };
    return Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setCustomValidity() {}
  reset() {}
  replaceChildren(...children) { this.children = children.flat(); }
  append(...children) { this.children.push(...children); }
  appendChild() {}
  scrollIntoView() {}
  querySelector(selector) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new ElementFixture(this.ownerDocument));
    return this.selectors.get(selector);
  }
}

class ContextualModalFixture {
  constructor(t, mode, options = {}) {
    globalThis.document = this;
    this.mode = mode;
    this.elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new ElementFixture(this, id)]));
    this.account = { keys: { address: 'a'.repeat(40) } };
    this.controller = new evmAssets.constructor();
    this.toasts = [];
    this.controller.configure({
      getAccount: () => this.account,
      showToast: (...args) => this.toasts.push(args),
      ...options,
    });
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

  createElement() { return new ElementFixture(this); }

  createDocumentFragment() {
    return Object.assign([], { append(...children) { this.push(...children); } });
  }

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

const savedAddress = 'b'.repeat(40);
const unsavedAddress = 'c'.repeat(40);
const rawAddress = `0x${'d'.repeat(40)}`;
const messageFee = '50000000000000000';
const requiredToll = '250000000000000000';

function autocompleteFactory(contacts) {
  const start = appSource.indexOf('class ContactSearch');
  const end = appSource.indexOf('class SearchContactsModal', start);
  assert.ok(start >= 0 && end > start);
  const ContactAutocomplete = runInNewContext(`${appSource.slice(start, end)}\nContactAutocomplete`, {
    getContactAvatarHtml: async () => '',
  });
  return ({ input, list, onSelect }) => new ContactAutocomplete({ input, list, getContacts: () => contacts, onSelect });
}

function prepareChatPayment(resolution) {
  const toll = resolution.username === 'newname' ? requiredToll : '0';
  return { address: resolution.address, username: resolution.username, fee: messageFee, toll,
    totalRequired: (BigInt(messageFee) + BigInt(toll)).toString() };
}

test('EVM Send browses saved contacts alphabetically and resolves the selected wallet', async t => {
  const fixture = new ContextualModalFixture(t, 'send', {
    createContactAutocomplete: autocompleteFactory([
      { username: 'zara', name: 'Zara', address: unsavedAddress },
      { username: 'alice', name: 'Alice', address: savedAddress },
    ]),
    lookupUsername: async username => username === 'alice' ? savedAddress : null,
    prepareChatPayment,
  });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  const { usernameInput } = fixture.modal;
  await usernameInput.emit('focus');
  const list = fixture.getElementById('evmSendRecipientSuggestions');
  assert.equal(list.hidden, false);
  assert.deepEqual(list.children.map(option => option.children[1].children[0].textContent), ['Alice', 'Zara']);

  await usernameInput.emit('keydown', { key: 'ArrowDown' });
  await usernameInput.emit('keydown', { key: 'Enter' });
  await new Promise(setImmediate);
  assert.equal(usernameInput.value, 'alice');
  assert.equal(fixture.modal.getResolvedRecipient()?.address, `0x${savedAddress}`);
  assert.equal(list.hidden, true);
  assert.equal(fixture.getElementById('evmSendRecipientToll').hidden, true);
});

test('EVM Send resolves an unsaved @username and displays the required LIB toll', async t => {
  const usernames = [];
  const fixture = new ContextualModalFixture(t, 'send', {
    lookupUsername: async username => {
      usernames.push(username);
      return unsavedAddress;
    },
    prepareChatPayment,
  });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  fixture.modal.usernameInput.value = '  @NewName  ';
  await fixture.modal.handleRecipientInput();
  assert.deepEqual(usernames, ['newname']);
  assert.equal(fixture.modal.usernameInput.value, '  @NewName  ');
  assert.equal(fixture.modal.getResolvedRecipient()?.address, `0x${unsavedAddress}`);
  const toll = fixture.getElementById('evmSendRecipientToll');
  assert.equal(toll.hidden, false);
  assert.match(toll.textContent, /0\.25 LIB/);
});

test('EVM Send shows the toll and blocks review when the sender is short of LIB', async t => {
  const fixture = new ContextualModalFixture(t, 'send', {
    lookupUsername: async () => unsavedAddress,
    prepareChatPayment: async () => {
      throw Object.assign(new Error('Not enough LIB for the chat message.'), { recipientToll: requiredToll });
    },
  });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  fixture.modal.amountInput.value = '0.1';
  fixture.modal.usernameInput.value = 'newname';
  await fixture.modal.handleRecipientInput();

  assert.match(fixture.getElementById('evmSendRecipientToll').textContent, /0\.25 LIB/);
  assert.match(fixture.modal.usernameAvailable.textContent, /not enough LIB/i);
  assert.equal(fixture.modal.submitButton.disabled, true);
});

test('a stale username lookup cannot replace a newer wallet-only recipient', async t => {
  let finishLookup;
  const lookup = new Promise(resolve => { finishLookup = resolve; });
  const fixture = new ContextualModalFixture(t, 'send', { lookupUsername: () => lookup, prepareChatPayment });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  fixture.modal.usernameInput.value = 'newname';
  const pending = fixture.modal.handleRecipientInput();
  fixture.modal.usernameInput.value = rawAddress;
  await fixture.modal.handleRecipientInput();
  finishLookup(unsavedAddress);
  await pending;

  assert.equal(fixture.modal.getResolvedRecipient()?.address, rawAddress);
  assert.equal(fixture.modal.memoGroup.hidden, true);
  assert.equal(fixture.getElementById('evmSendRecipientToll').hidden, true);
});

test('choosing a saved contact rejects a username that now resolves to a different wallet', async t => {
  const fixture = new ContextualModalFixture(t, 'send', {
    createContactAutocomplete: autocompleteFactory([{ username: 'alice', name: 'Alice', address: savedAddress }]),
    lookupUsername: async () => unsavedAddress,
    prepareChatPayment,
  });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  await fixture.modal.usernameInput.emit('focus');
  await fixture.modal.usernameInput.emit('keydown', { key: 'ArrowDown' });
  await fixture.modal.usernameInput.emit('keydown', { key: 'Enter' });
  await new Promise(setImmediate);

  assert.equal(fixture.modal.getResolvedRecipient(), null);
  assert.match(fixture.modal.usernameAvailable.textContent, /changed/i);
  assert.equal(fixture.modal.submitButton.disabled, true);
});

test('EVM Send stops before broadcast if the username mapping changes after review', async t => {
  let mappedAddress = unsavedAddress;
  let reviewedAddress;
  const fixture = new ContextualModalFixture(t, 'send', {
    lookupUsername: async () => mappedAddress,
    prepareChatPayment,
    confirmTransfer: async (_summary, prepared) => {
      reviewedAddress = prepared.validation.recipient;
      mappedAddress = savedAddress;
      return true;
    },
  });
  assert.equal(fixture.open(), true);
  await fixture.finishRefresh();

  fixture.controller.transactions.prepare = async ({ network, asset, recipient, amount }) => ({
    network, asset, maximumFee: 21000n, displayAmount: amount, validation: { recipient, account: fixture.account },
  });
  const broadcast = t.mock.method(fixture.controller.transactions, 'broadcast', () => {
    assert.fail('Unexpected broadcast for a changed recipient');
  });
  t.mock.method(console, 'error', () => {});
  fixture.modal.usernameInput.value = 'newname';
  fixture.modal.amountInput.value = '0.1';
  await fixture.modal.handleRecipientInput();

  const result = await fixture.modal.handleSubmit({ preventDefault() {} });

  assert.equal(reviewedAddress, `0x${unsavedAddress}`);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'USERNAME_ASSOCIATION_CHANGED');
  assert.equal(broadcast.mock.callCount(), 0);
});
