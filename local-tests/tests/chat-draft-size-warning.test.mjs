import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

// WEB_CLIENT_ROOT=/absolute/client/checkout node --test local-tests/tests/chat-draft-size-warning.test.mjs
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');
const limitDeclaration = appSource.match(/^const MAX_CHAT_MESSAGE_BYTES = [^;]+;/m)?.[0];
assert.ok(limitDeclaration, 'Chat message byte limit declaration must exist');
const classStart = appSource.indexOf('\nclass ChatModal {');
assert.ok(classStart >= 0, 'ChatModal must exist');
const chatSource = appSource.slice(classStart);
const methods = [
  'open',
  'loadDraft',
  'isActive',
  'validateMessageSize',
  'updateMessageByteCounter',
  'revalidateSendButtonState',
  'toggleSendButtonVisibility',
].map((name) => {
  const method = chatSource.match(new RegExp(`^  (?:async )?${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'))?.[0];
  assert.ok(method, `ChatModal.${name} must exist`);
  return method;
});

function createChat(drafts, { online = true } = {}) {
  const contacts = Object.fromEntries(Object.entries(drafts).map(([address, draft]) => [address, { draft, unread: 0 }]));
  const editInput = { value: '' };
  // Run the real open/load/input-validation lifecycle without network, rendering, or timers.
  const ChatModal = new Function('dependencies', `
    ${limitDeclaration}
    const { contacts, editInput, online: isOnline } = dependencies;
    const myData = { contacts };
    const document = { getElementById: () => editInput };
    const friendModal = { setAddress() {}, updateFriendButton() {} };
    const footer = { closeNewChatButton() {} };
    const walletScreen = { updateWalletBalances() {} };
    const getContactDisplayName = () => 'Synthetic contact';
    const getContactAvatarHtml = async () => '';
    const openModal = modal => modal.classList.add('active');
    return class ChatModal { ${methods.join('\n')} };
  `)({ contacts, editInput, online });
  const chat = new ChatModal();
  const classes = new Set();
  Object.assign(chat, {
    modal: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      querySelector: () => ({}),
    },
    messageInput: Object.assign(new EventTarget(), { value: '', style: {}, scrollHeight: 48 }),
    messageByteCounter: { style: {}, textContent: '' },
    sendButton: { style: {}, disabled: !online },
    voiceRecordButton: { style: {}, disabled: !online },
    addAttachmentButton: {},
    cancelEditButton: { style: {} },
    modalTitle: {},
    modalAvatar: {},
    retryOfTxId: { value: '' },
    messagesList: { innerHTML: '', querySelectorAll: () => [] },
    closeReactionSheet() {},
    clearPendingLocation() {},
    resetChatRenderWindow() {},
    updateTollValue() {},
    updateTollRequired() {},
    updateTollAmountUI() {},
    cancelReply() {},
    showAttachmentPreview() {},
    clearNotificationsIfAllRead() {},
    maybeShowTolledDepositToast() {},
    appendChatModal() {},
    maybePromptReclaimToll() {},
  });
  // loadDraft dispatches input before activation, as in the real textarea listener.
  chat.messageInput.addEventListener('input', () => chat.revalidateSendButtonState());
  return chat;
}

test('opening an oversized ASCII draft immediately shows its warning and disables Send', async () => {
  const draft = 'a'.repeat(10001);
  const chat = createChat({ contact: draft });
  await chat.open('contact', true);

  assert.equal(chat.isActive(), true);
  assert.equal(chat.messageInput.value, draft);
  assert.equal(chat.messageByteCounter.style.display, 'block');
  assert.equal(chat.messageByteCounter.textContent, '1 bytes - over limit');
  assert.equal(chat.messageByteCounter.style.color, '#dc3545');
  assert.equal(chat.sendButton.disabled, true);
  assert.equal(chat.sendButton.style.display, 'flex');
});

test('opening a multibyte draft counts UTF-8 bytes without requiring another keystroke', async () => {
  const chat = createChat({ contact: '😀'.repeat(2501) });
  await chat.open('contact', true);

  assert.equal(chat.messageByteCounter.style.display, 'block');
  assert.equal(chat.messageByteCounter.textContent, '4 bytes - over limit');
  assert.equal(chat.sendButton.disabled, true);
});

test('opening a draft at the warning threshold shows remaining bytes and allows sending', async () => {
  const chat = createChat({ contact: 'a'.repeat(9000) });
  await chat.open('contact', true);

  assert.equal(chat.messageByteCounter.style.display, 'block');
  assert.equal(chat.messageByteCounter.textContent, '1000 bytes - left');
  assert.equal(chat.messageByteCounter.style.color, '#ffa726');
  assert.equal(chat.sendButton.disabled, false);
});

test('opening short and empty drafts clears a previous chat restriction', async () => {
  const chat = createChat({ oversized: 'a'.repeat(10001), short: 'Hello', empty: '' });
  for (const address of ['short', 'empty']) {
    await chat.open('oversized', true);
    // Establish the previous chat's invalid state through its real input handler.
    chat.messageInput.dispatchEvent(new Event('input'));
    assert.equal(chat.sendButton.disabled, true);
    chat.modal.classList.remove('active');

    await chat.open(address, true);
    assert.equal(chat.messageInput.value, address === 'short' ? 'Hello' : '');
    assert.equal(chat.messageByteCounter.style.display, 'none');
    assert.equal(chat.sendButton.disabled, false);
    assert.equal(chat.sendButton.style.display, address === 'short' ? 'flex' : 'none');
    assert.equal(chat.voiceRecordButton.style.display, address === 'short' ? 'none' : 'flex');
    chat.modal.classList.remove('active');
  }
});

test('opening a valid near-limit draft while offline shows the counter and keeps Send disabled', async () => {
  const chat = createChat({ contact: 'a'.repeat(9000) }, { online: false });
  await chat.open('contact', true);

  assert.equal(chat.messageByteCounter.style.display, 'block');
  assert.equal(chat.messageByteCounter.textContent, '1000 bytes - left');
  assert.equal(chat.sendButton.disabled, true);
});
