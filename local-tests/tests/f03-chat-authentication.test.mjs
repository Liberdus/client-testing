import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  bin2hex, bin2base64, hex2bin, longAddress, normalizeAddress, getExpectedChatId,
  getUnsignedTransactionId, isPublicKeyForAddress, validateChatTransaction,
} from '../lib.js';
import {
  decryptMessage, dhkeyCombined, encryptChacha, ethHashMessage, generateAddress, generatePQKeys, getPublicKey, hashBytes,
  signMessage, verifyMessage,
} from '../crypto.js';
import { parse, stringify } from '../external/stringify-shardus.js';

globalThis.crypto ??= webcrypto;
const crypto = { ethHashMessage, generateAddress, hashBytes, stringify, verifyMessage };
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = appSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1);
  return appSource.slice(start, appSource.indexOf('\n/**', start));
}

function accountKeys(value) {
  const secret = value.toString(16).padStart(64, '0');
  const publicKey = bin2hex(getPublicKey(hex2bin(secret)));
  return {
    secret, public: publicKey, address: bin2hex(generateAddress(hex2bin(publicKey))),
    pqSeed: value.toString(16).padStart(128, '0'),
  };
}

const me = accountKeys(1);
const alice = accountKeys(2);
const bob = accountKeys(3);

async function signTransaction(transaction, sender) {
  const txid = getUnsignedTransactionId(transaction, crypto);
  const signature = await signMessage(hex2bin(ethHashMessage(txid)), hex2bin(sender.secret));
  const r = signature.r.toString(16).padStart(64, '0');
  const s = signature.s.toString(16).padStart(64, '0');
  const recovery = (27 + signature.recovery).toString(16).padStart(2, '0');
  return { ...transaction, sign: { owner: longAddress(sender.address), sig: `0x${r}${s}${recovery}` } };
}

async function transfer(sender, recipient, timestamp) {
  return signTransaction({
    type: 'transfer', from: longAddress(sender.address), to: longAddress(recipient.address),
    chatId: getExpectedChatId(sender.address, recipient.address, hashBytes),
    networkId: 'test-network', timestamp, amount: 1n, fee: 1n,
  }, sender);
}

function createChatSync(transactions) {
  const requests = [];
  const effects = [];
  const warnings = [];
  const accountInfo = new Map([alice, bob].map(keys => [keys.address, { account: { publicKey: keys.public } }]));
  const contacts = Object.fromEntries([alice, bob].map(keys => [keys.address, {
    address: keys.address, public: keys.public, messages: [], unread: 0,
  }]));
  const myData = { contacts, wallet: { history: [] }, chats: [] };
  const myAccount = { chatTimestamp: 50 };
  const classList = { add: name => effects.push(name) };
  const sandbox = {
    myData, myAccount, network: { netid: 'test-network' },
    console: { warn: message => warnings.push(message), log() {}, error() {} },
    bin2hex, hex2bin, longAddress, normalizeAddress, getExpectedChatId, isPublicKeyForAddress,
    validateChatTransaction, generateAddress, getPublicKey, hashBytes, ethHashMessage,
    stringify, parse, verifyMessage, decryptMessage,
    queryNetwork: async url => {
      requests.push(url);
      const [, endpoint, addressOrChatId, timestamp] = url.split('/');
      if (endpoint === 'account') return accountInfo.get(normalizeAddress(addressOrChatId)) ?? null;
      assert.equal(endpoint, 'messages');
      return { messages: parse(stringify(transactions.filter(tx =>
        tx.chatId === addressOrChatId && tx.timestamp >= Number(timestamp)
      ))) };
    },
    chatModal: { address: null, isActive: () => false },
    EVM_CHAT_MESSAGE_TYPE: 'evm_transfer', INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
    document: { visibilityState: 'visible' },
    playChatSound: () => effects.push('chat-sound'),
    chatsScreen: { isActive: () => false },
    footer: { chatButton: { classList }, walletButton: { classList } },
    walletScreen: { isActive: () => false, openHistoryModalButton: { classList } },
    historyModal: { isActive: () => false },
    isFaucetAddress: () => false,
    playTransferSound: () => effects.push('transfer-sound'),
    getLatestChatReactionActivity: () => null,
    insertSorted: (items, item, field) => {
      items.push(item);
      items.sort((left, right) => right[field] - left[field]);
    },
    createNewContact: address => { contacts[address] = { address, messages: [], unread: 0 }; },
  };
  vm.createContext(sandbox);
  const keySource = appSource.slice(appSource.indexOf('async function ensureContactKeys('),
    appSource.indexOf('\n/**', appSource.indexOf('async function getVerifiedChatContactKeys(')));
  vm.runInContext(`${keySource}\n${extractFunction('processChats')}`, sandbox);
  return {
    myData, myAccount, accountInfo, requests, effects, warnings,
    sync: participants => sandbox.processChats(Object.fromEntries(participants.map(keys => [
      keys.address, getExpectedChatId(me.address, keys.address, hashBytes),
    ])), me),
  };
}

