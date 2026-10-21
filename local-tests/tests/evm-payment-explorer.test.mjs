import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { EVM_CHAT_MESSAGE_TYPE, evmAssets, evmPaymentAmount, evmPaymentId, parseEvmTransferMessage } from '../evm-assets.js';
import { escapeHtml, escapeHtmlAttribute } from '../lib.js';

const HASH = `0x${'abcdef12'.repeat(8)}`;
const CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
const PAYMENT = {
  type: EVM_CHAT_MESSAGE_TYPE, version: 1, chainId: 56, networkId: 'bsc',
  transactionHash: HASH, from: `0x${'a'.repeat(40)}`, to: `0x${'b'.repeat(40)}`,
  assetKind: 'native', contractAddress: null, rawAmount: '1000000000000000', decimals: 18, symbol: 'BNB',
};
const EXPLORERS = [
  [1, 'https://etherscan.io'], [10, 'https://optimistic.etherscan.io'],
  [56, 'https://bscscan.com'], [137, 'https://polygonscan.com'],
  [8453, 'https://basescan.org'], [42161, 'https://arbiscan.io'],
];

test('resolves all six configured chains without portfolio or recovery records', () => {
  const controller = new evmAssets.constructor();
  controller.getPayments = () => { throw new Error('Explorer links must not consult recovery records'); };
  for (const [chainId, explorer] of EXPLORERS) {
    const payment = { ...PAYMENT, chainId, networkId: 'unrelated-network' };
    assert.equal(controller.getPaymentExplorerUrl(payment), `${explorer}/tx/${HASH}`);
    controller.discovery.reset();
    assert.equal(controller.getPaymentExplorerUrl(payment), `${explorer}/tx/${HASH}`);
  }
  assert.equal(controller.getEvmCatalog().length, 3, 'Explorer configuration must not add wallet rows');
});

test('ignores message explorer URLs and normalizes the complete transaction hash', () => {
  const controller = new evmAssets.constructor();
  const payment = { ...PAYMENT, transactionHash: `0x${'ABCDEF12'.repeat(8)}`, explorerUrl: 'https://untrusted.example' };
  assert.equal(controller.getPaymentExplorerUrl(payment), `https://bscscan.com/tx/${HASH}`);
  assert.equal(controller.getPaymentExplorerUrl({ ...payment, chainId: 999 }), null);
});

test('uses trusted discovered chain metadata even without any asset holdings', () => {
  const controller = new evmAssets.constructor();
  controller.discovery.portfolio = {
    chains: [{ networkId: 'extra', chainId: 999, explorerUrl: 'https://explorer.example/network/?q=discard#discard' }],
    tokens: [],
  };
  assert.equal(controller.getNetwork('extra'), null);
  assert.equal(controller.getPaymentExplorerUrl({ ...PAYMENT, chainId: 999 }), `https://explorer.example/network/tx/${HASH}`);
  controller.discovery.portfolio.chains.push({ chainId: 56, explorerUrl: 'https://wrong.example' });
  assert.equal(controller.getPaymentExplorerUrl(PAYMENT), `https://bscscan.com/tx/${HASH}`);
});

