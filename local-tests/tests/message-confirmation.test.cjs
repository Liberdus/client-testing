const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const path = process.argv[2] || require('node:path').resolve(process.cwd(), 'app.js');
const source = fs.readFileSync(path, 'utf8');
const noop = () => {};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fnSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing actual function ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const next = /^(?:(?:async )?function |class |const |let )/m.exec(tail);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
}
function classSource(name, instance) {
  const start = source.indexOf(`class ${name} {`);
  const end = source.indexOf(`const ${instance} = new ${name}();`, start);
  assert.ok(start >= 0 && end > start);
  return `${source.slice(start, end)}\nglobalThis.${name} = ${name};`;
}

function setup(options = {}) {
  const timers = new Map();
  const requests = [];
  const events = { refresh: [], save: [], toast: [], settlement: [], console: [] };
  let now = options.now || 1_000_000;
  let nextTimer = 0;
  let reply = options.reply === undefined ? null : options.reply;
  let fetchImpl = null;
  const pending = { txid: 'tx1', type: 'message', to: 'recipient', submittedts: now - 60_000, checkedts: 0 };
  const message = { txid: 'tx1', message: 'Original content', status: 'sent', my: true, timestamp: now - 60_000 };
  const account = { username: 'sender', netid: 'test' };
  const data = {
    account, pending: [pending], contacts: { recipient: { messages: [message] } },
    chats: [{ address: 'recipient', txid: 'tx1' }], wallet: { history: [], timestamp: 0 },
  };
  const inactive = { isActive: () => false, reset: noop, close: noop, reopen: async () => {}, refresh: noop };
  const ctx = vm.createContext({
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => events.console.push([k, ...args])])),
    AbortController, Event,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval: () => ++nextTimer, clearInterval: noop,
    getCorrectedTimestamp: () => now,
    myData: data, myAccount: account, isOnline: true,
    document: { visibilityState: 'visible' },
    window: { location: { href: 'http://localhost/' }, addEventListener: noop },
    history: { pushState: noop },
    localStorage: { getItem: () => JSON.stringify({ netids: { test: { usernames: { sender: {} } } } }) },
    network: { name: 'Testnet', netid: 'test' }, getGatewayForRequest: () => ({ web: 'https://gateway.test' }),
    parse: JSON.parse, stringify: JSON.stringify,
    fetch: async (url, opts) => {
      requests.push({ url, signal: opts.signal });
      if (fetchImpl) return fetchImpl(url, opts);
      return { text: async () => JSON.stringify(reply) };
    },
    assert: (condition, message) => assert.ok(condition, message),
    showToast: (...args) => events.toast.push(args),
    saveState: () => events.save.push(structuredClone(ctx.myData)),
    EVM_CHAT_MESSAGE_TYPE: 'evm', INTENTS_CHAT_MESSAGE_TYPE: 'intents',
    isDaoTransactionType: () => false,
    settleEvmPaymentMessage: (...args) => events.settlement.push(args),
    refreshNetworkParamsOnTxFeeMismatch: async () => ({ detected: false }),
    getUserFacingTxFailureReason: x => x,
    cleanupResolvedReactionChain: (...args) => { ctx.myData.pending = ctx.myData.pending.filter(p => !p.reactionPending || p.reactionPending.status === 'pending'); },
    syncPendingReactionChainState: () => ({ didChange: true, hasPending: false }),
    syncChatLatestActivityTimestamp: noop,
    refreshActiveBalanceDisplays: async () => {},
    checkEvmPayments: noop,
    historyModal: inactive, sendAssetFormModal: inactive, validatorModal: inactive,
    chatsScreen: { isActive: () => true, updateChatList: () => events.refresh.push('list'), updateChatData: async () => 0 },
    contactsScreen: { updateContactsList: async () => {} },
    walletScreen: { updateWalletBalances: async () => {}, updateWalletView: async () => {} },
    reactNativeApp: { isReactNativeWebView: false, handleNativeAppSubscribe: noop, handleNativeAppUnsubscribe: noop, sendNavigationBarVisibility: noop },
    useLongPolling: false, longPoll: noop, stopLongPoll: noop,
    getNetworkParams: async () => {}, updateUIForConnectivity: noop,
    stopEvmPaymentChecks: noop, evmAssets: { reset: noop }, receiveModal: inactive, multichain: { reset: noop },
    daoRepo: { reset: noop }, daoModal: { resetNotificationState: noop }, resetDaoNotificationSummary: noop,
    handleBrowserBackButton: noop, enterFullscreen: noop, loadState: () => data,
    logsModal: { log: noop }, migrateFriendStatusToConnection: () => false,
    migrateAttachmentKeysToEncKey: async () => false, migrateDeletedMessageStates: () => false,
    checkPendingTransactionsIntervalId: null, getSystemNoticeIntervalId: null, getSystemNotice: noop,
    welcomeScreen: { close: noop }, localStorageMonitor: { getStorageInfo: () => ({}) },
    footer: { switchView: async () => {} }, refreshDaoNotificationSummary: async () => {},
    callsModal: { refreshCalls: noop, startPeriodicCallsRefresh: noop }, header: { updateCallsIcon: noop },
    requestAnimationFrame: fn => fn(),
    formatTime: () => '12:00', escapeHtmlAttribute: String, escapeHtml: String, isDeleted: () => false,
    normalizeTransactionId: x => x || '', normalizeResourceUrl: x => x,
    encodeAttachmentName: x => x, normalizeMimeType: x => x, linkifyUrls: x => x,
  });
  vm.runInContext([
    classSource('ChatModal', 'chatModal'), classSource('FailedMessageMenu', 'failedMessageMenu'), classSource('SignInModal', 'signInModal'),
    ...['queryNetwork', 'removePendingTransaction', 'updateTransactionStatus', 'restorePendingMessageEdit', 'reconcilePendingMessageEdit',
      'settlePendingReaction', 'handleVisibilityChange', 'handleConnectivityChange', 'clearMyData'].map(fnSource),
    'let checkPendingTransactionsPromise = null;', fnSource('checkPendingTransactions'), fnSource('checkPendingTransactionsOnce'),
  ].join('\n'), ctx, { filename: path });
  const chat = Object.create(ctx.ChatModal.prototype);
  Object.assign(chat, {
    messageConfirmationController: null, abortController: new AbortController(), address: 'recipient',
    modal: {}, messagesList: { querySelector: () => ({}) }, isActive: () => true,
    appendChatModal: () => events.refresh.push('chat'), reopen: async () => {}, positionContextMenu: noop,
    fileAttachments: [], retryOfTxId: { value: '' },
    messageInput: { value: '', style: {}, scrollHeight: 48, dispatchEvent: noop, focus: noop },
    clearComposerAttachments: noop, showAttachmentPreview: noop, toggleSendButtonVisibility: noop,
    formatFileSize: () => '', getFileTypeForIcon: () => 'file',
  });
  ctx.chatModal = chat;
  return {
    ctx, chat, pending, message, data, events, requests, timers,
    setReply: value => { reply = value; },
    setFetch: fn => { fetchImpl = fn; },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = end; await flush();
    },
    setTime: value => { now = value; }, now: () => now,
  };
}
function deferredResponse(env, obeyAbort = true) {
  let resolve;
  env.setFetch((url, { signal }) => new Promise((res, reject) => {
    resolve = value => res({ text: async () => JSON.stringify(value) });
    if (obeyAbort) signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
  }));
  return value => resolve(value);
}