test('uses cached signing keys without PQ keys or account requests', async () => {
  const sync = createChatSync([await transfer(alice, me, 100), await transfer(bob, me, 200)]);
  sync.accountInfo.clear();
  await sync.sync([alice, bob]);
  assert.equal(sync.myData.wallet.history.length, 2);
  assert.equal(sync.myAccount.chatTimestamp, 200);
  assert.equal(sync.requests.some(url => url.startsWith('/account/')), false);
});

for (const participants of [[alice, bob], [bob, alice]]) {
  test(`retries a first-contact lookup without applying partial state (${participants[0].address.slice(0, 8)} first)`, async () => {
    const sync = createChatSync([await transfer(alice, me, 100), await transfer(bob, me, 200)]);
    delete sync.myData.contacts[alice.address];
    sync.accountInfo.delete(alice.address);
    const initialData = stringify(sync.myData);

    await sync.sync(participants);
    await sync.sync(participants);
    assert.equal(stringify(sync.myData), initialData);
    assert.equal(sync.myAccount.chatTimestamp, 50);
    assert.deepEqual(sync.effects, []);
    assert.ok(sync.warnings.some(message => message.includes('Deferring chat sync')));

    sync.accountInfo.set(alice.address, { account: { publicKey: alice.public } });
    await sync.sync(participants);
    assert.equal(sync.myData.wallet.history.length, 2);
    assert.equal(sync.myData.contacts[alice.address].messages.length, 1);
    assert.equal(sync.myData.contacts[bob.address].messages.length, 1);
    assert.equal(sync.myData.contacts[alice.address].unread, 1);
    assert.equal(sync.myData.contacts[bob.address].unread, 1);
    assert.equal(sync.myAccount.chatTimestamp, 200);

    await sync.sync(participants);
    assert.equal(sync.myData.wallet.history.length, 2);
    assert.equal(sync.myData.contacts[bob.address].unread, 1);
  });
}

test('malformed signatures are rejected without deferring for a missing key', async () => {
  const invalid = await transfer(alice, me, 100);
  invalid.sign.sig = 'invalid';
  const sync = createChatSync([invalid, await transfer(bob, me, 200)]);
  delete sync.myData.contacts[alice.address];
  sync.accountInfo.delete(alice.address);
  await sync.sync([alice, bob]);
  assert.equal(sync.myData.wallet.history.length, 1);
  assert.equal(sync.myAccount.chatTimestamp, 200);
  assert.equal(sync.myData.contacts[alice.address], undefined);
  assert.ok(sync.warnings.some(message => message.includes('invalid_signature_format')));
});

test('tampered signed transactions are rejected while valid chats proceed', async () => {
  const invalid = await transfer(alice, me, 100);
  invalid.amount = 2n;
  const sync = createChatSync([invalid, await transfer(bob, me, 200)]);
  await sync.sync([alice, bob]);
  assert.equal(sync.myData.wallet.history.length, 1);
  assert.equal(sync.myData.contacts[alice.address].messages.length, 0);
  assert.ok(sync.warnings.some(message => message.includes('invalid_signature')));
});

