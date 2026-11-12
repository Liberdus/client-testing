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
const [appSource, libSource] = await Promise.all([
  readFile(resolve(clientRoot, 'app.js'), 'utf8'),
  readFile(resolve(clientRoot, 'lib.js'), 'utf8'),
]);
const mimeTypeSource = libSource.match(/^export (function normalizeMimeType\(value\) \{[\s\S]*?^\})/m)?.[1];
const budgetSource = appSource.match(/^const FULL_MEDIA_CACHE_MAX_SIZE = .*;$/m)?.[0];
assert.ok(mimeTypeSource && budgetSource, 'Cannot locate full-media MIME normalization or budget');

function cacheClass(name, instance) {
  const start = appSource.indexOf(`\nclass ${name}`);
  const end = appSource.indexOf(`\nconst ${instance} = new ${name}(`, start);
  assert.ok(start !== -1 && end > start, `Cannot locate production ${name}`);
  return appSource.slice(start, end);
}

const cacheSource = [
  'let myAccount = null, myData = null; const network = { netid: "net1" };',
  'let contactAvatarCache, thumbnailCache, removeAccountModal;',
  'const SIGN_IN_USERNAME_ORDER_KEY = "signInUsernameOrder";',
  'const parse = JSON.parse, stringify = JSON.stringify;',
  'const normalizeAddress = address => address.toLowerCase();',
  'const openModal = modal => modal.classList.add("active"), enterFullscreen = () => {};',
  'const showToast = (message, duration, type) => window.toasts.push({ message, type });',
  'const clearMyData = () => { window.clearCount++; };',
  mimeTypeSource,
  budgetSource,
  appSource.includes('\nclass MediaCacheOwnership')
    ? appSource.slice(appSource.indexOf('\nclass MediaCacheOwnership'), appSource.indexOf('\nclass ContactAvatarCache'))
    : '',
  cacheClass('ContactAvatarCache', 'contactAvatarCache'),
  cacheClass('ThumbnailCache', 'thumbnailCache'),
  cacheClass('FullMediaCache', 'fullMediaCache'),
  cacheClass('AvatarEditModal', 'avatarEditModal'),
  // Only adapt the browser reload endpoint so assertions can observe ordering without navigating away.
  cacheClass('RemoveAccountModal', 'removeAccountModal').replaceAll('window.location.reload()', 'window.recordReload()'),
  cacheClass('RemoveAccountsModal', 'removeAccountsModal').replaceAll('window.location.reload()', 'window.recordReload()'),
  'Object.assign(window, { MediaCacheOwnership, ContactAvatarCache, ThumbnailCache, FullMediaCache, AvatarEditModal, RemoveAccountModal, RemoveAccountsModal });',
  'window.useAccount = (username, netid = "net1") => { myAccount = username ? { username, netid } : null; network.netid = netid; };',
  'window.useData = data => { myData = data; myAccount = data?.account || null; };',
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
          fullImages: { indexName: 'cachedAt', records: [{ id: 'legacy', blob: new Blob(['full'], { type: 'image/png' }), size: 4, cachedAt: 1 }] },
        });
      }
      await Promise.all([avatars.init(), thumbnails.init()]);
      useAccount('alice');
      try {
        return await callback({ avatars, thumbnails, images: new FullMediaCache(thumbnails) });
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
    window.putImage = (images, attachment, blob, owner, shouldCache = () => true) =>
      images.put({ attachment, blob, owner, shouldCache });
    window.fullMediaSize = async thumbnails =>
      (await readRows(thumbnails, thumbnails.fullMediaStoreName)).reduce((bytes, row) => bytes + row.size, 0);
    window.saveEverywhere = async ({ avatars, thumbnails, images }, id) => {
      const owner = MediaCacheOwnership.getOwnerKey();
      await avatars.save(id, imageBlob(`avatar-${id}`), owner);
      await thumbnails.save(photo(id).url, imageBlob(`thumb-${id}`), 'image/png', owner);
      await putImage(images, photo(id), imageBlob(`full-${id}`), owner);
    };
    window.ownerForAccount = (username, netid = 'net1') =>
      MediaCacheOwnership.getOwnerKey({ username, netid });
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
    const stores = [caches.avatars, caches.thumbnails].map(cache => Array.from(cache.db.objectStoreNames));
    await saveEverywhere(caches, 'new');
    return { schemas, stores, rows: await snapshot(caches) };
  }));
  assert.deepEqual(result.schemas, Array(3).fill({ keyPath: 'id', ownerPath: 'ownerKeys', multiEntry: true, unique: false }));
  assert.deepEqual(result.stores, [['avatars'], ['fullImages', 'thumbnails']]);
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'new', ownerKeys: ['alice_net1'] }]));
});

