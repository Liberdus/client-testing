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
    window.seedDatabase = (name, version, stores) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        for (const { name: storeName, keyPath, records, cachedAtIndex = true } of stores) {
          const store = request.result.createObjectStore(storeName, { keyPath });
          if (cachedAtIndex) store.createIndex('cachedAt', 'cachedAt');
          for (const record of records) store.put(record);
        }
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    window.withDatabaseName = async callback => {
      const name = `issue-1755-${crypto.randomUUID()}`;
      try {
        return await callback(name);
      } finally {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Test database cleanup blocked'));
        });
      }
    };
    window.withCache = (callback, fixture) => withDatabaseName(async name => {
      if (fixture) await seedDatabase(name, fixture.version, fixture.stores);
      const database = new ThumbnailCache();
      database.dbName = name;
      if (fixture?.upgradeVersion) database.dbVersion = fixture.upgradeVersion;
      try {
        await database.init();
        return await callback(database, new FullImageCache(database));
      } finally { database.db?.close(); }
    });
  });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(externalRequests, [], 'cache tests must remain offline');
  assert.deepEqual(pageErrors, []);
});

for (const legacyVersion of [1, 2]) {
  test(`upgrading URL-keyed database v${legacyVersion} migrates data and retains the newest record per ID`, async () => {
    const result = await page.evaluate(version => {
      // URL order puts the newest entry first for one ID, last for the other.
      const versions = [
        ['https://a.example/get/newest-first', 'new', 20],
        ['https://z.example/get/newest-first', 'old', 10],
        ['https://a.example/get/newest-last', 'old', 10],
        ['https://z.example/get/newest-last', 'new', 20],
      ];
      const stores = [{
        name: 'thumbnails', keyPath: 'url',
        records: versions.map(([url, value, cachedAt]) => ({
          url, thumbnail: new Blob([`${value}-thumb`], { type: 'image/jpeg' }),
          originalType: 'image/png', cachedAt,
        })),
      }];
      if (version === 2) stores.push({
        name: 'fullImages', keyPath: 'url',
        records: versions.map(([url, value, cachedAt]) => ({
          url, blob: new Blob([`${value}-image`], { type: 'image/png' }),
          mimeType: 'image/png', size: 9, cachedAt,
        })),
      });
      return withCache(async (database, images) => {
        const schema = ['thumbnails', 'fullImages'].map(name => {
          const store = database.db.transaction(name, 'readonly').objectStore(name);
          return { name, keyPath: store.keyPath, indexes: Array.from(store.indexNames) };
        });
        const thumbnails = await Promise.all((await readRecords(database, 'thumbnails')).map(async record => ({
          ...record, thumbnail: await record.thumbnail.text(), blobType: record.thumbnail.type,
        })));
        const fullImages = await Promise.all((await readRecords(database, 'fullImages')).map(async record => ({
          ...record, blob: await record.blob.text(), blobType: record.blob.type,
        })));
        return {
          version: database.db.version, stores: Array.from(database.db.objectStoreNames), schema, thumbnails, fullImages,
          thumbByNewHost: await (await database.get('https://changed.example/get/newest-first')).text(),
          imageByNewHost: version === 2 ? await (await images.get('https://changed.example/get/newest-last')).text() : null,
          size: await images.getCacheSize(),
        };
      }, { version, stores });
    }, legacyVersion);
    assert.deepEqual(result, {
      version: 3, stores: ['fullImages', 'thumbnails'],
      schema: [
        { name: 'thumbnails', keyPath: 'id', indexes: ['cachedAt'] },
        { name: 'fullImages', keyPath: 'id', indexes: ['cachedAt'] },
      ],
      thumbnails: ['newest-first', 'newest-last'].map(id => ({
        id, thumbnail: 'new-thumb', blobType: 'image/jpeg', originalType: 'image/png', cachedAt: 20,
      })),
      fullImages: legacyVersion === 2 ? ['newest-first', 'newest-last'].map(id => ({
        id, blob: 'new-image', blobType: 'image/png', mimeType: 'image/png', size: 9, cachedAt: 20,
      })) : [],
      thumbByNewHost: 'new-thumb', imageByNewHost: legacyVersion === 2 ? 'new-image' : null,
      size: legacyVersion === 2 ? 18 : 0,
    });
  });
}

