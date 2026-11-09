import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

// WEB_CLIENT_ROOT=/absolute/client/checkout node --test local-tests/tests/issue-1885-attaching-toast.test.mjs
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');
const classStart = appSource.indexOf('\nclass ChatModal {');
assert.ok(classStart >= 0, 'ChatModal must exist');
const chatSource = appSource.slice(classStart);
const methods = [
  'handleFileAttachment',
  'getMimeTypeFromFilename',
  'trackAttachmentLoadingToast',
  'untrackAttachmentLoadingToast',
  'hideAttachmentLoadingToastsForContact',
].map((name) => {
  const method = chatSource.match(new RegExp(`^  (?:async )?${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, 'm'))?.[0];
  assert.ok(method, `ChatModal.${name} must exist`);
  return method;
});

const CONTACT = 'contact-address';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Builds a ChatModal with the real attachment handler and toast bookkeeping.
 * Thumbnail generation, encryption and upload are synthetic; each one is held
 * open by a deferred promise so a test can inspect the state while it is in flight.
 */
function createChat({ attachments = [] } = {}) {
  const events = [];
  const toasts = new Map();
  const thumbnail = deferred();
  const upload = deferred();
  let nextToast = 0;
  let chat;

  const busy = () => ({
    isEncrypting: chat.isEncrypting === true,
    sendDisabled: chat.sendButton.disabled === true,
    attachDisabled: chat.addAttachmentButton.disabled === true,
  });
  const loadingToasts = () => [...toasts.values()].filter((toast) => toast.type === 'loading');
  const snapshots = {};
  const snapshot = (name) => {
    snapshots[name] = { loading: loadingToasts().map((toast) => toast.message), busy: busy() };
  };
  const generate = (name) => (file) => {
    events.push(name);
    snapshot(name);
    assert.ok(file, 'the selected file is passed to the thumbnail generator');
    return thumbnail.promise;
  };

  const dependencies = {
    myData: { contacts: { [CONTACT]: { name: 'Bob' } } },
    getContactDisplayName: (contact) => contact.name,
    showToast(message, duration, type) {
      const id = `toast-${++nextToast}`;
      toasts.set(id, { message, duration, type });
      events.push(`show:${type}`);
      return id;
    },
    hideToast(id) {
      if (!toasts.has(id)) return;
      events.push(`hide:${toasts.get(id).type}`);
      toasts.delete(id);
    },
    MediaCacheOwnership: { getOwnerKey: () => 'owner' },
    thumbnailCache: {
      generateThumbnail: generate('generateThumbnail'),
      extractVideoThumbnail: generate('extractVideoThumbnail'),
      save: async () => {},
    },
    chatsScreen: { isActive: () => false },
    generateRandomBytes: (length) => new Uint8Array(length),
    encryptBlob: async (blob) => blob,
    bin2base64: () => 'synthetic-key',
    Worker: class {
      constructor() {
        events.push('encrypt');
        snapshot('encrypt');
      }
      postMessage() {
        queueMicrotask(() => this.onmessage({ data: { cipherBin: new ArrayBuffer(4) } }));
      }
      terminate() {}
    },
    FileReader: class {
      readAsArrayBuffer() {
        queueMicrotask(() => this.onload({ target: { result: new ArrayBuffer(4) } }));
      }
    },
    console: { ...console, warn() {} },
  };
  const ChatModal = new Function(...Object.keys(dependencies), `return class ChatModal { ${methods.join('\n')} };`)(
    ...Object.values(dependencies),
  );
  chat = new ChatModal();
  Object.assign(chat, {
    address: CONTACT,
    fileAttachments: [...attachments],
    attachmentLoadingToastsByContact: new Map(),
    sendButton: { disabled: false },
    addAttachmentButton: { disabled: false },
    blockedByRecipient: false,
    isActive: () => true,
    isEditingMessage: () => false,
    uploadEncryptedFile() {
      events.push('upload');
      snapshot('upload');
      return upload.promise;
    },
    deleteAttachmentsFromServer() {},
    showAttachmentPreview() {
      events.push('preview');
    },
    saveAttachmentState() {},
    revalidateSendButtonState() {
      this.sendButton.disabled = false;
    },
  });
  return { chat, events, toasts, loadingToasts, snapshots, thumbnail, upload, busy };
}

function select(chat, name, type, size = 4096) {
  const input = { files: [{ name, type, size }], value: `C:\\fakepath\\${name}` };
  const completion = chat.handleFileAttachment({ target: input });
  completion.catch(() => {}); // tests that leave an upload pending never observe this
  return { completion, input };
}

const allBusy = { isEncrypting: true, sendDisabled: true, attachDisabled: true };

for (const [label, name, type, generator] of [
  ['an image', 'holiday.jpg', 'image/jpeg', 'generateThumbnail'],
  ['a video', 'clip.mp4', 'video/mp4', 'extractVideoThumbnail'],
  ['a video whose MIME type is missing', 'IMG_0042.MOV', '', 'extractVideoThumbnail'],
]) {
  test(`selecting ${label} shows the Attaching toast before its thumbnail is generated`, async () => {
    const { chat, events, loadingToasts, snapshots, busy } = createChat();
    select(chat, name, type);
    await tick();

    assert.deepEqual(events, ['show:loading', generator], 'thumbnail generation is still in flight');
    assert.deepEqual(snapshots[generator].loading, [`Attaching "${name}" to Bob...`]);
    assert.deepEqual(snapshots[generator].busy, allBusy, 'Send and attach are blocked before thumbnail work starts');

    // The toast is sticky and stays for as long as the thumbnail takes.
    const [toast] = loadingToasts();
    assert.equal(toast.duration, 0);
    assert.equal(chat.attachmentLoadingToastsByContact.get(CONTACT).size, 1);
    assert.deepEqual(busy(), allBusy);
  });
}

test('the same toast stays until the attachment appears in the composer', async () => {
  const { chat, events, toasts, loadingToasts, snapshots, thumbnail, upload } = createChat();
  const { completion, input } = select(chat, 'holiday.jpg', 'image/jpeg');
  await tick();
  thumbnail.resolve({ size: 16 });
  await tick();

  assert.deepEqual(events, ['show:loading', 'generateThumbnail', 'encrypt', 'upload']);
  assert.equal(loadingToasts().length, 1, 'encryption and upload reuse the toast shown at selection');
  // Encryption has finished by now; the buttons stay blocked through the upload.
  assert.equal(snapshots.upload.busy.sendDisabled, true);
  assert.equal(snapshots.upload.busy.attachDisabled, true);

  upload.resolve('https://files.example/get/attachment-id');
  await completion;

  assert.deepEqual(events.filter((event) => event.startsWith('show')), ['show:loading'], 'no second toast');
  assert.deepEqual(events.slice(-2), ['hide:loading', 'preview'], 'the toast is cleared as the preview is rendered');
  assert.equal(toasts.size, 0);
  assert.equal(chat.attachmentLoadingToastsByContact.size, 0);
  assert.equal(chat.fileAttachments.length, 1);
  assert.equal(chat.fileAttachments[0].name, 'holiday.jpg');
  assert.equal(chat.isEncrypting, false);
  assert.equal(chat.sendButton.disabled, false);
  assert.equal(chat.addAttachmentButton.disabled, false);
  assert.equal(input.value, '', 'the file input is reset so the same file can be chosen again');
});

test('a thumbnail failure keeps the toast and continues to encryption', async () => {
  const { chat, events, loadingToasts, snapshots, thumbnail } = createChat();
  select(chat, 'clip.mp4', 'video/mp4');
  await tick();
  thumbnail.reject(new Error('synthetic thumbnail failure'));
  await tick();

  assert.deepEqual(events, ['show:loading', 'extractVideoThumbnail', 'encrypt', 'upload']);
  assert.equal(loadingToasts().length, 1);
  assert.deepEqual(snapshots.encrypt.busy, allBusy);
});

test('closing the chat during thumbnail generation removes the toast', async () => {
  const { chat, toasts } = createChat();
  select(chat, 'holiday.jpg', 'image/jpeg');
  await tick();
  assert.equal(toasts.size, 1);

  // ChatModal.close() clears a contact's loading toasts through this method.
  chat.hideAttachmentLoadingToastsForContact(CONTACT);
  assert.equal(toasts.size, 0);
  assert.equal(chat.attachmentLoadingToastsByContact.size, 0);
});

test('documents and audio still show the toast at once and skip thumbnail generation', async () => {
  for (const [name, type] of [['report.pdf', 'application/pdf'], ['voice.mp3', 'audio/mpeg'], ['song.ogg', '']]) {
    const { chat, events, snapshots } = createChat();
    select(chat, name, type);
    await tick();

    assert.deepEqual(events, ['show:loading', 'encrypt', 'upload'], name);
    assert.deepEqual(snapshots.encrypt.loading, [`Attaching "${name}" to Bob...`]);
    assert.deepEqual(snapshots.encrypt.busy, allBusy, name);
  }
});

test('a rejected selection shows only its error and never enters the busy state', async () => {
  const fiveAttachments = Array.from({ length: 5 }, (_, index) => ({ name: `existing-${index}.jpg` }));
  for (const [options, size, message, prepare] of [
    [{ attachments: fiveAttachments }, 4096, 'You can only attach up to 5 files.'],
    [{}, 100 * 1024 * 1024 + 1, 'File size too large. Maximum size is 100MB.'],
    [{}, 4096, 'Unable to attach file: no active chat found.', (chat) => { chat.address = null; }],
  ]) {
    const { chat, events, toasts, busy } = createChat(options);
    prepare?.(chat);
    const { completion, input } = select(chat, 'holiday.jpg', 'image/jpeg', size);
    await completion;

    assert.deepEqual(events, ['show:error'], message);
    assert.deepEqual([...toasts.values()].map((toast) => toast.message), [message]);
    assert.deepEqual(busy(), { isEncrypting: false, sendDisabled: false, attachDisabled: false }, message);
    assert.equal(input.value, '', message);
  }
});
