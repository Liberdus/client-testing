// Offline Chromium test with synthetic data, actual crypto, and real IndexedDB.
// Requires ffmpeg with libvpx. Install the companion's pinned Playwright dependencies.
// WEB_CLIENT_ROOT=/absolute/client PLAYWRIGHT_ROOT=/absolute/client-testing/playwright-tests \
//   node --test local-tests/tests/issue-1675-full-video-cache.browser.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const videoMime = 'video/webm';
const assetTypes = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const syntheticKey = Buffer.alloc(32, 11);
const syntheticOwner = 'cachefixture_test';

function extract(source, start, end) {
  const first = source.indexOf(`\n${start}`);
  const last = source.indexOf(`\n${end}`, first + 1);
  assert.ok(first >= 0 && last > first, `Find production source from ${start} through ${end}`);
  return source.slice(first, last);
}

export class VideoCacheFixture {
  requests = new Map();
  bodies = new Map();
  unavailable = new Set();

  async start() {
    const clientRoot = process.env.WEB_CLIENT_ROOT;
    assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout');
    const companion = fileURLToPath(new URL('../..', import.meta.url));
    const require = createRequire(resolve(process.env.PLAYWRIGHT_ROOT || resolve(companion, 'playwright-tests'), 'package.json'));
    const { chromium } = require('playwright');
    const app = await readFile(resolve(clientRoot, 'app.js'), 'utf8');
    const index = (await readFile(resolve(clientRoot, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const { encryptChacha } = await import(pathToFileURL(resolve(clientRoot, 'crypto.js')));
    this.encrypt = bytes => Buffer.from(encryptChacha(syntheticKey, bytes.toString('base64')), 'base64');
    this.clip = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24',
      '-t', '4', '-c:v', 'libvpx', '-threads', '2', '-f', 'webm', 'pipe:1'], { timeout: 30000 });
    // The old cache name keeps the same behavior checks runnable on the before-fix client.
    const cacheName = app.includes('\nclass FullMediaCache {') ? 'Media' : 'Image';
    this.source = [
      extract(app, 'function encodeAttachmentName(', '// Used in getNetworkParams function'),
      extract(app, 'function getDeletedState(', 'function isDeletedForMeOnly('),
      extract(app, 'function generateMessageHash(', 'function normalizeFailureReason('),
      extract(app, 'function showToast(', '// Handle online/offline events'),
      extract(app, 'class MediaCacheOwnership {', '/** Handles IndexedDB storage for contact avatar thumbnails. */'),
      extract(app, 'class ThumbnailCache {', 'const thumbnailCache = new ThumbnailCache();'),
      extract(app, `const FULL_${cacheName.toUpperCase()}_CACHE_MAX_SIZE`, `const full${cacheName}Cache = new Full${cacheName}Cache(thumbnailCache);`),
      extract(app, 'class ChatModal {', 'const chatModal = new ChatModal();'),
      extract(app, 'class FullImageModal {', 'const fullImageModal = new FullImageModal();'),
      `const thumbnailCache = new ThumbnailCache(); const full${cacheName}Cache = new Full${cacheName}Cache(thumbnailCache);`,
    ].join('\n');

    this.server = createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(index);
      if (pathname.startsWith('/get/')) {
        const id = pathname.slice(5);
        this.requests.set(id, this.requestCount(id) + 1);
        const encrypted = this.bodies.get(id);
        if (this.unavailable.has(id) || !encrypted) return response.writeHead(410).end();
        return response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }).end(encrypted);
      }
      try {
        const file = resolve(clientRoot, '.' + decodeURIComponent(pathname));
        assert.ok(file.startsWith(clientRoot + sep));
        response.writeHead(200, { 'Content-Type': assetTypes[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((done, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done); });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.browser = await chromium.launch({ headless: true });
  }

  async stop() {
    await this.browser?.close();
    if (this.server) await new Promise(done => this.server.close(done));
  }

  requestCount(id) {
    return this.requests.get(id) || 0;
  }

  attachment(id, { bytes = this.clip, filename = 'Synthetic clip.webm' } = {}) {
    this.bodies.set(id, this.encrypt(bytes));
    return { id, url: `${this.origin}/get/${id}`, name: filename, type: videoMime, size: bytes.length, encKey: syntheticKey.toString('base64') };
  }

  async createSession(options = {}) {
    const context = await this.browser.newContext({ serviceWorkers: 'block', ...options });
    const external = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(`${this.origin}/`) || route.request().url().startsWith('blob:')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('popup', popup => popup.close());
    await page.goto(this.origin);
    return { context, page, external, errors };
  }

  async install(page, attachment, { blockCache = false } = {}) {
    await page.evaluate(async ({ attachment, blockCache }) => {
      window.fixture = { attachment, decrypts: 0, previewPopups: 0, revokedUrls: [] };
      window.fixture.lib = await import('/lib.js');
      window.fixture.crypto = await import('/crypto.js');
      if (blockCache) IDBFactory.prototype.open = () => { throw new DOMException('Test blocks storage access', 'SecurityError'); };
      const open = window.open.bind(window);
      window.open = (...args) => { fixture.previewPopups++; return open(...args); };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { fixture.revokedUrls.push(url); revoke(url); };
    }, { attachment, blockCache });
    await page.addScriptTag({ content: `
      const { base642bin, bin2base64, escapeHtml, escapeHtmlAttribute, formatTime, getSafeAttachmentPreviewMime,
        linkifyUrls, normalizeMimeType, normalizeResourceUrl, normalizeTransactionId, openModal } = fixture.lib;
      const { hashBytes } = fixture.crypto;
      const decryptChacha = (...args) => { fixture.decrypts++; return fixture.crypto.decryptChacha(...args); };
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const getCorrectedTimestamp = Date.now;
      const EVM_CHAT_MESSAGE_TYPE = 'evm-payment';
      const INTENTS_CHAT_MESSAGE_TYPE = 'intents-payment';
      const CHAT_THUMBNAIL_ATTACHMENT_SELECTOR = '[data-image-attachment="true"], [data-video-attachment="true"]';
      const myAccount = { username: 'cachefixture', netid: 'test' };
      const removeAccountModal = { isRemoving: false };
      const removeAccountsModal = { isRemovingAll: false };
      const message = { type: 'message', timestamp: Date.now(), message: fixture.attachment.name, deleted: '0', xattach: [fixture.attachment] };
      const contact = { messages: [message] };
      const myData = { contacts: { synthetic: contact } };
      ${this.source}
      const fullImageModal = new FullImageModal();
      fullImageModal.load();
      document.querySelector('#bootSplash')?.remove();
      const chat = Object.create(ChatModal.prototype);
      chat.address = 'synthetic';
      chat.abortController = new AbortController();
      chat.imageAttachmentContextMenu = document.querySelector('#imageAttachmentContextMenu');
      chat.imageAttachmentContextMenuReactions = chat.imageAttachmentContextMenu.querySelector('.message-context-reactions');
      // Account setup, reactions and delete-for-all authorization are outside this fixture.
      chat.closeAllContextMenus = () => chat.closeImageAttachmentContextMenu();
      chat.canDeleteMessageForAll = () => false;
      for (const method of ['syncContextReactionTrayDisplay', 'syncReactionPickerActiveState', 'syncDeleteContextMenuDisabledState']) chat[method] = () => {};
      const chatModal = document.querySelector('#chatModal');
      chatModal.querySelector('.modal-title').textContent = 'Synthetic chat';
      chatModal.querySelector('.messages-list').innerHTML = chat.renderChatMessageHTML(message, { contact, lastReadTs: 0 });
      chatModal.classList.add('active');
      const row = chatModal.querySelector('.attachment-row');
      row.addEventListener('click', event => chat.showAttachmentContextMenu(event, row));
      chat.imageAttachmentContextMenu.addEventListener('click', event => {
        const option = event.target.closest('[data-action]');
        if (option) chat.handleImageAttachmentContextMenuAction(option.dataset.action);
      });
      fixture.db = thumbnailCache;
      fixture.removeAttachment = () => {
        message.xattach = [];
        chat.purgeAttachmentCaches([fixture.attachment]);
      };
      if (!${blockCache}) void chat.loadThumbnailForAttachment(row);
    ` });
  }

  async choose(page, action) {
    await page.locator('#chatModal .attachment-row').click();
    await page.locator(`#imageAttachmentContextMenu [data-action="${action}"]`).click();
  }

  async open(page) {
    await this.choose(page, 'open');
    const outcome = await page.waitForFunction(() => {
      const video = document.querySelector('#fullImageViewerVideo');
      const error = document.querySelector('#fullImageError');
      if (!error.hidden) return error.textContent;
      return video.readyState >= 2 && !video.hidden && video.duration >= 3.9 && 'ready';
    }, null, { timeout: 8000 });
    assert.equal(await outcome.jsonValue(), 'ready', 'Open decodes the synthetic WebM in the in-app native player');
    await page.locator('#fullImageModal.is-transition-complete').waitFor();
  }

  async close(page) {
    const video = page.locator('#fullImageViewerVideo');
    const source = await video.getAttribute('src');
    await page.locator('#closeFullImageModal').click();
    assert.equal(await video.getAttribute('src'), null, 'Closing clears the video source');
    assert.equal(await video.evaluate(element => element.paused), true, 'Closing stops video');
    if (source) assert.equal(await page.evaluate(url => fixture.revokedUrls.includes(url), source), true, 'Closing revokes the playback object URL');
  }

  async save(page, attachment, bytes = this.clip) {
    const download = page.waitForEvent('download', { timeout: 8000 });
    await this.choose(page, 'save');
    const result = await download;
    assert.equal(result.suggestedFilename(), attachment.name);
    assert.deepEqual(await readFile(await result.path()), bytes, 'Save delivers the exact original decrypted bytes');
  }

  async counts(page, id) {
    return { requests: this.requestCount(id), decrypts: await page.evaluate(() => fixture.decrypts) };
  }
}

async function seedLegacyRows(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('liberdus_thumbnails', 4);
    request.onupgradeneeded = () => {
      for (const name of ['thumbnails', 'fullImages']) {
        const store = request.result.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('cachedAt', 'cachedAt');
        store.createIndex('byOwner', 'ownerKeys', { multiEntry: true });
        const blob = new Blob([name], { type: 'image/jpeg' });
        const record = name === 'fullImages' ? { blob, size: blob.size, mimeType: blob.type } : { thumbnail: blob, originalType: blob.type };
        store.put({ ...record, id: 'legacy-image', cachedAt: 123 });
      }
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }));
}

