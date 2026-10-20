import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { EVM_CHAT_MESSAGE_TYPE, evmAssets, parseEvmTransferMessage } from '../evm-assets.js';
import { parse, stringify } from '../external/stringify-shardus.js';
import { longAddress, normalizeAddress } from '../lib.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const syncSource = [
  ['async function getChats(', '// play sound if'],
  ['async function processChats(', '/**\n * Restore wallet/history'],
  ['function insertSorted(', '/**\n * Calculates the time difference'],
  ['function evmPaymentRecordId(', '// Submission responses own EVM progress'],
].map(([start, end]) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return source.slice(startIndex, endIndex);
}).join('\n');

const OWNER = 'a'.repeat(40);
const SENDER = 'b'.repeat(40);
const OTHER_SENDER = 'c'.repeat(40);
const START = 1_700_000_000_000;
const PAYMENT = {
  type: EVM_CHAT_MESSAGE_TYPE,
  version: 1,
  chainId: 1,
  networkId: 'ethereum',
  transactionHash: `0x${'d'.repeat(64)}`,
  from: `0x${SENDER}`,
  to: `0x${OWNER}`,
  assetKind: 'native',
  contractAddress: null,
  rawAmount: '1000000000000000',
  decimals: 18,
  symbol: 'ETH',
};

class ChatSyncFixture {
  constructor(records = []) {
    this.requests = [];
    this.warnings = [];
    this.savedStates = [];
    this.transactions = {};
    const account = { username: 'restored', keys: { address: OWNER }, chatTimestamp: START };
    this.data = {
      account,
      evmPayments: structuredClone(records),
      contacts: Object.fromEntries([SENDER, OTHER_SENDER].map((address) => [address, {
        address, username: address, messages: [], unread: 0,
      }])),
      chats: [],
      wallet: { history: [] },
    };
    this.context = vm.createContext({
      myData: this.data,
      myAccount: account,
      EVM_CHAT_MESSAGE_TYPE, evmAssets,
      INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
      EVM_RECHECK_MS: 300_000,
      parseEvmTransferMessage, parse, stringify, longAddress, normalizeAddress,
      // These plaintext queue fixtures do not exercise authentication. The
      // separate f03 and encrypted note-sync tests use real signatures/keys.
      network: { netid: 'fixture-network' },
      isPublicKeyForAddress: () => true,
      getExpectedChatId: (_owner, peer) => peer === SENDER ? 'first-chat' : 'second-chat',
      getVerifiedChatContactKeys: async () => ({ public: 'fixture-key' }),
      validateChatTransaction: tx => ({ ok: true, txid: tx.id }),
      generateAddress() {}, ethHashMessage() {}, hashBytes() {}, verifyMessage() {},
      console: { warn: (...args) => this.warnings.push(args), error() {} },
      getCorrectedTimestamp: () => START + 100_000,
      longPollResult: { timestamp: START + 100_000 },
      getTxid: (tx) => tx.id,
      decryptMessage() {}, // Plaintext fixtures exercise processing after decryption.
      isFaucetAddress: () => false,
      getLatestChatReactionActivity: () => null,
      playChatSound() {},
      playTransferSound() {},
      chatModal: { address: null, isActive: () => false },
      chatsScreen: { isActive: () => true, updateChatList() {} },
      document: { visibilityState: 'visible' },
      saveState: () => this.savedStates.push(structuredClone(this.data)),
      queryNetwork: async (url) => {
        this.requests.push(url);
        if (url.includes('/chats/')) return { chats: { [SENDER]: 'first-chat', [OTHER_SENDER]: 'second-chat' } };
        const match = /^\/messages\/([^/]+)\/(\d+)$/.exec(url);
        assert.ok(match, `Unexpected request: ${url}`);
        return { messages: structuredClone((this.transactions[match[1]] || [])
          .filter((tx) => tx.timestamp >= Number(match[2]))) };
      },
    });
    vm.runInContext(syncSource, this.context);
  }

