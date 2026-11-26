import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const client = process.env.WEB_CLIENT_ROOT;
assert.ok(client, 'Set WEB_CLIENT_ROOT to the client checkout to test.');
const root = pathToFileURL(resolve(client) + '/');
const source = await readFile(new URL('app.js', root), 'utf8');
const lib = await import(new URL('lib.js', root));
const crypto = await import(new URL('crypto.js', root));
const { parse, stringify } = await import(new URL('external/stringify-shardus.js', root));

// Exercise the real receive flow without starting unrelated screens or background polls.
const declarations = [
  'class ChatsScreen', 'class ChatModal', 'async function getChats', 'async function processChats',
  'async function queryNetwork', 'async function getUsernameAddress',
  'async function ensureContactKeys', 'async function getVerifiedChatContactKeys',
  'async function signObj', 'function getTxid', 'function insertSorted', 'function cleanSenderInfo',
].map(declaration => {
  const match = source.match(new RegExp('^' + declaration + '\\b[^]*?^}', 'm'));
  assert.ok(match, 'Missing client declaration: ' + declaration);
  return match[0];
}).join('\n');

function account(username, index) {
  const secret = index.toString(16).padStart(64, '0');
  const key = crypto.getPublicKey(lib.hex2bin(secret));
  const pqSeed = index.toString(16).padStart(128, '0');
  return {
    username, secret, address: lib.bin2hex(crypto.generateAddress(key)), public: lib.bin2hex(key),
    pqSeed, pqPublic: lib.bin2base64(crypto.generatePQKeys(pqSeed).publicKey),
  };
}
const recipient = account('recipient', 1);
const alice = account('alice', 2);
const bob = account('bob', 3);
const chatId = sender => lib.getExpectedChatId(recipient.address, sender.address, crypto.hashBytes);
const aliasPath = sender => '/address/' + crypto.hashBytes(lib.utf82bin(sender.username));
const keyPath = sender => '/account/' + lib.longAddress(sender.address);
const historyPath = (sender, since = 51) => '/messages/' + chatId(sender) + '/' + since;

function setup() {
  const messages = [];
  const requests = [];
  const logs = [];
  const calls = [];
  const sounds = [];
  const contacts = {};
  for (const sender of [alice, bob]) {
    contacts[sender.address] = {
      address: sender.address, username: sender.username, public: sender.public,
      pqPublic: sender.pqPublic, messages: [], unread: 0, tollRequiredToSend: 0,
    };
  }
  const myAccount = { keys: recipient, username: recipient.username, chatTimestamp: 50 };
  const responses = new Map();
  let now = 10000;
  async function fetch(url) {
    const path = new URL(url).pathname;
    requests.push(path);
    const queued = responses.get(path);
    if (queued?.length) return queued.shift()();
    const respond = body => new Response(stringify(body));
    if (path.startsWith(keyPath(recipient) + '/chats/')) {
      const since = Number(path.split('/').at(-1));
      const chats = Object.fromEntries(messages.filter(tx => tx.timestamp > since)
        .map(tx => [lib.normalizeAddress(tx.from === lib.longAddress(recipient.address) ? tx.to : tx.from), tx.chatId]));
      return respond({ chats });
    }
    for (const sender of [alice, bob]) {
      if (path === keyPath(sender)) return respond({ account: { publicKey: sender.public, pqPublicKey: sender.pqPublic } });
      if (path === aliasPath(sender)) return respond({ address: sender.address });
      if (path.startsWith('/messages/' + chatId(sender) + '/')) {
        const since = Number(path.split('/').at(-1));
        return respond({ messages: messages.filter(tx => tx.chatId === chatId(sender) && tx.timestamp >= since) });
      }
    }
    throw Error('Unexpected test gateway path ' + path);
  }
  const sandbox = vm.createContext({
    ...lib, ...crypto, parse, stringify, myAccount, myData: { account: myAccount, contacts, chats: [] },
    URL, fetch, isOnline: true, network: { name: 'Testnet', netid: 'test-network' },
    getGatewayForRequest: () => ({ web: 'https://test.invalid' }),
    getCorrectedTimestamp: () => now, longPollResult: { timestamp: Number.MAX_SAFE_INTEGER },
    logsModal: { log: (...args) => logs.push(args.join(' ')) },
    console: { log() {}, warn() {}, error() {} },
    chatModal: { isActive: () => false, isCallExpired: () => false, isFutureCall: () => true, appendChatModal() {} },
    getNetworkParams: async () => {}, getTransactionFeeWei: () => 1n, getTransactionTimestamp: () => now,
    injectTx: async tx => { messages.push(tx); return { result: { success: true } }; },
    reactNativeApp: { isReactNativeWebView: true, sendScheduledCall: (...args) => calls.push(args) },
    EDIT_WINDOW_MS: 15 * 60_000, isDeleted: record => Boolean(record.deleted),
    syncChatLatestActivityTimestamp() {}, shouldRefreshUpcomingCallsUiForCallTime: () => false,
    document: { visibilityState: 'visible' }, MediaCacheOwnership: { getOwnerKey: () => '' },
    isFaucetAddress: () => false, getLatestChatReactionActivity: () => null, playChatSound: () => sounds.push('message'),
    EVM_CHAT_MESSAGE_TYPE: 'evm_transfer', INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
  });
  vm.runInContext(declarations + `
    Object.setPrototypeOf(chatModal, ChatModal.prototype);
    const chatsScreen = new ChatsScreen();
    chatsScreen.isActive = () => true;
    chatsScreen.updateChatList = () => {};
  `, sandbox);

  async function add(sender, timestamp, text = sender.username + ' hello') {
    const { dhkey, cipherText } = crypto.dhkeyCombined(sender.secret, recipient.public, recipient.pqPublic);
    const tx = {
      type: 'message', from: lib.longAddress(sender.address), to: lib.longAddress(recipient.address),
      chatId: chatId(sender), networkId: 'test-network', timestamp, amount: 0n, fee: 1n,
      xmessage: {
        encrypted: true, encryptionMethod: 'xchacha20poly1305', sent_timestamp: timestamp,
        message: crypto.encryptChacha(dhkey, text),
        senderInfo: crypto.encryptChacha(dhkey, stringify({ username: sender.username })),
        pqEncSharedKey: lib.bin2base64(cipherText),
      },
    };
    await sandbox.signObj(tx, sender);
    messages.push(tx);
    return tx;
  }
  return {
    add, myAccount, contacts, logs, calls, sounds, txid: sandbox.getTxid, chatModal: sandbox.chatModal,
    sync: () => { now += 2000; return sandbox.getChats(recipient); },
    fail(path, times) {
      responses.set(path, Array.from({ length: times }, () => () => { throw new TypeError('Gateway unavailable'); }));
    },
    reply(path, body, status = 200) {
      responses.set(path, [() => new Response(stringify(body), { status })]);
    },
    count: path => requests.filter(value => value === path).length,
  };
}

