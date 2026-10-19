import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const manualFixture = await readFile(new URL('./issue-1656-full-image-cache.browser.test.html', import.meta.url), 'utf8');
const cacheSource = [
  appSource.slice(appSource.indexOf('\nclass ThumbnailCache'), appSource.indexOf('\nconst thumbnailCache = new ThumbnailCache();')),
  appSource.slice(appSource.lastIndexOf('\nconst FULL_IMAGE_CACHE_MAX_SIZE'), appSource.lastIndexOf('\nconst fullImageCache = new FullImageCache(thumbnailCache);')),
  'window.ThumbnailCache = ThumbnailCache; window.FullImageCache = FullImageCache;',
].join('\n');

let server;
let browser;
let page;
let origin;
const externalRequests = [];
const pageErrors = [];

before(async () => {
  // Only the cache classes run. No account, wallet, network service or full app is loaded.
  server = createServer((request, response) => {
    if (request.url === '/app.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(appSource);
    } else if (request.url === '/tests/issue-1656-full-image-cache.browser.test.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(manualFixture);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Attachment cache regression</title>');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  await page.addScriptTag({ content: cacheSource });
  await page.evaluate(() => {
    window.readRecords = (database, name) => new Promise((resolve, reject) => {
      const request = database.db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.withCache = async (callback, legacyVersion) => {
      const name = `issue-1755-${crypto.randomUUID()}`;
      if (legacyVersion) {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open(name, legacyVersion);
          request.onupgradeneeded = () => {
            const thumbnails = request.result.createObjectStore('thumbnails', { keyPath: 'url' });
            thumbnails.createIndex('cachedAt', 'cachedAt');
            thumbnails.put({ url: 'https://old.example/get/legacy', thumbnail: new Blob(['legacy-thumb']), cachedAt: 1 });
            if (legacyVersion === 2) {
              const images = request.result.createObjectStore('fullImages', { keyPath: 'url' });
              images.createIndex('cachedAt', 'cachedAt');
              images.put({ url: 'https://old.example/get/legacy', blob: new Blob(['legacy-image']), size: 12, cachedAt: 1 });
            }
          };
          request.onsuccess = () => { request.result.close(); resolve(); };
          request.onerror = () => reject(request.error);
        });
      }
      const database = new ThumbnailCache();
      database.dbName = name;
      await database.init();
      try {
        return await callback(database, new FullImageCache(database));
      } finally {
        database.db.close();
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Test database cleanup blocked'));
        });
      }
    };
  });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(externalRequests, [], 'cache tests must remain offline');
  assert.deepEqual(pageErrors, []);
});

for (const legacyVersion of [1, 2]) {
  test(`upgrading URL-keyed database v${legacyVersion} clears both caches and creates ID stores`, async () => {
    const result = await page.evaluate(version => withCache(async (database, images) => {
      const schema = ['thumbnails', 'fullImages'].map(name => {
        const store = database.db.transaction(name, 'readonly').objectStore(name);
        return { name, keyPath: store.keyPath, indexes: Array.from(store.indexNames) };
      });
      return {
        version: database.db.version,
        schema,
        thumbnails: (await readRecords(database, 'thumbnails')).length,
        images: (await readRecords(database, 'fullImages')).length,
        legacyThumb: await database.get('https://new.example/get/legacy'),
        legacyImage: await images.get('https://new.example/get/legacy'),
      };
    }, version), legacyVersion);
    assert.deepEqual(result, {
      version: 3,
      schema: [
        { name: 'thumbnails', keyPath: 'id', indexes: ['cachedAt'] },
        { name: 'fullImages', keyPath: 'id', indexes: ['cachedAt'] },
      ],
      thumbnails: 0, images: 0, legacyThumb: null, legacyImage: null,
    });
  });
}

test('fresh databases use ID keys and reopening v3 preserves thumbnails and full images', async () => {
  const result = await page.evaluate(() => withCache(async (database, images) => {
    await database.save('https://old.example/get/persisted', new Blob(['thumbnail'], { type: 'image/jpeg' }), 'image/png');
    await images.put({ url: 'https://old.example/get/persisted', type: 'image/png' }, new Blob(['full-image'], { type: 'image/png' }));
    database.db.close();
    const reopened = new ThumbnailCache();
    reopened.dbName = database.dbName;
    await reopened.init();
    // Leave the open connection with withCache so its cleanup also verifies it can close normally.
    database.db = reopened.db;
    const record = await new FullImageCache(reopened).getRecord('http://new.example:8080/get/persisted?download=1#image');
    return {
      version: reopened.db.version,
      thumb: await (await reopened.get('https://new.example/get/persisted')).text(),
      image: await record.blob.text(),
      id: record.id,
      hasUrl: Object.hasOwn(record, 'url'),
      mimeType: record.mimeType,
      size: record.size,
      timestamp: typeof record.cachedAt,
      thumbKeys: (await readRecords(reopened, 'thumbnails')).map(record => record.id),
    };
  }));
  assert.deepEqual(result, {
    version: 3, thumb: 'thumbnail', image: 'full-image', id: 'persisted', hasUrl: false,
    mimeType: 'image/png', size: 10, timestamp: 'number', thumbKeys: ['persisted'],
  });
});

