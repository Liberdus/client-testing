import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { big2str, bigxnum2big, EthNum } from '../lib.js';

const [appSource, markup] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);
const wei = 10n ** 18n;

class ElementFixture {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.events = [];
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    };
  }
  get value() { return this.inputValue; }
  set value(value) { this.inputValue = String(value); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.events.push(event.type); }
  setCustomValidity(message) { this.validationMessage = message; }
  reset() {}
  appendChild(child) { this.children.push(child); }
  querySelector() { return new ElementFixture(); }
}

class LibModalFixture {
  static source(start, end) {
    const first = appSource.indexOf(start);
    const last = appSource.indexOf(end, first);
    assert.ok(first >= 0 && last > first, start);
    return appSource.slice(first, last);
  }

  constructor() {
    this.elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new ElementFixture()]));
    this.account = { username: 'alice', keys: { address: 'a'.repeat(40) } };
    this.lib = { id: 'liberdus', name: 'Liberdus', symbol: 'LIB', balance: 100n * wei, price: 0.2 };
    this.evm = { id: 'bsc:native', name: 'BNB', symbol: 'BNB', balance: 900n * wei, price: 600 };
    this.data = { account: {}, wallet: { assets: [this.evm, this.lib], history: [] }, contacts: {}, pending: [], chats: [] };
    this.validations = [];
    this.transfers = [];
    this.toasts = [];
    this.qrTexts = [];
    this.refreshes = 0;
    this.context = {
      document: this, myData: this.data, myAccount: this.account, isOnline: true,
      parameters: { current: { stabilityFactorStr: '0.2' } },
      wei, big2str, bigxnum2big, EthNum, Blob, Event, setTimeout, clearTimeout,
      MAX_MEMO_BYTES: 1000, BUTTON_COOLDOWN_MS: 1000,
      withButtonCooldown: (_button, _delay, _finish, listener) => listener,
      normalizeUnsignedFloat: value => value,
      openModal: modal => { modal.classList.add('active'); return true; },
      getNetworkParams: async () => {}, getTransactionFeeWei: () => wei,
      isValidEthereumAddress: () => false, normalizeUsername: value => value,
      normalizeAddress: value => value, longAddress: value => value,
      queryNetwork: async path => path.startsWith('/address/')
        ? { address: 'b'.repeat(40) } : { account: {} },
      showToast: (...args) => this.toasts.push(args),
      validateBalance: async (amount, index, warning) => {
        this.validations.push({ amount, index });
        if (warning) { warning.textContent = ''; warning.style.display = 'none'; }
        return amount + wei <= this.data.wallet.assets[index].balance;
      },
      utf82bin: value => Buffer.from(value), bin2utf8: value => Buffer.from(value).toString(),
      bin2base64: value => Buffer.from(value).toString('base64'),
      base642bin: value => Buffer.from(value, 'base64'),
      btoa: value => Buffer.from(value, 'binary').toString('base64'),
      qr: { encodeQR: text => {
        this.qrTexts.push(text);
        if (this.failNextQr) { this.failNextQr = false; throw new Error('Synthetic QR failure'); }
        return new Uint8Array([1]);
      } },
      chatsScreen: { updateChatList() {} }, PopupSelect: { syncAll() {} },
      hashBytes: () => 'synthetic-username-hash',
      createNewContact: (address, username) => {
        this.data.contacts[address] = { address, username, messages: [] };
      },
      ensureContactKeys: async () => {},
      stringify: JSON.stringify,
      getCorrectedTimestamp: () => 123456,
      postAssetTransfer: async (address, amount, payload, keys, index) => {
        this.transfers.push({ address, amount, payload, keys, index });
        return { result: { success: true }, txid: 'synthetic-transfer' };
      },
      insertSorted: (items, item) => items.unshift(item),
      chatModal: { address: null, isActive: () => false },
      historyModal: { open() {} },
      console: { error() {}, warn() {} },
    };
    const sources = [
      LibModalFixture.source('function getStabilityFactor(', '// returns transaction fee in wei'),
      LibModalFixture.source('function isLibAsset(', 'function getLibUsdPriceFromParameters('),
      LibModalFixture.source('class WalletScreen', 'const walletScreen'),
      LibModalFixture.source('class SendAssetFormModal', 'const sendAssetFormModal'),
      LibModalFixture.source('class SendAssetConfirmModal', 'const sendAssetConfirmModal'),
      LibModalFixture.source('class ReceiveModal', '// initialize the receive modal'),
      LibModalFixture.source('class FailedTransactionModal', 'const failedTransactionModal'),
    ];
    runInNewContext(`${sources.join('\n')}
      globalThis.walletScreen = new WalletScreen();
      globalThis.sendAssetFormModal = new SendAssetFormModal();
      globalThis.sendAssetConfirmModal = new SendAssetConfirmModal();
      globalThis.receiveModal = new ReceiveModal();
      globalThis.failedTransactionModal = new FailedTransactionModal();`, this.context);
    this.wallet = this.context.walletScreen;
    this.send = this.context.sendAssetFormModal;
    this.confirm = this.context.sendAssetConfirmModal;
    this.receive = this.context.receiveModal;
    this.retry = this.context.failedTransactionModal;
    this.wallet.updateWalletBalances = async () => { this.refreshes++; };
    this.send.load();
    this.confirm.load();
    this.receive.load();
    this.retry.load();
  }

  getElementById(id) {
    assert.ok(this.elements.has(id), `Client markup is missing ${id}`);
    return this.elements.get(id);
  }
  querySelector(selector) {
    assert.ok(['#sendForm button[type="submit"]', 'label[for="sendMemo"]'].includes(selector), selector);
    return new ElementFixture();
  }
  createElement() { return new ElementFixture(); }
  prepareRecipient() {
    this.send.usernameInput.value = 'bob';
    this.send.usernameAvailable.textContent = 'found';
    this.send.usernameAvailable.style.display = 'inline';
    this.send.foundAddressObject = { address: 'b'.repeat(40) };
  }
  async approve(amount = '10', unit = 'LIB') {
    await this.send.open();
    this.prepareRecipient();
    this.send.balanceSymbol.textContent = unit;
    this.send.amountInput.value = amount;
    await this.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(this.confirm.isActive(), true);
  }
  encodePayment(payment) { return `liberdus://${Buffer.from(JSON.stringify(payment)).toString('base64')}`; }
  lastPayment() {
    return JSON.parse(Buffer.from(this.qrTexts.at(-1).slice('liberdus://'.length), 'base64').toString());
  }
}

