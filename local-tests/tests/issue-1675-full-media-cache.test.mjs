// Standalone offline policy tests; use the companion browser test for real IndexedDB.
// WEB_CLIENT_ROOT=/absolute/client/checkout node local-tests/tests/issue-1675-full-media-cache.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the implementation checkout');
const app = readFileSync(join(process.env.WEB_CLIENT_ROOT, 'app.js'), 'utf8');
const { normalizeMimeType } = await import(pathToFileURL(join(process.env.WEB_CLIENT_ROOT, 'lib.js')));

class MemoryDatabase {
  stores = new Map([['fullImages', new Map()], ['thumbnails', new Map()]]);
  writeFailures = [];
  events = [];

  transaction(names, mode = 'readonly') {
    return new MemoryTransaction(this, Array.isArray(names) ? names : [names], mode);
  }
}

// Requests added by onsuccess run before the transaction completes; failed
// transactions discard tentative deletes as well as writes.
class MemoryTransaction {
  constructor(database, names, mode) {
    this.database = database;
    this.mode = mode;
    this.pending = 0;
    this.active = true;
    this.stores = new Map(names.map(name => {
      assert.ok(database.stores.has(name), `Unknown store: ${name}`);
      return [name, new Map(database.stores.get(name))];
    }));
    queueMicrotask(() => this.complete());
  }

  complete() {
    if (!this.active || this.pending) return;
    this.active = false;
    if (this.mode === 'readwrite') {
      for (const [name, rows] of this.stores) this.database.stores.set(name, rows);
    }
    this.oncomplete?.();
  }

  request(operation, request = {}) {
    assert.ok(this.active, 'IndexedDB requests require an active transaction');
    this.pending++;
    queueMicrotask(() => {
      if (!this.active) return;
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = this.error = error;
        request.onerror?.({ target: request });
        this.onerror?.({ target: request });
        this.abort();
      } finally {
        this.pending--;
        this.complete();
      }
    });
    return request;
  }

  abort() {
    this.active = false;
    this.onabort?.();
  }

  objectStore(name) {
    const rows = this.stores.get(name);
    assert.ok(rows, `Store ${name} not in this transaction`);
    const store = {
      get: key => this.request(() => rows.get(key)),
      getAll: () => this.request(() => [...rows.values()]),
      put: record => this.request(() => {
        assert.equal(this.mode, 'readwrite');
        this.database.events.push(`put:${record.id}`);
        const failure = this.database.writeFailures.shift();
        if (failure) throw failure;
        rows.set(record.id, record);
      }),
      delete: key => this.request(() => {
        assert.equal(this.mode, 'readwrite');
        this.database.events.push(`delete:${key}`);
        rows.delete(key);
      }),
      clear: () => this.request(() => rows.clear()),
      index: index => ({ openCursor: key => this.cursor(rows, store, index, key) }),
    };
    return store;
  }

  cursor(rows, store, index, key) {
    let entries = [...rows.values()];
    if (index === 'cachedAt') entries.sort((a, b) => a.cachedAt - b.cachedAt || a.id.localeCompare(b.id));
    else if (index === 'byOwner') entries = entries.filter(row => row.ownerKeys?.includes(key));
    else throw new Error(`Unexpected index: ${index}`);
    const request = {};
    let next = 0;
    const advance = () => this.request(() => {
      const value = entries[next++];
      return value ? {
        value, primaryKey: value.id, key: index === 'cachedAt' ? value.cachedAt : key,
        continue: advance, update: record => store.put(record), delete: () => store.delete(value.id),
      } : null;
    }, request);
    return advance();
  }
}

class CacheFixture {
  constructor(limit, estimate) {
    this.database = new MemoryDatabase();
    const ownerStart = app.indexOf('\nclass MediaCacheOwnership {');
    const ownerEnd = app.indexOf('\nclass ContactAvatarCache {', ownerStart);
    const thumbnailStart = app.indexOf('\nclass ThumbnailCache {');
    const thumbnailEnd = app.indexOf('\nconst thumbnailCache =', thumbnailStart);
    // Exercise the same behavior on the pre-change FullImageCache when reproducing regressions.
    const cacheName = app.includes('\nclass FullMediaCache {') ? 'FullMediaCache' : 'FullImageCache';
    const constant = cacheName === 'FullMediaCache' ? 'FULL_MEDIA_CACHE_MAX_SIZE' : 'FULL_IMAGE_CACHE_MAX_SIZE';
    const cacheStart = app.indexOf(`\nconst ${constant}`);
    const cacheEnd = app.indexOf(`\nconst ${cacheName[0].toLowerCase()}${cacheName.slice(1)} =`, cacheStart);
    assert.ok(ownerStart >= 0 && ownerEnd > ownerStart && thumbnailEnd > thumbnailStart && cacheEnd > cacheStart);
    let clock = 100;
    const environment = {
      myAccount: { username: 'synthetic', netid: 'network' },
      normalizeMimeType,
      navigator: estimate ? { storage: { estimate: async () => {
        this.database.events.push('estimate');
        return estimate();
      } } } : {},
      Date: { now: () => ++clock },
      console: { warn() {}, error() {} },
      IDBKeyRange: { only: value => value },
      FileReader: class {
        async readAsDataURL(blob) {
          this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
          this.onloadend();
        }
      },
    };
    const { ThumbnailCache, Cache } = new Function(...Object.keys(environment), `
      ${app.slice(ownerStart, ownerEnd)}
      ${app.slice(thumbnailStart, thumbnailEnd)}
      ${app.slice(cacheStart, cacheEnd)}
      return { ThumbnailCache, Cache: ${cacheName} };
    `)(...Object.values(environment));
    this.thumbnail = new ThumbnailCache();
    this.thumbnail.db = this.database;
    this.cache = new Cache(this.thumbnail, limit);
  }