test('verifies outgoing records with our own key when the contact key is unavailable', async () => {
  const sync = createChatSync([await transfer(me, alice, 100)]);
  delete sync.myData.contacts[alice.address].public;
  sync.accountInfo.delete(alice.address);
  await sync.sync([alice]);
  assert.equal(sync.myData.wallet.history.length, 1);
  assert.equal(sync.myData.wallet.history[0].sign, -1);
  assert.equal(sync.myAccount.chatTimestamp, 100);
});

test('distinguishes an unavailable key from a mismatched key and rejects invalid records first', async () => {
  const transaction = await transfer(alice, me, 100);
  const context = {
    currentAddress: me.address, contactAddress: alice.address,
    expectedChatId: transaction.chatId, networkId: transaction.networkId,
    publicKey: null,
  };
  assert.equal(validateChatTransaction(transaction, context, crypto).reason, 'public_key_unavailable');
  assert.equal(validateChatTransaction(transaction, { ...context, publicKey: bob.public }, crypto).reason, 'public_key_mismatch');
  assert.equal(validateChatTransaction(transaction, { ...context, publicKey: alice.public }, crypto).ok, true);
  assert.equal(validateChatTransaction({ ...transaction, sign: undefined }, context, crypto).reason, 'missing_signature');
  assert.equal(validateChatTransaction({ ...transaction, networkId: 'other' }, context, crypto).reason, 'network_mismatch');
});

async function encryptedMessage() {
  const { publicKey } = generatePQKeys(me.pqSeed);
  const { dhkey, cipherText } = dhkeyCombined(alice.secret, me.public, publicKey);
  return signTransaction({
    type: 'message', from: longAddress(alice.address), to: longAddress(me.address),
    chatId: getExpectedChatId(alice.address, me.address, hashBytes),
    networkId: 'test-network', timestamp: 100, amount: 1n, fee: 1n,
    xmessage: {
      encrypted: true, encryptionMethod: 'xchacha20poly1305',
      message: encryptChacha(dhkey, 'hello'), pqEncSharedKey: bin2base64(cipherText),
      sent_timestamp: 100,
    },
  }, alice);
}

test('decrypts a real encrypted incoming message using the cached signing key', async () => {
  const sync = createChatSync([await encryptedMessage()]);
  await sync.sync([alice]);
  assert.equal(sync.myData.contacts[alice.address].messages[0].message, 'hello');
});

for (const prefix of ['0x', '0X']) {
  test(`normalizes cached ${prefix}-prefixed keys before decrypting messages`, async () => {
    const sync = createChatSync([await encryptedMessage()]);
    const contact = sync.myData.contacts[alice.address];
    contact.public = prefix + alice.public;
    contact.pqPublic = bin2base64(generatePQKeys(alice.pqSeed).publicKey);
    sync.accountInfo.clear();
    await sync.sync([alice]);
    assert.equal(contact.public, alice.public);
    assert.equal(contact.messages[0].message, 'hello');
    assert.equal(sync.requests.some(url => url.startsWith('/account/')), false);
  });

  test(`normalizes fetched ${prefix}-prefixed keys before decrypting first-contact messages`, async () => {
    const sync = createChatSync([await encryptedMessage()]);
    delete sync.myData.contacts[alice.address];
    sync.accountInfo.set(alice.address, { account: {
      publicKey: prefix + alice.public,
      pqPublicKey: bin2base64(generatePQKeys(alice.pqSeed).publicKey),
    } });
    await sync.sync([alice]);
    const contact = sync.myData.contacts[alice.address];
    assert.equal(contact.public, alice.public);
    assert.equal(contact.messages[0].message, 'hello');
    assert.equal(sync.myAccount.chatTimestamp, 100);
  });
}
