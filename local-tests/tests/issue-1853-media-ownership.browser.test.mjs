import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../../playwright-tests/package.json', import.meta.url));
const { chromium } = require('playwright');
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot, 'Set WEB_CLIENT_ROOT to the absolute implementation checkout path');
assert.equal(resolve(clientRoot), clientRoot, 'WEB_CLIENT_ROOT must be an absolute path');
const appSource = await readFile(resolve(clientRoot, 'app.js'), 'utf8');

function cacheClass(name, instance) {
  const start = appSource.indexOf(`\nclass ${name}`);
  const end = appSource.indexOf(`\nconst ${instance} = new ${name}(`, start);
  assert.ok(start !== -1 && end > start, `Cannot locate production ${name}`);
  return appSource.slice(start, end);
}

const cacheSource = [
  'let myAccount = null; const network = { netid: "net1" };',
  'let contactAvatarCache, thumbnailCache, removeAccountModal;',
  'const SIGN_IN_USERNAME_ORDER_KEY = "signInUsernameOrder";',
  'const parse = JSON.parse, stringify = JSON.stringify;',
  'const showToast = (message, duration, type) => window.toasts.push({ message, type });',
  'const clearMyData = () => { window.clearCount++; };',
  'const FULL_IMAGE_CACHE_MAX_SIZE = 250 * 1024 * 1024;',
  appSource.includes('\nclass MediaCacheOwnership')
    ? appSource.slice(appSource.indexOf('\nclass MediaCacheOwnership'), appSource.indexOf('\nclass ContactAvatarCache'))
    : '',
  cacheClass('ContactAvatarCache', 'contactAvatarCache'),
  cacheClass('ThumbnailCache', 'thumbnailCache'),
  cacheClass('FullImageCache', 'fullImageCache'),
  // Only adapt the browser reload endpoint so assertions can observe ordering without navigating away.
  cacheClass('RemoveAccountModal', 'removeAccountModal').replaceAll('window.location.reload()', 'window.recordReload()'),
  cacheClass('RemoveAccountsModal', 'removeAccountsModal').replaceAll('window.location.reload()', 'window.recordReload()'),
  'Object.assign(window, { ContactAvatarCache, ThumbnailCache, FullImageCache, RemoveAccountModal, RemoveAccountsModal });',
  'window.useAccount = (username, netid = "net1") => { myAccount = username ? { username, netid } : null; network.netid = netid; };',
].join('\n');

let server;
let browser;
let page;
let origin;
const externalRequests = [];
const pageErrors = [];

