import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

// Standalone until the shared main branch contains the offline regression runner.
// WEB_CLIENT_ROOT=/absolute/client/path node local-tests/tests/issue-1847-video-preview.test.mjs
assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the absolute client checkout.');
const clientRoot = process.env.WEB_CLIENT_ROOT;
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');
const htmlSource = readFileSync(join(clientRoot, 'index.html'), 'utf8');
const securitySource = readFileSync(join(clientRoot, 'lib.js'), 'utf8');
const security = await import(`data:text/javascript;base64,${Buffer.from(securitySource).toString('base64')}`);

class Element {
  constructor(tag, markup = '') {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.style = {};
    this.dataset = {};
    this.hidden = /\bhidden(?:\s|>|$)/.test(markup);
    this.controls = /\bcontrols(?:\s|>|$)/.test(markup);
    this.playsInline = /\bplaysinline(?:\s|>|$)/.test(markup);
    this.autoplay = /\bautoplay(?:\s|>|$)/.test(markup);
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.pauseCount = 0;
    this.loadCount = 0;
    this.playCount = 0;
    this.support = 'probably';
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classes.has(name) : force;
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
  }

  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get poster() { return this.getAttribute('poster') || ''; }
  set poster(value) { this.setAttribute('poster', value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  canPlayType() { return this.support; }
  pause() { this.pauseCount += 1; }
  load() { this.loadCount += 1; }
  play() { this.playCount += 1; return Promise.resolve(); }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name, event = {}) {
    this[`on${name}`]?.(event);
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
}

class PreviewHarness {
  constructor() {
    this.nodes = new Map();
    for (const match of htmlSource.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      this.nodes.set(match[2], new Element(match[1], match[0]));
    }
    this.document = new Element('document');
    this.document.getElementById = id => this.nodes.get(id) || null;
    this.created = new Map();
    this.createdPlaybackCounts = new Map();
    this.revoked = [];
    this.toasts = [];
    this.errors = [];
    this.cacheCalls = [];
    this.decryptCalls = [];
    this.thumbnailCalls = [];
    this.savedThumbnails = [];
    this.savedFiles = [];
    this.env = {
      ...security,
      assert,
      Blob,
      document: this.document,
      URL: {
        createObjectURL: blob => {
          const url = `blob:preview-${this.created.size + 1}`;
          this.created.set(url, blob);
          this.createdPlaybackCounts.set(url, {
            pauses: this.modal?.video?.pauseCount || 0,
            loads: this.modal?.video?.loadCount || 0,
          });
          return url;
        },
        revokeObjectURL: url => this.revoked.push(url),
      },
      console: { error() {}, warn() {}, log() {} },
      openModal: modal => { modal.classList.add('active'); return true; },
      showToast: (...args) => { this.toasts.push(args); return this.toasts.length; },
      hideToast() {},
      window: { ReactNativeWebView: { postMessage: value => this.savedFiles.push(JSON.parse(value)) } },
      FileReader: class {
        readAsDataURL(blob) {
          this.result = `data:${blob.type};base64,c3ludGhldGlj`;
          this.onloadend();
        }
      },
      CHAT_THUMBNAIL_ATTACHMENT_SELECTOR: '.attachment-thumbnail',
      thumbnailCache: {
        extractVideoThumbnail: async blob => { this.thumbnailCalls.push(blob); return new Blob(['thumbnail']); },
        save: async (...args) => { this.savedThumbnails.push(args); },
        get: async () => null,
      },
    };
    this.modal = this.construct('FullImageModal', 'fullImageModal');
    this.modal.load();
    this.env.fullImageModal = this.modal;
  }

  construct(className, instanceName, extra = {}) {
    const start = appSource.indexOf(`\nclass ${className} {`);
    const end = appSource.indexOf(`\nconst ${instanceName} =`, start);
    assert.ok(start >= 0 && end > start, `${className} must remain extractable for isolated behavior tests`);
    const environment = { ...this.env, ...extra };
    const Constructor = new Function(...Object.keys(environment), `return (${appSource.slice(start, end)});`)(...Object.values(environment));
    return className === 'FullImageModal' ? new Constructor() : Object.create(Constructor.prototype);
  }

  chat() {
    const chat = this.construct('ChatModal', 'chatModal');
    chat.getAttachmentContextFromRow = row => row.context;
    chat.getFullImageBlob = async (...args) => { this.cacheCalls.push(args); return this.imageBlob; };
    chat.decryptAttachmentToBlob = async (...args) => { this.decryptCalls.push(args); return this.videoBlob; };
    chat.handleAttachmentError = (...args) => this.errors.push(args);
    return chat;
  }

  row(type = 'video/mp4', name = 'clip.mp4') {
    const row = new Element('div');
    row.dataset = {
      type,
      name: encodeURIComponent(name),
      url: `https://files.example/get/${name}`,
      imageAttachment: String(type.startsWith('image/')),
    };
    row.context = { item: { type: 'chat', xattach: [{ type, url: row.dataset.url }] }, url: row.dataset.url };
    return row;
  }

  video(type = 'video/mp4') {
    const bytes = type === 'video/webm'
      ? Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])
      : type === 'video/ogg' ? new TextEncoder().encode('OggS') : new TextEncoder().encode('0000ftypisom');
    return new Blob([bytes], { type });
  }

