import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');
const limitDeclaration = appSource.match(/^const MAX_CHAT_MESSAGE_BYTES = [^;]+;/m)?.[0];
assert.ok(limitDeclaration, 'Chat message byte limit declaration must exist');
const chatSource = appSource.slice(appSource.indexOf('\nclass ChatModal {'));
const methods = [
  'validateMessageSize',
  'updateMessageByteCounter',
  'revalidateSendButtonState',
  'toggleSendButtonVisibility',
  'isActive',
].map((name) => {
  const method = chatSource.match(new RegExp(`^  ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'))?.[0];
  assert.ok(method, `ChatModal.${name} must exist`);
  return method;
});
// Evaluate only the composer methods, without launching the application or network services.
const ChatModal = new Function(`
  ${limitDeclaration}
  const isOnline = true;
  return class ChatModal { ${methods.join('\n')} };
`)();

test('ASCII messages are accepted through 10,000 bytes and rejected one byte later', () => {
  const chat = new ChatModal();
  assert.equal(chat.validateMessageSize('a'.repeat(10000)).isValid, true);
  assert.deepEqual(chat.validateMessageSize('a'.repeat(10001)), {
    isValid: false,
    currentBytes: 10001,
    remainingBytes: -1,
    percentage: 100.01,
    maxBytes: 10000,
  });
});

test('multibyte text uses UTF-8 bytes at the same boundary', () => {
  const chat = new ChatModal();
  assert.equal(chat.validateMessageSize('😀'.repeat(2500)).isValid, true);
  const overLimit = chat.validateMessageSize('😀'.repeat(2501));
  assert.equal(overLimit.isValid, false);
  assert.equal(overLimit.currentBytes, 10004);
  assert.equal(overLimit.remainingBytes, -4);
});

test('composer counter warns at 9,000 bytes and sending recovers after shortening', () => {
  const chat = new ChatModal();
  chat.modal = { classList: { contains: (name) => name === 'active' } };
  chat.messageInput = { value: 'a'.repeat(8999) };
  chat.messageByteCounter = { style: {}, textContent: '' };
  chat.sendButton = { style: {}, disabled: false };
  chat.voiceRecordButton = { style: {} };

  chat.revalidateSendButtonState();
  assert.equal(chat.messageByteCounter.style.display, 'none');
  assert.equal(chat.sendButton.disabled, false);
  assert.equal(chat.sendButton.style.display, 'flex');

  chat.messageInput.value = 'a'.repeat(9000);
  chat.revalidateSendButtonState();
  assert.equal(chat.messageByteCounter.style.display, 'block');
  assert.equal(chat.messageByteCounter.textContent, '1000 bytes - left');
  assert.equal(chat.sendButton.disabled, false);

  chat.messageInput.value = 'a'.repeat(10001);
  chat.revalidateSendButtonState();
  assert.equal(chat.messageByteCounter.textContent, '1 bytes - over limit');
  assert.equal(chat.sendButton.disabled, true);

  chat.messageInput.value = 'a'.repeat(10000);
  chat.revalidateSendButtonState();
  assert.equal(chat.messageByteCounter.textContent, '0 bytes - left');
  assert.equal(chat.sendButton.disabled, false);
});