before(async () => {
  // Run production cache classes only: no account data, application startup or network service.
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Media ownership regression</title>');
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
    window.readRows = (cache, name = cache.storeName) => new Promise((resolve, reject) => {
      const request = cache.db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.writeRows = (cache, name, records) => new Promise((resolve, reject) => {
      const transaction = cache.db.transaction(name, 'readwrite');
      for (const record of records) transaction.objectStore(name).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
    });
    window.seedDatabase = (name, version, stores) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        for (const [storeName, { indexName, records }] of Object.entries(stores)) {
          const store = request.result.createObjectStore(storeName, { keyPath: 'id' });
          store.createIndex(indexName, indexName);
          for (const record of records) store.put(record);
        }
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    window.withCaches = async (callback, legacy = false) => {
      const avatars = new ContactAvatarCache();
      const thumbnails = new ThumbnailCache();
      avatars.dbName = `issue-1853-avatars-${crypto.randomUUID()}`;
      thumbnails.dbName = `issue-1853-attachments-${crypto.randomUUID()}`;
      if (legacy) {
        await seedDatabase(avatars.dbName, 2, {
          avatars: { indexName: 'savedAt', records: [{ id: 'legacy', blob: new Blob(['avatar']), savedAt: 1 }] },
        });
        await seedDatabase(thumbnails.dbName, 3, {
          thumbnails: { indexName: 'cachedAt', records: [{ id: 'legacy', thumbnail: new Blob(['thumbnail']), cachedAt: 1 }] },
          fullImages: { indexName: 'cachedAt', records: [{ id: 'legacy', blob: new Blob(['full']), size: 4, cachedAt: 1 }] },
        });
      }
      await Promise.all([avatars.init(), thumbnails.init()]);
      useAccount('alice');
      try {
        return await callback({ avatars, thumbnails, images: new FullImageCache(thumbnails) });
      } finally {
        for (const cache of [avatars, thumbnails]) {
          cache.db?.close();
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(cache.dbName);
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Database cleanup blocked'));
          });
        }
      }
    };
    window.photo = id => ({ url: `https://storage.example/get/${id}`, type: 'image/png' });
    window.imageBlob = value => new Blob([value], { type: 'image/png' });
    window.saveEverywhere = async ({ avatars, thumbnails, images }, id) => {
      const owners = await Promise.all([avatars.captureOwner(myAccount), thumbnails.captureOwner(myAccount), images.captureOwner(myAccount)]);
      await avatars.save(id, imageBlob(`avatar-${id}`), owners[0]);
      await thumbnails.save(photo(id).url, imageBlob(`thumb-${id}`), 'image/png', owners[1]);
      await images.put(photo(id), imageBlob(`full-${id}`), undefined, owners[2]);
    };
    window.captureEverywhere = async ({ avatars, thumbnails, images }, username, netid = 'net1') => {
      const account = { username, netid };
      return Promise.all([avatars.captureOwner(account), thumbnails.captureOwner(account), images.captureOwner(account)]);
    };
    window.removeEverywhere = ({ avatars, thumbnails }, keys) => Promise.all([
      avatars.removeOwners(keys), thumbnails.removeOwners(keys),
    ]);
    window.snapshot = async ({ avatars, thumbnails }) => {
      const rows = await Promise.all([
        readRows(avatars), readRows(thumbnails), readRows(thumbnails, 'fullImages'),
      ]);
      return rows.map(records => records.map(({ id, ownerKeys }) => ({ id, ownerKeys: ownerKeys?.sort() })));
    };
    window.installRemovalModals = caches => {
      contactAvatarCache = caches.avatars;
      thumbnailCache = caches.thumbnails;
      removeAccountModal = new RemoveAccountModal();
      window.confirm = () => true;
      window.toasts = [];
      window.reloadCount = 0;
      window.clearCount = 0;
      window.recordReload = () => { window.reloadCount++; };
      localStorage.clear();
      localStorage.setItem('accounts', JSON.stringify({ netids: { net1: {
        usernames: { alice: {}, bob: {}, carol: {} },
        [SIGN_IN_USERNAME_ORDER_KEY]: { public: ['alice', 'bob', 'carol'], private: [] },
      } } }));
      for (const username of ['alice', 'bob', 'carol']) localStorage.setItem(`${username}_net1`, `${username}-account-data`);
      return removeAccountModal;
    };
    window.accountState = () => ({
      registry: JSON.parse(localStorage.getItem('accounts')),
      data: ['alice', 'bob', 'carol'].map(username => localStorage.getItem(`${username}_net1`)),
      reloads: window.reloadCount, clears: window.clearCount,
    });
  });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(externalRequests, [], 'ownership regressions must remain offline');
  assert.deepEqual(pageErrors, []);
});

test('new avatars, thumbnails and full images have an indexed account owner', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const schemas = [
      [caches.avatars, 'avatars'], [caches.thumbnails, 'thumbnails'], [caches.thumbnails, 'fullImages'],
    ].map(([cache, name]) => {
      const store = cache.db.transaction(name, 'readonly').objectStore(name);
      const index = store.index('byOwner');
      return { keyPath: store.keyPath, ownerPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique };
    });
    await saveEverywhere(caches, 'new');
    return { schemas, rows: await snapshot(caches) };
  }));
  assert.deepEqual(result.schemas, Array(3).fill({ keyPath: 'id', ownerPath: 'ownerKeys', multiEntry: true, unique: false }));
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'new', ownerKeys: ['alice_net1'] }]));
});