async function readRow(page, store, id) {
  return page.evaluate(async ({ store, id }) => {
    const db = await fixture.db.init();
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record) return null;
    const blob = record.blob || record.thumbnail;
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return { version: db.version, size: blob.size, type: blob.type, ownerKeys: record.ownerKeys, digest: fixture.lib.bin2base64(new Uint8Array(digest)) };
  }, { store, id });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = new VideoCacheFixture();
  before(() => fixture.start());
  after(() => fixture.stop());

  for (const [id, actions] of [
    ['open-open', ['open', 'open']], ['open-save', ['open', 'save']],
    ['save-open', ['save', 'open']], ['save-save', ['save', 'save']],
  ]) {
    test(`${actions.join(' → ')} fetches and decrypts once`, async t => {
      const attachment = fixture.attachment(id);
      const { context, page, external, errors } = await fixture.createSession();
      t.after(() => context.close());
      await fixture.install(page, attachment);
      for (const action of actions) {
        if (action === 'save') await fixture.save(page, attachment);
        else { await fixture.open(page); await fixture.close(page); }
      }
      assert.deepEqual(await fixture.counts(page, id), { requests: 1, decrypts: 1 });
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    });
  }

  test('IndexedDB survives reload and keeps existing v4 image and thumbnail data', async t => {
    const attachment = fixture.attachment('persisted');
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await seedLegacyRows(page);
    await fixture.install(page, attachment);
    await fixture.open(page);
    const video = page.locator('#fullImageViewerVideo');
    assert.equal(await video.getAttribute('controls'), '');
    assert.equal(await video.getAttribute('playsinline'), '');
    await video.evaluate(element => element.play());
    await page.waitForFunction(() => document.querySelector('#fullImageViewerVideo').currentTime > 0.1);
    await fixture.close(page);
    const record = await readRow(page, 'fullImages', attachment.id);
    assert.ok(record, 'Open stores the full video in IndexedDB');
    assert.deepEqual(record, {
      version: 4, size: fixture.clip.length, type: videoMime, ownerKeys: [syntheticOwner],
      digest: createHash('sha256').update(fixture.clip).digest('base64'),
    });
    fixture.unavailable.add(attachment.id);
    await page.reload();
    await fixture.install(page, attachment);
    await fixture.open(page);
    await fixture.close(page);
    await fixture.save(page, attachment);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 0 }, 'Reload performs neither another fetch nor another decrypt');
    await page.locator('#chatModal .attachment-thumbnail').waitFor();
    await page.evaluate(() => fixture.removeAttachment());
    assert.equal(await readRow(page, 'fullImages', attachment.id), null, 'Removal purges full video bytes');
    assert.equal(await readRow(page, 'thumbnails', attachment.id), null, 'Removal purges the video thumbnail');
    for (const name of ['fullImages', 'thumbnails']) {
      const legacy = await readRow(page, name, 'legacy-image');
      assert.equal(legacy.digest, createHash('sha256').update(name).digest('base64'));
      assert.equal(legacy.ownerKeys, undefined, 'Legacy unowned rows retain their shape');
    }
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });

  test('cache unavailable still allows Open and Save', async t => {
    const attachment = fixture.attachment('blocked');
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await fixture.install(page, attachment, { blockCache: true });
    await fixture.open(page);
    await fixture.close(page);
    await fixture.save(page, attachment);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 2, decrypts: 2 });
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'No persistent cache exists');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });

  test('mobile bridge receives original bytes from a cached Open', async t => {
    const attachment = fixture.attachment('mobile-bridge');
    const { context, page, external, errors } = await fixture.createSession({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    t.after(() => context.close());
    await fixture.install(page, attachment);
    await fixture.open(page);
    await fixture.close(page);
    await page.evaluate(() => {
      window.ReactNativeWebView = { postMessage: message => { fixture.bridgeDownload = JSON.parse(message); } };
    });
    await fixture.choose(page, 'save');
    const handle = await page.waitForFunction(() => fixture.bridgeDownload, null, { timeout: 8000 });
    const { dataUrl, ...details } = await handle.jsonValue();
    assert.deepEqual(details, { type: 'DOWNLOAD_ATTACHMENT', filename: attachment.name, mime: videoMime });
    assert.equal(dataUrl, `data:${videoMime};base64,${fixture.clip.toString('base64')}`, 'Bridge delivers the exact video data URL');
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 1 });
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });

  test('unsafe bytes cannot become a video preview after reuse', async t => {
    const bytes = Buffer.from('<html><script>alert("unsafe")</script></html>');
    const attachment = fixture.attachment('unsafe', { bytes, filename: 'Unsafe bytes.webm' });
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await fixture.install(page, attachment);
    await fixture.save(page, attachment, bytes);
    assert.equal(await page.evaluate(() => fixture.previewPopups), 0, 'Save never opens unsafe bytes in a new tab');
    await fixture.choose(page, 'open');
    const error = page.locator('#fullImageError');
    await error.waitFor();
    assert.match(await error.textContent(), /cannot be previewed safely/i);
    assert.equal(await page.locator('#fullImageViewerVideo').getAttribute('src'), null);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 1 }, 'Preview checks cached bytes as well as freshly decrypted bytes');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });
}
