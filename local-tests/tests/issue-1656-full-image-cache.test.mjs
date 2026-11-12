import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeMimeType } from '../lib.js';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const thumbnailSource = appSource.slice(
  appSource.indexOf('\nclass ThumbnailCache'),
  appSource.indexOf('\nconst thumbnailCache = new ThumbnailCache();'),
);
const ownershipSource = appSource.slice(
  appSource.indexOf('\nclass MediaCacheOwnership'),
  appSource.indexOf('\nclass ContactAvatarCache'),
);
const cacheSource = appSource.slice(
  appSource.indexOf('\nconst FULL_MEDIA_CACHE_MAX_SIZE'),
  appSource.indexOf('\nconst fullMediaCache = new FullMediaCache(thumbnailCache);'),
);
const { FullMediaCache } = new Function(
  'normalizeMimeType', 'myAccount',
  `${thumbnailSource}\n${ownershipSource}\n${cacheSource}\nreturn { FullMediaCache };`,
)(normalizeMimeType, { username: 'synthetic', netid: 'test-network' });

class MemoryCache extends FullMediaCache {
  constructor() {
    super({ ownership: { deleting: false } });
    this.records = new Map();
  }

  async get(attachmentUrl, _owner, acceptsRecord) {
    const record = this.records.get(attachmentUrl);
    return acceptsRecord(record) ? record.blob : null;
  }

  async put({ attachment, blob }) {
    this.records.set(attachment.url, { mimeType: attachment.type, blob });
  }
}