for (const [name, reply] of [
  ['top-level null', null], ['missing transaction', {}], ['null transaction', { transaction: null }],
  ['empty transaction', { transaction: {} }], ['unknown nonempty receipt', { transaction: { processing: true } }],
  ['malformed receipt string', { transaction: 'unexpected' }], ['nonboolean success', { transaction: { success: 'true' } }],
]) test(`${name}: waits, then retains failed message and saves`, async () => {
  const e = setup({ reply });
  await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.data.pending.length, 1); assert.equal(e.message.status, 'sent'); assert.equal(e.pending.checkedts, e.now());
  assert.equal(e.timers.size, 0);
  await e.advance(29_999); await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.message.status, 'sent');
  await e.advance(1); await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.data.pending.length, 0); assert.equal(e.data.contacts.recipient.messages[0], e.message);
  assert.equal(e.message.status, 'failed'); assert.equal(e.message.message, 'Original content');
  assert.ok(e.events.refresh.includes('chat')); assert.ok(e.events.refresh.includes('list'));
  assert.equal(e.events.save.at(-1).contacts.recipient.messages[0].status, 'failed'); assert.equal(e.timers.size, 0);
});

test('undefined query result is also null-safe and expires', async () => {
  const e = setup(); e.ctx.queryNetwork = async () => undefined;
  await e.ctx.checkPendingTransactionsOnce(); await e.advance(30_000); await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.message.status, 'failed');
});
test('parse/transport error becomes unknown and expires without throwing', async () => {
  const e = setup(); e.setFetch(async () => ({ text: async () => 'broken json' }));
  await e.ctx.checkPendingTransactionsOnce(); await e.advance(30_000); await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.message.status, 'failed'); assert.ok(e.events.console.some(x => String(x[1]).includes('queryNetwork ERROR')));
});
test('hung lookup aborts by deadline, clears timer and unlocks checker', async () => {
  const e = setup(); deferredResponse(e);
  const p = e.ctx.checkPendingTransactions(); await flush();
  const concurrent = e.ctx.checkPendingTransactions(); await flush();
  assert.equal(e.requests.length, 1); assert.equal(e.timers.size, 1);
  await e.advance(30_000); await Promise.all([p, concurrent]);
  assert.equal(e.requests[0].signal.aborted, true); assert.equal(e.message.status, 'failed');
  assert.equal(e.timers.size, 0); assert.equal(e.chat.messageConfirmationController, null);
  e.data.pending.push({ ...e.pending, txid: 'tx2', checkedts: 0 });
  e.setFetch(null); e.setReply({ transaction: { success: true } });
  await e.ctx.checkPendingTransactions(); assert.equal(e.data.pending.length, 0); assert.equal(e.requests.length, 2);
});
for (const success of [true, false]) test(`explicit late ${success ? 'success' : 'rejection'} overrides expired deadline`, async () => {
  const e = setup(); const resolve = deferredResponse(e, false);
  const p = e.ctx.checkPendingTransactionsOnce(); await flush();
  await e.advance(31_000); resolve({ transaction: { success, reason: 'Rejected by network' } }); await p;
  assert.equal(e.data.pending.length, 0); assert.equal(e.message.status, success ? 'sent' : 'failed');
  assert.deepEqual(e.events.settlement.at(-1), ['tx1', success]); assert.equal(e.timers.size, 0);
});
test('restored old message gets a fresh window through actual sign-in hook', async () => {
  const e = setup(); e.pending.checkedts = e.now() - 90_000;
  const signIn = Object.create(e.ctx.SignInModal.prototype);
  Object.assign(signIn, { selectedUsername: 'sender', recordRecentSignInUsername: noop, forceClose: noop });
  await signIn.handleSignIn(); assert.equal(e.pending.checkedts, 0);
  await e.ctx.checkPendingTransactionsOnce(); assert.equal(e.message.status, 'sent'); assert.equal(e.pending.checkedts, e.now());
});
for (const state of ['hidden', 'offline']) test(`${state}: no lookup or failure even after old deadline`, async () => {
  const e = setup(); e.pending.checkedts = e.now() - 90_000;
  if (state === 'hidden') e.ctx.document.visibilityState = 'hidden'; else e.ctx.isOnline = false;
  await e.ctx.checkPendingTransactionsOnce(); await e.advance(90_000); await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.requests.length, 0); assert.equal(e.message.status, 'sent'); assert.equal(e.data.pending.length, 1);
});
test('hide/resume cancels stale in-flight receipt and starts a fresh window', async () => {
  const e = setup(); const resolve = deferredResponse(e, false);
  const p = e.ctx.checkPendingTransactionsOnce(); await flush();
  e.ctx.document.visibilityState = 'hidden'; e.ctx.handleVisibilityChange();
  assert.equal(e.requests[0].signal.aborted, true); assert.equal(e.pending.checkedts, 0);
  await e.advance(60_000); e.ctx.document.visibilityState = 'visible'; e.ctx.handleVisibilityChange();
  resolve({ transaction: { success: false } }); await p;
  assert.equal(e.message.status, 'sent'); assert.equal(e.data.pending.length, 1);
  e.setFetch(null); await e.ctx.checkPendingTransactionsOnce(); assert.equal(e.pending.checkedts, e.now());
  assert.equal(e.message.status, 'sent'); assert.equal(e.timers.size, 0);
});
test('offline/reconnect aborts lookup and gives the message another full window', async () => {
  const e = setup(); deferredResponse(e); const p = e.ctx.checkPendingTransactionsOnce(); await flush();
  e.ctx.isOnline = false; await e.ctx.handleConnectivityChange(); await p;
  assert.equal(e.pending.checkedts, 0); assert.equal(e.message.status, 'sent');
  await e.advance(60_000); e.ctx.isOnline = true; await e.ctx.handleConnectivityChange();
  e.setFetch(null); await e.ctx.checkPendingTransactionsOnce(); assert.equal(e.pending.checkedts, e.now()); assert.equal(e.message.status, 'sent');
});
test('account change ignores completed result and does not mutate the new account', async () => {
  const e = setup(); const resolve = deferredResponse(e, false); const p = e.ctx.checkPendingTransactionsOnce(); await flush();
  const oldData = e.ctx.myData; e.ctx.clearMyData();
  assert.equal(e.requests[0].signal.aborted, true);
  e.ctx.myAccount = { username: 'other' }; e.ctx.myData = { pending: [], contacts: {} };
  resolve({ transaction: { success: false } }); await p;
  assert.equal(oldData.contacts.recipient.messages[0].status, 'sent'); assert.equal(e.ctx.myData.pending.length, 0); assert.equal(e.timers.size, 0);
});
test('reset changes only ordinary messages, preserving edit/reaction/transfer bookkeeping', async () => {
  const e = setup(); const extra = [
    { type: 'message', reactionPending: { status: 'pending' }, checkedts: 123 },
    { type: 'message', editPending: {}, checkedts: 456 }, { type: 'transfer', checkedts: 789 },
  ]; e.data.pending.push(...extra); e.pending.checkedts = 101;
  e.chat.resetPendingMessageConfirmations(); assert.equal(e.pending.checkedts, 0);
  assert.deepEqual(extra.map(x => x.checkedts), [123, 456, 789]);
});
test('expired edit keeps its existing rollback behavior without ordinary window', async () => {
  const e = setup(); e.pending.editPending = { targetTxid: 'original', previousMessage: { message: 'Before edit' }, previousHistory: { kind: 'none' } };
  e.message.txid = 'original'; e.message.message = 'Edited'; e.message.edited = 1; e.message.edited_timestamp = 10;
  await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.message.message, 'Before edit'); assert.equal(e.message.edited, undefined); assert.equal(e.message.status, 'sent');
  assert.equal(e.data.pending.length, 0); assert.equal(e.pending.checkedts, 0); assert.equal(e.requests[0].signal, null);
});
test('expired reaction follows existing failure/cleanup without failing target bubble', async () => {
  const e = setup(); e.pending.reactionPending = { status: 'pending', targetTxid: 'target' };
  e.message.txid = 'target'; await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.pending.reactionPending.status, 'failure'); assert.equal(e.data.pending.length, 0); assert.equal(e.message.status, 'sent');
  assert.equal(e.pending.checkedts, 0); assert.equal(e.requests[0].signal, null);
});
test('transfer retains existing age timeout and no message timer', async () => {
  const e = setup(); e.pending.type = 'transfer'; await e.ctx.checkPendingTransactionsOnce();
  assert.equal(e.data.pending.length, 0); assert.equal(e.pending.checkedts, 0); assert.equal(e.requests[0].signal, null); assert.equal(e.timers.size, 0);
});
test('failed bubble exposes existing Retry and restores original text plus attachments', async () => {
  const e = setup(); e.message.xattach = [{ name: 'file.txt', type: 'text/plain', url: 'https://files.test/a', encKey: 'existing-key' }];
  await e.ctx.checkPendingTransactionsOnce(); await e.advance(30_000); await e.ctx.checkPendingTransactionsOnce();
  const html = e.chat.renderChatMessageHTML(e.message, { contact: e.data.contacts.recipient, lastReadTs: 0 });
  assert.match(html, /data-status="failed"/); assert.match(html, /Original content/);
  const options = new Map(); const menu = Object.create(e.ctx.FailedMessageMenu.prototype);
  menu.menu = { style: {}, querySelector(selector) {
    if (!options.has(selector)) options.set(selector, { style: {}, querySelector: () => ({ textContent: '' }) });
    return options.get(selector);
  }};
  const element = { dataset: { txid: 'tx1' }, querySelector: () => null };
  e.chat.getMessageRecordFromElement = () => e.message;
  menu.open({ preventDefault: noop, stopPropagation: noop }, element);
  assert.equal(options.get('[data-action="retry"]').style.display, 'flex');
  menu.handleFailedMessageRetry(element);
  assert.equal(e.chat.messageInput.value, 'Original content'); assert.equal(e.chat.retryOfTxId.value, 'tx1');
  assert.deepEqual(JSON.parse(JSON.stringify(e.chat.fileAttachments)), e.message.xattach); assert.notEqual(e.chat.fileAttachments, e.message.xattach);
  assert.equal(e.data.contacts.recipient.messages[0], e.message);
});