  image() {
    return new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
  }

  readyVideo() {
    this.modal.video.dispatch('loadedmetadata');
    this.modal.video.dispatch('loadeddata');
    this.modal.video.dispatch('canplay');
  }

  assertReleased(url) {
    const previous = this.createdPlaybackCounts.get(url);
    assert.equal(this.modal.video.src, '', 'release the native media source');
    assert.equal(this.modal.video.poster, '', 'release the previous thumbnail reference');
    assert.ok(this.modal.video.pauseCount > previous.pauses, 'pause native playback after attaching this source');
    assert.ok(this.modal.video.loadCount > previous.loads, 'reset the native media resource');
    assert.ok(this.revoked.includes(url), 'revoke the owned object URL');
  }
}

test('only eligible declared video formats expose Open; filenames cannot enable preview', () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  for (const type of ['video/mp4', 'video/webm', 'video/ogg', ' Video/MP4 ']) {
    assert.equal(chat.getAttachmentPreviewKind(h.row(type)), 'video', type);
  }
  for (const type of ['', 'text/html', 'audio/ogg', 'video/quicktime', 'video/x-msvideo']) {
    assert.equal(chat.getAttachmentPreviewKind(h.row(type, 'pretend.mp4')), null, type);
  }
  assert.equal(chat.getAttachmentPreviewKind(h.row('image/png', 'photo.png')), 'image');
});

test('Open displays loading immediately, then a verified video using native inline controls', async () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  let resolveDownload;
  chat.decryptAttachmentToBlob = () => new Promise(resolve => { resolveDownload = resolve; });
  const row = h.row();
  row.dataset.thumbnailUrl = 'blob:existing-thumbnail';
  const opening = chat.openMediaAttachment(row);

  assert.equal(h.modal.modal.classList.contains('active'), true);
  assert.equal(h.modal.loading.hidden, false);
  assert.equal(h.modal.viewer.getAttribute('aria-busy'), 'true');
  assert.equal(h.modal.title.textContent, 'clip.mp4');
  assert.equal(h.modal.video.poster, row.dataset.thumbnailUrl);
  assert.equal(h.created.size, 0, 'do not create a media source before decryption finishes');

  resolveDownload(h.video());
  await opening;
  h.readyVideo();
  assert.equal(h.modal.video.tagName, 'VIDEO');
  assert.equal(h.modal.video.controls, true);
  assert.equal(h.modal.video.playsInline, true);
  assert.equal(h.modal.video.autoplay, false);
  assert.equal(h.modal.video.playCount, 0, 'let the user press Play');
  assert.equal(h.modal.video.hidden, false);
  assert.equal(h.modal.image.hidden, true);
  assert.equal(h.modal.zoomControls.hidden, true);
  assert.equal(h.modal.loading.hidden, true);
  assert.equal(h.modal.viewer.getAttribute('aria-busy'), 'false');
  assert.equal([...h.created.values()][0].type, 'video/mp4');
  assert.equal(h.cacheCalls.length, 0, 'full-video caching remains outside this change');
});

test('MP4, WebM and Ogg pass byte signature validation before media is attached', async () => {
  for (const type of ['video/mp4', 'video/webm', 'video/ogg']) {
    const h = new PreviewHarness();
    h.videoBlob = h.video(type);
    await h.chat().openMediaAttachment(h.row(type));
    assert.equal([...h.created.values()][0]?.type, type, type);
  }
});

test('active markup and mismatched image bytes never become video sources', async () => {
  for (const payload of [
    new Blob(['<!doctype html><script>parent.pwned=true</script>'], { type: 'video/mp4' }),
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'video/mp4' }),
  ]) {
    const h = new PreviewHarness();
    h.videoBlob = payload;
    await h.chat().openMediaAttachment(h.row());
    assert.equal(h.created.size, 0);
    assert.equal(h.modal.video.src, '');
    assert.match(h.modal.error.textContent, /save/i);
  }
});