test('cache hits add shared owners, including avatar blob-URL hits and another network', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    await saveEverywhere(caches, 'shared');
    const firstUrl = await caches.avatars.getBlobUrl('shared');
    let downloads = 0;
    let bobUrl;
    for (const [username, netid] of [['bob', 'net1'], ['alice', 'net2']]) {
      const owner = ownerForAccount(username, netid);
      bobUrl = await caches.avatars.getBlobUrl('shared', owner);
      await caches.thumbnails.get(photo('shared').url, owner);
      useAccount(username, netid);
      await caches.images.getOrCache({
        attachment: photo('shared'),
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
    const bob = ownerForAccount('bob');
    const carol = ownerForAccount('carol');
    await Promise.all([
      caches.avatars.get('shared', bob), caches.avatars.get('shared', carol),
      caches.thumbnails.get('shared', bob), caches.thumbnails.get('shared', carol),
      caches.images.get('shared', bob), caches.images.get('shared', carol),
    ]);
    return snapshot(caches);
  }));
  assert.deepEqual(result, Array(3).fill([{ id: 'shared', ownerKeys: ['alice_net1', 'bob_net1', 'carol_net1'] }]));
});

test('upgrading existing ID-keyed stores preserves untracked rows through hits and rewrites', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const before = await snapshot(caches);
    const owner = ownerForAccount('alice');
    await caches.avatars.getBlobUrl('legacy', owner);
    await caches.thumbnails.get('legacy', owner);
    await caches.images.get('legacy', owner);
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
    const bob = ownerForAccount('bob');
    const url = await caches.avatars.getBlobUrl('alice-only');
    await caches.avatars.get('shared', bob);
    await caches.thumbnails.get('shared', bob);
    await caches.images.get('shared', bob);
    await removeEverywhere(caches, ['alice_net1']);
    const afterAlice = await snapshot(caches);
    const deletedUrl = await caches.avatars.getBlobUrl('alice-only', bob);
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
    const bob = ownerForAccount('bob');
    await caches.avatars.get('selected', bob);
    await caches.thumbnails.get('selected', bob);
    await caches.images.get('selected', bob);
    const otherNetwork = ownerForAccount('alice', 'net2');
    await caches.avatars.get('keep', otherNetwork);
    await caches.thumbnails.get('keep', otherNetwork);
    await caches.images.get('keep', otherNetwork);
    await removeEverywhere(caches, ['alice_net1', 'bob_net1']);
    return snapshot(caches);
  }));
  assert.deepEqual(result, Array(3).fill([{ id: 'keep', ownerKeys: ['alice_net2'] }]));
});

test('best-effort removal allows late writes under their original account key', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const owner = MediaCacheOwnership.getOwnerKey();
    await saveEverywhere(caches, 'removed');
    let releaseDownload, startDownload;
    const downloaded = new Promise(resolve => { releaseDownload = resolve; });
    const started = new Promise(resolve => { startDownload = resolve; });
    const pendingImage = caches.images.getOrCache({
      attachment: photo('late'),
      downloadAndDecrypt: () => { startDownload(); return downloaded; },
    });
    await started;
    await removeEverywhere(caches, ['alice_net1']);
    const removed = await snapshot(caches);
    useAccount('bob');
    releaseDownload(imageBlob('late-full'));
    const image = await pendingImage;
    await caches.avatars.save('late', imageBlob('late-avatar'), owner);
    await caches.thumbnails.save('late', imageBlob('late-thumb'), 'image/png', owner);
    return { removed, late: await snapshot(caches), image: await image.text() };
  }));
  assert.deepEqual(result.removed, [[], [], []]);
  assert.deepEqual(result.late, Array(3).fill([{ id: 'late', ownerKeys: ['alice_net1'] }]));
  assert.equal(result.image, 'late-full');
});