test('cache hits add shared owners, including avatar blob-URL hits and another network', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'shared');
    const firstUrl = await caches.avatars.getBlobUrl('shared');
    let downloads = 0;
    let bobUrl;
    for (const [username, netid] of [['bob', 'net1'], ['alice', 'net2']]) {
      const owners = await captureEverywhere(caches, username, netid);
      bobUrl = await caches.avatars.getBlobUrl('shared', owners[0]);
      await caches.thumbnails.get(photo('shared').url, owners[1]);
      await caches.images.getOrCache({
        attachment: photo('shared'), owner: owners[2],
        downloadAndDecrypt: async () => { downloads++; return imageBlob('must not download'); },
      });
    }
    return { rows: await snapshot(caches), reusedUrl: firstUrl === bobUrl, downloads };
  }));
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'shared', ownerKeys: ['alice_net1', 'alice_net2', 'bob_net1'] }]));
  assert.equal(result.reusedUrl, true);
  assert.equal(result.downloads, 0);
});

test('concurrent ownership registration preserves both accounts on one stored blob', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'shared');
    const bob = await captureEverywhere(caches, 'bob');
    const carol = await captureEverywhere(caches, 'carol');
    await Promise.all([
      caches.avatars.get('shared', bob[0]), caches.avatars.get('shared', carol[0]),
      caches.thumbnails.get('shared', bob[1]), caches.thumbnails.get('shared', carol[1]),
      caches.images.get('shared', bob[2]), caches.images.get('shared', carol[2]),
    ]);
    return snapshot(caches);
  }));
  assert.deepEqual(result, Array(3).fill([{ id: 'shared', ownerKeys: ['alice_net1', 'bob_net1', 'carol_net1'] }]));
});

test('upgrading existing ID-keyed stores preserves untracked rows through hits and rewrites', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const before = await snapshot(caches);
    const owners = await captureEverywhere(caches, 'alice');
    await caches.avatars.getBlobUrl('legacy', owners[0]);
    await caches.thumbnails.get('legacy', owners[1]);
    await caches.images.get('legacy', owners[2]);
    await saveEverywhere(caches, 'legacy');
    const afterRewrite = await snapshot(caches);
    await saveEverywhere(caches, 'new');
    await removeEverywhere(caches, ['alice_net1']);
    return { before, afterRewrite, afterRemoval: await snapshot(caches) };
  }, true));
  const legacy = Array(3).fill([{ id: 'legacy', ownerKeys: undefined }]);
  assert.deepEqual(result, { before: legacy, afterRewrite: legacy, afterRemoval: legacy });
});

test('account removal detaches shared ownership, deletes the last owner, and invalidates avatar URLs', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'alice-only');
    await saveEverywhere(caches, 'shared');
    const bob = await captureEverywhere(caches, 'bob');
    const url = await caches.avatars.getBlobUrl('alice-only');
    await caches.avatars.get('shared', bob[0]);
    await caches.thumbnails.get('shared', bob[1]);
    await caches.images.get('shared', bob[2]);
    await removeEverywhere(caches, ['alice_net1']);
    const afterAlice = await snapshot(caches);
    const deletedUrl = await caches.avatars.getBlobUrl('alice-only', bob[0]);
    const response = await fetch(url).then(() => 'still usable', () => 'revoked');
    await removeEverywhere(caches, ['bob_net1']);
    return { afterAlice, afterBob: await snapshot(caches), deletedUrl, response };
  }));
  assert.deepEqual(result.afterAlice, Array(3).fill([{ id: 'shared', ownerKeys: ['bob_net1'] }]));
  assert.deepEqual(result.afterBob, [[], [], []]);
  assert.equal(result.deletedUrl, null);
  assert.equal(result.response, 'revoked');
});

test('selected-account removal keeps owners outside the selected set and other networks', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'selected');
    await saveEverywhere(caches, 'keep');
    const bob = await captureEverywhere(caches, 'bob');
    await caches.avatars.get('selected', bob[0]);
    await caches.thumbnails.get('selected', bob[1]);
    await caches.images.get('selected', bob[2]);
    const otherNetwork = await captureEverywhere(caches, 'alice', 'net2');
    await caches.avatars.get('keep', otherNetwork[0]);
    await caches.thumbnails.get('keep', otherNetwork[1]);
    await caches.images.get('keep', otherNetwork[2]);
    await removeEverywhere(caches, ['alice_net1', 'bob_net1']);
    return snapshot(caches);
  }));
  assert.deepEqual(result, Array(3).fill([{ id: 'keep', ownerKeys: ['alice_net2'] }]));
});