for (const scenario of [
  { name: 'ID-keyed caches at an older database version', version: 2, upgradeVersion: 3, thumbnails: 'id', fullImages: 'id' },
  { name: 'ID-keyed caches during a future v3 to v4 upgrade', version: 3, upgradeVersion: 4, thumbnails: 'id', fullImages: 'id' },
  { name: 'ID-keyed caches with missing cachedAt indexes', version: 2, upgradeVersion: 3, thumbnails: 'id', fullImages: 'id', cachedAtIndex: false },
  { name: 'an ID-keyed image store alongside legacy thumbnails', version: 2, upgradeVersion: 3, thumbnails: 'url', fullImages: 'id' },
  { name: 'an ID-keyed thumbnail store alongside legacy images', version: 2, upgradeVersion: 3, thumbnails: 'id', fullImages: 'url' },
  { name: 'an existing image store when thumbnails are missing', version: 2, upgradeVersion: 3, fullImages: 'id' },
  { name: 'an existing thumbnail store when full images are missing', version: 2, upgradeVersion: 3, thumbnails: 'id' },
]) {
  test(`upgrades preserve ${scenario.name}`, async () => {
    const result = await page.evaluate(fixture => {
      const stores = [];
      for (const name of ['thumbnails', 'fullImages']) {
        const keyPath = fixture[name];
        if (!keyPath) continue;
        const key = keyPath === 'id' ? 'kept' : 'https://old.example/get/kept';
        const record = name === 'thumbnails'
          ? { thumbnail: new Blob(['kept-thumb'], { type: 'image/jpeg' }), originalType: 'image/png' }
          : { blob: new Blob(['kept-image'], { type: 'image/png' }), size: 10, mimeType: 'image/png' };
        stores.push({ name, keyPath, cachedAtIndex: fixture.cachedAtIndex, records: [{ [keyPath]: key, ...record, cachedAt: 123 }] });
      }
      return withCache(async (database, images) => {
        if (fixture.cachedAtIndex === false) {
          // Writes exercise the repaired cachedAt index used by image eviction.
          await images.put({ url: 'https://files.example/get/new', type: 'image/png' }, new Blob(['new']));
          await images.delete('new');
        }
        return {
          version: database.db.version,
          indexes: ['thumbnails', 'fullImages'].map(name => Array.from(database.db.transaction(name).objectStore(name).indexNames)),
          stores: Array.from(database.db.objectStoreNames),
          thumbnails: await Promise.all((await readRecords(database, 'thumbnails')).map(async record => ({
            ...record, thumbnail: await record.thumbnail.text(), blobType: record.thumbnail.type,
          }))),
          fullImages: await Promise.all((await readRecords(database, 'fullImages')).map(async record => ({
            ...record, blob: await record.blob.text(), blobType: record.blob.type,
          }))),
        };
      }, { ...fixture, stores });
    }, scenario);
    assert.deepEqual(result, {
      version: scenario.upgradeVersion, indexes: [['cachedAt'], ['cachedAt']], stores: ['fullImages', 'thumbnails'],
      thumbnails: scenario.thumbnails ? [{ id: 'kept', thumbnail: 'kept-thumb', blobType: 'image/jpeg', originalType: 'image/png', cachedAt: 123 }] : [],
      fullImages: scenario.fullImages ? [{ id: 'kept', blob: 'kept-image', blobType: 'image/png', size: 10, mimeType: 'image/png', cachedAt: 123 }] : [],
    });
  });
}

for (const failure of ['invalid legacy URL', 'unsupported key path', 'destination write failure']) {
  test(`a migration with ${failure} rolls back both stores and the database version`, async () => {
    const result = await page.evaluate(reason => withDatabaseName(async name => {
      const legacyUrl = reason === 'invalid legacy URL' ? 'https://old.example/unsupported/image' : 'https://old.example/get/kept';
      const fullImageKeyPath = reason === 'unsupported key path' ? 'unsupported' : 'url';
      await seedDatabase(name, 2, [
        { name: 'thumbnails', keyPath: 'url', records: [{ url: legacyUrl, thumbnail: new Blob(['kept-thumb']), cachedAt: 123 }] },
        { name: 'fullImages', keyPath: fullImageKeyPath, records: [{ [fullImageKeyPath]: legacyUrl, blob: new Blob(['kept-image']), size: 10, cachedAt: 123 }] },
      ]);
      const originalPut = IDBObjectStore.prototype.put;
      if (reason === 'destination write failure') {
        IDBObjectStore.prototype.put = function(record, ...args) {
          const request = originalPut.call(this, record, ...args);
          // A real asynchronous ConstraintError aborts the versionchange transaction.
          if (this.keyPath === 'id' && Object.hasOwn(record, 'blob')) return this.add(record);
          return request;
        };
      }
      const database = new ThumbnailCache();
      database.dbName = name;
      let rejected = false;
      try {
        await database.init();
      } catch { rejected = true; }
      finally {
        IDBObjectStore.prototype.put = originalPut;
        database.db?.close();
      }
      const original = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const thumbnails = await readRecords({ db: original }, 'thumbnails');
        const images = await readRecords({ db: original }, 'fullImages');
        return {
          rejected, version: original.version, stores: Array.from(original.objectStoreNames),
          keyPaths: ['thumbnails', 'fullImages'].map(store => original.transaction(store).objectStore(store).keyPath),
          thumbnail: { ...thumbnails[0], thumbnail: await thumbnails[0].thumbnail.text() },
          image: { ...images[0], blob: await images[0].blob.text() },
        };
      } finally { original.close(); }
    }), failure);
    const legacyUrl = failure === 'invalid legacy URL' ? 'https://old.example/unsupported/image' : 'https://old.example/get/kept';
    const fullImageKeyPath = failure === 'unsupported key path' ? 'unsupported' : 'url';
    assert.deepEqual(result, {
      rejected: true, version: 2, stores: ['fullImages', 'thumbnails'], keyPaths: ['url', fullImageKeyPath],
      thumbnail: { url: legacyUrl, thumbnail: 'kept-thumb', cachedAt: 123 },
      image: { [fullImageKeyPath]: legacyUrl, blob: 'kept-image', size: 10, cachedAt: 123 },
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