test('an owner captured before switching accounts is retained for delayed writes', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const alice = ownerForAccount('alice');
    useAccount('bob');
    await caches.avatars.save('delayed', imageBlob('avatar'), alice);
    await caches.thumbnails.save('delayed', imageBlob('thumb'), 'image/png', alice);
    await putImage(caches.images, photo('delayed'), imageBlob('full'), alice);
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
    const info = (owners, contents = 'backup-image') => ({ data: btoa(contents), type: 'image/png', originalType: 'image/png', ...(owners ? { ownerKeys: owners } : {}) });
    const backup = {
      restored: info(['alice_net1', 'foreign_net1']),
      foreign: info(['foreign_net1']),
      legacy: info(),
    };
    const imported = [
      await avatars.importAll(backup, false, ['alice_net1']),
      await thumbnails.importAll(backup, false, ['alice_net1']),
    ];
    const initial = [await readRows(avatars), await readRows(thumbnails)]
      .map(rows => rows.map(({ id, ownerKeys }) => ({ id, ownerKeys })));
    const replacement = { restored: info(['bob_net1'], 'replacement') };
    const skipped = [
      await avatars.importAll(replacement, false, ['bob_net1']),
      await thumbnails.importAll(replacement, false, ['bob_net1']),
    ];
    const ownersAfterSkipped = [await readRows(avatars), await readRows(thumbnails)]
      .map(rows => rows.find(row => row.id === 'restored').ownerKeys?.sort());
    const beforeOverwrite = [
      await (await avatars.get('restored', null)).text(),
      await (await thumbnails.get('restored', null)).text(),
    ];
    const overwritten = [
      await avatars.importAll(replacement, true, ['bob_net1']),
      await thumbnails.importAll(replacement, true, ['bob_net1']),
    ];
    const afterOverwrite = [
      await (await avatars.get('restored', null)).text(),
      await (await thumbnails.get('restored', null)).text(),
    ];
    const exported = [await avatars.exportAll(), await thumbnails.exportAll()]
      .map(data => ({ restored: data.restored.ownerKeys?.sort(), legacyTracked: Object.hasOwn(data.legacy, 'ownerKeys') }));
    await removeEverywhere(caches, ['alice_net1']);
    return { imported, skipped, ownersAfterSkipped, overwritten, beforeOverwrite, afterOverwrite, initial, exported, remaining: (await snapshot(caches)).slice(0, 2) };
  }));
  assert.deepEqual(result.imported, [2, 2]);
  assert.deepEqual(result.skipped, [0, 0]);
  assert.deepEqual(result.ownersAfterSkipped, Array(2).fill(['alice_net1', 'bob_net1']));
  assert.deepEqual(result.overwritten, [1, 1]);
  assert.deepEqual(result.beforeOverwrite, ['backup-image', 'backup-image']);
  assert.deepEqual(result.afterOverwrite, ['replacement', 'replacement']);
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
      const owner = ownerForAccount(username);
      await caches.avatars.get('shared', owner);
      await caches.thumbnails.get('shared', owner);
      await caches.images.get('shared', owner);
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
    const owner = ownerForAccount('alice');
    const oldUrl = 'https://old.example/get/shared';
    const alias = 'http://new.example:8080/get/shared/?token=changed#preview';
    await caches.thumbnails.save(oldUrl, imageBlob('old-thumb'), 'image/png', owner);
    await putImage(caches.images, { url: oldUrl, type: 'image/png' }, imageBlob('old-full'), owner);
    const initial = [await (await caches.thumbnails.get(alias, owner)).text(), await (await caches.images.get(alias, owner)).text()];
    await caches.thumbnails.save(alias, imageBlob('new-thumb'), 'image/png', owner);
    await putImage(caches.images, { url: alias, type: 'image/png' }, imageBlob('new-full'), owner);
    const replaced = [await (await caches.thumbnails.get(oldUrl, owner)).text(), await (await caches.images.get(oldUrl, owner)).text()];
    const rows = (await snapshot(caches)).slice(1);
    await caches.thumbnails.delete('https://third.example/get/shared#delete');
    await caches.images.delete('https://third.example/get/shared#delete', 'image/png');
    return { initial, replaced, rows, deleted: (await snapshot(caches)).slice(1) };
  }));
  assert.deepEqual(result, {
    initial: ['old-thumb', 'old-full'], replaced: ['new-thumb', 'old-full'],
    rows: Array(2).fill([{ id: 'shared', ownerKeys: ['alice_net1'] }]), deleted: [[], []],
  });
});

