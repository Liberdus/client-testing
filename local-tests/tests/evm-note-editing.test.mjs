import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { EVM_CHAT_MESSAGE_TYPE, evmAssets, parseEvmTransferMessage } from '../evm-assets.js';
import { normalizeAddress } from '../lib.js';
import { parse, stringify } from '../external/stringify-shardus.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const NOW = Date.now();
const OWNER = 'a'.repeat(40);
const PEER = 'b'.repeat(40);
const ORIGINAL_TXID = 'c'.repeat(64);
const EDIT_TXID = 'e'.repeat(64);
const PAYMENT = {
  type: EVM_CHAT_MESSAGE_TYPE, version: 1, chainId: 56, networkId: 'bsc',
  transactionHash: `0x${'d'.repeat(64)}`, from: `0x${OWNER}`, to: `0x${PEER}`,
  assetKind: 'native', contractAddress: null, rawAmount: '5000000000000000',
  decimals: 18, symbol: 'BNB', note: 'Original\nnote <3',
};

function excerpt(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}

const methods = [
  excerpt('  static getEditText(message)', '  /**\n   * Starts reply flow:'),
  excerpt('  async handleSendMessage()', '  /**\n   * Starts the browser geolocation'),
  excerpt('  getMessageRecordFromElement(messageEl)', '  getMessageRecordFromRenderedChild('),
].join('\n');
const globals = [
  excerpt('function hasPendingEditForTarget(', 'const DELETE_FOR_ALL_ACTION_GUARD_MS'),
  excerpt('function restorePendingMessageEdit(', '/**\n * Reverts a pending optimistic'),
  excerpt('function trackPendingMessageEditBeforeInject(', '/**\n * Creates or updates the provisional pending entry used to persist optimistic reaction'),
  excerpt('function evmPaymentRecordId(', '// Submission responses own EVM progress'),
  excerpt('function evmPaymentMessages(', '// Background status updates'),
].join('\n');