test('closing while video decryption is pending prevents the viewer reopening', async () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  let resolveDownload;
  let signal;
  chat.decryptAttachmentToBlob = (...args) => {
    signal = args[3];
    return new Promise(resolve => { resolveDownload = resolve; });
  };
  const opening = chat.openMediaAttachment(h.row());
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  h.modal.close();
  assert.equal(signal.aborted, true, 'abort the outstanding media download');
  resolveDownload(h.video());
  await opening;
  assert.equal(h.modal.modal.classList.contains('active'), false);
  assert.equal(h.modal.video.src, '');
  assert.equal(h.created.size, 0);
});

test('a newer attachment wins when video decryptions complete out of order', async () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  const completions = [];
  chat.decryptAttachmentToBlob = () => new Promise(resolve => completions.push(resolve));
  const oldOpening = chat.openMediaAttachment(h.row('video/mp4', 'old.mp4'));
  const newOpening = chat.openMediaAttachment(h.row('video/webm', 'new.webm'));
  assert.equal(completions.length, 2, 'allow a new Open while the previous preview is loading');
  completions[1](h.video('video/webm'));
  await newOpening;
  const currentUrl = h.modal.video.src;
  completions[0](h.video());
  await oldOpening;
  assert.equal(h.modal.title.textContent, 'new.webm');
  assert.equal(h.modal.video.src, currentUrl);
  assert.equal(h.created.size, 1);
});

test('late download errors cannot replace a newer attachment or show stale feedback', async () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  let rejectDownload;
  chat.decryptAttachmentToBlob = () => new Promise((resolve, reject) => { rejectDownload = reject; });
  const opening = chat.openMediaAttachment(h.row());
  const imageRequest = h.modal.openLoading('new.png', 'image');
  h.modal.showImage(h.image(), imageRequest);
  rejectDownload(new Error('HTTP 404'));
  await opening;
  assert.equal(h.modal.title.textContent, 'new.png');
  assert.equal(h.modal.image.src, 'blob:preview-1');
  assert.equal(h.errors.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('closing during asynchronous signature validation prevents stale media display', async () => {
  const h = new PreviewHarness();
  h.videoBlob = h.video();
  let finishValidation;
  h.env.getSafeAttachmentPreviewMime = () => new Promise(resolve => { finishValidation = resolve; });
  const opening = h.chat().openMediaAttachment(h.row());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishValidation, 'function');
  h.modal.close();
  finishValidation('video/mp4');
  await opening;
  assert.equal(h.created.size, 0);
  assert.equal(h.modal.modal.classList.contains('active'), false);
});

test('close and Escape stop playback and release media URLs', () => {
  for (const useEscape of [false, true]) {
    const h = new PreviewHarness();
    const request = h.modal.openLoading('clip.mp4', 'video', 'blob:thumbnail');
    h.modal.showVideo(h.video(), request);
    h.readyVideo();
    const url = h.modal.video.src;
    if (useEscape) h.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
    else h.modal.closeButton.dispatch('click');
    assert.equal(h.modal.modal.classList.contains('active'), false);
    assert.equal(h.modal.isCurrentRequest(request), false);
    h.assertReleased(url);
    assert.equal(h.revoked.includes('blob:thumbnail'), false, 'thumbnail URL belongs to its existing cache owner');
  }
});

test('attachment replacement releases playing video and ignores stale media callbacks', () => {
  const h = new PreviewHarness();
  const request = h.modal.openLoading('old.mp4', 'video');
  h.modal.showVideo(h.video(), request);
  const oldUrl = h.modal.video.src;
  const oldReady = h.modal.video.onloadedmetadata;
  const oldError = h.modal.video.onerror;
  const next = h.modal.openLoading('new.png', 'image');
  h.assertReleased(oldUrl);
  h.modal.showImage(h.image(), next);
  oldReady?.();
  oldError?.();
  assert.equal(h.modal.title.textContent, 'new.png');
  assert.equal(h.modal.image.src, 'blob:preview-2');
  assert.equal(h.modal.loading.hidden, false, 'stale metadata cannot complete the newer image load');
  assert.equal(h.modal.viewer.getAttribute('aria-busy'), 'true');
  assert.equal(h.modal.isCurrentRequest(next), true);
});

test('unsupported codecs and playback errors release media and leave a useful Save fallback', () => {
  for (const unsupported of [false, true]) {
    const h = new PreviewHarness();
    h.modal.video.support = unsupported ? '' : 'probably';
    const request = h.modal.openLoading('clip.mp4', 'video');
    h.modal.showVideo(h.video(), request);
    const url = [...h.created.keys()][0];
    if (!unsupported) h.modal.video.dispatch('error');
    assert.equal(h.modal.loading.hidden, true);
    assert.equal(h.modal.video.src, '');
    assert.equal(h.modal.error.hidden, false);
    assert.match(h.modal.error.textContent, /save/i);
    if (url) h.assertReleased(url);
  }
});

test('video touch and zoom attempts leave native playback controls alone', () => {
  const h = new PreviewHarness();
  const request = h.modal.openLoading('clip.mp4', 'video');
  h.modal.showVideo(h.video(), request);
  h.readyVideo();
  let prevented = 0;
  const event = {
    target: h.modal.video,
    touches: [{ clientX: 10, clientY: 10 }, { clientX: 30, clientY: 30 }],
    preventDefault() { prevented += 1; },
  };
  h.modal.handleTouchStart(event);
  h.modal.handleTouchMove(event);
  h.modal.handleTouchEnd(event);
  h.modal.zoomBy(1);
  assert.equal(prevented, 0);
  assert.equal(h.modal.scale, 1);
  assert.equal(h.modal.touchGesture, null);
});

test('Save continues to download video and generate its existing cached thumbnail', async () => {
  const h = new PreviewHarness();
  h.videoBlob = h.video();
  const chat = h.chat();
  const row = h.row();
  await chat.saveImageAttachment(row);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.decryptCalls.length, 1, 'video Save uses the existing decrypt flow');
  assert.equal(h.cacheCalls.length, 0, 'video Save does not use the full-image cache');
  assert.equal(h.thumbnailCalls.length, 1);
  assert.equal(h.thumbnailCalls[0].type, 'video/mp4');
  assert.equal(h.savedThumbnails.length, 1);
  assert.equal(h.savedThumbnails[0][0], row.dataset.url);
  assert.equal(h.savedThumbnails[0][2], 'video/mp4');
  assert.deepEqual(h.savedFiles, [{
    type: 'DOWNLOAD_ATTACHMENT',
    filename: 'clip.mp4',
    mime: 'video/mp4',
    dataUrl: 'data:video/mp4;base64,c3ludGhldGlj',
  }]);
  assert.equal(chat.attachmentDownloadInProgress, false);
});

