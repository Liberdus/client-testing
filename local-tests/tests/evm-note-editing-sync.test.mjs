import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  bin2hex, bin2base64, hex2bin, longAddress, normalizeAddress, getExpectedChatId,
  getUnsignedTransactionId, isPublicKeyForAddress, validateChatTransaction,
} from '../lib.js';
import {
  decryptMessage, dhkeyCombined, encryptChacha, ethHashMessage, generateAddress,
  generatePQKeys, getPublicKey, hashBytes, signMessage, verifyMessage,
} from '../crypto.js';
import { evmAssets, parseEvmTransferMessage } from '../evm-assets.js';
import { parse, stringify } from '../external/stringify-shardus.js';

globalThis.crypto ??= webcrypto;
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const NOW = Date.now();
function excerpt(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
function keys(value) {
  const secret = value.toString(16).padStart(64, '0');
  const publicKey = bin2hex(getPublicKey(hex2bin(secret)));
  return { secret, public: publicKey, address: bin2hex(generateAddress(hex2bin(publicKey))), pqSeed: value.toString(16).padStart(128, '0') };
}
const owner = keys(1), sender = keys(2);
const claim = {
  type: 'evm_transfer', version: 1, chainId: 56, networkId: 'bsc',
  transactionHash: `0x${'d'.repeat(64)}`, from: `0x${sender.address}`, to: `0x${owner.address}`,
  assetKind: 'native', contractAddress: null, rawAmount: '5000000000000000', decimals: 18, symbol: 'BNB', note: 'Original note',
};
async function transaction(body, timestamp, author = sender) {
  const recipient = author === sender ? owner : sender;
  const { publicKey } = generatePQKeys(recipient.pqSeed);
  const { dhkey, cipherText } = dhkeyCombined(author.secret, recipient.public, publicKey);
  const tx = {
    type: 'message', from: longAddress(author.address), to: longAddress(recipient.address),
    chatId: getExpectedChatId(author.address, recipient.address, hashBytes),
    networkId: 'test-network', timestamp, amount: 0n, fee: 1n,
    xmessage: {
      encrypted: true, encryptionMethod: 'xchacha20poly1305',
      message: encryptChacha(dhkey, JSON.stringify(body)), pqEncSharedKey: bin2base64(cipherText), sent_timestamp: timestamp,
    },
  };
  const txid = getUnsignedTransactionId(tx, { ethHashMessage, hashBytes, stringify });
  const signature = await signMessage(hex2bin(ethHashMessage(txid)), hex2bin(author.secret));
  const r = signature.r.toString(16).padStart(64, '0'), s = signature.s.toString(16).padStart(64, '0');
  const recovery = (27 + signature.recovery).toString(16).padStart(2, '0');
  tx.sign = { owner: longAddress(author.address), sig: `0x${r}${s}${recovery}` };
  return { tx, txid };
}
function fixture() {
  let batch = [], saved;
  const warnings = [];
  const context = vm.createContext({
    myAccount: { keys: owner, chatTimestamp: NOW - 120_000 },
    myData: { contacts: { [sender.address]: { address: sender.address, public: sender.public, messages: [], unread: 0 } },
      wallet: { history: [] }, chats: [], evmPayments: [], pending: [] },
    network: { netid: 'test-network' }, EVM_CHAT_MESSAGE_TYPE: 'evm_transfer', INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
    EDIT_WINDOW_MS: 15 * 60_000, EVM_RECHECK_MS: 300_000,
    evmAssets, parseEvmTransferMessage, bin2hex, bin2base64, hex2bin, longAddress, normalizeAddress,
    getExpectedChatId, getUnsignedTransactionId, isPublicKeyForAddress, validateChatTransaction,
    generateAddress, getPublicKey, hashBytes, ethHashMessage, verifyMessage, decryptMessage, parse, stringify,
    console: { log() {}, error: (...args) => warnings.push(args[0]), warn: (...args) => warnings.push(args[0]) },
    isDeleted: message => Boolean(message.deleted), isFaucetAddress: () => false,
    document: { visibilityState: 'visible' },
    chatModal: { address: null, isActive: () => false },
    chatsScreen: { isActive: () => false }, walletScreen: { isActive: () => false }, historyModal: { isActive: () => false },
    footer: { chatButton: { classList: { add() {} } } },
    playChatSound() {}, playTransferSound() {}, getLatestChatReactionActivity: () => null,
    syncChatLatestActivityTimestamp() {},
    insertSorted: (items, item, field) => { items.push(item); items.sort((a, b) => b[field] - a[field]); },
    saveState: () => { saved = parse(stringify(context.myData)); },
    queryNetwork: async url => {
      const timestamp = Number(url.split('/').at(-1));
      return { messages: parse(stringify(batch.filter(tx => tx.timestamp >= timestamp))) };
    },
  });
  const methods = excerpt('  static getEditText(message)', '  restoreEditComposer(');
  const keyStart = source.indexOf('async function ensureContactKeys(');
  const keyEnd = source.indexOf('\n/**', source.indexOf('async function getVerifiedChatContactKeys('));
  assert.ok(keyStart >= 0 && keyEnd > keyStart);
  const keySource = source.slice(keyStart, keyEnd);
  // Keep the original authenticated batch processing and decryption paths.
  const processStart = source.indexOf('async function processChats(');
  const processEnd = source.indexOf('\n/**', processStart);
  assert.ok(processEnd > processStart);
  vm.runInContext(`class ChatModal { ${methods} }\n${keySource}\n${source.slice(processStart, processEnd)}\n${excerpt('function evmPaymentRecordId(', '// Submission responses own EVM progress')}`, context);
  return {
    context,
    warnings,
    get data() { return context.myData; },
    get saved() { return saved; },
    async sync(transactions) {
      batch = transactions;
      await context.processChats({ [sender.address]: getExpectedChatId(owner.address, sender.address, hashBytes) }, owner);
      // Exercise the existing save lifecycle after the sync entry point returns.
      context.saveState();
    },
  };
}

test('authenticated encrypted note edits survive full processChats sync, reload, and receipt replay', async () => {
  const f = fixture();
  const payment = await transaction(claim, NOW - 60_000);
  await f.sync([payment.tx]);
  const card = f.data.contacts[sender.address].messages[0];
  assert.equal(card.payment.note, claim.note);
  assert.equal(card.txid, payment.txid);
  const edit = await transaction({ type: 'edit', txid: payment.txid, text: 'Encrypted\nupdated note <3' }, NOW);
  await f.sync([edit.tx]);
  assert.equal(card.payment.note, 'Encrypted\nupdated note <3', stringify({ warnings: f.warnings, card, cursor: f.context.myAccount.chatTimestamp }));
  assert.equal(card.message, '');
  assert.equal(card.edited, 1);
  assert.equal(card.paymentVerified, 'unchecked');
  assert.equal(f.saved.contacts[sender.address].messages[0].payment.note, card.payment.note);
  f.context.myData = parse(stringify(f.saved));
  f.context.myAccount.chatTimestamp = NOW - 120_000;
  await f.sync([payment.tx, edit.tx]);
  assert.equal(f.data.contacts[sender.address].messages.length, 1);
  assert.equal(f.data.contacts[sender.address].messages[0].payment.note, 'Encrypted\nupdated note <3');
  assert.equal(f.data.evmPayments.length, 1);
});

test('a verified peer cannot edit our EVM payment note', async () => {
  const f = fixture();
  const ownClaim = { ...claim, from: `0x${owner.address}`, to: `0x${sender.address}` };
  const payment = await transaction(ownClaim, NOW - 60_000, owner);
  f.data.contacts[sender.address].messages.push({
    type: 'evm_transfer', payment: ownClaim, message: '', txid: payment.txid,
    my: true, timestamp: NOW - 60_000, sent_timestamp: NOW - 60_000, status: 'sent',
  });
  // The peer's control has a real valid signature and encryption, but does not own the card.
  const edit = await transaction({ type: 'edit', txid: payment.txid, text: 'Unauthorized change' }, NOW);
  await f.sync([edit.tx]);
  assert.equal(f.data.contacts[sender.address].messages[0].payment.note, claim.note);
  assert.equal(f.data.contacts[sender.address].messages[0].edited, undefined);
  assert.equal(f.context.myAccount.chatTimestamp, NOW, stringify(f.warnings));
  assert.deepEqual(f.warnings, []);
});
