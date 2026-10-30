import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Run directly with WEB_CLIENT_ROOT=/absolute/client node this-file.mjs.
// Synthetic accounts only: no browser, external network, or signing is used.
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to an absolute client checkout.');
globalThis.crypto ??= webcrypto;
const [appSource, crypto, lib] = await Promise.all([
  readFile(join(clientRoot, 'app.js'), 'utf8'),
  import(pathToFileURL(join(clientRoot, 'crypto.js')).href),
  import(pathToFileURL(join(clientRoot, 'lib.js')).href),
]);

const password = 'legacy-pass';
const salt = '0123456789abcdef0123456789abcdef';
// Independently generated with Python hashlib.blake2b(digest_size=32),
// iterating 100,000 times from the UTF-8 input, without an extra initial hash.
const legacyVerifier = 'dd4582af022abccbbdd9ebaf1bdb075bd0a536b35f2b2a3f81396fc2648eb4c3';
const legacyEncryptionKey = '0731868d9b979a9658ce38f0c3cd97d16604825f3bed10a87fbb877e9b4e2cf1';
const saltedVerifier = '4b0116e280d217d61f4853b514f17bce4d4b5f30053dee2bfc6bd6f48eca1fce';
const saltedLock = salt + saltedVerifier;
const otherSaltedLock = 'f'.repeat(32) + '49ffaae0b22c87eb22ad7d2b8aa2096b9cb8c066bf4698406903604b3e5fa5a1';
const localLock = 'e'.repeat(32) + 'cbdab6c40a7e4443653de92fe616eb7bfe2d7a9da6f9e0c854e8a21e3b1719ce';
const newEncryptionKey = '676ca57d4826973a0b02825d4a5dc5ae9217a852d0e43c5eddcd5b057b6270ba';
const recordPattern = /^[0-9a-f]{96}$/;
const netid = 'a'.repeat(64);
const accountKey = `alice_${netid}`;
const account = { account: { username: 'alice', netid, keys: { address: 'b'.repeat(40) } } };
const plaintext = JSON.stringify(account);
const submit = { preventDefault() {} };

