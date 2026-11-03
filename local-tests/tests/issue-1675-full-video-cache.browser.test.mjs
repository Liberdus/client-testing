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
const wrongKey = Buffer.alloc(32, 12).toString('base64');
const syntheticOwner = 'cachefixture_test';
const syntheticAccountKeys = { secret: 'fixture-secret', pqSeed: 'fixture-pq-seed' };
const legacyImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgTqkAAAFlAOgNRA6IAAAAAElFTkSuQmCC', 'base64');

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
    const { encryptChacha, encryptData } = await import(pathToFileURL(resolve(clientRoot, 'crypto.js')));
    this.encrypt = bytes => Buffer.from(encryptChacha(syntheticKey, bytes.toString('base64')), 'base64');
    this.selfKey = encryptData(syntheticKey.toString('hex'), syntheticAccountKeys.secret + syntheticAccountKeys.pqSeed, true);
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
      extract(app, 'class ShareAttachmentModal {', 'const shareAttachmentModal = new ShareAttachmentModal();'),
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
    await page.evaluate(async ({ attachment, blockCache, accountKeys }) => {
      window.fixture = { attachment, accountKeys, decrypts: 0, previewPopups: 0, revokedUrls: [] };
      window.fixture.lib = await import('/lib.js');
      window.fixture.crypto = await import('/crypto.js');
      if (blockCache) IDBFactory.prototype.open = () => { throw new DOMException('Test blocks storage access', 'SecurityError'); };
      const open = window.open.bind(window);
      window.open = (...args) => { fixture.previewPopups++; return open(...args); };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { fixture.revokedUrls.push(url); revoke(url); };
    }, { attachment, blockCache, accountKeys: syntheticAccountKeys });
    await page.addScriptTag({ content: `
      const { base642bin, bin2base64, escapeHtml, escapeHtmlAttribute, formatTime, getSafeAttachmentPreviewMime, hex2bin,
        linkifyUrls, normalizeMimeType, normalizeResourceUrl, normalizeTransactionId, openModal } = fixture.lib;
      const { decryptData, hashBytes } = fixture.crypto;
      const decryptChacha = (...args) => { fixture.decrypts++; return fixture.crypto.decryptChacha(...args); };
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const getCorrectedTimestamp = Date.now;
      const EVM_CHAT_MESSAGE_TYPE = 'evm-payment';
      const INTENTS_CHAT_MESSAGE_TYPE = 'intents-payment';
      const CHAT_THUMBNAIL_ATTACHMENT_SELECTOR = '[data-image-attachment="true"], [data-video-attachment="true"]';
      const myAccount = { username: 'cachefixture', netid: 'test', keys: fixture.accountKeys };
      const removeAccountModal = { isRemoving: false };
      const removeAccountsModal = { isRemovingAll: false };
      const message = { type: 'message', timestamp: Date.now(), message: fixture.attachment.name, deleted: '0',
        my: Boolean(fixture.attachment.selfKey), xattach: [fixture.attachment] };
      const contact = { messages: [message] };
      const myData = { contacts: { synthetic: contact } };
      ${this.source}
      const fullImageModal = new FullImageModal();
      fullImageModal.load();
      document.querySelector('#bootSplash')?.remove();
      const chatModal = Object.create(ChatModal.prototype);
      chatModal.address = 'synthetic';
      chatModal.abortController = new AbortController();
      chatModal.imageAttachmentContextMenu = document.querySelector('#imageAttachmentContextMenu');
      chatModal.imageAttachmentContextMenuReactions = chatModal.imageAttachmentContextMenu.querySelector('.message-context-reactions');
      // Account setup, reactions and delete-for-all authorization are outside this fixture.
      chatModal.closeAllContextMenus = () => chatModal.closeImageAttachmentContextMenu();
      chatModal.canDeleteMessageForAll = () => false;
      for (const method of ['syncContextReactionTrayDisplay', 'syncReactionPickerActiveState', 'syncDeleteContextMenuDisabledState']) chatModal[method] = () => {};
      const chatElement = document.querySelector('#chatModal');
      chatElement.querySelector('.modal-title').textContent = 'Synthetic chat';
      chatElement.querySelector('.messages-list').innerHTML = chatModal.renderChatMessageHTML(message, { contact, lastReadTs: 0 });
      chatElement.classList.add('active');
      const row = chatElement.querySelector('.attachment-row');
      row.addEventListener('click', event => chatModal.showAttachmentContextMenu(event, row));
      chatModal.imageAttachmentContextMenu.addEventListener('click', event => {
        const option = event.target.closest('[data-action]');
        if (option) chatModal.handleImageAttachmentContextMenuAction(option.dataset.action);
      });
      fixture.db = thumbnailCache;
      fixture.shareMetadata = () => ShareAttachmentModal.prototype.extractAttachmentData(row.closest('.message'));
      fixture.removeAttachment = () => {
        const attachments = message.xattach;
        message.xattach = [];
        return chatModal.purgeAttachmentCaches(attachments, message);
      };
      if (!${blockCache}) void chatModal.loadThumbnailForAttachment(row);
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
  await page.evaluate(imageBase64 => new Promise((resolve, reject) => {
    const request = indexedDB.open('liberdus_thumbnails', 4);
    request.onupgradeneeded = () => {
      for (const name of ['thumbnails', 'fullImages']) {
        const store = request.result.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('cachedAt', 'cachedAt');
        store.createIndex('byOwner', 'ownerKeys', { multiEntry: true });
        const blob = new Blob([Uint8Array.from(atob(imageBase64), character => character.charCodeAt(0))], { type: 'image/png' });
        const record = name === 'fullImages' ? { blob, size: blob.size, mimeType: blob.type } : { thumbnail: blob, originalType: blob.type };
        store.put({ ...record, id: 'legacy-image', cachedAt: 123 });
      }
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }), legacyImage.toString('base64'));
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

  for (const [action, type] of [['open', videoMime], ['save', videoMime], ['save', 'image/png']]) {
    test(`${action} rejects cached video bytes with a different key declared as ${type}`, async t => {
      const attachment = fixture.attachment(`wrong-key-${action}-${type.split('/')[1]}`);
      const { context, page, external, errors } = await fixture.createSession();
      t.after(() => context.close());
      await fixture.install(page, attachment);
      await fixture.open(page);
      await fixture.close(page);
      await page.reload();
      await fixture.install(page, { ...attachment, type, encKey: wrongKey });

      if (action === 'open') {
        await fixture.choose(page, 'open');
        const outcome = await page.waitForFunction(() => {
          if (!document.querySelector('#fullImageError').hidden) return 'error';
          return document.querySelector('#fullImageViewerVideo').readyState >= 2 && 'played';
        }, null, { timeout: 8000 });
        assert.equal(await outcome.jsonValue(), 'error', 'Open must not play cached bytes with a different key');
        assert.equal(await page.locator('#fullImageViewerVideo').getAttribute('src'), null);
      } else {
        const result = Promise.race([
          page.waitForEvent('download', { timeout: 8000 }).then(() => 'downloaded'),
          page.locator('#toastContainer .toast.error.show').waitFor({ timeout: 8000 }).then(() => 'error'),
        ]);
        const [outcome] = await Promise.all([result, fixture.choose(page, 'save')]);
        assert.equal(outcome, 'error', 'Save must not download cached bytes with a different key');
        assert.equal(await page.evaluate(() => fixture.previewPopups), 0, 'Save must not open the cached video in a new tab');
      }

      assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 2, decrypts: 1 }, 'The different key misses the cache and fails authenticated decryption');
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    });
  }

  for (const type of [videoMime, 'image/png']) {
    test(`purging the same attachment ID with a different key declared as ${type} preserves the cached video`, async t => {
      const attachment = fixture.attachment(`purge-wrong-key-${type.split('/')[1]}`);
      const { context, page, external, errors } = await fixture.createSession();
      t.after(() => context.close());
      await fixture.install(page, attachment);
      await fixture.open(page);
      await fixture.close(page);
      fixture.unavailable.add(attachment.id);

      await page.reload();
      await fixture.install(page, { ...attachment, type, encKey: wrongKey });
      await page.evaluate(() => fixture.removeAttachment());
      // Wait behind the cache transaction before closing the deleting document.
      await readRow(page, 'fullImages', attachment.id);

      await page.reload();
      await fixture.install(page, attachment);
      await fixture.open(page);
      await fixture.close(page);
      await fixture.save(page, attachment);
      assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 0 });
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    });
  }

  test('shared video metadata reuses the cached bytes across storage hosts', async t => {
    const attachment = fixture.attachment('shared-key');
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await fixture.install(page, attachment);
    await fixture.open(page);
    await fixture.close(page);
    const shared = await page.evaluate(() => fixture.shareMetadata());
    assert.equal(shared.url, attachment.url, 'Share copies the storage URL');
    assert.equal(shared.encKey, attachment.encKey, 'Share copies the original encryption key');

    const alias = new URL(shared.url);
    alias.protocol = 'https:';
    alias.hostname = 'localhost';
    fixture.unavailable.add(attachment.id);
    await page.reload();
    const copiedAttachment = { ...shared, url: alias.href };
    await fixture.install(page, copiedAttachment);
    await fixture.open(page);
    await fixture.close(page);
    await fixture.save(page, copiedAttachment);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 0 }, 'The copy uses the same IndexedDB data after reload');
    assert.deepEqual(external, [], 'A cache hit never contacts the alternate storage host');
    assert.deepEqual(errors, []);
  });

  test('existing unkeyed image cache entries still open and save', async t => {
    const id = 'legacy-image';
    const attachment = { id, url: `${fixture.origin}/get/${id}`, name: 'Legacy image.png', type: 'image/png', size: legacyImage.length };
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await seedLegacyRows(page);
    await fixture.install(page, attachment);
    await fixture.choose(page, 'open');
    await page.waitForFunction(() => {
      const image = document.querySelector('#fullImageViewerImage');
      return !image.hidden && image.complete && image.naturalWidth === 1;
    }, null, { timeout: 8000 });
    await fixture.close(page);
    await fixture.save(page, attachment, legacyImage);
    assert.deepEqual(await fixture.counts(page, id), { requests: 0, decrypts: 0 });
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });

  test('legacy selfKey and explicit encKey resolve to the same cached video', async t => {
    const attachment = fixture.attachment('legacy-video-key');
    const { context, page, external, errors } = await fixture.createSession();
    t.after(() => context.close());
    await fixture.install(page, { ...attachment, encKey: undefined, selfKey: fixture.selfKey });
    await fixture.open(page);
    await fixture.close(page);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 1 });
    fixture.unavailable.add(attachment.id);
    await page.reload();
    await fixture.install(page, attachment);
    await fixture.save(page, attachment);
    assert.deepEqual(await fixture.counts(page, attachment.id), { requests: 1, decrypts: 0 });
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });

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
      assert.equal(legacy.digest, createHash('sha256').update(legacyImage).digest('base64'));
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
