import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Run directly: WEB_CLIENT_ROOT=/absolute/client node --test <this file>.
// Only the real ChatModal class and small UI helpers run; every account,
// transaction, network response, clock and DOM element below is synthetic.
const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root && path.isAbsolute(root), 'WEB_CLIENT_ROOT must select an absolute client checkout');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const classStart = source.indexOf('class ChatModal {');
const classEnd = source.indexOf('\nconst chatModal = new ChatModal();', classStart);
assert.ok(classStart >= 0 && classEnd > classStart, 'ChatModal source is available');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production helper: ${name}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

function element(classes = [], dataset = {}) {
  const values = new Set(classes);
  const attributes = new Map();
  return {
    dataset: { ...dataset }, style: {}, disabled: false,
    classList: {
      contains: value => values.has(value),
      add: value => values.add(value),
      remove: value => values.delete(value),
      toggle(value, force) { if (force) values.add(value); else values.delete(value); },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'data-requires-connection') this.dataset.requiresConnection = String(value);
    },
    getAttribute: name => attributes.get(name) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

const actions = ['delete-for-all', 'delete', 'copy', 'reply', 'edit', 'save', 'join',
  'call-invite', 'edit-resend', 'evm-check', 'evm-review', 'open', 'import-contacts'];

function menu() {
  const result = element();
  result.options = new Map(actions.map(action => [action, element(['context-menu-option'], { action })]));
  result.querySelector = selector => result.options.get(selector.match(/data-action="([^"]+)"/)?.[1]) ?? null;
  result.querySelectorAll = selector => {
    const names = [...selector.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]);
    return [...result.options.values()].filter(option => names.includes(option.dataset.action));
  };
  return result;
}