function between(start, end) {
  const first = appSource.indexOf(start);
  const last = appSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Cannot locate client source: ${start}`);
  return appSource.slice(first, last);
}

function storageFixture(initial = {}) {
  const storage = { ...initial };
  Object.defineProperties(storage, {
    getItem: { value: key => Object.hasOwn(storage, key) ? storage[key] : null },
    setItem: { value: (key, value) => { storage[key] = String(value); } },
    removeItem: { value: key => { delete storage[key]; } },
    key: { value: index => Object.keys(storage)[index] ?? null },
    length: { get: () => Object.keys(storage).length },
  });
  return storage;
}

function element(value = '', display = 'none') {
  return { value, style: { display }, textContent: '', classList: { remove() {} } };
}

function fixture(initial = {}) {
  const storage = storageFixture(initial);
  const toasts = [];
  const context = {
    ...crypto, bin2hex: lib.bin2hex,
    localStorage: storage, parse: JSON.parse, stringify: JSON.stringify,
    console, setTimeout, clearTimeout,
    showToast: (...args) => { toasts.push(args); return toasts.length; },
    hideToast() {}, saveState() {}, clearMyData() {}, confirm: () => true,
    document: { contains: () => false, addEventListener() {}, removeEventListener() {} },
    window: { location: { reload() {} } },
    signInModal: { open() {} },
    myAccount: account.account, myData: account,
    contactAvatarCache: { exportAll: async () => ({}), importAll: async () => {} },
    thumbnailCache: { exportAll: async () => ({}), importAll: async () => {} },
  };
  const classes = runInNewContext([
    between('async function encryptAllAccounts(', '\nfunction saveState('),
    between('class LockModal {', 'const lockModal = new LockModal();'),
    'const lockModal = new LockModal();',
    between('class UnlockModal {', 'const unlockModal = new UnlockModal();'),
    between('class BackupAccountModal {', 'const backupModal = new BackupAccountModal();'),
    between('class RestoreAccountModal {', 'const importModal = new RestoreAccountModal();'),
    '({ UnlockModal, BackupAccountModal, RestoreAccountModal, lockModal })',
  ].join('\n'), context);
  const lock = classes.lockModal;
  lock.oldPasswordInput = element();
  lock.newPasswordInput = element();
  lock.confirmNewPasswordInput = element();
  lock.passwordWarning = element();
  lock.modal = element();
  const unlock = new classes.UnlockModal();
  unlock.passwordInput = element();
  unlock.modal = element();
  const restore = Object.create(classes.RestoreAccountModal.prototype);
  restore.backupAccountLock = element();
  restore.overwriteAccountsCheckbox = { checked: true };
  restore.passwordInput = element();
  restore.sourceLocationSelect = { value: 'local' };
  restore.developerOptionsEnabled = false;
  const backup = new classes.BackupAccountModal();
  backup.passwordInput = element();
  backup.generateBackupFilename = () => 'synthetic-backup.json';
  const exports = [];
  backup.handleGoogleDriveUpload = async data => exports.push(data);
  return { ...classes, storage, toasts, lock, unlock, restore, backup, exports };
}

function accountStorage(lock) {
  return {
    lock,
    accounts: JSON.stringify({ netids: { [netid]: { usernames: { alice: { address: 'b'.repeat(40) } } } } }),
    [accountKey]: crypto.encryptData(plaintext, legacyEncryptionKey, true),
  };
}

function lockInputs(f, mode, oldPassword = '', newPassword = '') {
  f.lock.mode = mode;
  f.lock.oldPasswordInput.value = oldPassword;
  f.lock.oldPasswordInput.style.display = mode === 'set' ? 'none' : 'block';
  f.lock.newPasswordInput.value = newPassword;
  f.lock.confirmNewPasswordInput.value = newPassword;
}

function snapshot(storage) {
  return Object.fromEntries(Object.entries(storage));
}

test('no salt preserves the exact legacy verifier and account encryption key', async () => {
  assert.equal(await crypto.passwordToKey(password), legacyVerifier);
  assert.equal(await crypto.passwordToKey(password + 'liberdusData'), legacyEncryptionKey);
  assert.equal(await crypto.passwordToKey(''), null);
});

test('optional salt changes password derivation while an empty salt preserves legacy output', async () => {
  assert.equal(await crypto.passwordToKey(password, salt), saltedVerifier);
  assert.equal(await crypto.passwordToKey(password, ''), legacyVerifier);
});

test('new locks store independent random salts and verify with their own saved salt', async () => {
  const { lock } = fixture();
  const first = await lock.createLock(password);
  const second = await lock.createLock(password);
  assert.match(first, recordPattern);
  assert.match(second, recordPattern);
  assert.notEqual(first.slice(0, 32), second.slice(0, 32));
  for (const record of [first, second]) {
    const recordSalt = record.slice(0, 32);
    const verifier = record.slice(32);
    assert.equal(verifier, await crypto.passwordToKey(password, recordSalt));
    assert.equal(await lock.verifyPassword(password, record), true);
    assert.equal(await lock.verifyPassword('wrong-password', record), false);
  }
});

test('verification accepts legacy records and fails closed for damaged or unsupported records', async () => {
  const { lock } = fixture();
  assert.equal(await lock.verifyPassword(password, legacyVerifier), true);
  assert.equal(await lock.verifyPassword('wrong-password', legacyVerifier), false);
  assert.equal(await lock.verifyPassword(password, saltedLock), true);
  const invalid = [
    '', null, undefined, 42, {}, '0'.repeat(63), 'g'.repeat(64),
    '0'.repeat(65), '0'.repeat(95), '0'.repeat(97), 'g'.repeat(96),
    `v2:${salt}:${saltedVerifier}`, salt.toUpperCase() + saltedVerifier,
    ` ${saltedLock}`, `${saltedLock}\n`, salt + '0'.repeat(64),
  ];
  for (const record of invalid) {
    assert.equal(await lock.verifyPassword(password, record), false, String(record));
  }
  assert.equal(await lock.verifyPassword('', legacyVerifier), false);
  assert.equal(await lock.verifyPassword('', saltedLock), false);
});

test('legacy accounts unlock without changing their lock record or encrypted data', async () => {
  const f = fixture(accountStorage(legacyVerifier));
  const before = snapshot(f.storage);
  f.unlock.passwordInput.value = password;
  await f.unlock.handleSubmit(submit);
  assert.equal(f.unlock.isLocked(), false);
  assert.equal(f.lock.encKey, legacyEncryptionKey);
  assert.equal(crypto.decryptData(f.storage[accountKey], f.lock.encKey, true), plaintext);
  assert.deepEqual(snapshot(f.storage), before);
});

test('setting a lock saves a salted record and keeps the established account encryption format', async () => {
  const f = fixture(accountStorage(legacyVerifier));
  delete f.storage.lock;
  f.storage[accountKey] = plaintext;
  lockInputs(f, 'set', '', password);
  await f.lock.handleSubmit(submit);
  assert.match(f.storage.lock, recordPattern);
  assert.equal(await f.lock.verifyPassword(password, f.storage.lock), true);
  assert.equal(f.lock.encKey, legacyEncryptionKey);
  assert.notEqual(f.storage[accountKey], plaintext);
  assert.equal(crypto.decryptData(f.storage[accountKey], legacyEncryptionKey, true), plaintext);
});

test('salted accounts unlock with the saved salt without rewriting their data or lock', async () => {
  const f = fixture(accountStorage(saltedLock));
  const before = snapshot(f.storage);
  f.unlock.passwordInput.value = password;
  await f.unlock.handleSubmit(submit);
  assert.equal(f.unlock.isLocked(), false);
  assert.equal(f.lock.encKey, legacyEncryptionKey);
  assert.equal(crypto.decryptData(f.storage[accountKey], f.lock.encKey, true), plaintext);
  assert.deepEqual(snapshot(f.storage), before);
});

test('wrong passwords and damaged records cannot unlock or mutate stored accounts', async () => {
  for (const record of [legacyVerifier, saltedLock, `v3:${salt}:${saltedVerifier}`, 'damaged']) {
    const f = fixture(accountStorage(record));
    const before = snapshot(f.storage);
    f.unlock.passwordInput.value = 'wrong-password';
    await f.unlock.handleSubmit(submit);
    assert.equal(f.unlock.isLocked(), true);
    assert.equal(f.lock.encKey, null);
    assert.deepEqual(snapshot(f.storage), before);
    assert.ok(f.toasts.some(([, , kind]) => kind === 'error'));
  }
});

test('changing either legacy or salted locks creates a fresh salt and re-encrypts accounts', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture(accountStorage(record));
    lockInputs(f, 'change', password, 'new-pass');
    await f.lock.handleSubmit(submit);
    assert.match(f.storage.lock, recordPattern);
    assert.notEqual(f.storage.lock, record);
    assert.notEqual(f.storage.lock.slice(0, 32), salt);
    assert.equal(await f.lock.verifyPassword('new-pass', f.storage.lock), true);
    assert.equal(await f.lock.verifyPassword(password, f.storage.lock), false);
    assert.equal(f.lock.encKey, newEncryptionKey);
    assert.equal(crypto.decryptData(f.storage[accountKey], newEncryptionKey, true), plaintext);
  }
});

test('wrong old passwords cannot change or remove either lock format', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    for (const mode of ['change', 'remove']) {
      const f = fixture(accountStorage(record));
      const before = snapshot(f.storage);
      lockInputs(f, mode, 'wrong-password', mode === 'change' ? 'new-pass' : '');
      await f.lock.handleSubmit(submit);
      assert.deepEqual(snapshot(f.storage), before);
      assert.equal(f.lock.encKey, null);
      assert.ok(f.toasts.some(([, , kind]) => kind === 'error'));
    }
  }
});

test('removing either lock format returns accounts to plaintext', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture(accountStorage(record));
    f.lock.encKey = legacyEncryptionKey;
    lockInputs(f, 'remove', password);
    await f.lock.handleSubmit(submit);
    assert.equal(f.storage.getItem('lock'), null);
    assert.equal(f.lock.encKey, null);
    assert.equal(f.storage[accountKey], plaintext);
  }
});

test('single and all-account backups preserve both lock formats independently of backup passwords', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture(accountStorage(record));
    const original = snapshot(f.storage);
    f.backup.passwordInput.value = 'backup-password-a';
    await f.backup.handleSubmitOne(true);
    f.backup.passwordInput.value = 'backup-password-b';
    await f.backup.handleSubmitAll(true);
    assert.equal(f.exports.length, 2);
    for (const [index, backupPassword] of ['backup-password-a', 'backup-password-b'].entries()) {
      const decoded = JSON.parse(crypto.decryptData(f.exports[index], backupPassword));
      assert.equal(decoded.lock, record);
      assert.equal(decoded[accountKey], original[accountKey]);
      assert.equal(crypto.decryptData(decoded[accountKey], legacyEncryptionKey, true), plaintext);
    }
    assert.deepEqual(snapshot(f.storage), original);
  }
});

test('restoring either lock format decrypts with its password and re-encrypts for the local lock', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture({ lock: localLock, unrelated: 'keep-me' });
    f.lock.encKey = newEncryptionKey;
    f.restore.backupAccountLock.value = password;
    assert.equal(await f.restore.mergeBackupAccountsToLocal(accountStorage(record)), 1);
    assert.equal(f.storage.lock, localLock);
    assert.equal(f.storage.unrelated, 'keep-me');
    assert.equal(crypto.decryptData(f.storage[accountKey], newEncryptionKey, true), plaintext);
    assert.equal(JSON.parse(f.storage.accounts).netids[netid].usernames.alice.address, account.account.keys.address);
  }
});

test('restoring legacy and salted backups into an unlocked app stores plaintext', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture({ unrelated: 'keep-me' });
    f.restore.backupAccountLock.value = password;
    assert.equal(await f.restore.mergeBackupAccountsToLocal(accountStorage(record)), 1);
    assert.equal(f.storage.getItem('lock'), null);
    assert.equal(f.storage[accountKey], plaintext);
  }
});

test('same passwords with different salts restore correctly and exact lock matches need no prompt', async () => {
  const f = fixture({ lock: otherSaltedLock });
  f.lock.encKey = legacyEncryptionKey;
  f.restore.backupAccountLock.value = password;
  assert.equal(await f.restore.mergeBackupAccountsToLocal(accountStorage(saltedLock)), 1);
  assert.equal(f.storage.lock, otherSaltedLock);
  assert.equal(crypto.decryptData(f.storage[accountKey], legacyEncryptionKey, true), plaintext);
  for (const record of [legacyVerifier, saltedLock]) {
    const matching = fixture({ lock: record });
    matching.lock.encKey = legacyEncryptionKey;
    const backup = accountStorage(record);
    assert.equal(await matching.restore.mergeBackupAccountsToLocal(backup), 1);
    assert.equal(matching.storage[accountKey], backup[accountKey]);
  }
});

test('wrong backup account passwords skip accounts without changing local data', async () => {
  for (const record of [legacyVerifier, saltedLock]) {
    const f = fixture({ lock: localLock, unrelated: 'keep-me' });
    f.lock.encKey = newEncryptionKey;
    f.restore.backupAccountLock.value = 'wrong-password';
    const before = snapshot(f.storage);
    assert.equal(await f.restore.mergeBackupAccountsToLocal(accountStorage(record)), 0);
    assert.deepEqual(snapshot(f.storage), before);
    assert.ok(f.toasts.some(([, , kind]) => kind === 'error'));
  }
});

test('encrypted backup restore uses its file password separately from its account-lock password', async () => {
  const f = fixture();
  const encryptedFile = crypto.encryptData(JSON.stringify(accountStorage(saltedLock)), 'backup-password');
  f.restore.fileInput = { files: [{ text: async () => encryptedFile }] };
  f.restore.passwordInput.value = 'backup-password';
  f.restore.backupAccountLock.value = password;
  await f.restore.handleSubmit(submit);
  assert.equal(f.storage[accountKey], plaintext);
  assert.ok(f.toasts.some(([message, , kind]) => kind === 'success' && message === '1 account restored'));
});
