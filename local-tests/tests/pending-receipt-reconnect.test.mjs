import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';

const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to an absolute web-client-v2 checkout path');
const app = readFileSync(join(clientRoot, 'app.js'), 'utf8');

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Cannot find ${start} through ${end} in app.js`);
  return app.slice(from, to);
}

const appSource = [
  sourceBetween('async function queryNetwork(', 'async function getChats('),
  sourceBetween('async function handleConnectivityChange()', '// Setup connectivity detection'),
  sourceBetween('function isValidRequiredValue(', '/**\n * Returns the newest valid reaction activity'),
  sourceBetween('function removePendingTransaction(', 'async function checkPendingTransaction('),
  sourceBetween('let checkPendingTransactionsPromise = null;', '/*\n * Used to prevent tab from working.'),
  sourceBetween('class CreateAccountModal {', '// Initialize the create account modal'),
].join('\n');

const username = 'offlineuser';
const address = 'b'.repeat(40);
const contactAddress = 'a'.repeat(40);
const registrationTx = { txid: 'registration', type: 'register', username, address: address.padEnd(64, '0') };
const contactTx = { txid: 'contact-update', type: 'update_toll_required', to: contactAddress };
const contactHistory = { type: contactTx.type, txid: contactTx.txid };
const contactChatId = 'c'.repeat(64);
const signedContactUpdate = {
  from: registrationTx.address,
  to: contactAddress.padEnd(64, '0'),
  chatId: contactChatId,
  type: contactTx.type,
  required: 0,
  previousRequired: 1,
  timestamp: 100_000,
};
const contactTollPath = `/messages/${contactChatId}/toll`;
const aliasPath = '/address/synthetic-alias-hash';
const transportError = () => { throw new TypeError('Synthetic receipt connection failure'); };

function createFixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const storage = new Map();
  const toasts = new Map();
  const requests = [];
  const signedIn = [];
  const contactSettlements = [];
  const submittedAccounts = [];
  const contact = { friend: 2, friendOld: 1, messages: [{ ...contactHistory }] };
  let respond = transportError;
  let stateWrites = 0;

  const context = createContext({
    assert,
    AbortController,
    AbortSignal,
    Date,
    URL,
    console: { log() {}, warn() {}, error() {} },
    network: { name: 'Testnet', netid: 'synthetic' },
    isOnline: true,
    myAccount: null,
    myData: null,
    navigator: { onLine: true },
    document: { visibilityState: 'visible' },
    useLongPolling: false,
    checkPendingTransactionsIntervalId: null,
    getSystemNoticeIntervalId: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    parse: JSON.parse,
    stringify: JSON.stringify,
    isDaoTransactionType: () => false,
    DAO_ACTION_TYPES: { VOTE: 'dao-vote' },
    getCorrectedTimestamp: () => Date.now(),
    getGatewayForRequest: () => ({ web: 'https://receipt.invalid' }),
    async fetch(url) {
      const { pathname, search } = new URL(url);
      const endpoint = pathname + search;
      requests.push(endpoint);
      const result = respond(endpoint);
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    },
    getNetworkParams: async () => true,
    updateUIForConnectivity() {},
    stopLongPoll() {},
    refreshActiveBalanceDisplays: async () => {},
    refreshNetworkParamsOnTxFeeMismatch: async () => null,
    getUserFacingTxFailureReason: (reason) => reason,
    checkEvmPayments: async () => {},
    syncChatLatestActivityTimestamp() {},
    chatModal: { resetPendingMessageConfirmations() {}, isActive: () => false, refreshCurrentView() {} },
    contactInfoModal: { isActive: () => false },
    friendModal: { handlePendingStatusSettled: (who) => contactSettlements.push(who) },
    chatsScreen: { updateChatData: async () => 0, updateChatList: async () => {} },
    contactsScreen: { updateContactsList: async () => {} },
    walletScreen: { updateWalletView: async () => {}, updateWalletBalances: async () => {} },
    migrateAccountsModal: { isOpening: false, isMigrating: false, isActive: () => false },
    signInModal: { open: (who) => signedIn.push(who) },
    welcomeScreen: { close() {} },
    normalizeUsername: (value) => value.toLowerCase(),
    normalizeAddress: (value) => value,
    longAddress: (value) => value.padEnd(64, '0'),
    hashBytes: () => 'synthetic-alias-hash',
    utf82bin: (value) => Buffer.from(value),
    generateRandomPrivateKey: () => new Uint8Array([1]),
    generateRandomBytes: () => new Uint8Array([2]),
    getPublicKey: () => new Uint8Array([3]),
    generateAddress: () => Buffer.from(address, 'hex'),
    bin2hex: (value) => Buffer.from(value).toString('hex'),
    showToast(message, _duration, kind) {
      toasts.set(message, kind);
      return message;
    },
    hideToast: (id) => toasts.delete(id),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    loadState: (key) => JSON.parse(storage.get(key) ?? 'null'),
    newDataRecord: (account) => ({ account, wallet: { timestamp: 1 }, contacts: {}, pending: [] }),
    saveState() {
      stateWrites += 1;
      const { username, netid } = context.myAccount;
      storage.set(`${username}_${netid}`, JSON.stringify(context.myData));
    },
    clearMyData() {
      context.myAccount = null;
      context.myData = null;
    },
    async postRegisterAlias(alias, keys) {
      submittedAccounts.push({ alias, keys: { ...keys } });
      context.myData.pending.push({ ...registrationTx, submittedts: Date.now() });
      return { result: { success: true }, txid: registrationTx.txid };
    },
  });

  // Read the full production polling and registration paths, with mock DOM controls and HTTP.
  runInContext(`${appSource}\nglobalThis.modal = Object.create(CreateAccountModal.prototype);`, context);
  const { modal } = context;
  const control = (fields = {}) => ({ disabled: false, hasAttribute: () => false, ...fields });
  Object.assign(modal, {
    usernameInput: control({ value: username }),
    privateKeyInput: control({ value: '' }),
    privateKeyError: { style: {} },
    privateAccountCheckbox: control({ checked: false }),
    submitButton: control(),
    backButton: control(),
    migrateAccountsButton: control(),
    advancedSummary: { setAttribute() {} },
    advancedSection: { classList: { toggle() {} } },
    usernameAvailable: { style: {} },
    isUsernameAvailable: true,
    close() {},
  });
  modal.controls = [modal.submitButton, modal.backButton, modal.usernameInput, modal.privateKeyInput];

  return {
    context, contact, storage, toasts, requests, signedIn, contactSettlements, submittedAccounts, modal,
    get stateWrites() { return stateWrites; },
    respondWith(handler) { respond = handler; },
    async advance(milliseconds) {
      await setImmediate();
      for (let remaining = milliseconds; remaining > 0; remaining -= 1000) {
        t.mock.timers.tick(Math.min(remaining, 1000));
        await setImmediate();
      }
    },
    poll() { return context.checkPendingTransactions(); },
    async reconnect() {
      context.isOnline = false;
      context.navigator.onLine = false;
      await context.handleConnectivityChange();
      context.isOnline = true;
      context.navigator.onLine = true;
      await context.handleConnectivityChange();
      await setImmediate();
    },
    submitRegistration() { return modal.handleSubmit({ preventDefault() {} }); },
    seedContactUpdate(updateTollRequiredTx) {
      context.myAccount = { username, netid: 'synthetic', keys: { address } };
      context.myData = {
        account: context.myAccount,
        contacts: { [contactAddress]: contact },
        pending: [{ ...contactTx, submittedts: Date.now(), updateTollRequiredTx }],
      };
    },
  };
}

test('an unavailable receipt keeps the contact update and reconnect reconciles a successful receipt', async (t) => {
  const fixture = createFixture(t);
  fixture.seedContactUpdate();
  await fixture.advance(10_000);
  await fixture.poll();
  assert.ok(fixture.requests.includes(`/transaction/${contactTx.txid}`));

  await fixture.advance(25_000);
  await fixture.poll();
  assert.ok(fixture.requests.includes(`/collector/api/transaction?appReceiptId=${contactTx.txid}`));
  assert.equal(fixture.context.myData.pending.length, 1);
  assert.equal(fixture.contact.friend, 2);
  assert.equal(fixture.contact.friendOld, 1);
  assert.deepEqual(fixture.contact.messages, [contactHistory]);
  assert.deepEqual(fixture.contactSettlements, []);
  assert.equal(fixture.stateWrites, 0);
  assert.equal([...fixture.toasts.values()].includes('error'), false);

  fixture.respondWith(() => ({ transaction: { success: true } }));
  await fixture.reconnect();
  await fixture.poll();
  assert.equal(fixture.context.myData.pending.length, 0);
  assert.equal(fixture.contact.friend, 2);
  assert.equal(fixture.contact.friendOld, 2);
  assert.deepEqual(fixture.contactSettlements, [contactAddress]);
  assert.equal(fixture.stateWrites, 1);
});

test('a collector absence and an unavailable node preserve the contact update until both report absence', async (t) => {
  const fixture = createFixture(t);
  fixture.seedContactUpdate();
  await fixture.advance(35_000);
  fixture.respondWith((endpoint) => endpoint.startsWith('/collector/') ? { transaction: {} } : transportError());
  await fixture.poll();
  assert.equal(fixture.context.myData.pending.length, 1);
  assert.equal(fixture.contact.friend, 2);
  assert.deepEqual(fixture.contact.messages, [contactHistory]);

  fixture.respondWith(() => ({ transaction: null }));
  await fixture.poll();

  assert.equal(fixture.context.myData.pending.length, 0);
  assert.equal(fixture.contact.friend, 1);
  assert.equal(fixture.contact.messages.length, 0);
  assert.deepEqual(fixture.contactSettlements, [contactAddress]);
  assert.match([...fixture.toasts.keys()].join('\n'), /contact status timed out/i);
});

test('a matching on-chain toll setting settles a contact update whose receipts are absent', async (t) => {
  const fixture = createFixture(t);
  fixture.seedContactUpdate(signedContactUpdate);
  await fixture.advance(35_000);
  // The sender sorts second, and only the sender's setting matches the requested change.
  fixture.respondWith((endpoint) => endpoint === contactTollPath ? { toll: { required: [1, 0] } } : { transaction: null });
  await fixture.poll();

  assert.ok(fixture.requests.includes(contactTollPath));
  assert.equal(fixture.context.myData.pending.length, 0);
  assert.equal(fixture.contact.friend, 2);
  assert.equal(fixture.contact.friendOld, 2);
  assert.deepEqual(fixture.contact.messages, [contactHistory]);
  assert.deepEqual(fixture.contactSettlements, [contactAddress]);
  assert.equal(fixture.stateWrites, 1);
  assert.equal([...fixture.toasts.values()].includes('error'), false);
});

test('an unavailable toll setting retains the contact update until a confirmed mismatch permits rollback', async (t) => {
  const fixture = createFixture(t);
  fixture.seedContactUpdate(signedContactUpdate);
  await fixture.advance(35_000);
  fixture.respondWith((endpoint) => endpoint === contactTollPath ? transportError() : { transaction: null });
  await fixture.poll();

  assert.ok(fixture.requests.includes(contactTollPath));
  assert.equal(fixture.context.myData.pending.length, 1);
  assert.equal(fixture.contact.friend, 2);
  assert.deepEqual(fixture.contact.messages, [contactHistory]);
  assert.deepEqual(fixture.contactSettlements, []);
  assert.equal(fixture.stateWrites, 0);
  assert.equal([...fixture.toasts.values()].includes('error'), false);

  // Only the other party's requirement matches. The sender's toll is still required.
  fixture.respondWith((endpoint) => endpoint === contactTollPath ? { toll: { required: [0, 1] } } : { transaction: null });
  await fixture.poll();

  assert.equal(fixture.context.myData.pending.length, 1, 'one stale network read must leave the update pending');
  assert.equal(fixture.contact.friend, 2);

  await fixture.advance(16_000);
  fixture.respondWith((endpoint) => endpoint === contactTollPath ? transportError() : { transaction: null });
  await fixture.poll();
  assert.equal(fixture.context.myData.pending.length, 1, 'an unavailable lookup cannot roll back an update after the grace window');

  fixture.respondWith((endpoint) => endpoint === contactTollPath ? { toll: { required: [0, 1] } } : { transaction: null });
  await fixture.poll();

  assert.equal(fixture.context.myData.pending.length, 0);
  assert.equal(fixture.contact.friend, 1);
  assert.equal(fixture.contact.messages.length, 0);
  assert.deepEqual(fixture.contactSettlements, [contactAddress]);
  assert.match([...fixture.toasts.keys()].join('\n'), /contact status timed out/i);
});

test('registration with a rejected receipt releases the form without signing in', async (t) => {
  const fixture = createFixture(t);
  fixture.respondWith(() => ({ transaction: { success: false, reason: 'Username taken' } }));
  let finished = false;
  const submission = fixture.submitRegistration().then(() => { finished = true; });
  await fixture.advance(40_000);

  assert.equal(finished, true);
  await submission;
  assert.equal(fixture.modal.isCreatingAccount, false);
  assert.equal(fixture.modal.backButton.disabled, false);
  assert.equal(fixture.storage.has('pendingRegistration_synthetic'), false);
  assert.equal(fixture.storage.has('accounts'), false);
  assert.deepEqual(fixture.signedIn, []);
  assert.equal([...fixture.toasts.values()].includes('loading'), false);
  assert.match([...fixture.toasts.keys()].join('\n'), /Username taken/);
  assert.equal(fixture.submittedAccounts.length, 1);
});

test('an unavailable registration receipt stays pending and completes against the original identity after reconnect', async (t) => {
  const fixture = createFixture(t);
  let finished = false;
  const submission = fixture.submitRegistration().then(() => { finished = true; });
  await fixture.advance(40_000);

  assert.equal(finished, false);
  assert.equal(fixture.context.myData.pending.length, 1, 'an unavailable provider must leave registration pending for the next poll');
  assert.match([...fixture.toasts.keys()].join('\n'), /still waiting for account confirmation/i);
  const original = fixture.submittedAccounts[0];
  assert.deepEqual(fixture.signedIn, []);

  fixture.respondWith((path) => path === aliasPath ? { address: registrationTx.address } : transportError());
  await fixture.reconnect();
  await fixture.advance(10_000);
  assert.equal(finished, true);
  await submission;
  assert.ok(fixture.requests.includes(aliasPath));
  assert.deepEqual(fixture.signedIn, [username]);
  assert.equal(fixture.submittedAccounts.length, 1);
  assert.equal(JSON.parse(fixture.storage.get('accounts')).netids.synthetic.usernames[username].address, address);
  assert.deepEqual(JSON.parse(fixture.storage.get(`${username}_synthetic`)).account.keys, original.keys);
  assert.equal([...fixture.toasts.values()].includes('loading'), false);
});

test('two absent receipts and a missing alias settle registration failure', async (t) => {
  const fixture = createFixture(t);
  fixture.respondWith((path) => path === aliasPath
    ? { error: 'No account exists for the given handle' }
    : { transaction: null });
  let finished = false;
  const submission = fixture.submitRegistration().then(() => { finished = true; });
  await fixture.advance(40_000);

  assert.equal(finished, true, 'confirmed absence must release the account creation form');
  await submission;
  assert.ok(fixture.requests.includes(aliasPath));
  assert.equal(fixture.modal.isCreatingAccount, false);
  assert.equal(fixture.modal.backButton.disabled, false);
  assert.equal(fixture.storage.has('accounts'), false);
  assert.deepEqual(fixture.signedIn, []);
  assert.equal([...fixture.toasts.values()].includes('loading'), false);
  assert.match([...fixture.toasts.keys()].join('\n'), /account confirmation timed out/i);
  assert.equal(fixture.submittedAccounts.length, 1);
});