function fixture(options = {}) {
  const trace = [];
  const timers = new Map();
  let now = 1_000_000;
  let timerId = 0;
  const message = {
    txid: 'original-message', timestamp: now, my: true, status: 'sent', type: 'message',
    message: 'Synthetic message', ...options.message,
  };
  const contact = {
    address: 'a'.repeat(40), username: 'Synthetic contact', tollRequiredToSend: 0,
    public: 'recipient-public', pqPublic: 'recipient-pq', messages: [message], ...options.contact,
  };
  const regular = menu();
  const attachment = menu();
  const allOptions = [...regular.options.values(), ...attachment.options.values()];
  const context = {
    console: { warn() {}, error(...args) { trace.push(['error', ...args]); } },
    AbortController,
    window: { innerHeight: 800 },
    CHAT_REACTION_SHEET_DEFAULT_CATEGORY: 'common', CHAT_INITIAL_RENDER_COUNT: 40,
    DELETE_FOR_ALL_ACTION_GUARD_MS: 10_000, EDIT_WINDOW_MS: 15 * 60_000,
    MESSAGE_DELETED_STATE_LOCAL: 1, MESSAGE_DELETED_STATE_ALL: 2,
    EVM_CHAT_MESSAGE_TYPE: 'evm_transfer', INTENTS_CHAT_MESSAGE_TYPE: 'intents_transfer',
    FEE_FAILURE_REASON_INSUFFICIENT_BALANCE: 'insufficient_balance',
    FEE_FAILURE_REASON_NETWORK_ERROR: 'network_error',
    FEE_FAILURE_REASON_WALLET_UNAVAILABLE: 'wallet_unavailable',
    isOnline: options.online ?? true,
    myAccount: { keys: options.keys === false ? null : { secret: 'synthetic', pqSeed: 'synthetic' } },
    myData: { contacts: { [contact.address]: contact } },
    assert: (condition, message) => assert.ok(condition, message),
    getEffectiveTollLibWei: () => options.toll ?? 0n,
    getCorrectedTimestamp: () => now,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    showToast: (message, duration, type) => trace.push(['toast', message, type]),
    confirm(message) { trace.push(['confirm', message]); return options.confirm ?? true; },
    async getFeeBalanceStatus() {
      trace.push(['fee']);
      if (options.feeWait) return options.feeWait;
      return options.feeStatus ?? { success: true, reason: null };
    },
    async validateBalance(toll) {
      trace.push(['legacy-fee', toll]);
      if (options.feeWait) return (await options.feeWait).success;
      return options.feeStatus?.success ?? true;
    },
    async ensureContactKeys() {
      trace.push(['keys']);
      if (options.recipientKeysWait) await options.recipientKeysWait;
      return options.recipientKeys ?? true;
    },
    dhkeyCombined: () => ({ dhkey: new Uint8Array([1]), cipherText: new Uint8Array([2]) }),
    encryptData: () => 'synthetic-self-key', bin2hex: () => '01', bin2base64: () => 'Ag==',
    encryptChacha: (_key, text) => text, stringify: JSON.stringify,
    async signObj() { trace.push(['sign']); if (options.signWait) await options.signWait; },
    getTxid: () => 'synthetic-delete-tx',
    async injectTx(tx) {
      trace.push(['inject', tx]);
      if (options.injectWait) await options.injectWait;
      return options.injectResponse ?? { result: { success: true } };
    },
    evmAssets: { getPaymentActions: () => ({}) },
    failedMessageMenu: { open: () => trace.push(['failed-menu']) },
    document: {
      getElementById: () => null,
      querySelectorAll(selector) {
        if (selector === '[data-requires-connection]') {
          return allOptions.filter(option => option.dataset.requiresConnection === 'true');
        }
        if (!selector.startsWith('.message-context-menu .context-menu-option')) return [];
        const excluded = [...selector.matchAll(/:not\(\[data-action="([^"]+)"\]\)/g)].map(match => match[1]);
        return allOptions.filter(option => !excluded.includes(option.dataset.action));
      },
    },
  };
  vm.createContext(context);
  const helpers = ['getDeletedState', 'isDeleted', 'isDeletedForMeOnly', 'isDeletedForAll', 'getFeeFailureToastConfig',
    'showFeeBalanceFailureToast', 'markConnectivityDependentElements', 'updateUIForConnectivity'];
  vm.runInContext(`${helpers.map(functionSource).join('\n')}\n${source.slice(classStart, classEnd)}\nglobalThis.ChatModal = ChatModal;`, context);
  const chat = new context.ChatModal();
  chat.address = contact.address;
  chat.toll = options.toll ?? 0n;
  chat.contextMenu = regular;
  chat.imageAttachmentContextMenu = attachment;
  chat.contextMenuReactions = element();
  chat.imageAttachmentContextMenuReactions = element();
  chat.closeAllContextMenus = () => {};
  chat.closeContextMenu = () => {};
  chat.closeImageAttachmentContextMenu = () => {};
  chat.syncContextReactionTrayDisplay = () => {};
  chat.syncReactionPickerActiveState = () => {};
  chat.positionContextMenu = () => {};
  chat.isKeyboardOpen = () => false;
  chat.deleteAttachmentsFromServer = () => trace.push(['attachment-cleanup']);
  chat.createChatMessage = async (address, payload, toll) => {
    trace.push(['create', address, payload, toll]);
    if (options.createWait) await options.createWait;
    return { type: 'message', xmessage: payload };
  };
  const messageEl = element(['message', message.my ? 'sent' : 'received',
    ...(message.deleted ? ['deleted-message'] : []), ...(options.payment ? ['payment-info'] : [])], {
    txid: message.txid, messageTimestamp: String(message.timestamp), status: message.status,
  });
  messageEl.querySelector = selector => selector === '.message-content' ? { textContent: message.message } : null;
  const row = element(['attachment-row'], { imageAttachment: String(options.image ?? false), type: 'application/pdf', name: 'synthetic.pdf' });
  row.closest = selector => selector === '.message' ? messageEl : null;
  chat.getAttachmentContextFromRow = () => ({ messageEl, item: message });
  const event = { preventDefault() {}, stopPropagation() {}, target: {
    tagName: 'DIV', closest: selector => selector === '.message' ? messageEl : null,
  } };
  return {
    chat, contact, message, messageEl, row, event, trace, context, regular, attachment,
    count: name => trace.filter(entry => entry[0] === name).length,
    toasts: () => trace.filter(entry => entry[0] === 'toast').map(entry => entry[1]),
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function waitForStage(f, name) {
  for (let attempt = 0; attempt < 40 && !f.count(name); attempt++) await Promise.resolve();
  assert.ok(f.count(name), `Production flow reached ${name}; feedback: ${f.toasts().join('; ')}`);
}

test('own regular, image and file menus retain Delete for all under contact/toll restrictions', () => {
  for (const contact of [{ tollRequiredToSend: 2 }, { tollRequiredToSend: 1 }]) {
    for (const mode of ['regular', 'image', 'file']) {
      const f = fixture({ contact, toll: 5n, image: mode === 'image' });
      if (mode === 'regular') f.chat.showMessageContextMenu(f.event, f.messageEl);
      else f.chat.showAttachmentContextMenu(f.event, f.row);
      const menu = mode === 'regular' ? f.regular : f.attachment;
      assert.equal(menu.options.get('delete-for-all').style.display, 'flex', `${mode}, requirement ${contact.tollRequiredToSend}`);
    }
  }
});

test('own local-deletion placeholder menu opens even when the recipient currently blocks the sender', async () => {
  const f = fixture({ contact: { tollRequiredToSend: 2 }, message: { deleted: 1 } });
  await f.chat.handleMessageClick(f.event);
  assert.equal(f.regular.style.display, 'block');
  assert.equal(f.regular.options.get('delete-for-all').style.display, 'flex');
  assert.equal(f.regular.options.get('delete').style.display, 'none');
});

test('received, globally deleted, failed and missing-ID records remain inapplicable', async () => {
  for (const message of [{ my: false }, { deleted: 2 }, { status: 'failed' }, { txid: undefined }]) {
    const f = fixture({ message });
    assert.equal(f.chat.canDeleteMessageForAll(f.messageEl), false, JSON.stringify(message));
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.equal(f.count('confirm'), 0);
    assert.equal(f.count('sign'), 0);
    assert.equal(f.count('inject'), 0);
  }
});

test('offline Delete for all stays tappable in both menus while other online actions remain disabled', () => {
  const f = fixture({ online: false });
  vm.runInContext('markConnectivityDependentElements(); updateUIForConnectivity();', f.context);
  for (const menu of [f.regular, f.attachment]) {
    f.chat.syncDeleteContextMenuDisabledState(menu, f.messageEl);
    const deletion = menu.options.get('delete-for-all');
    assert.equal(deletion.getAttribute('aria-disabled'), 'false');
    assert.equal(deletion.disabled, false);
    assert.equal(menu.options.get('reply').getAttribute('aria-disabled'), 'true');
  }
});

test('an existing pending deletion still disables Delete for all in both menus', () => {
  const f = fixture({ online: false });
  f.chat.markRecentDeleteForAllForTarget(f.message.txid);
  for (const menu of [f.regular, f.attachment]) {
    f.chat.syncDeleteContextMenuDisabledState(menu, f.messageEl);
    assert.equal(menu.options.get('delete-for-all').getAttribute('aria-disabled'), 'true');
  }
});

for (const [name, options, reason] of [
  ['offline', { online: false }, /offline|internet|connection/i],
  ['blocked by recipient', { contact: { tollRequiredToSend: 2 } }, /block/i],
  ['nonzero payable toll', { contact: { tollRequiredToSend: 1 }, toll: 5n }, /connection|toll|contact/i],
]) {
  test(`${name} explains the restriction before confirmation and never builds a transaction`, async () => {
    const f = fixture(options);
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.ok(f.toasts().some(message => reason.test(message)), f.toasts().join('; '));
    assert.equal(f.count('confirm'), 0);
    assert.equal(f.count('create'), 0);
    assert.equal(f.count('inject'), 0);
  });
}

for (const [reason, text] of [
  ['insufficient_balance', /insufficient.*fee/i],
  ['network_error', /network.*fee/i],
  ['wallet_unavailable', /wallet.*unavailable/i],
]) {
  test(`${reason} fee failure keeps its specific feedback and precedes confirmation`, async () => {
    const f = fixture({ feeStatus: { success: false, reason } });
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.ok(f.toasts().some(message => text.test(message)), f.toasts().join('; '));
    assert.equal(f.count('confirm'), 0);
    assert.equal(f.count('inject'), 0);
  });
}

test('both allowed toll policies check fees, confirm, and send exactly one zero-toll deletion', async () => {
  for (const options of [
    { contact: { tollRequiredToSend: 0 }, toll: 5n },
    { contact: { tollRequiredToSend: 1 }, toll: 0n },
  ]) {
    const f = fixture(options);
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.equal(f.count('fee'), 1);
    assert.equal(f.count('confirm'), 1);
    assert.ok(f.trace.findIndex(entry => entry[0] === 'fee') < f.trace.findIndex(entry => entry[0] === 'confirm'));
    assert.equal(f.count('create'), 1);
    assert.equal(f.trace.find(entry => entry[0] === 'create')[3], 0n);
    assert.equal(JSON.parse(f.trace.find(entry => entry[0] === 'create')[2].message).txid, f.message.txid);
    assert.equal(f.count('sign'), 1);
    assert.equal(f.count('inject'), 1);
    assert.equal(f.message.deleted, undefined, 'network processing still owns the deletion UI');
  }
});

test('both menu actions route the same original message into the shared deletion flow', () => {
  const f = fixture();
  const targets = [];
  f.chat.deleteMessageForAll = message => targets.push(message);
  f.chat.currentContextMessage = f.messageEl;
  f.chat.handleContextMenuAction('delete-for-all');
  f.chat.currentImageAttachmentRow = f.row;
  f.chat.handleImageAttachmentContextMenuAction('delete-for-all');
  assert.deepEqual(targets, [f.messageEl, f.messageEl]);
});

test('cancelled confirmation releases the guard and permits a later attempt', async () => {
  const options = { confirm: false };
  const f = fixture(options);
  await f.chat.deleteMessageForAll(f.messageEl);
  assert.equal(f.count('inject'), 0);
  assert.equal(f.chat.hasRecentDeleteForAllForTarget(f.message.txid), false);
  options.confirm = true;
  await f.chat.deleteMessageForAll(f.messageEl);
  assert.equal(f.count('inject'), 1);
});

test('missing sender or recipient keys never sign or inject', async () => {
  for (const options of [{ keys: false }, { recipientKeys: false }]) {
    const f = fixture(options);
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.ok(f.toasts().some(message => /key/i.test(message)), f.toasts().join('; '));
    assert.equal(f.count('sign'), 0);
    assert.equal(f.count('inject'), 0);
    assert.equal(f.chat.hasRecentDeleteForAllForTarget(f.message.txid), false);
  }
});

test('an in-flight fee lookup stays guarded beyond the old ten-second timer', async () => {
  let finishFee;
  const feeWait = new Promise(resolve => { finishFee = resolve; });
  const f = fixture({ feeWait });
  const first = f.chat.deleteMessageForAll(f.messageEl);
  f.advance(10_001);
  const second = f.chat.deleteMessageForAll(f.messageEl);
  finishFee({ success: true, reason: null });
  await Promise.all([first, second]);
  assert.equal(f.count('confirm'), 1);
  assert.equal(f.count('inject'), 1);
});

test('going offline during the fee lookup prevents confirmation and submission', async () => {
  let finishFee;
  const feeWait = new Promise(resolve => { finishFee = resolve; });
  const f = fixture({ feeWait });
  const attempt = f.chat.deleteMessageForAll(f.messageEl);
  f.context.isOnline = false;
  finishFee({ success: true, reason: null });
  await attempt;
  assert.equal(f.count('confirm'), 0);
  assert.equal(f.count('inject'), 0);
  assert.ok(f.toasts().some(message => /offline|internet|connection/i.test(message)), f.toasts().join('; '));
  assert.equal(f.chat.hasRecentDeleteForAllForTarget(f.message.txid), false);
});

test('key lookup revalidates a new payable toll or recipient block before building a deletion', async () => {
  for (const requirement of [1, 2]) {
    const keys = deferred();
    const options = { recipientKeysWait: keys.promise, toll: 5n };
    const f = fixture(options);
    const originalTxid = f.message.txid;
    const attempt = f.chat.deleteMessageForAll(f.messageEl);
    await waitForStage(f, 'keys');
    f.contact.tollRequiredToSend = requirement;
    keys.resolve();
    await attempt;
    assert.equal(f.count('create'), 0);
    assert.equal(f.count('inject'), 0);
    assert.equal(f.chat.hasRecentDeleteForAllForTarget(originalTxid), false);
    assert.ok(f.toasts().some(message => /block|toll/i.test(message)), f.toasts().join('; '));
  }
});

test('transaction preparation revalidates message deletion, failure, and account changes', async () => {
  for (const change of ['deleted', 'failed', 'account']) {
    const preparation = deferred();
    const f = fixture({ createWait: preparation.promise });
    const originalTxid = f.message.txid;
    const attempt = f.chat.deleteMessageForAll(f.messageEl);
    await waitForStage(f, 'create');
    if (change === 'deleted') f.message.deleted = 2;
    if (change === 'failed') f.message.status = 'failed';
    if (change === 'account') f.context.myAccount = { keys: { secret: 'another synthetic account' } };
    preparation.resolve();
    await attempt;
    assert.equal(f.count('sign'), 0, change);
    assert.equal(f.count('inject'), 0, change);
    assert.equal(f.chat.hasRecentDeleteForAllForTarget(originalTxid), false, change);
  }
});

test('signing revalidates the chat and original target before submission', async () => {
  for (const change of ['chat', 'target']) {
    const signature = deferred();
    const f = fixture({ signWait: signature.promise });
    const originalTxid = f.message.txid;
    const attempt = f.chat.deleteMessageForAll(f.messageEl);
    await waitForStage(f, 'sign');
    if (change === 'chat') f.chat.address = 'c'.repeat(40);
    if (change === 'target') f.message.txid = 'different-announcement';
    signature.resolve();
    await attempt;
    assert.equal(f.count('inject'), 0, change);
    assert.equal(f.chat.hasRecentDeleteForAllForTarget(originalTxid), false, change);
  }
});

test('slow submission remains guarded until completion, then retains exactly the normal cooldown', async () => {
  const submission = deferred();
  const f = fixture({ injectWait: submission.promise });
  const first = f.chat.deleteMessageForAll(f.messageEl);
  await waitForStage(f, 'inject');
  f.advance(10_001);
  const second = f.chat.deleteMessageForAll(f.messageEl);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  const confirmationsDuringSubmission = f.count('confirm');
  const submissionsWhileWaiting = f.count('inject');
  submission.resolve();
  await Promise.all([first, second]);
  assert.equal(confirmationsDuringSubmission, 1);
  assert.equal(submissionsWhileWaiting, 1);
  f.advance(9_999);
  assert.equal(f.chat.hasRecentDeleteForAllForTarget(f.message.txid), true);
  await f.chat.deleteMessageForAll(f.messageEl);
  assert.equal(f.count('inject'), 1);
  f.advance(1);
  assert.equal(f.chat.hasRecentDeleteForAllForTarget(f.message.txid), false);
  await f.chat.deleteMessageForAll(f.messageEl);
  assert.equal(f.count('inject'), 2);
});

test('EVM announcements and own local placeholders use the flow while failed native payments stay excluded', async () => {
  for (const message of [
    { type: 'evm_transfer', payment: { rawAmount: '1', symbol: 'ETH' } },
    { deleted: 1, message: 'Deleted on this device' },
  ]) {
    const f = fixture({ message });
    await f.chat.handleMessageClick(f.event);
    assert.equal(f.regular.options.get('delete-for-all').style.display, 'flex');
    await f.chat.deleteMessageForAll(f.messageEl);
    assert.equal(f.count('inject'), 1);
  }
  const failed = fixture({ payment: true, message: { amount: 1n, status: 'failed' } });
  await failed.chat.handleMessageClick(failed.event);
  assert.equal(failed.regular.options.get('delete-for-all').style.display, 'none');
  await failed.chat.deleteMessageForAll(failed.messageEl);
  assert.equal(failed.count('confirm'), 0);
  assert.equal(failed.count('inject'), 0);
});
