import assert from 'node:assert/strict';
import test from 'node:test';
import { EvmSendConfirmationModal } from '../evm-assets.js';
import { installModalTransitionListeners } from '../lib.js';

const transitions = new Map();
const memoElement = { textContent: '' };
globalThis.document = {
  addEventListener: (type, listener) => transitions.set(type, listener),
  getElementById: (id) => id === 'confirmMemo' ? memoElement : null,
};
installModalTransitionListeners();

function confirmation() {
  const modal = new EvmSendConfirmationModal();
  modal.loaded = true;
  const classes = new Set();
  modal.modal = { classList: {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
  } };
  for (const name of ['recipient', 'amount', 'asset', 'networkValue', 'feeValue', 'feeUsd',
    'signingNotice', 'amountUsd', 'memoGroup', 'networkGroup', 'feeGroup', 'confirmButton', 'cancelButton']) {
    modal[name] = { textContent: '', style: { display: '' }, hidden: false };
  }
  return modal;
}

function prepared(price = '600') {
  const asset = { networkId: 'bsc', chainId: 56, tokenType: 'native', contractAddress: null,
    tokenSymbol: 'BNB', tokenName: 'BNB', tokenPriceUsd: price };
  return {
    network: { id: 'bsc', chainId: 56, name: 'BNB Smart Chain', nativeSymbol: 'BNB', assets: [asset] },
    asset, maximumFee: 100000000000000n, displayAmount: '0.01',
    validation: { recipient: `0x${'a'.repeat(40)}` },
  };
}

function usd(value) {
  return `≈ ${value.toLocaleString(undefined, {
    style: 'currency', currency: 'USD', maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
  })}`;
}

const invalidPrices = [null, undefined, '', '   ', 'bad', -1, '-1', Infinity, NaN, true, {}, []];
for (const price of invalidPrices) {
  test(`hides unavailable amount USD for ${String(price)} without changing native values`, () => {
    const modal = confirmation();
    const transfer = prepared();
    modal.render(transfer);
    transfer.asset.tokenPriceUsd = price;
    modal.render(transfer);
    assert.equal(modal.amountUsd.textContent, '');
    assert.equal(modal.amountUsd.style.display, 'none');
    assert.equal(modal.amount.textContent, '0.01 BNB');
    assert.equal(modal.feeValue.textContent, '0.0001 BNB');
  });
}

test('shows valid zero and restores a valid estimate after missing prices', () => {
  const modal = confirmation();
  modal.render(prepared(null));
  for (const price of [0, '0', 600, '600']) {
    modal.render(prepared(price));
    assert.equal(modal.amountUsd.textContent, usd(Number(price) * 0.01));
    assert.equal(modal.amountUsd.style.display, 'block');
  }
});

test('hides overflowing USD estimates', () => {
  const modal = confirmation();
  modal.render({ ...prepared(Number.MAX_VALUE), displayAmount: '10' });
  assert.equal(modal.amountUsd.style.display, 'none');
});

for (const close of ['cancel', 'reset', 'dismiss', 'confirm']) {
  test(`${close} restores shared USD visibility and resolves the confirmation`, async () => {
    const modal = confirmation();
    modal.amountUsd.style.display = 'inline';
    const result = modal.confirm('', prepared(null));
    transitions.get('transitionend')({ target: modal.modal, propertyName: 'opacity' });
    assert.equal(modal.amountUsd.style.display, 'none');
    if (close === 'reset') modal.reset();
    else modal.settle(close === 'confirm', { close: close !== 'dismiss' });
    assert.equal(await result, close === 'confirm');
    assert.equal(modal.amountUsd.style.display, 'inline');
    assert.equal(modal.feeGroup.hidden, true);
  });
}