function fixture(kind = 'evm') {
  const message = {
    type: kind === 'evm' ? EVM_CHAT_MESSAGE_TYPE : 'message',
    message: kind === 'evm' ? '' : 'Original memo',
    ...(kind === 'evm' ? { payment: structuredClone(PAYMENT), paymentVerified: 'pending', paymentCheckedAt: NOW, paymentMessageConfirmed: true }
      : kind === 'lib' ? { amount: 10n } : {}),
    txid: ORIGINAL_TXID, my: true, timestamp: NOW - 60_000, sent_timestamp: NOW - 60_000, status: 'sent',
  };
  const account = { username: 'sender', keys: { address: OWNER } };
  const contact = { address: PEER, messages: [message], tollRequiredToSend: 0, draft: '' };
  const data = { account, contacts: { [PEER]: contact }, pending: [], evmPayments: [],
    chats: [{ address: PEER, txid: ORIGINAL_TXID, timestamp: message.timestamp }],
    wallet: { history: kind === 'lib' ? [{ txid: ORIGINAL_TXID, memo: message.message }] : [] } };
  const elements = { editOfTxId: { value: ORIGINAL_TXID } };
  const sends = [], saved = [], toasts = [], built = [];
  const context = vm.createContext({
    myData: data, myAccount: account, isOnline: true, EVM_CHAT_MESSAGE_TYPE,
    INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer', EDIT_WINDOW_MS: 15 * 60_000, EVM_RECHECK_MS: 300_000,
    evmAssets, parseEvmTransferMessage, normalizeAddress, parse, stringify, assert,
    console: { warn() {}, error() {}, log() {} },
    isDeleted: value => Boolean(value.deleted),
    document: { getElementById: id => elements[id] },
    validateBalance: async () => true,
    getEffectiveTollLibWei: () => 0n,
    getCorrectedTimestamp: () => NOW,
    saveState: () => saved.push(parse(stringify(data))),
    showToast: (...args) => toasts.push(args),
    insertSorted: (items, item, field) => { items.push(item); items.sort((a, b) => b[field] - a[field]); },
    syncChatLatestActivityTimestamp(address, currentContact) {
      if (!data.chats.some(chat => chat.address === address)) {
        data.chats.push({ address, txid: currentContact.messages[0].txid, timestamp: currentContact.messages[0].timestamp });
      }
    },
    isRecipientTollStateFailure: () => false,
    injectTx: async tx => { sends.push(tx); return { result: { success: true } }; },
    checkFirstTimeTip: () => true,
    setFirstTimeTipShown() {}, Event: class {}, requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(`class ChatModal { ${methods} }\n${globals}\nglobalThis.ChatModal = ChatModal;`, context);
  const modal = new context.ChatModal();
  Object.assign(modal, {
    address: PEER, toll: 0n, fileAttachments: [], blockedByRecipient: false,
    messageInput: { value: 'Updated\nnote <b>hello</b>', style: {}, focus() {}, dispatchEvent() {}, scrollHeight: 48 },
    retryOfTxId: { value: '' }, cancelEditButton: { style: {} }, addAttachmentButton: { disabled: false },
    messageByteCounter: { style: {} }, messagesList: { parentElement: { scrollTop: 0, scrollHeight: 0 } },
    prepareEncryptedChatContext: async () => ({}),
    buildEncryptedStructuredChatTx: async (address, messageObj) => {
      built.push({ address, messageObj });
      return { payload: { sent_timestamp: NOW }, chatMessageObj: messageObj, txid: EDIT_TXID };
    },
    appendChatModal() {}, toggleSendButtonVisibility() {}, debouncedSaveDraft() {},
    clearReplyState() {}, clearAttachmentState() {}, clearRetryState() {}, cancelReply() {}, cancelAllOperations() {},
    isActive: () => false,
  });
  context.chatModal = modal;
  return { context, modal, message, contact, data, elements, sends, saved, toasts, built };
}

test('EVM eligibility allows only own, nonempty, valid notes in the existing edit window', () => {
  const { context, message } = fixture();
  assert.equal(context.ChatModal.canEditMessage(message), true);
  for (const change of [
    { my: false }, { deleted: 1 }, { status: 'failed' }, { timestamp: NOW - 16 * 60_000 }, { timestamp: 0 }, { timestamp: Infinity },
    { payment: { ...PAYMENT, note: undefined } }, { payment: { ...PAYMENT, note: '   ' } },
    { payment: { ...PAYMENT, rawAmount: '-1' } },
    { type: 'intents_transfer', payment: { note: 'A multichain note' } },
  ]) assert.equal(context.ChatModal.canEditMessage({ ...message, ...change }), false, stringify(change));
});

test('EVM note validation uses the existing UTF-8 byte limit', () => {
  const { context, message } = fixture();
  for (const text of ['x'.repeat(1000), 'é'.repeat(500), '😀'.repeat(250), 'Line one\n<b>Line two</b>']) {
    assert.equal(context.ChatModal.isValidEditText(message, text), true);
  }
  for (const text of ['x'.repeat(1001), 'é'.repeat(501), '😀'.repeat(251), '', '  ', null, { note: 'bad' }]) {
    assert.equal(context.ChatModal.isValidEditText(message, text), false);
  }
});

test('applying a note replaces a frozen claim without changing transfer or verification fields', () => {
  const { context, message } = fixture();
  message.payment = Object.freeze(message.payment);
  const before = structuredClone(message);
  assert.equal(context.ChatModal.applyMessageEdit(message, 'New note', NOW), true);
  assert.equal(message.message, '');
  assert.equal(message.payment.note, 'New note');
  const expected = { ...before, payment: { ...before.payment, note: 'New note' }, edited: 1, edited_timestamp: NOW };
  assert.equal(stringify(message), stringify(expected));
  assert.equal(Object.isFrozen(message.payment), true);
  assert.equal(context.ChatModal.applyMessageEdit(message, 'Older edit', NOW - 1), false);
  assert.equal(message.payment.note, 'New note');
});

test('serialized optimistic snapshots restore the note and prior edit markers after reload', () => {
  const { context, message } = fixture();
  message.edited = 1; message.edited_timestamp = NOW - 20_000;
  const before = stringify(message);
  const snapshot = parse(stringify(context.ChatModal.snapshotMessageEdit(message)));
  context.ChatModal.applyMessageEdit(message, 'Pending note', NOW);
  context.ChatModal.restoreMessageEdit(message, snapshot);
  assert.equal(stringify(message), before);
});

for (const kind of ['message', 'lib']) {
  test(`existing ${kind} edits still update ordinary text and LIB history when applicable`, async () => {
    const f = fixture(kind);
    await f.modal.handleSendMessage();
    assert.equal(f.message.message, 'Updated\nnote <b>hello</b>');
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].type, 'edit');
    if (kind === 'lib') assert.equal(f.data.wallet.history[0].memo, f.message.message);
    const snapshot = f.data.pending[0].editPending;
    f.context.restorePendingMessageEdit(EDIT_TXID, PEER, snapshot);
    assert.equal(f.message.message, 'Original memo');
    assert.equal(f.message.edited, undefined);
    if (kind === 'lib') assert.equal(f.data.wallet.history[0].memo, 'Original memo');
  });
}