test('deduplicating full images preserves FIFO eviction and the byte budget', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { images } = caches;
    images.maxCacheSize = 11;
    const owner = MediaCacheOwnership.getOwnerKey({ username: 'alice', netid: 'net1' });
    const realNow = Date.now;
    let time = 1;
    Date.now = () => time++;
    try {
      await putImage(images, photo('a'), imageBlob('first'), owner);
      await putImage(images, photo('b'), imageBlob('second'), owner);
      await putImage(images, photo('a'), imageBlob('FIRST'), owner);
      const afterDuplicate = await fullMediaSize(caches.thumbnails);
      const originalBytes = await (await images.get('a', owner)).text();
      await putImage(images, photo('c'), imageBlob('third'), owner);
      const oversized = await putImage(images, photo('too-big'), imageBlob('twelve-bytes'), owner);
      return {
        afterDuplicate, originalBytes, oversized, size: await fullMediaSize(caches.thumbnails),
        keys: (await readRows(caches.thumbnails, 'fullImages')).map(row => row.id),
        first: await images.get('a', owner), second: await (await images.get('b', owner)).text(),
        third: await (await images.get('c', owner)).text(),
      };
    } finally { Date.now = realNow; }
  }));
  assert.deepEqual(result, {
    afterDuplicate: 11, originalBytes: 'first', oversized: false, size: 11,
    keys: ['b', 'c'], first: null, second: 'second', third: 'third',
  });
});

test('storage failures do not prevent downloading and displaying an image', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    let downloads = 0;
    const init = caches.thumbnails.init;
    caches.thumbnails.init = async () => { throw new Error('Synthetic storage failure'); };
    try {
      const image = await caches.images.getOrCache({
        attachment: photo('storage-failure'),
        downloadAndDecrypt: async () => { downloads++; return imageBlob('storage-fallback'); },
      });
      return { downloads, contents: await image.text() };
    } finally { caches.thumbnails.init = init; }
  }));
  assert.deepEqual(result, { downloads: 1, contents: 'storage-fallback' });
});

test('empty lookups, rejected writes and invalid attachments do not access storage', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    let opens = 0;
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
      settle(() => putImage(caches.images, photo('oversized'), imageBlob('oversized'))),
      settle(() => putImage(caches.images, photo('disallowed'), imageBlob('x'), undefined, () => false)),
      settle(() => putImage(caches.images, {}, imageBlob('x'))),
      settle(() => putImage(caches.images, { url: photo('text').url, type: 'text/plain' }, imageBlob('x'))),
      settle(() => putImage(caches.images, photo('invalid-blob'), {})),
      settle(() => caches.images.get(invalidUrl)),
      settle(() => caches.images.getRecord(invalidUrl)),
      settle(() => caches.thumbnails.get(invalidUrl)),
      settle(() => caches.thumbnails.save(invalidUrl, imageBlob('x'), 'image/png')),
    ]);
    return { opens, outcomes };
  }));
  assert.equal(result.opens, 0);
  assert.deepEqual(result.outcomes, [
    { value: null }, { value: null }, { error: 'avatar id required' },
    { value: false }, { value: false },
    { error: 'Missing attachment URL or ID' },
    { error: 'Full-media cache accepts only images and videos' },
    { error: 'Full-media cache requires a Blob' },
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

test('a late thumbnail write after removal still follows the normal cache budget', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { thumbnails } = caches;
    thumbnails.maxCacheSize = 10;
    const bob = MediaCacheOwnership.getOwnerKey({ username: 'bob', netid: 'net1' });
    const alice = MediaCacheOwnership.getOwnerKey({ username: 'alice', netid: 'net1' });
    await thumbnails.save('bob-only', imageBlob('0123456789'), 'image/png', bob);
    await thumbnails.removeOwners(['alice_net1']);
    const saved = await thumbnails.save('late-alice', imageBlob('x'), 'image/png', alice);
    const rows = (await readRows(thumbnails)).map(({ id, ownerKeys }) => ({ id, ownerKeys }));
    return { saved, rows, bytes: await thumbnails.getCacheSize() };
  }));
  assert.deepEqual(result, { saved: true, rows: [{ id: 'late-alice', ownerKeys: ['alice_net1'] }], bytes: 1 });
});