  paymentTransaction() {
    return {
      id: 'payment-message', type: 'message',
      from: longAddress(SENDER), to: longAddress(OWNER), timestamp: START + 1000,
      xmessage: { message: JSON.stringify(PAYMENT), sent_timestamp: START + 1000 },
    };
  }

  textTransaction(address, timestamp) {
    return {
      id: `text-${address}`, type: 'message',
      from: longAddress(address), to: longAddress(OWNER), timestamp,
      xmessage: { message: 'new ordinary message', sent_timestamp: timestamp },
    };
  }

  async receiveBatch(existingPayment) {
    if (existingPayment) {
      this.data.contacts[SENDER].messages.push({
        type: EVM_CHAT_MESSAGE_TYPE, payment: structuredClone(PAYMENT),
        my: false, txid: 'payment-message', timestamp: START + 1000,
      });
    }
    this.transactions = {
      'first-chat': [this.paymentTransaction(), this.textTransaction(SENDER, START + 2000)],
      'second-chat': [this.textTransaction(OTHER_SENDER, START + 3000)],
    };
    return this.context.getChats(this.data.account.keys);
  }
}

// Earlier recovery records carried networkId on the record, not its payment.
const legacyPayment = { ...PAYMENT };
delete legacyPayment.networkId;
const legacyRecord = { kind: 'outgoing', networkId: 'ethereum', payment: legacyPayment };

for (const existingPayment of [false, true]) {
  test(`invalid saved EVM records allow ${existingPayment ? 'existing' : 'new'} payment messages and later chats to sync`, async () => {
    const fixture = new ChatSyncFixture([legacyRecord]);
    assert.equal(await fixture.receiveBatch(existingPayment), 2);

    assert.deepEqual(fixture.data.contacts[SENDER].messages.map((message) => message.txid), [
      `text-${SENDER}`, 'payment-message',
    ]);
    assert.equal(fixture.data.contacts[OTHER_SENDER].messages[0].txid, `text-${OTHER_SENDER}`);
    assert.equal(fixture.data.account.chatTimestamp, START + 3000);
    assert.equal(fixture.savedStates.at(-1).account.chatTimestamp, START + 3000);
    assert.equal(fixture.data.evmPayments.length, 1);
    assert.equal(fixture.data.evmPayments[0].kind, 'verification');
    assert.equal(stringify(fixture.data.evmPayments[0].payment), stringify(PAYMENT));
    assert.equal(stringify(fixture.savedStates.at(-1).evmPayments), stringify(fixture.data.evmPayments));
    assert.doesNotThrow(() => fixture.context.loadEvmPayments());
    assert.equal(fixture.warnings.length, 1);
    assert.deepEqual(fixture.warnings[0], ['Removed invalid saved EVM payment records:', 1]);
    const paymentMessage = fixture.data.contacts[SENDER].messages.find((message) => message.txid === 'payment-message');
    assert.equal(paymentMessage.paymentMessageConfirmed, true);
    assert.equal(paymentMessage.paymentVerified, existingPayment ? undefined : 'unchecked');
  });
}

test('valid saved records continue to queue verification without duplicates', () => {
  const fixture = new ChatSyncFixture([]);
  const message = { payment: PAYMENT, txid: 'payment-message' };
  fixture.context.queueEvmPaymentMessage(message);
  fixture.context.queueEvmPaymentMessage(message);

  assert.equal(fixture.data.evmPayments.length, 1);
  assert.equal(fixture.data.evmPayments[0].kind, 'verification');
  assert.equal(fixture.data.evmPayments[0].payment.networkId, 'ethereum');
  assert.equal(fixture.data.evmPayments[0].assetState, 'unknown');
  assert.equal(fixture.warnings.length, 0);
});

test('queue warnings are limited per account and resume after successful loading', () => {
  const fixture = new ChatSyncFixture();
  fixture.data.evmPayments = { malformed: true };
  const message = { payment: PAYMENT, txid: 'payment-message' };
  fixture.context.queueEvmPaymentMessage(message);
  fixture.context.queueEvmPaymentMessage(message);
  assert.equal(fixture.warnings.length, 1);

  fixture.data.evmPayments = [];
  fixture.context.queueEvmPaymentMessage(message);
  fixture.data.evmPayments = { malformed: true };
  fixture.context.queueEvmPaymentMessage(message);
  assert.equal(fixture.warnings.length, 2);

  fixture.context.myAccount = { ...fixture.data.account, username: 'another-account' };
  fixture.context.queueEvmPaymentMessage(message);
  assert.equal(fixture.warnings.length, 3);
});