test('rejects malformed hashes and nonnumeric or invalid chain IDs', () => {
  const controller = new evmAssets.constructor();
  for (const transactionHash of [null, '', '0x1234', `0x${'g'.repeat(64)}`, `${HASH}/../other`, `${HASH}?next=other`, `${HASH}" onclick="alert(1)`]) {
    assert.equal(controller.getPaymentExplorerUrl({ ...PAYMENT, transactionHash }), null);
  }
  for (const chainId of [0, -1, 1.5, '56', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(controller.getPaymentExplorerUrl({ ...PAYMENT, chainId }), null);
  }
});

test('returns no link for unknown, missing, or unsafe explorer configuration', () => {
  const controller = new evmAssets.constructor();
  for (const explorerUrl of [null, '', 'bad', 'http://explorer.example', 'javascript:alert(1)', 'https://user:password@explorer.example']) {
    controller.discovery.portfolio = { chains: [{ chainId: 999, explorerUrl }], tokens: [] };
    assert.equal(controller.getPaymentExplorerUrl({ ...PAYMENT, chainId: 999 }), null);
  }
});

test('resolves token contracts on every configured chain without metadata queries', (t) => {
  const controller = new evmAssets.constructor();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Explorer links must not query'); });
  for (const [chainId, explorer] of EXPLORERS) {
    assert.equal(controller.getPaymentTokenExplorerUrl({ chainId, contractAddress: CONTRACT }), `${explorer}/token/${CONTRACT}`);
  }
  assert.equal(controller.getPaymentTokenExplorerUrl({ chainId: 56, contractAddress: `0x${CONTRACT.slice(2).toUpperCase()}` }), `https://bscscan.com/token/${CONTRACT}`);
});

test('token links reject invalid claims and unknown or unsafe explorer configuration', () => {
  const controller = new evmAssets.constructor();
  for (const contractAddress of [null, '', '0x1234', `${CONTRACT}/../other`, `${CONTRACT}?next=other`, 'javascript:alert(1)']) {
    assert.equal(controller.getPaymentTokenExplorerUrl({ chainId: 56, contractAddress }), null);
  }
  for (const chainId of [0, -1, '56', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(controller.getPaymentTokenExplorerUrl({ chainId, contractAddress: CONTRACT }), null);
  }
  assert.equal(controller.getPaymentTokenExplorerUrl({ chainId: 999, contractAddress: CONTRACT, explorerUrl: 'https://untrusted.example' }), null);
  for (const explorerUrl of ['http://explorer.example', 'javascript:alert(1)', 'https://user:password@explorer.example']) {
    controller.discovery.portfolio = { chains: [{ chainId: 999, explorerUrl }], tokens: [] };
    assert.equal(controller.getPaymentTokenExplorerUrl({ chainId: 999, contractAddress: CONTRACT }), null);
  }
  controller.discovery.portfolio = { chains: [{ chainId: 999, explorerUrl: 'https://explorer.example/network/' }], tokens: [] };
  assert.equal(controller.getPaymentTokenExplorerUrl({ chainId: 999, contractAddress: CONTRACT }), `https://explorer.example/network/token/${CONTRACT}`);
});

test('recovery rows retain the same hash link for username and raw-address unresolved or failed sends', () => {
  const controller = new evmAssets.constructor();
  controller.getAccount = () => ({ keys: { address: 'a'.repeat(40) } });
  const modal = controller.assetsModal;
  modal.recovery = {};
  modal.recoveryList = {};
  for (const username of [null, 'recipient']) {
    for (const assetState of ['pending', 'unknown', 'rejected', 'reverted']) {
      controller.getPayments = () => [{ kind: 'outgoing', payment: PAYMENT, networkId: 'bsc', username, assetState, messageState: username ? 'ready' : 'none' }];
      modal.renderRecovery();
      const html = modal.recoveryList.innerHTML;
      assert.equal(modal.recovery.hidden, false);
      assert.ok(html.includes(`href="https://bscscan.com/tx/${HASH}"`));
      assert.ok(html.includes(`title="${HASH}"`));
      assert.ok(html.includes('0xabcdef12…abcdef12'));
      assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));
    }
  }
  controller.getPayments = () => [{ kind: 'outgoing', payment: { ...PAYMENT, chainId: 999 }, assetState: 'unknown' }];
  modal.renderRecovery();
  assert.ok(modal.recoveryList.innerHTML.includes(`<span title="${HASH}">`));
  assert.ok(!modal.recoveryList.innerHTML.includes('<a '));
});

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('  renderEvmPaymentDetailLink(value, url, label) {');
const renderEnd = source.indexOf('  buildChatMessageRangeHTML(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
const chat = vm.runInNewContext(`new (class { ${source.slice(renderStart, renderEnd)} })()`, {
  EVM_CHAT_MESSAGE_TYPE, INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
  evmAssets, parseEvmTransferMessage, evmPaymentId, evmPaymentAmount, escapeHtml, escapeHtmlAttribute,
  formatTime: () => '12:00', isDeleted: () => false, normalizeTransactionId: () => '',
  paymentStatusLabel: (state) => state,
});

test('sent and synchronized received chat cards keep links for every outcome with no portfolio or recovery record', () => {
  assert.equal(evmAssets.discovery.portfolio, null);
  for (const my of [true, false]) {
    for (const paymentVerified of ['unchecked', 'pending', 'settled', 'failed', 'unverifiable']) {
      const message = { type: EVM_CHAT_MESSAGE_TYPE, payment: PAYMENT, txid: 'liberdus-announcement', timestamp: 1, my, paymentVerified };
      const html = chat.renderChatMessageHTML(message, { contact: { messages: [message] }, lastReadTs: 0 });
      assert.ok(html.includes(`href="https://bscscan.com/tx/${HASH}"`));
      assert.ok(!html.includes('/tx/liberdus-announcement'));
      assert.ok(html.includes(`aria-label="View transaction ${HASH} in block explorer"`));
      assert.ok(html.includes(`data-verified="${paymentVerified}"`));
      assert.equal(message.paymentVerified, paymentVerified);
    }
  }
});

test('chat renders unknown-chain hashes as full plain text in details and rejects invalid payment claims', () => {
  const message = { type: EVM_CHAT_MESSAGE_TYPE, payment: { ...PAYMENT, chainId: 999 }, timestamp: 1 };
  const html = chat.renderChatMessageHTML(message, { contact: { messages: [message] }, lastReadTs: 0 });
  assert.ok(html.includes(`<code>${HASH}</code>`));
  assert.ok(!html.includes('<a '));
  message.payment.transactionHash = 'javascript:alert(1)';
  const invalid = chat.renderChatMessageHTML(message, { contact: { messages: [message] }, lastReadTs: 0 });
  assert.ok(!invalid.includes('evm-payment-message'));
});

test('sent and received chat cards show each full transaction hash once, only in Payment details', () => {
  for (const my of [true, false]) {
    for (const chainId of [56, 999]) {
      const html = chat.renderEvmPaymentMessage({ my, payment: { ...PAYMENT, chainId } }, '');
      const detailsStart = html.indexOf('<details');
      assert.ok(detailsStart > 0);
      const textBeforeDetails = html.slice(0, detailsStart).replace(/<[^>]*>/g, '');
      const allText = html.replace(/<[^>]*>/g, '');
      const details = html.slice(detailsStart);
      assert.ok(!textBeforeDetails.includes(HASH));
      assert.ok(!allText.includes('0xabcdef12…abcdef12'), 'The abbreviated hash must not remain on the card');
      assert.equal(allText.split(HASH).length - 1, 1, 'The full hash must appear as text exactly once');
      assert.ok(details.includes('<summary>Payment details</summary>'));
      assert.ok(details.includes(`<code>${HASH}</code>`));
      assert.equal(html.split(`href="https://bscscan.com/tx/${HASH}"`).length - 1, chainId === 56 ? 1 : 0);
    }
  }
});

test('symbol-only ERC-20 cards render locally with a labeled note, contract in details, and one timestamp', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Rendering must not fetch metadata'); });
  const contractAddress = '0x55d398326f99059ff775485246999027b3197955';
  const message = {
    type: EVM_CHAT_MESSAGE_TYPE, timestamp: 1, my: true,
    payment: { ...PAYMENT, assetKind: 'erc20', contractAddress, symbol: 'USDT', rawAmount: '5000000000000000', note: 'Lunch\nThanks <3' },
  };
  const html = chat.renderChatMessageHTML(message, { contact: { messages: [message] }, lastReadTs: 0 });
  assert.ok(html.includes('−0.005 <span class="evm-payment-unit">USDT</span>'));
  assert.ok(!html.includes('evm-payment-contract'));
  assert.ok(html.indexOf(contractAddress) > html.indexOf('<details'));
  assert.ok(html.includes('<section class="evm-payment-note" aria-label="Payment note"><div class="evm-payment-label">Note</div>'));
  assert.ok(html.includes('<div class="evm-payment-label">Payment sent</div>'));
  assert.ok(html.includes(`<code>${contractAddress}</code>`));
  assert.ok(html.includes(`<code>${HASH}</code>`));
  assert.ok(html.includes('Lunch\nThanks &lt;3'));
  assert.ok(html.includes('<summary>Payment details</summary>'));
  assert.equal((html.match(/class="message-time"/g) || []).length, 1);
  assert.ok(html.indexOf('class="message-time"') > html.indexOf('class="evm-payment-footer"'));
  assert.ok(!html.includes('<img') && !html.includes('Tether') && !html.includes('tokenName'));
  assert.equal(requests, 0);
});