test('owner keys are synchronous account snapshots without IndexedDB access', async () => {
  const result = await page.evaluate(() => {
    const open = indexedDB.open;
    const transaction = IDBDatabase.prototype.transaction;
    let storageCalls = 0;
    const fail = () => { storageCalls++; throw new Error('Unexpected ownership storage access'); };
    indexedDB.open = fail;
    IDBDatabase.prototype.transaction = fail;
    try {
      useAccount('alice');
      const owner = MediaCacheOwnership.getOwnerKey();
      useAccount('bob', 'net2');
      const keys = [
        owner, MediaCacheOwnership.getOwnerKey(),
        MediaCacheOwnership.getOwnerKey({ username: 'carol', netid: 'net3' }),
        MediaCacheOwnership.getOwnerKey(null),
        MediaCacheOwnership.getOwnerKey({ username: 'missing-network' }),
        MediaCacheOwnership.getOwnerKey({ netid: 'net1' }),
      ];
      useAccount(null);
      keys.push(MediaCacheOwnership.getOwnerKey());
      return { keys, storageCalls };
    } finally {
      indexedDB.open = open;
      IDBDatabase.prototype.transaction = transaction;
    }
  });
  assert.deepEqual(result, { keys: ['alice_net1', 'bob_net2', 'carol_net3', null, null, null, null], storageCalls: 0 });
});

test('default owners survive account switches during asynchronous cache reads and writes', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { avatars, thumbnails, images } = caches;
    await saveEverywhere(caches, 'shared');
    useAccount('bob');
    let releaseStorage;
    const storageReady = new Promise(resolve => { releaseStorage = resolve; });
    const originals = [avatars, thumbnails].map(cache => [cache, cache.init]);
    for (const [cache, init] of originals) {
      cache.init = async () => { await storageReady; return init.call(cache); };
    }
    try {
      const pending = Promise.all([
        avatars.get('shared'), thumbnails.get('shared'), images.get('shared'),
        avatars.save('delayed', imageBlob('avatar')),
        thumbnails.save('delayed', imageBlob('thumbnail'), 'image/png'),
        images.getOrCache({
          attachment: photo('delayed'),
          downloadAndDecrypt: async () => imageBlob('full'),
        }),
      ]);
      useAccount('carol');
      releaseStorage();
      const results = await pending;
      return { hits: results.slice(0, 3).every(blob => blob instanceof Blob), rows: await snapshot(caches) };
    } finally {
      for (const [cache, init] of originals) cache.init = init;
    }
  }));
  assert.equal(result.hits, true);
  assert.deepEqual(result.rows, Array(3).fill([
    { id: 'delayed', ownerKeys: ['bob_net1'] },
    { id: 'shared', ownerKeys: ['alice_net1', 'bob_net1'] },
  ]));
});

test('explicit null ownership still permits untracked records while an account is active', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { avatars, thumbnails, images } = caches;
    useAccount('bob');
    await avatars.save('untracked', imageBlob('avatar'), null);
    await thumbnails.save('untracked', imageBlob('thumbnail'), 'image/png', null);
    await putImage(images, photo('untracked'), imageBlob('full'), null);
    await removeEverywhere(caches, ['alice_net1', 'bob_net1']);
    return {
      rows: await snapshot(caches),
      contents: [
        await (await avatars.get('untracked', null)).text(),
        await (await thumbnails.get('untracked', null)).text(),
        await (await images.get('untracked', null)).text(),
      ],
    };
  }));
  assert.deepEqual(result.rows, Array(3).fill([{ id: 'untracked', ownerKeys: undefined }]));
  assert.deepEqual(result.contents, ['avatar', 'thumbnail', 'full']);
});