test('both caches share read, replacement and delete identity across URL variants', async () => {
  const result = await page.evaluate(() => withCache(async (database, images) => {
    const original = 'https://old.example/get/shared';
    const alias = 'http://new.example:8080/get/shared/?token=two#preview';
    const attachment = url => ({ url, name: 'photo.png', type: 'image/png' });
    await database.save(original, new Blob(['old-thumb']), 'image/png');
    await images.put(attachment(original), new Blob(['old-image'], { type: 'image/png' }));
    const initial = [await (await database.get(alias)).text(), await (await images.get(alias)).text()];
    await database.save(alias, new Blob(['new-thumb']), 'image/png');
    await images.put(attachment(alias), new Blob(['new-image'], { type: 'image/png' }));
    await database.save('https://old.example/get/other', new Blob(['other-thumb']), 'image/png');
    await images.put(attachment('https://old.example/get/other'), new Blob(['other-image'], { type: 'image/png' }));
    const replaced = [await (await database.get(original)).text(), await (await images.get(original)).text()];
    const keys = [
      (await readRecords(database, 'thumbnails')).map(record => record.id),
      (await readRecords(database, 'fullImages')).map(record => record.id),
    ];
    await database.delete('https://third.example/get/shared#delete');
    await images.delete('https://third.example/get/shared#delete');
    return {
      initial, replaced, keys,
      deleted: [await database.get(original), await images.get(alias)],
      kept: [await (await database.get('other')).text(), await (await images.get('other')).text()],
    };
  }));
  assert.deepEqual(result, {
    initial: ['old-thumb', 'old-image'], replaced: ['new-thumb', 'new-image'],
    keys: [['other', 'shared'], ['other', 'shared']], deleted: [null, null],
    kept: ['other-thumb', 'other-image'],
  });
});

test('full-image replacement counts an ID once and FIFO eviction respects the size limit', async () => {
  const result = await page.evaluate(() => withCache(async (database, images) => {
    images.maxCacheSize = 11;
    const attachment = id => ({ url: `https://old.example/get/${id}`, type: 'image/png' });
    const blob = value => new Blob([value], { type: 'image/png' });
    const realNow = Date.now;
    let time = 1;
    Date.now = () => time++;
    try {
      await images.put(attachment('a'), blob('first'));
      await images.put(attachment('b'), blob('second'));
      await images.put({ ...attachment('a'), url: 'http://new.example:8080/get/a?replace=1' }, blob('FIRST'));
      const afterReplacement = { size: await images.getCacheSize(), keys: (await readRecords(database, 'fullImages')).map(record => record.id) };
      await images.put(attachment('c'), blob('third!'));
      const oversized = await images.put(attachment('too-big'), blob('twelve-bytes'));
      return {
        afterReplacement, oversized,
        size: await images.getCacheSize(),
        first: await (await images.get('a')).text(),
        second: await images.get('b'),
        third: await (await images.get('c')).text(),
        keys: (await readRecords(database, 'fullImages')).map(record => record.id),
      };
    } finally { Date.now = realNow; }
  }));
  assert.deepEqual(result, {
    afterReplacement: { size: 11, keys: ['a', 'b'] }, oversized: false,
    size: 11, first: 'FIRST', second: null, third: 'third!', keys: ['a', 'c'],
  });
});

test('getOrCache reuses a full image after the storage hostname changes', async () => {
  const result = await page.evaluate(() => withCache(async (database, images) => {
    let downloads = 0;
    const resolveImage = url => images.getOrCache({
      attachment: { url, type: 'image/png' },
      downloadAndDecrypt: async () => {
        downloads++;
        return new Blob(['decrypted-image'], { type: 'image/png' });
      },
    });
    await resolveImage('https://old.example/get/photo');
    const cached = await resolveImage('http://new.example:8080/get/photo/?token=changed#preview');
    return { downloads, bytes: await cached.text(), records: (await readRecords(database, 'fullImages')).length };
  }));
  assert.deepEqual(result, { downloads: 1, bytes: 'decrypted-image', records: 1 });
});

test('legacy thumbnail backups deduplicate by ID and round-trip through bare-ID exports', async () => {
  const result = await page.evaluate(() => withCache(async database => {
    const info = value => ({ data: btoa(value), type: 'image/jpeg', originalType: 'image/png' });
    const backup = {
      'https://old.example/get/photo': info('first'),
      'http://new.example:8080/get/photo?token=two#preview': info('second'),
      ['__proto__']: info('special'),
    };
    const imported = await database.importAll(backup);
    const beforeOverwrite = await (await database.get('https://third.example/get/photo')).text();
    const exported = JSON.parse(JSON.stringify(await database.exportAll()));
    const roundTrip = await withCache(async restored => {
      const count = await restored.importAll(exported);
      return {
        count,
        photo: await (await restored.get('https://fourth.example/get/photo')).text(),
        special: await (await restored.get('https://fourth.example/get/__proto__')).text(),
      };
    });
    const skipped = await database.importAll({ photo: info('ignored') });
    const overwritten = await database.importAll(backup, true);
    return {
      imported, beforeOverwrite, skipped, overwritten, roundTrip,
      exportKeys: Object.keys(exported).sort(),
      originalType: exported.photo.originalType,
      afterOverwrite: await (await database.get('photo')).text(),
      recordCount: (await readRecords(database, 'thumbnails')).length,
    };
  }));
  assert.deepEqual(result, {
    imported: 2, beforeOverwrite: 'first', skipped: 0, overwritten: 3,
    roundTrip: { count: 2, photo: 'first', special: 'special' },
    exportKeys: ['__proto__', 'photo'], originalType: 'image/png', afterOverwrite: 'second', recordCount: 2,
  });
});

test('the existing full-image manual fixture passes against the ID-keyed database', async () => {
  const fixture = await browser.newPage();
  try {
    await fixture.goto(`${origin}/tests/issue-1656-full-image-cache.browser.test.html`);
    await fixture.waitForFunction(() => document.querySelector('#result').dataset.result, null, { timeout: 10000 });
    assert.equal(await fixture.locator('#result').innerText(), 'PASS');
  } finally { await fixture.close(); }
});