function assertDelivered(sync, sender, timestamp) {
  const contact = sync.contacts[sender.address];
  assert.equal(contact.messages.length, 1);
  assert.equal(contact.messages[0].message, sender.username + ' hello');
  assert.equal(contact.unread, 1);
  assert.equal(sync.myAccount.chatTimestamp, timestamp);
}

for (const operation of ['history', 'signing key', 'username']) {
  test(operation + ' lookup recovers during the same sync and delivers once', async () => {
    const sync = setup();
    await sync.add(alice, 100);
    let path = historyPath(alice);
    if (operation === 'signing key') {
      delete sync.contacts[alice.address].public;
      path = keyPath(alice);
    }
    if (operation === 'username') {
      delete sync.contacts[alice.address].username;
      path = aliasPath(alice);
    }
    if (operation === 'history') sync.reply(path, { error: 'Service unavailable' }, 503);
    else if (operation === 'signing key') sync.reply(path, { account: null });
    else sync.fail(path, 1);
    await sync.sync();
    assert.equal(sync.count(path), 2);
    assertDelivered(sync, alice, 100);
    assert.match(sync.logs.join('\n'), /retr/i);
    await sync.sync();
    assertDelivered(sync, alice, 100);
  });
}

test('two failed key lookups leave the newer chat available and advance to it', async () => {
  const sync = setup();
  await sync.add(alice, 100);
  await sync.add(bob, 200);
  delete sync.contacts[alice.address].public;
  sync.fail(keyPath(alice), 2);
  await sync.sync();
  assert.equal(sync.count(keyPath(alice)), 2);
  assert.equal(sync.contacts[alice.address].messages.length, 0);
  assertDelivered(sync, bob, 200);
  await sync.sync();
  assert.equal(sync.count(keyPath(alice)), 2);
});

test('unresolved username keeps the cursor and repeated failed polls share one log group', async () => {
  const sync = setup();
  await sync.add(alice, 100);
  delete sync.contacts[alice.address].username;
  sync.fail(aliasPath(alice), 4);
  await sync.sync();
  assert.equal(sync.count(aliasPath(alice)), 2);
  assert.equal(sync.myAccount.chatTimestamp, 50);
  assert.equal(sync.contacts[alice.address].unread, 0);
  const count = sync.logs.length;
  assert.ok(count > 0);
  await sync.sync();
  assert.equal(sync.count(aliasPath(alice)), 4);
  assert.equal(sync.logs.length, count);
  await sync.sync();
  assertDelivered(sync, alice, 100);
});

test('a confirmed username mismatch is rejected without retrying it', async () => {
  const sync = setup();
  await sync.add(alice, 200);
  await sync.add(bob, 100);
  delete sync.contacts[alice.address].username;
  sync.reply(aliasPath(alice), { address: bob.address });
  await sync.sync();
  assert.equal(sync.count(aliasPath(alice)), 1);
  assert.equal(sync.contacts[alice.address].messages.length, 0);
  assertDelivered(sync, bob, 100);
  assert.ok(sync.logs.length > 0);
});