test('avatar editor helpers select the current account and retain ownership across their cache reads', async () => {
  const result = await page.evaluate(() => withCaches(async ({ avatars }) => {
    const accountData = (username, contact) => ({ account: { username, netid: 'net1' }, contacts: { contact } });
    const alice = accountData('alice', { mineAvatarId: 'alice-preview' });
    const bob = accountData('bob', { avatarId: 'bob-contact', mineAvatarId: 'bob-uploaded' });
    const carol = accountData('carol', { avatarId: 'carol-contact', mineAvatarId: 'carol-uploaded' });
    for (const id of ['alice-preview', 'bob-contact', 'bob-uploaded']) {
      await avatars.save(id, imageBlob(id), 'seed_net1');
    }
    contactAvatarCache = avatars;
    const modal = new AvatarEditModal();
    for (const name of ['modal', 'avatarThumbContact', 'avatarThumbUploaded', 'avatarThumbIdenticon', 'avatarOptionsContainer', 'avatarOptionsActions', 'avatarUseButton']) {
      modal[name] = document.createElement('div');
    }
    // Keep real preview/option selection; image decoding and button cooldown are unrelated here.
    window.generateIdenticon = () => '<svg></svg>';
    window.withButtonCooldown = (_button, _delay, _message, action) => action;
    window.BUTTON_COOLDOWN_MS = 0;
    let preview;
    modal.setImageFromBlob = async blob => { preview = await blob.text(); useData(bob); };
    const get = avatars.get.bind(avatars);
    avatars.get = async (id, owner) => {
      const blob = await get(id, owner);
      if (id === 'bob-contact') useData(carol);
      return blob;
    };
    useData(alice);
    try {
      await modal.open('CONTACT');
      const options = await Promise.all([modal.avatarThumbContact, modal.avatarThumbUploaded].map(async thumb => {
        const image = thumb.querySelector('img');
        return image ? (await fetch(image.src)).text() : null;
      }));
      return {
        preview, options,
        owners: (await readRows(avatars)).map(({ id, ownerKeys }) => ({ id, ownerKeys: ownerKeys.sort() })),
        currentUsername: myData.account.username,
        address: modal.currentAddress,
        opened: modal.modal.classList.contains('active'),
        optionsVisible: modal.avatarOptionsContainer.style.display === 'block',
      };
    } finally {
      for (const url of modal._optionBlobUrls) URL.revokeObjectURL(url);
      delete window.generateIdenticon;
      delete window.withButtonCooldown;
      delete window.BUTTON_COOLDOWN_MS;
    }
  }));
  assert.deepEqual(result, {
    preview: 'alice-preview', options: ['bob-contact', 'bob-uploaded'],
    owners: [
      { id: 'alice-preview', ownerKeys: ['alice_net1', 'seed_net1'] },
      { id: 'bob-contact', ownerKeys: ['bob_net1', 'seed_net1'] },
      { id: 'bob-uploaded', ownerKeys: ['bob_net1', 'seed_net1'] },
    ],
    currentUsername: 'carol', address: 'contact', opened: true, optionsVisible: true,
  });
});

test('caching a duplicate legacy full image without cachedAt preserves its untracked record', async () => {
  const result = await page.evaluate(() => withCaches(async caches => {
    const { thumbnails, images } = caches;
    await writeRows(thumbnails, 'fullImages', [{ id: 'legacy-no-time', blob: imageBlob('old'), size: 3 }]);
    const [legacy] = await readRows(thumbnails, 'fullImages');
    const owner = MediaCacheOwnership.getOwnerKey({ username: 'alice', netid: 'net1' });
    const saved = await putImage(images, photo('legacy-no-time'), imageBlob('replacement'), owner);
    const [replaced] = await readRows(thumbnails, 'fullImages');
    await removeEverywhere(caches, ['alice_net1']);
    const remaining = await readRows(thumbnails, 'fullImages');
    return {
      startedWithoutTimestamp: !Object.hasOwn(legacy, 'cachedAt'),
      saved, trackedAfterReplacement: Object.hasOwn(replaced, 'ownerKeys'), timestamp: typeof replaced.cachedAt,
      remaining: await Promise.all(remaining.map(async record => ({
        id: record.id, tracked: Object.hasOwn(record, 'ownerKeys'), size: record.size, contents: await record.blob.text(),
      }))),
    };
  }));
  assert.deepEqual(result, {
    startedWithoutTimestamp: true, saved: true, trackedAfterReplacement: false, timestamp: 'undefined',
    remaining: [{ id: 'legacy-no-time', tracked: false, size: 3, contents: 'old' }],
  });
});