test('labeled sections separate sent and received notes from verification and transaction metadata', () => {
  for (const my of [true, false]) {
    const html = chat.renderEvmPaymentMessage({ my, payment: { ...PAYMENT, note: 'Message <not metadata>' } }, '');
    assert.ok(html.includes(`Payment ${my ? 'sent' : 'received'}`));
    assert.ok(html.includes('Message &lt;not metadata&gt;'));
    assert.ok(html.indexOf('evm-payment-note') < html.indexOf('evm-payment-meta'));
    assert.ok(html.indexOf('evm-payment-meta') < html.indexOf('intents-payment-verified'));
    assert.ok(html.indexOf('evm-payment-footer') < html.indexOf('<details'));
  }
});

test('payments without notes do not render an empty note section', () => {
  for (const note of [undefined, '']) {
    const html = chat.renderEvmPaymentMessage({ payment: { ...PAYMENT, note } }, '');
    assert.ok(!html.includes('evm-payment-note'));
    assert.ok(html.includes('evm-payment-meta'));
    assert.ok(html.includes('<summary>Payment details</summary>'));
  }
});

test('native payment details omit token contracts and generic messages keep timestamp and edit indicators', () => {
  for (const type of [EVM_CHAT_MESSAGE_TYPE, 'message']) {
    const message = { type, payment: PAYMENT, timestamp: 1, my: false, edited: true, edited_timestamp: 2 };
    const html = chat.renderChatMessageHTML(message, { contact: { messages: [message] }, lastReadTs: 0 });
    assert.equal((html.match(/class="message-time"/g) || []).length, 1);
    assert.ok(html.includes('message-edited-label') && html.includes('edited-new-dot'));
    assert.ok(!html.includes('evm-payment-contract') && !html.includes('<dt>Token contract</dt>'));
    assert.equal(html.includes('evm-payment-footer'), type === EVM_CHAT_MESSAGE_TYPE);
  }
});