test('late downloads cannot resurrect a removed owner or attach to a recreated account', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const old = await captureEverywhere(caches, 'alice');
    let releaseDownload;
    const downloaded = new Promise(resolve => { releaseDownload = resolve; });
    const pendingImage = caches.images.getOrCache({
      attachment: photo('late'), owner: old[2],
      downloadAndDecrypt: () => downloaded,
    });
    await removeEverywhere(caches, ['alice_net1']);
    await caches.avatars.save('removed', imageBlob('avatar'), old[0]);
    await caches.thumbnails.save('removed', imageBlob('thumb'), 'image/png', old[1]);
    await caches.images.put(photo('removed'), imageBlob('full'), undefined, old[2]);
    const removed = await snapshot(caches);
    await Promise.all([caches.avatars.activateOwners(['alice_net1']), caches.thumbnails.activateOwners(['alice_net1'])]);
    releaseDownload(imageBlob('late-full'));
    await pendingImage;
    await caches.avatars.save('late', imageBlob('late-avatar'), old[0]);
    await caches.thumbnails.save('late', imageBlob('late-thumb'), 'image/png', old[1]);
    const stale = await snapshot(caches);
    await saveEverywhere(caches, 'fresh');
    return { removed, stale, fresh: await snapshot(caches) };
  }));
  assert.deepEqual(result.removed, [[], [], []]);
  assert.deepEqual(result.stale, [[], [], []]);
  assert.deepEqual(result.fresh, Array(3).fill([{ id: 'fresh', ownerKeys: ['alice_net1'] }]));
});

test('an owner captured before switching accounts is retained for delayed writes', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const alice = await captureEverywhere(caches, 'alice');
    useAccount('bob');
    await caches.avatars.save('delayed', imageBlob('avatar'), alice[0]);
    await caches.thumbnails.save('delayed', imageBlob('thumb'), 'image/png', alice[1]);
    await caches.images.put(photo('delayed'), imageBlob('full'), undefined, alice[2]);
    return snapshot(caches);
  }));
  assert.deepEqual(result, Array(3).fill([{ id: 'delayed', ownerKeys: ['alice_net1'] }]));
});

test('aborted removal rejects and leaves persisted media and ownership intact', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'keep');
    const failures = [];
    for (const cache of [caches.avatars, caches.thumbnails]) {
      const db = cache.db;
      const transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
      try {
        await cache.removeOwners(['alice_net1']);
        failures.push('resolved');
      } catch {
        failures.push('rejected');
      } finally {
        db.transaction = transaction;
      }
    }
    return { failures, rows: await snapshot(caches) };
  }));
  assert.deepEqual(result.failures, ['rejected', 'rejected']);
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'keep', ownerKeys: ['alice_net1'] }]));
});

test('backup imports retain accepted ownership, register skipped-byte hits, and leave legacy records untracked', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { avatars, thumbnails } = caches;
    const info = owners => ({ data: btoa('backup-image'), type: 'image/png', originalType: 'image/png', ...(owners ? { ownerKeys: owners } : {}) });
    const backup = {
      restored: info(['alice_net1', 'foreign_net1']),
      legacy: info(),
    };
    await avatars.importAll(backup, false, ['alice_net1']);
    await thumbnails.importAll(backup, false, ['alice_net1']);
    const initial = [await readRows(avatars), await readRows(thumbnails)]
      .map(rows => rows.map(({ id, ownerKeys }) => ({ id, ownerKeys })));
    await avatars.importAll({ restored: info(['bob_net1']) }, false, ['bob_net1']);
    await thumbnails.importAll({ restored: info(['bob_net1']) }, false, ['bob_net1']);
    const exported = [await avatars.exportAll(), await thumbnails.exportAll()]
      .map(data => ({ restored: data.restored.ownerKeys?.sort(), legacyTracked: Object.hasOwn(data.legacy, 'ownerKeys') }));
    await removeEverywhere(caches, ['alice_net1']);
    return { initial, exported, remaining: (await snapshot(caches)).slice(0, 2) };
  }));
  assert.deepEqual(result.initial, Array(2).fill([
    { id: 'legacy', ownerKeys: undefined }, { id: 'restored', ownerKeys: ['alice_net1'] },
  ]));
  assert.deepEqual(result.exported, Array(2).fill({ restored: ['alice_net1', 'bob_net1'], legacyTracked: false }));
  assert.deepEqual(result.remaining, Array(2).fill([
    { id: 'legacy', ownerKeys: undefined }, { id: 'restored', ownerKeys: ['bob_net1'] },
  ]));
});