test('cleanup preserves valid records, defers persistence, and returns independent snapshots', () => {
  const outgoing = { kind: 'outgoing', payment: PAYMENT, messageState: 'submitted', rawTransaction: 'saved-test-transaction' };
  const verification = { kind: 'verification', payment: { ...PAYMENT, transactionHash: `0x${'e'.repeat(64)}` } };
  const fixture = new ChatSyncFixture([legacyRecord, outgoing, null, verification, { kind: 'unknown', payment: PAYMENT }]);
  const expected = stringify([outgoing, verification]);
  const loaded = fixture.context.loadEvmPayments();

  assert.equal(stringify(loaded), expected);
  assert.equal(stringify(fixture.data.evmPayments), expected);
  assert.equal(fixture.savedStates.length, 0);
  assert.deepEqual(fixture.warnings, [['Removed invalid saved EVM payment records:', 3]]);
  loaded[0].messageState = 'delivered';
  assert.equal(fixture.data.evmPayments[0].messageState, 'submitted');
  assert.equal(stringify(fixture.context.loadEvmPayments()), expected);
  assert.equal(fixture.warnings.length, 1);
  assert.equal(fixture.savedStates.length, 0);
});

test('all-invalid recovery records are removed without generating payment retries', () => {
  const fixture = new ChatSyncFixture([legacyRecord, null]);
  assert.equal(fixture.context.loadEvmPayments().length, 0);
  assert.equal(fixture.data.evmPayments.length, 0);
  assert.equal(fixture.savedStates.length, 0);
  assert.deepEqual(fixture.warnings, [['Removed invalid saved EVM payment records:', 2]]);
});

test('EVM Assets recovery renders valid records and still refreshes balances after legacy cleanup', async (t) => {
  const previousDocument = globalThis.document;
  // Recovery markup only needs text-only divs for these fixed, benign fixtures.
  globalThis.document = { createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }) };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const fixture = new ChatSyncFixture([legacyRecord, { kind: 'outgoing', payment: PAYMENT, assetState: 'pending' }]);
  const controller = new evmAssets.constructor();
  controller.configure({ getAccount: () => fixture.data.account, getPayments: () => fixture.context.loadEvmPayments() });
  const modal = controller.assetsModal;
  modal.recovery = { hidden: true };
  modal.recoveryList = { innerHTML: '', textContent: '' };
  modal.connectionSummary = { textContent: '', dataset: {} };
  let refreshed = false;
  controller.refresh = async () => { refreshed = true; };

  await modal.update();

  assert.equal(refreshed, true);
  assert.equal(modal.recovery.hidden, false);
  assert.equal(modal.recoveryList.textContent, '');
  assert.match(modal.recoveryList.innerHTML, /Confirming transfer/);
  assert.equal(fixture.data.evmPayments.length, 1);
  assert.equal(fixture.savedStates.length, 0);
});

test('missing recovery state is compatible and malformed collections are preserved', () => {
  const fixture = new ChatSyncFixture();
  delete fixture.data.evmPayments;
  fixture.context.queueEvmPaymentMessage({ payment: PAYMENT, txid: 'payment-message' });
  assert.equal(fixture.data.evmPayments.length, 1);

  const malformed = { legacy: true };
  fixture.data.evmPayments = malformed;
  fixture.context.queueEvmPaymentMessage({ payment: PAYMENT, txid: 'payment-message' });
  assert.equal(fixture.data.evmPayments, malformed);
  assert.throws(() => fixture.context.loadEvmPayments(), /Saved EVM payment records could not be read/);
  assert.equal(fixture.warnings.length, 1);
  assert.equal(fixture.savedStates.length, 0);
});