test('a failed signature check is logged and does not delay the other chat', async () => {
  const sync = setup();
  const first = await sync.add(alice, 200);
  const second = await sync.add(bob, 100);
  first.sign.sig = second.sign.sig;
  await sync.sync();
  assert.equal(sync.count(historyPath(alice)), 1);
  assert.equal(sync.count(keyPath(alice)), 0);
  assert.equal(sync.contacts[alice.address].messages.length, 0);
  assertDelivered(sync, bob, 100);
  assert.match(sync.logs.join('\n'), /signat/i);
});

const cutoff = Date.parse('2026-11-18T17:31:19Z');

test('replaying a saved chat recovers a message at the cutoff and leaves previous edits read', async () => {
  const sync = setup();
  const original = await sync.add(alice, cutoff + 1);
  const txid = sync.txid(original);
  await sync.add(alice, cutoff + 2, JSON.stringify({ type: 'edit', txid, text: 'first edit' }));
  await sync.add(alice, cutoff + 3, JSON.stringify({ type: 'edit', txid, text: 'final edit' }));
  await sync.sync();
  const contact = sync.contacts[alice.address];
  assert.equal(contact.messages.length, 1);
  assert.equal(contact.messages[0].message, 'final edit');
  contact.unread = 0; // The user read the prior conversation before recovery.
  const priorSounds = sync.sounds.length;

  await sync.add(alice, cutoff, 'previously missed');
  sync.myAccount.chatTimestamp = cutoff - 1;
  await sync.sync();
  assert.equal(sync.count(historyPath(alice, cutoff)), 1);
  assert.equal(sync.myAccount.chatTimestamp, cutoff + 3);
  assert.deepEqual(contact.messages.map(m => m.message), ['final edit', 'previously missed']);
  assert.equal(contact.unread, 1);
  assert.equal(sync.sounds.length, priorSounds + 1);
});

test('replaying a scheduled call keeps its original notification and chat entry', async () => {
  const sync = setup();
  await sync.add(alice, cutoff + 10, JSON.stringify({
    type: 'call', url: 'https://meeting.invalid/disposable', callTime: cutoff + 60_000,
  }));
  await sync.sync();
  const contact = sync.contacts[alice.address];
  assert.equal(contact.messages.length, 1);
  assert.equal(contact.messages[0].type, 'call');
  assert.equal(sync.calls.length, 1);
  contact.unread = 0;

  sync.myAccount.chatTimestamp = cutoff - 1;
  await sync.sync();
  assert.equal(sync.myAccount.chatTimestamp, cutoff + 10);
  assert.equal(contact.messages.length, 1);
  assert.equal(contact.unread, 0);
  assert.equal(sync.calls.length, 1);
  assert.equal(sync.sounds.length, 1);
});

test('a new outgoing call schedules one reminder on confirmation, including after a rewind', async () => {
  const sync = setup();
  const contact = sync.contacts[alice.address];
  sync.chatModal.address = alice.address;
  const sent = await sync.chatModal.sendCallMessage('https://meeting.invalid/outgoing', cutoff + 60_000);
  assert.equal(sent, true);
  assert.equal(contact.messages.length, 1, 'the composer inserted its optimistic call');
  assert.equal(sync.calls.length, 0);
  sync.chatModal.address = null;

  await sync.sync();
  assert.equal(sync.calls.length, 1);
  sync.myAccount.chatTimestamp = 50;
  await sync.sync();
  assert.equal(sync.calls.length, 1, 're-reading the confirmed call must stay quiet');
  assert.equal(contact.messages.length, 1);
  assert.equal(contact.unread, 0);
});

test('equal-time edits converge and preserve a legacy edit on replay', async () => {
  const sync = setup();
  const original = await sync.add(alice, cutoff + 1);
  const txid = sync.txid(original);
  const edits = [];
  for (const text of ['first contender', 'second contender']) {
    const edit = await sync.add(alice, cutoff + 2, JSON.stringify({ type: 'edit', txid, text }));
    edits.push({ txid: sync.txid(edit), text });
  }
  await sync.sync();
  const contact = sync.contacts[alice.address];
  const winningEdit = edits[0].txid > edits[1].txid ? edits[0] : edits[1];
  assert.equal(contact.messages[0].message, winningEdit.text);
  contact.unread = 0;
  sync.myAccount.chatTimestamp = cutoff - 1;
  await sync.sync();
  assert.equal(contact.messages[0].message, winningEdit.text);
  assert.equal(contact.unread, 0);

  // Legacy backups retained the edit timestamp and text but no edit transaction ID.
  delete contact.messages[0].editTxid;
  contact.messages[0].message = 'stored legacy edit';
  sync.myAccount.chatTimestamp = cutoff - 1;
  await sync.sync();
  assert.equal(contact.messages[0].message, 'stored legacy edit');
  assert.equal(contact.unread, 0);
});