test('native Send and Receive identify LIB without an asset dropdown', async () => {
  const fixture = new LibModalFixture();
  assert.doesNotMatch(markup, /\b(?:id|for)="(?:sendAsset|receiveAsset)"/);
  assert.ok(markup.includes('<div class="modal-title">Send LIB</div>'));
  assert.ok(markup.includes('<div class="modal-title">Receive LIB</div>'));
  assert.equal(await fixture.send.open(), true);
  assert.equal(fixture.refreshes, 1);
  assert.equal(fixture.send.balanceSymbol.textContent, 'LIB');
  assert.equal(fixture.send.balanceAmount.textContent, '100.000000 LIB');
  assert.equal(fixture.send.transactionFee.textContent, '1.00 LIB');
  assert.equal(fixture.receive.open(), true);
  assert.equal(fixture.receive.displayAddress.textContent, `0x${fixture.account.keys.address}`);
  assert.deepEqual(fixture.lastPayment(), { u: 'alice', i: 'liberdus', s: 'LIB', d: 'LIB' });
});

test('LIB lookup follows the current wallet and ignores catalog order and EVM assets', () => {
  const fixture = new LibModalFixture();
  assert.equal(fixture.wallet.getLibAsset(), fixture.lib);
  const replacement = { ...fixture.lib, balance: 40n * wei };
  fixture.context.myData = { wallet: { assets: [replacement, fixture.evm] } };
  assert.equal(fixture.wallet.getLibAsset(), replacement);
  fixture.context.myData.wallet.assets = [fixture.evm];
  assert.equal(fixture.wallet.getLibAsset(), null);
  fixture.context.myData = null;
  assert.equal(fixture.wallet.getLibAsset(), null);
});