test('sender reuses the chat edit control and saves a note snapshot without a new payment card', async () => {
  const f = fixture();
  const original = structuredClone(f.message.payment);
  await f.modal.handleSendMessage();
  assert.equal(f.sends.length, 1);
  assert.equal(stringify(f.sends[0]), stringify({ type: 'edit', txid: ORIGINAL_TXID, text: 'Updated\nnote <b>hello</b>' }));
  assert.equal(f.message.payment.note, f.sends[0].text);
  assert.equal(f.contact.messages.length, 1);
  assert.equal(f.message.txid, ORIGINAL_TXID);
  assert.equal(f.message.payment.transactionHash, original.transactionHash);
  assert.equal(f.message.paymentVerified, 'pending');
  assert.equal(f.data.pending[0].editPending.previousMessage.paymentNote, original.note);
  assert.equal(f.saved[0].contacts[PEER].messages[0].payment.note, f.sends[0].text);
  assert.equal(f.elements.editOfTxId.value, '');
});

for (const failure of ['rejected', 'exception']) {
  test(`${failure} submission restores the note and composer, then permits retry`, async () => {
    const f = fixture();
    f.context.injectTx = async tx => {
      f.sends.push(tx);
      if (failure === 'exception') throw new Error('simulated network failure');
      return { result: { success: false } };
    };
    await f.modal.handleSendMessage();
    assert.equal(f.message.payment.note, PAYMENT.note);
    assert.equal(f.message.edited, undefined);
    assert.equal(f.data.pending.length, 0);
    assert.equal(f.saved.at(-1).contacts[PEER].messages[0].payment.note, PAYMENT.note);
    assert.equal(f.elements.editOfTxId.value, ORIGINAL_TXID);
    assert.equal(f.modal.messageInput.value, 'Updated\nnote <b>hello</b>');
    f.context.injectTx = async tx => { f.sends.push(tx); return { result: { success: true } }; };
    await f.modal.handleSendMessage();
    assert.equal(f.sends.length, 2);
    assert.equal(f.contact.messages.length, 1);
    assert.equal(f.message.payment.note, 'Updated\nnote <b>hello</b>');
  });
}

test('pending edit guard prevents a second submission', async () => {
  const f = fixture();
  await f.modal.handleSendMessage();
  f.elements.editOfTxId.value = ORIGINAL_TXID;
  f.modal.messageInput.value = 'A second note';
  await f.modal.handleSendMessage();
  assert.equal(f.sends.length, 1);
  assert.equal(f.message.payment.note, 'Updated\nnote <b>hello</b>');
});