test('single-account removal waits for both databases before deleting storage or reloading', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'alice-only');
    const modal = installRemovalModals(caches);
    const initial = accountState();
    let releaseAvatar, releaseThumbnail, avatarCompleted;
    const avatarGate = new Promise(resolve => { releaseAvatar = resolve; });
    const thumbnailGate = new Promise(resolve => { releaseThumbnail = resolve; });
    const avatarDone = new Promise(resolve => { avatarCompleted = resolve; });
    const removeAvatar = caches.avatars.removeOwners.bind(caches.avatars);
    const removeThumbnail = caches.thumbnails.removeOwners.bind(caches.thumbnails);
    let calls = 0;
    caches.avatars.removeOwners = async keys => { calls++; await avatarGate; await removeAvatar(keys); avatarCompleted(); };
    caches.thumbnails.removeOwners = async keys => { calls++; await thumbnailGate; await removeThumbnail(keys); };
    const pending = modal.submit('alice');
    const before = accountState();
    const duplicate = await modal.removeAccounts([{ username: 'alice', netid: 'net1' }]);
    releaseAvatar();
    await avatarDone;
    const afterOne = accountState();
    releaseThumbnail();
    await pending;
    return { initial, before, afterOne, duplicate, calls, final: accountState(), rows: await snapshot(caches) };
  }));
  assert.deepEqual(result.before, result.initial);
  assert.deepEqual(result.afterOne, result.initial);
  assert.equal(result.duplicate, false);
  assert.equal(result.calls, 2);
  assert.deepEqual(result.final.data, [null, 'bob-account-data', 'carol-account-data']);
  assert.deepEqual(Object.keys(result.final.registry.netids.net1.usernames), ['bob', 'carol']);
  assert.deepEqual(result.final.registry.netids.net1.signInUsernameOrder.public, ['bob', 'carol']);
  assert.equal(result.final.reloads, 1);
  assert.equal(result.final.clears, 1);
  assert.deepEqual(result.rows, [[], [], []]);
});

test('failed cleanup waits for the other database and preserves account data without success or reload', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const modal = installRemovalModals(caches);
    const initial = accountState();
    let releaseThumbnail;
    const thumbnailGate = new Promise(resolve => { releaseThumbnail = resolve; });
    caches.avatars.removeOwners = async () => { throw new Error('Synthetic IndexedDB failure'); };
    caches.thumbnails.removeOwners = () => thumbnailGate;
    const pending = modal.submit('alice');
    await Promise.resolve();
    const beforeOtherSettles = { storage: accountState(), errors: toasts.length, busy: modal.isRemoving };
    releaseThumbnail();
    await pending;
    return { initial, beforeOtherSettles, final: accountState(), toasts, busy: modal.isRemoving };
  }));
  assert.deepEqual(result.beforeOtherSettles, { storage: result.initial, errors: 0, busy: true });
  assert.deepEqual(result.final, result.initial);
  assert.deepEqual(result.toasts.map(toast => toast.type), ['error']);
  assert.equal(result.busy, false);
});

test('selected-account modal removes selected account data and keeps the surviving shared owner', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'selected-only');
    await saveEverywhere(caches, 'shared');
    for (const username of ['bob', 'carol']) {
      const owner = await captureEverywhere(caches, username);
      await caches.avatars.get('shared', owner[0]);
      await caches.thumbnails.get('shared', owner[1]);
      await caches.images.get('shared', owner[2]);
    }
    installRemovalModals(caches);
    const modal = new RemoveAccountsModal();
    modal.modal = document.createElement('div');
    modal.modal.classList.add('active');
    modal.listContainer = document.createElement('div');
    modal.listContainer.innerHTML = '<input type="checkbox" data-username="alice" data-netid="net1" checked><input type="checkbox" data-username="bob" data-netid="net1" checked><input type="checkbox" data-username="carol" data-netid="net1">';
    await modal.handleSubmit();
    return { storage: accountState(), rows: await snapshot(caches), toasts, closed: !modal.modal.classList.contains('active') };
  }));
  assert.deepEqual(result.storage.data, [null, null, 'carol-account-data']);
  assert.deepEqual(Object.keys(result.storage.registry.netids.net1.usernames), ['carol']);
  assert.deepEqual(result.storage.registry.netids.net1.signInUsernameOrder.public, ['carol']);
  assert.equal(result.storage.reloads, 0);
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'shared', ownerKeys: ['carol_net1'] }]));
  assert.deepEqual(result.toasts.map(toast => toast.type), ['success']);
  assert.equal(result.closed, true);
});