test('Send uses refreshed LIB balances and its actual wallet position for validation', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '10';
  await fixture.send.updateAvailableBalance();
  assert.deepEqual(fixture.validations.at(-1), { amount: 10n * wei, index: 1 });
  assert.equal(fixture.send.submitButton.disabled, false);

  const replacement = { ...fixture.lib, balance: 4n * wei };
  fixture.data.wallet = { assets: [replacement, fixture.evm] };
  await fixture.send.updateAvailableBalance();
  assert.deepEqual(fixture.validations.at(-1), { amount: 10n * wei, index: 0 });
  assert.equal(fixture.send.balanceAmount.textContent, '4.000000 LIB');
  assert.equal(fixture.send.submitButton.disabled, true);
});

test('USD validation uses the wallet replacement received during its price refresh', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.amountInput.value = '10';
  fixture.context.getNetworkParams = async () => {
    fixture.data.wallet.assets = [{ ...fixture.lib, balance: 4n * wei }, fixture.evm];
  };
  await fixture.send.refreshSendButtonDisabledState();
  assert.deepEqual(fixture.validations.at(-1), { amount: 50n * wei, index: 0 });
  assert.equal(fixture.send.submitButton.disabled, true);
});

test('confirmation validates the wallet replacement received during recipient lookup', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.amountInput.value = '10';
  fixture.context.queryNetwork = async () => {
    fixture.data.wallet.assets = [{ ...fixture.lib, balance: 80n * wei }, fixture.evm];
    return { account: {} };
  };
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.deepEqual(fixture.validations.at(-1), { amount: 50n * wei, index: 0 });
  assert.equal(fixture.confirm.isActive(), true);
  assert.equal(fixture.confirm.confirmAmount.textContent, '50');
});

test('Send max and LIB/USD balances retain the LIB fee and price', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  await fixture.send.fillAmount();
  assert.equal(fixture.send.amountInput.value, '99.00');
  await fixture.send.handleToggleBalance();
  assert.equal(fixture.send.balanceSymbol.textContent, 'USD');
  assert.equal(fixture.send.amountInput.value, '19.8');
  assert.equal(fixture.send.balanceAmount.textContent, '$20.0000');
  assert.equal(fixture.send.transactionFee.textContent, '$0.20');
  await fixture.send.fillAmount();
  assert.equal(fixture.send.amountInput.value, '19.8');
  assert.equal(fixture.send.getAmountWei(), 99n * wei);
  await fixture.send.handleToggleBalance();
  assert.equal(fixture.send.amountInput.value, '99');
  assert.equal(fixture.send.getAmountWei(), 99n * wei);
});

for (const { amount, unit, price = '0.2', expected } of [
  { amount: '1.000000000000000001', unit: 'LIB', expected: 1000000000000000001n },
  { amount: '10000000000000000.000000000000000001', unit: 'LIB', expected: 10000000000000000000000000000000001n },
  { amount: '0.000000000000000001', unit: 'LIB', expected: 1n },
  { amount: '0.000000000000000001', unit: 'USD', expected: 5n },
  { amount: '0.02', unit: 'USD', expected: 100000000000000000n },
  { amount: '1', unit: 'USD', price: '0.3', expected: 3333333333333333333n },
]) {
  test(`${unit} amount ${amount} converts exactly at LIB price ${price}`, () => {
    const fixture = new LibModalFixture();
    fixture.send.amountInput.value = amount;
    fixture.send.balanceSymbol.textContent = unit;
    fixture.context.parameters.current.stabilityFactorStr = price;
    assert.equal(fixture.send.getAmountWei(), expected);
  });
}

test('Send rejects invalid, zero and excessive-precision amounts before confirmation', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  for (const amount of ['', '0', '-1', 'bad', 'NaN', 'Infinity', '1e-18', '1.0000000000000000001']) {
    fixture.send.amountInput.value = amount;
    assert.equal(fixture.send.getAmountWei(), null, amount);
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, true, amount);
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), false, amount);
  }
  assert.deepEqual(fixture.transfers, []);
});

