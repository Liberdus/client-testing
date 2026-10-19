import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { big2str, bigxnum2big } from '../lib.js';

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
    this.data = { account: {}, wallet: { assets: [this.evm, this.lib], history: [] }, contacts: {}, pending: [] };
    this.validations = [];
    this.toasts = [];
    this.qrTexts = [];
    this.refreshes = 0;
    this.context = {
      document: this, myData: this.data, myAccount: this.account, isOnline: true,
      wei, big2str, bigxnum2big, Blob, Event, setTimeout, clearTimeout,
      MAX_MEMO_BYTES: 1000, BUTTON_COOLDOWN_MS: 1000,
      withButtonCooldown: (_button, _delay, _finish, listener) => listener,
      normalizeUnsignedFloat: value => value,
      openModal: modal => { modal.classList.add('active'); return true; },
      getNetworkParams: async () => {}, getTransactionFeeWei: () => wei,
      getStabilityFactor: () => 0.2,
      normalizeTollToLibWei: toll => toll, getEffectiveTollLibWei: toll => toll,
      isValidEthereumAddress: () => false, normalizeUsername: value => value,
      normalizeAddress: value => value, longAddress: value => value,
      queryNetwork: async () => ({ account: {} }),
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
      console: { error() {}, warn() {} },
    };
    const sources = [
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

  fixture.lib.name = 'LIB';
  fixture.send.balanceSymbol.textContent = 'USD';
  await fixture.send.handleSendFormSubmit({ preventDefault() {} });
  assert.equal(fixture.confirm.confirmAmount.textContent, '50');
  assert.equal(fixture.confirm.confirmAsset.textContent, 'LIB');
  assert.equal(fixture.confirm.confirmAmountUSD.textContent, '≈ $10.000000 USD');
});

test('LIB submission validates the current LIB wallet slot', async () => {
  const fixture = new LibModalFixture();
  await fixture.send.open();
  fixture.prepareRecipient();
  fixture.send.amountInput.value = '101';
  await fixture.confirm.handleSendAsset({ preventDefault() {} });
  assert.deepEqual(fixture.validations.at(-1), { amount: 101n * wei, index: 1 });
  assert.match(fixture.toasts.at(-1)[0], /Insufficient balance: 101.00 \+ 1.00 \(fee\) > 100.00 LIB/);
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