test('attachment identity remains independent of storage host through reads, replacement and deletion', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const owners = await captureEverywhere(caches, 'alice');
    const oldUrl = 'https://old.example/get/shared';
    const alias = 'http://new.example:8080/get/shared/?token=changed#preview';
    await caches.thumbnails.save(oldUrl, imageBlob('old-thumb'), 'image/png', owners[1]);
    await caches.images.put({ url: oldUrl, type: 'image/png' }, imageBlob('old-full'), undefined, owners[2]);
    const initial = [await (await caches.thumbnails.get(alias, owners[1])).text(), await (await caches.images.get(alias, owners[2])).text()];
    await caches.thumbnails.save(alias, imageBlob('new-thumb'), 'image/png', owners[1]);
    await caches.images.put({ url: alias, type: 'image/png' }, imageBlob('new-full'), undefined, owners[2]);
    const replaced = [await (await caches.thumbnails.get(oldUrl, owners[1])).text(), await (await caches.images.get(oldUrl, owners[2])).text()];
    const rows = (await snapshot(caches)).slice(1);
    await caches.thumbnails.delete('https://third.example/get/shared#delete');
    await caches.images.delete('https://third.example/get/shared#delete');
    return { initial, replaced, rows, deleted: (await snapshot(caches)).slice(1) };
  }));
  assert.deepEqual(result, {
    initial: ['old-thumb', 'old-full'], replaced: ['new-thumb', 'new-full'],
    rows: Array(2).fill([{ id: 'shared', ownerKeys: ['alice_net1'] }]), deleted: [[], []],
  });
});

test('full-image replacement and FIFO eviction still respect the byte budget', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { images } = caches;
    images.maxCacheSize = 11;
    const owner = await images.captureOwner({ username: 'alice', netid: 'net1' });
    const realNow = Date.now;
    let time = 1;
    Date.now = () => time++;
    try {
      await images.put(photo('a'), imageBlob('first'), undefined, owner);
      await images.put(photo('b'), imageBlob('second'), undefined, owner);
      await images.put(photo('a'), imageBlob('FIRST'), undefined, owner);
      const afterReplace = await images.getCacheSize();
      await images.put(photo('c'), imageBlob('third!'), undefined, owner);
      const oversized = await images.put(photo('too-big'), imageBlob('twelve-bytes'), undefined, owner);
      return {
        afterReplace, oversized, size: await images.getCacheSize(),
        keys: (await readRows(caches.thumbnails, 'fullImages')).map(row => row.id),
        first: await (await images.get('a', owner)).text(), second: await images.get('b', owner),
        third: await (await images.get('c', owner)).text(),
      };
    } finally { Date.now = realNow; }
  }));
  assert.deepEqual(result, { afterReplace: 11, oversized: false, size: 11, keys: ['a', 'c'], first: 'FIRST', second: null, third: 'third!' });
});

test('owner capture and storage failures do not prevent downloading and displaying an image', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    let downloads = 0;
    const captureFailure = await caches.images.getOrCache({
      attachment: photo('capture-failure'), owner: Promise.reject(new Error('Synthetic owner capture failure')),
      downloadAndDecrypt: async () => { downloads++; return imageBlob('capture-fallback'); },
    });
    const init = caches.thumbnails.init.bind(caches.thumbnails);
    caches.thumbnails.init = async () => { throw new Error('Synthetic storage failure'); };
    let storageFailure;
    try {
      storageFailure = await caches.images.getOrCache({
        attachment: photo('storage-failure'),
        downloadAndDecrypt: async () => { downloads++; return imageBlob('storage-fallback'); },
      });
    } finally { caches.thumbnails.init = init; }
    return { downloads, capture: await captureFailure.text(), storage: await storageFailure.text() };
  }));
  assert.deepEqual(result, { downloads: 2, capture: 'capture-fallback', storage: 'storage-fallback' });
});