test('USD requires a usable network quote while LIB remains available without one', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '1';
  for (const price of [undefined, null, '', 'bad', '0', '-0.2', 'Infinity', '0.0000000000000000001']) {
    fixture.context.parameters.current.stabilityFactorStr = price;
    fixture.send.balanceSymbol.textContent = 'USD';
    assert.equal(fixture.send.getAmountWei(), null, String(price));
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, true, String(price));
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), false, String(price));
    fixture.send.balanceSymbol.textContent = 'LIB';
    assert.equal(fixture.send.getAmountWei(), wei, String(price));
  }
});

test('a USD amount below one native wei stays disabled', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.context.parameters.current.stabilityFactorStr = '2';
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.amountInput.value = '0.000000000000000001';
  assert.equal(fixture.send.getAmountWei(), null);
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, true);
});

test('memo toll validation remains expressed in LIB', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.memoInput.value = 'memo';
  fixture.send.tollInfo = { required: 1, toll: 3n * wei, tollUnit: 'LIB' };
  fixture.send.amountInput.value = '2';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, true);
  assert.equal(fixture.send.balanceWarning.textContent, 'less than toll for memo');
  fixture.send.amountInput.value = '3';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, false);
});

test('USD validation compares exact native LIB amounts at fee and memo toll boundaries', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.memoInput.value = 'memo';
  fixture.send.tollInfo = { required: 1, toll: 3n * wei, tollUnit: 'LIB' };
  fixture.send.amountInput.value = '0.6';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.validations.at(-1).amount, 3n * wei);
  assert.equal(fixture.send.submitButton.disabled, false);

  fixture.send.amountInput.value = '0.599999999999999999';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, true);
  assert.equal(fixture.send.balanceWarning.textContent, 'less than toll for memo');

  fixture.send.memoInput.value = '';
  fixture.send.amountInput.value = '19.8';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.validations.at(-1).amount, 99n * wei);
  assert.equal(fixture.send.submitButton.disabled, false);
  fixture.send.amountInput.value = '19.800000000000000001';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, true);
});

for (const { unit, exact, below } of [
  { unit: 'USD', exact: '1', below: '0.999999999999999999' },
  { unit: 'LIB', exact: '3.333333333333333333', below: '3.333333333333333332' },
]) {
  test(`${unit} Send uses exact conversion for a matching USD memo toll`, async () => {
    const fixture = new LibModalFixture();
    await fixture.send.open();
    fixture.prepareRecipient();
    fixture.context.parameters.current.stabilityFactorStr = '0.3';
    fixture.send.balanceSymbol.textContent = unit;
    fixture.send.memoInput.value = 'memo';
    fixture.send.tollInfo = { required: 1, toll: wei, tollUnit: 'USD' };
    fixture.send.amountInput.value = exact;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.validations.at(-1).amount, 3333333333333333333n);
    assert.equal(fixture.send.submitButton.disabled, false);
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), true);
    assert.equal(fixture.confirm.confirmAmount.textContent, '3.333333333333333333');
    fixture.confirm.close();

    fixture.send.amountInput.value = below;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, true);
    assert.equal(fixture.send.balanceWarning.textContent, 'less than toll for memo');
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), false);
  });
}

test('a zero USD memo toll does not block LIB or USD Send', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.context.parameters.current.stabilityFactorStr = '0.3';
  fixture.send.memoInput.value = 'memo';
  fixture.send.tollInfo = { required: 1, toll: 0n, tollUnit: 'USD' };
  fixture.send.amountInput.value = '1';
  for (const unit of ['LIB', 'USD']) {
    fixture.send.balanceSymbol.textContent = unit;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, false, unit);
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), true, unit);
    fixture.confirm.close();
  }
  fixture.send.balanceSymbol.textContent = 'LIB';
  for (const price of [undefined, '0', 'bad']) {
    fixture.context.parameters.current.stabilityFactorStr = price;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, false, String(price));
  }
});

test('a USD memo toll retains the effective network minimum in LIB', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.context.parameters.current.stabilityFactorStr = '0.3';
  fixture.context.parameters.current.minTollUsdStr = '0.6';
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.memoInput.value = 'memo';
  fixture.send.tollInfo = { required: 1, toll: EthNum.toWei('0.1'), tollUnit: 'USD' };
  fixture.send.amountInput.value = '0.3';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, true);
  fixture.send.amountInput.value = '0.6';
  await fixture.send.refreshSendButtonDisabledState();
  assert.equal(fixture.send.submitButton.disabled, false);
});