  attachment(id, type = 'video/mp4', host = 'files.example') {
    return { url: `https://${host}/get/${id}`, type };
  }

  blob(bytes, type = 'video/mp4') { return new Blob([bytes], { type }); }

  seed(id, bytes, cachedAt, type = 'video/mp4', ownerKeys) {
    const blob = this.blob(bytes, type);
    this.database.stores.get('fullImages').set(id, {
      id, mimeType: type, blob, cachedAt, size: blob.size, ...(ownerKeys ? { ownerKeys } : {}),
    });
    return blob;
  }

  fetch(id, blob, shouldCache) {
    return this.cache.getOrCache({ attachment: this.attachment(id, blob.type), downloadAndDecrypt: async () => blob, shouldCache });
  }

  quotaError() { return new DOMException('Synthetic quota exceeded', 'QuotaExceededError'); }
}

test('full media has a 1 GiB budget independent of the 50 MiB thumbnail budget', () => {
  const h = new CacheFixture();
  assert.equal(h.cache.maxCacheSize, 1024 ** 3);
  assert.equal(h.thumbnail.maxCacheSize, 50 * 1024 ** 2);
});

test('legacy full images and cached videos share FIFO; reading an old record does not extend its life', async () => {
  const h = new CacheFixture(11);
  const image = h.seed('old-image', 'photo', 10, 'image/png', ['another_network']);
  const oldUrl = h.attachment('old-image', 'image/png', 'moved.example').url;
  const hit = await h.cache.getOrCache({
    attachment: { url: oldUrl, type: image.type },
    downloadAndDecrypt: async () => { throw new Error('Existing full image must not download again'); },
  });
  assert.equal(await hit?.text(), 'photo');
  const retained = await h.cache.getRecord(oldUrl);
  assert.equal(retained.cachedAt, 10);
  assert.deepEqual(retained.ownerKeys, ['another_network', 'synthetic_network']);

  const firstVideo = h.blob('video!');
  await h.fetch('video-a', firstVideo);
  assert.equal(await (await h.cache.get(h.attachment('video-a', 'video/mp4', 'moved.example').url))?.text(), 'video!');
  const secondVideo = h.blob('clip!');
  await h.fetch('video-b', secondVideo);
  assert.equal(await h.cache.get(oldUrl), null, 'the older image is evicted even after a cache hit');
  assert.equal(await (await h.cache.get(h.attachment('video-a').url))?.text(), 'video!');
  assert.equal(await (await h.cache.get(h.attachment('video-b').url))?.text(), 'clip!');
});

test('available browser quota is checked before writing and older records make space', async () => {
  const h = new CacheFixture(100, () => ({ usage: 98, quota: 100 }));
  h.seed('old', 'old!', 10, 'image/png');
  const recent = h.seed('recent', 'new!', 11);
  const incoming = h.blob('clip');
  await h.fetch('incoming', incoming);
  assert.equal(h.database.events[0], 'estimate');
  assert.equal(await h.cache.get(h.attachment('old').url), null);
  assert.equal(await (await h.cache.get(h.attachment('recent').url))?.text(), await recent.text());
  assert.equal(await (await h.cache.get(h.attachment('incoming').url))?.text(), await incoming.text());
});

test('quota errors evict FIFO and retry once, then reuse the newly cached video', async () => {
  const h = new CacheFixture(100);
  h.seed('old', 'photo', 10, 'image/png');
  const recent = h.seed('recent', 'still here', 20);
  h.database.writeFailures.push(h.quotaError());
  const incoming = h.blob('clip');
  assert.equal(await h.fetch('incoming', incoming), incoming);
  assert.equal(h.database.events.filter(event => event === 'put:incoming').length, 2);
  assert.equal(await h.cache.get(h.attachment('old').url), null);
  assert.equal(await (await h.cache.get(h.attachment('recent').url))?.text(), await recent.text());
  const hit = await h.cache.getOrCache({
    attachment: h.attachment('incoming'),
    downloadAndDecrypt: async () => { throw new Error('Quota retry should have committed the video'); },
  });
  assert.equal(await hit?.text(), await incoming.text());
});