test('empty lookups, rejected writes and invalid attachments do not attempt owner capture or storage', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    let captures = 0;
    let opens = 0;
    for (const cache of [caches.avatars, caches.thumbnails, caches.images]) {
      cache.captureOwner = () => { captures++; throw new Error('Unexpected owner capture'); };
    }
    for (const cache of [caches.avatars, caches.thumbnails]) {
      cache.init = async () => { opens++; throw new Error('Unexpected storage open'); };
    }
    caches.images.maxCacheSize = 4;
    const settle = async operation => {
      try { return { value: await operation() }; }
      catch (error) { return { error: error.message }; }
    };
    const invalidUrl = 'https://storage.example/not-an-attachment';
    const outcomes = await Promise.all([
      settle(() => caches.avatars.get(null)),
      settle(() => caches.avatars.getBlobUrl(null)),
      settle(() => caches.avatars.save(null, imageBlob('x'))),
      settle(() => caches.images.put(photo('oversized'), imageBlob('oversized'))),
      settle(() => caches.images.put(photo('disallowed'), imageBlob('x'), () => false)),
      settle(() => caches.images.put({}, imageBlob('x'))),
      settle(() => caches.images.put({ url: photo('text').url, type: 'text/plain' }, imageBlob('x'))),
      settle(() => caches.images.put(photo('invalid-blob'), {})),
      settle(() => caches.images.get(invalidUrl)),
      settle(() => caches.images.getRecord(invalidUrl)),
      settle(() => caches.thumbnails.get(invalidUrl)),
      settle(() => caches.thumbnails.save(invalidUrl, imageBlob('x'), 'image/png')),
    ]);
    return { captures, opens, outcomes };
  }));
  assert.equal(result.captures, 0, 'validation and early returns must precede owner capture');
  assert.equal(result.opens, 0);
  assert.deepEqual(result.outcomes, [
    { value: null }, { value: null }, { error: 'avatar id required' },
    { value: false }, { value: false },
    { error: 'Cannot cache an image without an attachment URL' },
    { error: 'Full-image cache accepts only image attachments' },
    { error: 'Full-image cache requires a Blob' },
    ...Array(4).fill({ error: 'Invalid attachment URL' }),
  ]);
});

test('synchronously thrown ownership actions abort queued writes before they reach IndexedDB', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    let error;
    try {
      await caches.avatars.ownership.run(['avatars'], null, ({ transaction }) => {
        transaction.objectStore('avatars').put({ id: 'must-rollback', blob: imageBlob('queued'), savedAt: 1 });
        throw new Error('Synthetic action failure after queued write');
      });
    } catch (failure) { error = failure.message; }
    return { error, rows: await readRows(caches.avatars) };
  }));
  assert.match(result.error, /Synthetic action failure|abort/i);
  assert.deepEqual(result.rows, [], 'rejecting the action must also roll back its pending writes');
});

test('a removed owner cannot evict a surviving account thumbnail before its late save is rejected', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { thumbnails } = caches;
    thumbnails.maxCacheSize = 10;
    const bob = await thumbnails.captureOwner({ username: 'bob', netid: 'net1' });
    const alice = await thumbnails.captureOwner({ username: 'alice', netid: 'net1' });
    await thumbnails.save('bob-only', imageBlob('0123456789'), 'image/png', bob);
    await thumbnails.removeOwners(['alice_net1']);
    const saved = await thumbnails.save('late-alice', imageBlob('x'), 'image/png', alice);
    const rows = (await readRows(thumbnails)).map(({ id, ownerKeys }) => ({ id, ownerKeys }));
    return { saved, rows, bytes: await thumbnails.getCacheSize() };
  }));
  assert.deepEqual(result, { saved: false, rows: [{ id: 'bob-only', ownerKeys: ['bob_net1'] }], bytes: 10 });
});