test('concurrent preparation cannot submit two edits for the same original message', async () => {
  const f = fixture();
  const release = [];
  const build = f.modal.buildEncryptedStructuredChatTx;
  f.modal.buildEncryptedStructuredChatTx = (...args) => new Promise(resolve => release.push(async () => resolve(await build(...args))));
  const first = f.modal.handleSendMessage();
  const second = f.modal.handleSendMessage();
  while (release.length < 2) await new Promise(resolve => setImmediate(resolve));
  await release[0]();
  await first;
  await release[1]();
  await second;
  assert.equal(f.sends.length, 1);
  assert.equal(f.data.pending.length, 1);
});

for (const change of [{ deleted: 1 }, { timestamp: NOW - 16 * 60_000 }]) {
  test(`eligibility is rechecked after asynchronous preparation: ${Object.keys(change)[0]}`, async () => {
    const f = fixture();
    const build = f.modal.buildEncryptedStructuredChatTx;
    f.modal.buildEncryptedStructuredChatTx = async (...args) => { Object.assign(f.message, change); return build(...args); };
    await f.modal.handleSendMessage();
    assert.equal(f.sends.length, 0);
    assert.equal(f.message.payment.note, PAYMENT.note);
    assert.equal(f.data.pending.length, 0);
  });
}

test('oversize and invalid edit targets do not become ordinary messages or submit', async () => {
  for (const change of [{ my: false }, { deleted: 1 }, { status: 'failed' }, { timestamp: NOW - 16 * 60_000 }]) {
    const f = fixture(); Object.assign(f.message, change);
    await f.modal.handleSendMessage();
    assert.equal(f.sends.length, 0);
    assert.equal(f.contact.messages.length, 1);
  }
  const f = fixture(); f.modal.messageInput.value = 'é'.repeat(501);
  await f.modal.handleSendMessage();
  assert.equal(f.sends.length, 0);
  assert.equal(f.message.payment.note, PAYMENT.note);
});

test('edit initiation prefills from the source record rather than rendered markup', () => {
  const f = fixture(); f.elements.editOfTxId.value = '';
  const element = { dataset: { txid: ORIGINAL_TXID, messageTimestamp: String(f.message.timestamp) } };
  f.modal.startEditMessage(element);
  assert.equal(f.modal.messageInput.value, PAYMENT.note);
  assert.equal(f.elements.editOfTxId.value, ORIGINAL_TXID);
  assert.equal(f.modal.addAttachmentButton.disabled, true);
});

const incoming = excerpt("                } else if (parsedMessage.type === 'edit') {", "                } else if (parsedMessage.type === 'call') {")
  .replace(/^\s*} else if \(parsedMessage.type === 'edit'\) \{/, '');

test('incoming edits update the recipient note and survive serialized reload/replay', async () => {
  const f = fixture(); f.message.my = false;
  f.message.payment = { ...PAYMENT, from: `0x${PEER}`, to: `0x${OWNER}` };
  vm.runInContext(`async function receiveEdit(parsedMessage, tx, contact, keys, from) {
    let editIncrements = 0; const inActiveChatWithSender = false;
    for (const ignored of [tx]) { ${incoming} }
    return editIncrements;
  }`, f.context);
  const control = { type: 'edit', txid: ORIGINAL_TXID, text: 'Received\n<b>new note</b>' };
  const tx = { from: PEER, timestamp: NOW };
  assert.equal(await f.context.receiveEdit(control, tx, f.contact, f.data.account.keys, PEER), 1);
  assert.equal(f.message.payment.note, control.text);
  assert.equal(f.message.message, '');
  assert.equal(f.message.paymentVerified, 'pending');
  f.data.contacts[PEER] = parse(stringify(f.contact));
  assert.equal(f.data.contacts[PEER].messages[0].payment.note, control.text);
  await f.context.receiveEdit(control, tx, f.data.contacts[PEER], f.data.account.keys, PEER);
  assert.equal(f.data.contacts[PEER].messages.length, 1);
});