test('repeated quota and non-quota write failures still return the in-memory media', async () => {
  for (const repeatedQuota of [true, false]) {
    const h = new CacheFixture(8);
    h.seed('old', 'photo', 10, 'image/png');
    h.database.writeFailures.push(...(repeatedQuota
      ? [h.quotaError(), h.quotaError()] : [new DOMException('Synthetic write failure', 'UnknownError')]));
    const incoming = h.blob('clip');
    assert.equal(await h.fetch('incoming', incoming), incoming);
    assert.equal(h.database.events.filter(event => event === 'put:incoming').length, repeatedQuota ? 2 : 1);
    assert.equal(await h.cache.get(h.attachment('incoming').url), null);
    const old = await h.cache.get(h.attachment('old').url);
    assert.equal(old ? await old.text() : null, repeatedQuota ? null : 'photo',
      'quota eviction commits before retry; non-quota transaction failure rolls back its tentative eviction');
  }
});

test('an IndexedDB read/open failure does not stop using freshly decrypted media', async () => {
  const h = new CacheFixture(100);
  h.thumbnail.init = async () => { throw new Error('Synthetic IndexedDB failure'); };
  const incoming = h.blob('clip');
  assert.equal(await h.fetch('incoming', incoming), incoming);
  assert.equal(h.database.events.length, 0);
});

test('oversized videos remain usable without evicting cached media', async () => {
  const h = new CacheFixture(5, () => ({ usage: 100, quota: 100 }));
  const image = h.seed('existing', 'photo', 10, 'image/png');
  const oversized = h.blob('longer clip');
  assert.equal(await h.fetch('too-large', oversized), oversized);
  assert.deepEqual(h.database.events, []);
  assert.equal(await h.cache.get(h.attachment('too-large').url), null);
  assert.equal(await (await h.cache.get(h.attachment('existing').url))?.text(), await image.text());
});

test('a download invalidated during decryption cannot reinsert an attachment removed from the cache', async () => {
  const h = new CacheFixture(100);
  const attachment = h.attachment('removed');
  let keepAttachment = true;
  let finishDownload;
  let started;
  const startedDownload = new Promise(resolve => { started = resolve; });
  const opening = h.cache.getOrCache({
    attachment,
    downloadAndDecrypt: () => new Promise(resolve => { finishDownload = resolve; started(); }),
    shouldCache: () => keepAttachment,
  });
  await startedDownload;
  keepAttachment = false;
  await h.cache.delete(attachment.url);
  const blob = h.blob('clip');
  finishDownload(blob);
  assert.equal(await opening, blob);
  assert.equal(await h.cache.get(attachment.url), null);
  assert.equal(h.database.events.includes('put:removed'), false);
});

test('full videos follow attachment deletion and remove-all without entering thumbnail backups', async () => {
  const h = new CacheFixture(100);
  h.seed('legacy-image', 'photo', 10, 'image/png');
  await h.fetch('video', h.blob('decrypted full video'));
  const thumbnail = h.blob('preview', 'image/jpeg');
  h.database.stores.get('thumbnails').set('video', { id: 'video', thumbnail, originalType: 'video/mp4' });
  const backup = await h.thumbnail.exportAll();
  assert.deepEqual(Object.keys(backup), ['video']);
  assert.equal(Buffer.from(backup.video.data, 'base64').toString(), 'preview');
  assert.equal(backup.video.originalType, 'video/mp4');
  const videoUrl = h.attachment('video', 'video/mp4', 'moved.example').url;
  assert.ok(await h.cache.get(videoUrl));
  await h.cache.delete(videoUrl);
  assert.equal(await h.cache.get(videoUrl), null);
  await h.fetch('video', h.blob('redownloaded full video'));
  await h.cache.clear();
  assert.equal(await h.cache.get(videoUrl), null);
  assert.equal(await h.cache.get(h.attachment('legacy-image').url), null);
  assert.deepEqual(Object.keys(await h.thumbnail.exportAll()), ['video']);
});

test('remove-all does not let an earlier download repopulate the full media cache', async () => {
  const h = new CacheFixture(100);
  const attachment = h.attachment('in-flight');
  const blob = h.blob('clip');
  const result = await h.cache.getOrCache({
    attachment,
    downloadAndDecrypt: async () => {
      await h.cache.clear();
      return blob;
    },
  });
  assert.equal(result, blob);
  assert.equal(await h.cache.get(attachment.url), null);
});