async function blobText(blob) {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

test('downloads once and reuses the full image by URL', async () => {
  const cache = new MemoryCache();
  const attachment = { url: 'https://files.example/get/image-a', type: 'image/png' };
  let decryptions = 0;

  const resolveImage = () => cache.getOrCache({
    attachment,
    downloadAndDecrypt: async () => {
      decryptions += 1;
      return new Blob(['full-image-bytes'], { type: attachment.type });
    },
  });

  const firstBlob = await resolveImage();
  const secondBlob = await resolveImage();

  assert.equal(decryptions, 1);
  assert.equal(await blobText(firstBlob), 'full-image-bytes');
  assert.equal(await blobText(secondBlob), 'full-image-bytes');
});

test('different URLs do not collide when images have the same filename', async () => {
  const cache = new MemoryCache();
  const first = { url: 'https://files.example/get/a', name: 'photo.png', type: 'image/png' };
  const second = { url: 'https://files.example/get/b', name: 'photo.png', type: 'image/png' };

  const firstBlob = await cache.getOrCache({
    attachment: first,
    downloadAndDecrypt: async () => new Blob(['first'], { type: first.type }),
  });
  const secondBlob = await cache.getOrCache({
    attachment: second,
    downloadAndDecrypt: async () => new Blob(['second'], { type: second.type }),
  });

  assert.equal(cache.records.size, 2);
  assert.equal(await blobText(firstBlob), 'first');
  assert.equal(await blobText(secondBlob), 'second');
});

test('evicts the oldest full images until the incoming image fits', async () => {
  const records = [
    { id: 'a', size: 5, cachedAt: 1 },
    { id: 'b', size: 6, cachedAt: 2 },
  ];
  const deletedUrls = [];
  let insertedRecord;
  let finish;
  let result = false;
  const store = {
    get: (id) => {
      assert.equal(id, 'c');
      const request = {};
      queueMicrotask(() => request.onsuccess());
      return request;
    },
    index: (name) => {
      assert.equal(name, 'cachedAt');
      return {
        openCursor: () => {
          const request = {};
          let recordIndex = 0;
          const advance = () => {
            const record = records[recordIndex];
            const cursor = record
              ? {
                  value: record,
                  primaryKey: record.id,
                  continue: () => {
                    recordIndex += 1;
                    queueMicrotask(advance);
                  },
                }
              : null;
            request.result = cursor;
            request.onsuccess();
            if (!cursor) finish(result);
          };
          queueMicrotask(advance);
          return request;
        },
      };
    },
    delete: url => deletedUrls.push(url),
    put: (record) => { insertedRecord = record; },
  };
  const database = {
    fullMediaStoreName: 'fullImages',
    ownership: {
      run: (storeNames, owner, action) => new Promise((resolve) => {
        assert.deepEqual(storeNames, ['fullImages']);
        finish = resolve;
        action({
          transaction: { objectStore: () => store },
          owners: [owner],
          setResult: value => { result = value; },
        });
      }),
    },
  };
  const cache = new FullMediaCache(database, 11);

  const cached = await cache.put({
    attachment: { url: 'https://files.example/get/c', type: 'image/png' },
    blob: new Blob(['third'], { type: 'image/png' }),
    owner: 'synthetic_test-network',
    shouldCache: () => true,
  });

  assert.equal(cached, true);
  assert.deepEqual(deletedUrls, ['a']);
  assert.equal(insertedRecord.id, 'c');
});

test('cache failures do not prevent use of a freshly decrypted image', async () => {
  const cache = new MemoryCache();
  const downloadedBlob = new Blob(['fresh-bytes'], { type: 'image/png' });
  cache.put = async () => { throw new Error('QuotaExceededError'); };

  const blob = await cache.getOrCache({
    attachment: { url: 'https://files.example/get/image', type: 'image/png' },
    downloadAndDecrypt: async () => downloadedBlob,
  });

  assert.equal(blob, downloadedBlob);
});

test('saving full images uses the shared media cache and preserves the native download handoff', async () => {
  const methodStart = appSource.indexOf('\n  async getAttachmentBlob(');
  const methodEnd = appSource.indexOf('\n  async handleAttachmentDownload(', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  const Harness = new Function(
    'FullMediaCache', 'fullMediaCache', 'normalizeMimeType', 'myAccount',
    `return class Harness {${appSource.slice(methodStart, methodEnd)}\n}`,
  )(FullMediaCache, { getOrCache: async ({ attachment }) => cached.push(attachment.url) }, normalizeMimeType, {});
  const cached = [];
  const harness = new Harness();
  harness.abortController = new AbortController();
  const downloaded = [];
  harness.decryptAttachmentToBlob = async (_item, row) => downloaded.push(row.dataset.url);
  for (const [type, filename] of [['image/png', 'image'], ['application/pdf', 'document']]) {
    const url = `https://files.example/${filename}`;
    const row = { dataset: { url } };
    const item = { xattach: [{ url, type }] };
    await harness.getAttachmentBlob(item, row);
  }
  assert.deepEqual(cached, ['https://files.example/image']);
  assert.deepEqual(downloaded, ['https://files.example/document']);
  assert.match(appSource.slice(methodEnd), /async handleAttachmentDownload\(item, linkEl\) \{[^]*?const blob = await this\.getAttachmentBlob\(item, linkEl\)/);
  assert.match(appSource, /type: "DOWNLOAD_ATTACHMENT",\s*filename: filename,\s*mime: blob\.type,\s*dataUrl: reader\.result/);
});

test('attachment cleanup deletes both image records', async () => {
  const methodStart = appSource.indexOf('\n  async purgeAttachmentCaches(');
  assert.ok(methodStart >= 0, 'purgeAttachmentCaches must exist to clean up attachment images');
  const methodEnd = appSource.indexOf('\n  /**', methodStart + 1);
  const methodSource = appSource.slice(methodStart, methodEnd);
  const deletedThumbnails = [];
  const deletedFullImages = [];
  const Harness = new Function(
    'thumbnailCache', 'fullMediaCache', 'FullMediaCache', 'normalizeMimeType',
    `return class Harness {${methodSource}\n}`,
  )(
    { delete: async url => deletedThumbnails.push(url) },
    { delete: async url => deletedFullImages.push(url) },
    FullMediaCache,
    normalizeMimeType,
  );

  await new Harness().purgeAttachmentCaches([
    { url: 'https://files.example/image', type: 'image/png' },
    { url: 'https://files.example/document', type: 'application/pdf' },
  ]);

  assert.deepEqual(deletedThumbnails, ['https://files.example/image']);
  assert.deepEqual(deletedFullImages, ['https://files.example/image']);
});