test('LIB Send with a USD memo toll requires a usable network quote', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '10';
  fixture.send.memoInput.value = 'memo';
  fixture.send.tollInfo = { required: 1, toll: wei, tollUnit: 'USD' };
  for (const price of [undefined, '', '0', 'bad', '-0.3']) {
    fixture.context.parameters.current.stabilityFactorStr = price;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.send.submitButton.disabled, true, String(price));
    assert.equal(fixture.send.balanceWarning.textContent, 'Unable to calculate the memo toll.');
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.isActive(), false, String(price));
  }
  assert.deepEqual(fixture.transfers, []);
});

test('confirmation derives the LIB label from wallet data and preserves USD previews', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.memoInput.value = 'memo';
  fixture.send.amountInput.value = '10';
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.confirmAmount.textContent, '10');
  assert.equal(fixture.confirm.confirmAsset.textContent, 'Liberdus (LIB)');
  assert.equal(fixture.confirm.confirmAmountUSD.textContent, '≈ $2.000000 USD');
  assert.equal(fixture.confirm.confirmMemo.textContent, 'memo');

  fixture.confirm.close();
  fixture.lib.name = 'LIB';
  fixture.send.balanceSymbol.textContent = 'USD';
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.confirmAmount.textContent, '50');
  assert.equal(fixture.confirm.confirmAsset.textContent, 'LIB');
  assert.equal(fixture.confirm.confirmAmountUSD.textContent, '≈ $10.000000 USD');
});

for (const { usd, price, lib, expected } of [
  { usd: '10', price: '0.2', lib: '50', expected: 50n * wei },
  { usd: '0.04', price: '0.008', lib: '5', expected: 5n * wei },
]) {
  test(`USD ${usd} Send at price ${price} approves and posts exactly ${lib} LIB`, async () => {
    const fixture = new LibModalFixture();
    await fixture.send.open();
    fixture.prepareRecipient();
    fixture.context.parameters.current.stabilityFactorStr = price;
    fixture.send.balanceSymbol.textContent = 'USD';
    fixture.send.amountInput.value = usd;
    await fixture.send.refreshSendButtonDisabledState();
    assert.equal(fixture.validations.at(-1).amount, expected);
    assert.equal(fixture.send.submitButton.disabled, false);
    await fixture.send.handleSendFormSubmit({ preventDefault() {} });
    assert.equal(fixture.confirm.confirmAmount.textContent, lib);
    await fixture.confirm.handleSendAsset({ preventDefault() {} });
    assert.equal(fixture.transfers.length, 1);
    assert.equal(fixture.validations.at(-1).amount, expected);
    assert.equal(fixture.transfers[0].amount, expected);
    assert.equal(fixture.data.wallet.history[0].amount, expected);
    assert.equal(fixture.data.contacts['b'.repeat(40)].messages[0].amount, expected);
    assert.equal(fixture.confirm.isActive(), false);
    await fixture.confirm.handleSendAsset({ preventDefault() {} });
    assert.equal(fixture.transfers.length, 1);
  });
}

test('confirmation submits its approved amount when the hidden input and quote change', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.balanceSymbol.textContent = 'USD';
  fixture.send.amountInput.value = '10';
  fixture.send.memoInput.value = 'approved memo';
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.confirmAmount.textContent, '50');
  fixture.context.getStabilityFactor = () => 0.5;
  fixture.context.parameters.current.stabilityFactorStr = '0.5';
  fixture.send.amountInput.value = '7';
  fixture.send.usernameInput.value = 'carol';
  fixture.send.memoInput.value = 'changed memo';
  fixture.confirm.confirmAmount.textContent = '999';
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.equal(fixture.transfers.length, 1);
  assert.equal(fixture.transfers[0].amount, 50n * wei);
  assert.equal(fixture.data.wallet.history[0].memo, 'approved memo');
  assert.equal(fixture.data.contacts['b'.repeat(40)].username, 'bob');
});