test('uses the native price for fees and the ERC-20 price for transfer USD independently', () => {
  const modal = confirmation();
  const transfer = prepared();
  transfer.asset = { ...transfer.asset, contractAddress: `0x${'b'.repeat(40)}`,
    tokenType: 'erc20', tokenSymbol: 'USDT', tokenPriceUsd: '1' };
  transfer.displayAmount = '10';
  transfer.network.assets.push(transfer.asset);
  modal.render(transfer);
  assert.equal(modal.amountUsd.textContent, usd(10));
  assert.equal(modal.feeUsd.textContent, usd(0.06));
  assert.equal(modal.feeValue.textContent, '0.0001 BNB');

  transfer.asset.tokenPriceUsd = null;
  modal.render(transfer);
  assert.equal(modal.amountUsd.style.display, 'none');
  assert.equal(modal.feeUsd.textContent, usd(0.06));
  transfer.asset.tokenPriceUsd = '1';
  transfer.network.assets[0].tokenPriceUsd = null;
  modal.render(transfer);
  assert.equal(modal.amountUsd.textContent, usd(10));
  assert.equal(modal.feeUsd.textContent, '');
  assert.equal(modal.feeUsd.style.display, 'none');
  assert.equal(modal.feeValue.textContent, '0.0001 BNB');
});

test('never substitutes a token or another network native asset for a missing native price', () => {
  const modal = confirmation();
  const transfer = prepared();
  const native = transfer.asset;
  transfer.network.assets = [
    { ...native, networkId: 'ethereum', chainId: 1, tokenPriceUsd: '99999' },
    { ...native, chainId: 1, tokenPriceUsd: '99999' },
    { ...native, tokenType: 'erc20', contractAddress: `0x${'b'.repeat(40)}`, tokenPriceUsd: '1' },
  ];
  modal.render(transfer);
  assert.equal(modal.feeUsd.style.display, 'none');
  assert.equal(modal.feeValue.textContent, '0.0001 BNB');
  transfer.network.assets.push(native);
  modal.render(transfer);
  assert.equal(modal.feeUsd.textContent, usd(0.06));
  assert.equal(modal.feeUsd.style.display, 'block');
});

test('uses the new network on rerender and formats small fees', () => {
  const modal = confirmation();
  modal.render(prepared());
  const transfer = prepared('3000');
  transfer.network = { ...transfer.network, id: 'ethereum', chainId: 1,
    name: 'Ethereum', nativeSymbol: 'ETH', assets: [{ ...transfer.asset,
      networkId: 'ethereum', chainId: 1, tokenSymbol: 'ETH' }] };
  modal.render(transfer);
  assert.equal(modal.feeValue.textContent, '0.0001 ETH');
  assert.equal(modal.feeUsd.textContent, usd(0.3));
  modal.render({ ...prepared(), maximumFee: 1000000000000n });
  assert.equal(modal.feeUsd.textContent, usd(0.0006));
});

for (const price of invalidPrices) {
  test(`hides unavailable fee USD for ${String(price)} without hiding native fee`, () => {
    const modal = confirmation();
    modal.render(prepared());
    const transfer = prepared();
    transfer.asset.tokenPriceUsd = price;
    modal.render(transfer);
    assert.equal(modal.feeUsd.textContent, '');
    assert.equal(modal.feeUsd.style.display, 'none');
    assert.equal(modal.feeValue.textContent, '0.0001 BNB');
  });
}

test('accepts an explicitly zero native price', () => {
  const modal = confirmation();
  modal.render(prepared(0));
  assert.equal(modal.feeUsd.textContent, usd(0));
  assert.equal(modal.feeUsd.style.display, 'block');
});


test('keeps notes, LIB costs and duplicate warnings alongside independent USD estimates', () => {
  const modal = confirmation();
  const transfer = prepared(null);
  transfer.chat = { totalRequired: '1000000000000000000', note: 'Lunch\nThank you <3' };
  transfer.duplicatePaymentWarning = 'An earlier payment is still pending.';
  modal.render(transfer);
  assert.equal(modal.memoGroup.style.display, 'block');
  assert.equal(memoElement.textContent, transfer.chat.note);
  assert.match(modal.signingNotice.textContent, /1 LIB/);
  assert.match(modal.signingNotice.textContent, /An earlier payment is still pending/);
  assert.equal(modal.feeValue.textContent, '0.0001 BNB');
  assert.equal(modal.feeUsd.style.display, 'none');
  modal.render(prepared());
  assert.equal(modal.memoGroup.style.display, 'none');
  assert.equal(memoElement.textContent, '');
  assert.equal(modal.feeUsd.textContent, usd(0.06));
});