test('image Open retains the full-image cache route, image zoom and URL cleanup', async () => {
  const h = new PreviewHarness();
  h.imageBlob = h.image();
  const chat = h.chat();
  await chat.openMediaAttachment(h.row('image/png', 'photo.png'));
  h.modal.image.dispatch('load');
  assert.equal(h.cacheCalls.length, 1);
  assert.equal(h.decryptCalls.length, 0);
  assert.equal(h.modal.image.hidden, false);
  assert.equal(h.modal.video.hidden, true);
  h.modal.zoomBy(0.5);
  assert.equal(h.modal.scale, 1.5);
  assert.equal(h.modal.zoomControls.hidden, false);
  const imageUrl = h.modal.image.src;
  h.modal.close();
  assert.equal(h.modal.scale, 1);
  assert.equal(h.modal.image.src, '');
  assert.ok(h.revoked.includes(imageUrl));
});

test('sign-out invalidates pending previews and stops playback before clearing account data', async () => {
  const h = new PreviewHarness();
  const chat = h.chat();
  let resolveDownload;
  chat.decryptAttachmentToBlob = () => new Promise(resolve => { resolveDownload = resolve; });
  const opening = chat.openMediaAttachment(h.row());
  const accountCleared = new Error('account cleared');
  const menu = h.construct('MenuModal', 'menuModal', {
    backupModal: { isUploading: false },
    logsModal: { log() {} },
    myAccount: { username: 'synthetic' },
    checkPendingTransactionsIntervalId: null,
    getSystemNoticeIntervalId: null,
    callsModal: { stopPeriodicCallsRefresh() {} },
    saveState() {},
    clearMyData: () => { throw accountCleared; },
  });
  await assert.rejects(menu.handleSignOut(), error => error === accountCleared);
  assert.equal(h.modal.modal.classList.contains('active'), false);
  resolveDownload(h.video());
  await opening;
  assert.equal(h.created.size, 0);
  assert.equal(h.modal.video.src, '');

  const request = h.modal.openLoading('playing.mp4', 'video');
  h.modal.showVideo(h.video(), request);
  const playingUrl = h.modal.video.src;
  await assert.rejects(menu.handleSignOut(), error => error === accountCleared);
  h.assertReleased(playingUrl);
});