for (const action of ['cancel', 'form close', 'form reset', 'form reopen']) {
  test(`${action} invalidates a previously approved LIB payment`, async () => {
    const fixture = new LibModalFixture();
    await fixture.approve();
    if (action === 'cancel') fixture.confirm.cancelButton.listeners.get('click')();
    if (action === 'form close') await fixture.send.close();
    if (action === 'form reset') fixture.send.reset();
    if (action === 'form reopen') await fixture.send.reopen();
    assert.equal(fixture.confirm.isActive(), false);
    assert.equal(fixture.confirm.payment, null);
    await fixture.confirm.handleSendAsset({ preventDefault() {} });
    assert.deepEqual(fixture.transfers, []);
    assert.deepEqual(fixture.data.wallet.history, []);
  });
}

test('an overlapping confirmation opening preserves the approved payment', async () => {
  const fixture = new LibModalFixture();
  const openModal = fixture.context.openModal;
  fixture.context.openModal = modal => !modal.classList.contains('active') && openModal(modal);
  await fixture.approve();
  const approved = fixture.confirm.payment;
  const approvedAmount = fixture.confirm.confirmAmount.textContent;
  fixture.send.amountInput.value = '20';
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.payment, approved);
  assert.equal(fixture.confirm.confirmAmount.textContent, approvedAmount);
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.equal(fixture.transfers.length, 1);
  assert.equal(fixture.transfers[0].amount, 10n * wei);
});

test('reopening USD Send clears its old confirmation and preserves its amount unit', async () => {
  const fixture = new LibModalFixture();
  await fixture.approve('10', 'USD');
  await fixture.send.reopen();
  assert.equal(fixture.confirm.isActive(), false);
  assert.equal(fixture.send.balanceSymbol.textContent, 'USD');
  assert.equal(fixture.send.amountInput.value, '10');
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.deepEqual(fixture.transfers, []);
  fixture.prepareRecipient();
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.confirmAmount.textContent, '50');
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.equal(fixture.transfers.length, 1);
  assert.equal(fixture.transfers[0].amount, 50n * wei);
});

test('a failed confirmation opening cannot leave a payment ready to submit', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '10';
  fixture.context.openModal = modal => {
    assert.equal(modal, fixture.confirm.modal);
    return false;
  };
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.isActive(), false);
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.deepEqual(fixture.transfers, []);
});

for (const boundary of ['balance validation', 'recipient lookup', 'contact keys']) {
  test(`closing confirmation during ${boundary} prevents a broadcast`, async () => {
    const fixture = new LibModalFixture();
    await fixture.approve();
    let release;
    let reached;
    const ready = new Promise(resolve => { reached = resolve; });
    const gate = async () => {
      reached();
      await new Promise(resolve => { release = resolve; });
    };
    if (boundary === 'balance validation') fixture.context.validateBalance = async () => { await gate(); return true; };
    if (boundary === 'recipient lookup') fixture.context.queryNetwork = async () => { await gate(); return { address: 'b'.repeat(40) }; };
    if (boundary === 'contact keys') fixture.context.ensureContactKeys = gate;
    const sending = fixture.confirm.handleSendAsset({ preventDefault() {} });
    await ready;
    fixture.confirm.close();
    release();
    await sending;
    assert.deepEqual(fixture.transfers, []);
    assert.deepEqual(fixture.data.wallet.history, []);
  });
}

test('LIB submission validates the current LIB wallet slot', async () => {
  const fixture = new LibModalFixture();
  await fixture.approve('99');
  fixture.data.wallet.assets = [{ ...fixture.lib, balance: 98n * wei }, fixture.evm];
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.deepEqual(fixture.validations.at(-1), { amount: 99n * wei, index: 0 });
  assert.match(fixture.toasts.at(-1)[0], /Insufficient balance: 99.00 \+ 1.00 \(fee\) > 98.00 LIB/);
  assert.deepEqual(fixture.transfers, []);
});

test('missing LIB never falls back to EVM and keeps Send disabled', async () => {
  const fixture = new LibModalFixture();
  fixture.data.wallet.assets = [fixture.evm];
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '1';
  await fixture.send.updateAvailableBalance();
  assert.equal(fixture.send.balanceAmount.textContent, 'Unavailable');
  assert.equal(fixture.send.transactionFee.textContent, 'Unavailable');
  assert.equal(fixture.send.submitButton.disabled, true);
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.isActive(), false);
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.deepEqual(fixture.validations, []);
  assert.match(fixture.toasts.at(-1)[0], /asset is unavailable/);
});

