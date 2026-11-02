import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const thumbnailSource = appSource.slice(
  appSource.indexOf('\nclass ThumbnailCache'),
  appSource.indexOf('\nconst thumbnailCache = new ThumbnailCache();'),
);
const cacheSource = appSource.slice(
  appSource.lastIndexOf('\nconst FULL_IMAGE_CACHE_MAX_SIZE'),
  appSource.lastIndexOf('\nconst fullImageCache = new FullImageCache(thumbnailCache);'),
);
const { FullImageCache } = new Function(
  `${thumbnailSource}\n${cacheSource}\nreturn { FullImageCache };`,
)();

class MemoryCache extends FullImageCache {
  constructor() {
    super({});
    this.records = new Map();
  }

  async get(attachmentUrl) {
    return this.records.get(attachmentUrl)?.blob || null;
  }

  async put(attachment, blob) {
    this.records.set(attachment.url, { attachment, blob });
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
  const transaction = {};
  const store = {
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
            request.onsuccess({ target: { result: cursor } });
            if (!cursor) queueMicrotask(() => transaction.oncomplete());
          };
          queueMicrotask(advance);
          return request;
        },
      };
    },
    delete: url => deletedUrls.push(url),
    put: (record) => { insertedRecord = record; },
  };
  transaction.objectStore = () => store;
  const database = {
    fullImageStoreName: 'fullImages',
    init: async () => ({ transaction: () => transaction }),
  };
  const cache = new FullImageCache(database, 11);

  const cached = await cache.put(
    { url: 'https://files.example/get/c', type: 'image/png' },
    new Blob(['third'], { type: 'image/png' }),
  );

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

test('the application routes only image saves through the full-image cache', () => {
  assert.match(appSource, /const blob = isImage\s*\? await this\.getFullImageBlob\(item, linkEl\)\s*:\s*await this\.decryptAttachmentToBlob\(item, linkEl\)/);
  assert.match(appSource, /return fullImageCache\.getOrCache\(\{\s*attachment,/);
  assert.match(appSource, /type: "DOWNLOAD_ATTACHMENT",\s*filename: filename,\s*mime: blob\.type,\s*dataUrl: reader\.result/);
});

test('attachment cleanup deletes both image records', async () => {
  const methodStart = appSource.indexOf('\n  purgeImageCaches(xattach) {');
  assert.ok(methodStart >= 0, 'purgeImageCaches must exist to clean up attachment images');
  const methodEnd = appSource.indexOf('\n  /**', methodStart + 1);
  const methodSource = appSource.slice(methodStart, methodEnd);
  const deletedThumbnails = [];
  const deletedFullImages = [];
  const Harness = new Function(
    'thumbnailCache',
    'fullImageCache',
    `return class Harness {${methodSource}\n}`,
  )(
    { delete: async url => deletedThumbnails.push(url) },
    { delete: async url => deletedFullImages.push(url) },
  );

  new Harness().purgeImageCaches([
    { url: 'https://files.example/image', type: 'image/png' },
    { url: 'https://files.example/document', type: 'application/pdf' },
  ]);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletedThumbnails, ['https://files.example/image']);
  assert.deepEqual(deletedFullImages, ['https://files.example/image']);
});