test('full contract and transaction details use accessible chain-correct links in sent and received cards', () => {
  for (const my of [true, false]) {
    const payment = { ...PAYMENT, assetKind: 'erc20', contractAddress: CONTRACT, networkId: 'ethereum' };
    const html = chat.renderEvmPaymentMessage({ payment, my }, '');
    const details = html.slice(html.indexOf('<details'));
    assert.ok(details.includes(`href="https://bscscan.com/token/${CONTRACT}"`));
    assert.ok(details.includes(`href="https://bscscan.com/tx/${HASH}"`));
    assert.ok(details.includes(`aria-label="View token contract ${CONTRACT} in block explorer"`));
    assert.ok(details.includes(`aria-label="View transaction ${HASH} in block explorer"`));
    assert.equal((details.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
    assert.equal((details.match(/<span aria-hidden="true">↗<\/span>/g) || []).length, 2);
    assert.ok(details.includes(`<code>${CONTRACT}</code>`));
    assert.ok(details.includes(`<code>${HASH}</code>`));
  }
});

test('unknown-chain token and transaction details remain plain selectable text', () => {
  const payment = { ...PAYMENT, chainId: 999, assetKind: 'erc20', contractAddress: CONTRACT };
  const html = chat.renderEvmPaymentMessage({ payment }, '');
  const details = html.slice(html.indexOf('<details'));
  assert.ok(details.includes(`<code>${CONTRACT}</code>`));
  assert.ok(details.includes(`<code>${HASH}</code>`));
  assert.ok(!details.includes('<a '));
});