for (const unit of ['LIB', 'USD']) {
  test(`payment QR prefills ${unit} amounts without selecting an asset`, async () => {
    const fixture = new LibModalFixture();
    await fixture.send.open();
    await fixture.send.fillFromQR(fixture.encodePayment({ u: 'bob', i: 'liberdus', s: 'LIB', d: unit, a: '10', m: 'memo' }));
    assert.equal(fixture.send.usernameInput.value, 'bob');
    assert.equal(fixture.send.amountInput.value, '10');
    assert.equal(fixture.send.memoInput.value, 'memo');
    assert.equal(fixture.send.balanceSymbol.textContent, unit);
    assert.equal(fixture.send.getAmountWei(), (unit === 'USD' ? 50n : 10n) * wei);
    assert.deepEqual(fixture.send.usernameInput.events, ['input']);
    assert.deepEqual(fixture.send.amountInput.events, ['input']);
  });
}

test('failed-payment retry retains the LIB amount, recipient, memo and transaction id', async () => {
  const fixture = new LibModalFixture();
  fixture.retry.txid = 'failed-tx';
  fixture.retry.address = 'b'.repeat(40);
  fixture.retry.memo = 'retry memo';
  fixture.data.contacts[fixture.retry.address] = { username: 'bob' };
  fixture.data.wallet.history = [{ txid: 'failed-tx', amount: 5n * wei }];
  fixture.retry.handleRetry();
  await new Promise(setImmediate);
  assert.equal(fixture.send.isActive(), true);
  assert.equal(fixture.send.balanceSymbol.textContent, 'LIB');
  assert.equal(fixture.send.amountInput.value, '5.000000000000000000');
  assert.equal(fixture.send.usernameInput.value, 'bob');
  assert.equal(fixture.send.memoInput.value, 'retry memo');
  assert.equal(fixture.send.retryTxIdInput.value, 'failed-tx');
});

test('Receive QR keeps native metadata while LIB/USD amounts toggle', async () => {
  const fixture = new LibModalFixture();
  fixture.receive.open();
  fixture.receive.amountInput.value = '50';
  fixture.receive.memoInput.value = ' memo ';
  fixture.receive.updateQRCode();
  assert.deepEqual(fixture.lastPayment(), { u: 'alice', i: 'liberdus', s: 'LIB', d: 'LIB', a: '50', m: 'memo' });
  await fixture.receive.handleToggleBalance();
  assert.deepEqual(fixture.lastPayment(), { u: 'alice', i: 'liberdus', s: 'LIB', d: 'USD', a: '10', m: 'memo' });
  await fixture.receive.handleToggleBalance();
  assert.equal(fixture.receive.amountInput.value, '50');
  assert.equal(fixture.lastPayment().d, 'LIB');
});

test('Receive reads a replacement wallet and still generates LIB QR data without its record', () => {
  const fixture = new LibModalFixture();
  fixture.receive.open();
  fixture.data.wallet.assets = [{ ...fixture.lib, id: 'replacement-lib', name: 'LIB' }, fixture.evm];
  assert.equal(fixture.receive.createQRPaymentData().i, 'replacement-lib');
  fixture.data.wallet.assets = [fixture.evm];
  fixture.receive.updateQRCode();
  assert.deepEqual(fixture.lastPayment(), { u: 'alice', i: 'liberdus', s: 'LIB', d: 'LIB' });
  assert.equal(fixture.receive.displayAddress.textContent, `0x${fixture.account.keys.address}`);
});

test('Receive preserves the username QR fallback if full QR encoding fails', () => {
  const fixture = new LibModalFixture();
  fixture.receive.open();
  fixture.failNextQr = true;
  fixture.receive.updateQRCode();
  assert.deepEqual(fixture.lastPayment(), { u: 'alice' });
  assert.equal(fixture.receive.previewElement.style.display, 'block');
  assert.match(fixture.receive.previewElement.innerHTML, /Generating QR with only username/);
});
