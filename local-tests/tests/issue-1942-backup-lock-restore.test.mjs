import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

globalThis.crypto ??= webcrypto;

// Also works directly with node --test while the overlay runner is unpublished.
const clientRoot = process.env.WEB_CLIENT_ROOT;
if (clientRoot) assert.ok(isAbsolute(clientRoot), 'WEB_CLIENT_ROOT must be an absolute path');
const clientSource = file => clientRoot
  ? pathToFileURL(join(clientRoot, file))
  : new URL(`../${file}`, import.meta.url);
const { decryptData, encryptData, passwordToKey } = await import(clientSource('crypto.js'));
const { parse, stringify } = await import(clientSource('external/stringify-shardus.js'));
const app = readFileSync(clientSource('app.js'), 'utf8');
const start = app.indexOf('class RestoreAccountModal {');
const end = app.indexOf('const importModal = new RestoreAccountModal();', start);
assert.ok(start >= 0 && end > start);
const restoreModalSource = app.slice(start, end);

const netid = 'a'.repeat(64);
const accountKey = `restored_${netid}`;
const backupAccount = stringify({
  account: { username: 'restored', netid, keys: { address: 'b'.repeat(40) } },
});
const currentPassword = 'synthetic-device-password';
const backupPassword = 'synthetic-backup-account-password';
const firstSalt = '1'.repeat(32);
const secondSalt = '2'.repeat(32);
const [firstVerifier, secondVerifier, differentVerifier, legacyVerifier, currentKey, backupKey] = await Promise.all([
  passwordToKey(currentPassword, firstSalt),
  passwordToKey(currentPassword, secondSalt),
  passwordToKey(backupPassword, secondSalt),
  passwordToKey(currentPassword),
  passwordToKey(currentPassword + 'liberdusData'),
  passwordToKey(backupPassword + 'liberdusData'),
]);
const localLock = firstSalt + firstVerifier;
const samePasswordLock = secondSalt + secondVerifier;
const differentPasswordLock = secondSalt + differentVerifier;

function setup({ existingAccount = null, overwrite = false, locked = false } = {}) {
  const storage = new Map([['lock', localLock]]);
  if (existingAccount !== null) storage.set(accountKey, existingAccount);
  const localStorage = {
    get lock() { return storage.get('lock'); },
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const cache = { importAll() { assert.fail('No cache data supplied'); } };
  const RestoreAccountModal = vm.runInNewContext(restoreModalSource + '\nRestoreAccountModal', {
    localStorage, lockModal: { encKey: currentKey }, unlockModal: { isLocked: () => locked },
    contactAvatarCache: cache, thumbnailCache: cache, parse, stringify, decryptData, encryptData, passwordToKey,
    showToast() {},
    PopupSelect: { syncAll() {} },
    Option: class Option {
      constructor(label, value) { Object.assign(this, { label, value, dataset: {} }); }
    },
  });
  const modal = new RestoreAccountModal();
  modal.backupAccountLockGroup = { style: { display: 'none' } };
  modal.backupAccountLock = { value: '' };
  modal.passwordInput = { value: '' };
  modal.overwriteAccountsCheckbox = { checked: overwrite };
  function createSelect() {
    const options = [];
    return { options, add: option => options.push(option), remove: index => options.splice(index, 1) };
  }
  modal.oldStringSelect = createSelect();
  modal.newStringSelect = createSelect();
  return { modal, storage };
}

function lockedBackup(lock, key) {
  return { lock, [accountKey]: encryptData(backupAccount, key, true) };
}

test('an unlocked device restores backups with the same account password and independent verifiers', async () => {
  assert.notEqual(localLock, samePasswordLock);
  for (const lock of [samePasswordLock, legacyVerifier]) {
    const { modal, storage } = setup();
    const backup = lockedBackup(lock, currentKey);
    modal.googleDriveFileContent = stringify(backup);

    await modal.extractNetids();
    assert.equal(modal.backupAccountLockGroup.style.display, 'none');
    assert.equal(await modal.mergeBackupAccountsToLocal(backup), 1);
    assert.equal(decryptData(storage.get(accountKey), currentKey, true), backupAccount);
    assert.equal(parse(storage.get('accounts')).netids[netid].usernames.restored.address, 'b'.repeat(40));
    assert.equal(storage.get('lock'), localLock);
  }
});

test('a different account password is requested before a locked backup can be restored', async () => {
  const { modal, storage } = setup();
  const backup = lockedBackup(differentPasswordLock, backupKey);
  modal.googleDriveFileContent = encryptData(stringify(backup), 'synthetic-file-password');
  modal.passwordInput.value = 'synthetic-file-password';

  await modal.extractNetids();
  assert.equal(modal.backupAccountLockGroup.style.display, 'block');
  assert.equal(await modal.mergeBackupAccountsToLocal(backup), false);
  assert.equal(storage.has(accountKey), false);
  assert.equal(storage.has('accounts'), false);

  modal.backupAccountLock.value = backupPassword;
  assert.equal(await modal.mergeBackupAccountsToLocal(backup), 1);
  assert.equal(decryptData(storage.get(accountKey), currentKey, true), backupAccount);
  assert.equal(storage.get('lock'), localLock);
});

test('copying the local verifier cannot make tampered ciphertext overwrite account data', async () => {
  const existingAccount = encryptData(backupAccount, currentKey, true);
  const { modal, storage } = setup({ existingAccount, overwrite: true });
  const tampered = Buffer.from(existingAccount, 'base64');
  tampered[tampered.length - 1] ^= 1;

  const backup = { lock: localLock, [accountKey]: tampered.toString('base64') };
  assert.equal(await modal.mergeBackupAccountsToLocal(backup), false);
  assert.equal(storage.get(accountKey), existingAccount);
  assert.equal(storage.has('accounts'), false);
});

test('a locked device cannot restore with a cached key from its previous unlock', async () => {
  const { modal, storage } = setup({ locked: true });
  const backup = lockedBackup(localLock, currentKey);

  assert.equal(await modal.mergeBackupAccountsToLocal(backup), false);
  assert.equal(storage.has(accountKey), false);
});