test('incoming malformed, unauthorized, expired, deleted, and out-of-order EVM edits are ignored', async () => {
  for (const scenario of ['unauthorized', 'expired', 'before-payment', 'invalid-time', 'oversize', 'empty', 'no-note', 'deleted', 'older-edit']) {
    const f = fixture(); f.message.my = false;
    f.message.payment = { ...PAYMENT, from: `0x${PEER}`, to: `0x${OWNER}` };
    const control = { type: 'edit', txid: ORIGINAL_TXID, text: 'Attempted edit' };
    const tx = { from: PEER, timestamp: NOW };
    if (scenario === 'unauthorized') tx.from = 'f'.repeat(40);
    if (scenario === 'expired') tx.timestamp = f.message.sent_timestamp + 20 * 60_000;
    if (scenario === 'before-payment') tx.timestamp = f.message.sent_timestamp - 1;
    if (scenario === 'invalid-time') tx.timestamp = 'invalid';
    if (scenario === 'oversize') control.text = '😀'.repeat(251);
    if (scenario === 'empty') control.text = '  ';
    if (scenario === 'no-note') delete f.message.payment.note;
    if (scenario === 'deleted') f.message.deleted = 1;
    if (scenario === 'older-edit') f.message.edited_timestamp = NOW + 1;
    const before = stringify(f.message);
    vm.runInContext(`async function receiveEdit(parsedMessage, tx, contact, keys, from) {
      let editIncrements = 0; const inActiveChatWithSender = false;
      for (const ignored of [tx]) { ${incoming} }
      return editIncrements;
    }`, f.context);
    await f.context.receiveEdit(control, tx, f.contact, f.data.account.keys, PEER);
    assert.equal(stringify(f.message), before, scenario);
  }
});

test('payment matching ignores only notes and keeps all transfer claims distinct', () => {
  const key = evmAssets.getPaymentClaimKey(PAYMENT);
  assert.equal(key, evmAssets.getPaymentClaimKey({ ...PAYMENT, note: 'Edited note' }));
  for (const change of [
    { rawAmount: '1' }, { chainId: 1 }, { networkId: 'ethereum' }, { symbol: 'FAKE' }, { decimals: 6 },
    { from: `0x${'f'.repeat(40)}` }, { to: `0x${'f'.repeat(40)}` }, { transactionHash: `0x${'f'.repeat(64)}` },
    { assetKind: 'erc20', contractAddress: `0x${'f'.repeat(40)}` },
  ]) assert.notEqual(key, evmAssets.getPaymentClaimKey({ ...PAYMENT, ...change }), stringify(change));
  assert.equal(PAYMENT.note, 'Original\nnote <3');
  assert.equal(evmAssets.getPaymentClaimKey({ ...PAYMENT, rawAmount: '-1' }), null);
});

test('edited cards stay attached to the original recovery/verification record without duplicates', () => {
  const f = fixture();
  const record = { kind: 'outgoing', payment: structuredClone(PAYMENT), assetState: 'pending', messageState: 'submitted' };
  f.data.evmPayments.push(record);
  f.context.ChatModal.applyMessageEdit(f.message, 'Edited note', NOW);
  assert.equal(f.context.evmPaymentMessages(record, f.data.account).length, 1);
  f.context.queueEvmPaymentMessage(f.message);
  assert.equal(f.data.evmPayments.length, 1);
  assert.equal(f.data.evmPayments[0].messageState, 'delivered');
  assert.equal(f.data.evmPayments[0].payment.note, PAYMENT.note, 'The original transfer/receipt record stays unchanged');
  assert.equal(f.message.payment.note, 'Edited note');
});
