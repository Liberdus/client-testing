import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { after, before, beforeEach, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Run with WEB_CLIENT_ROOT=/path/to/web-client-v2 node --test this-file.mjs.
const require = createRequire(import.meta.url);
const { chromium, expect } = require(require.resolve('@playwright/test', {
  paths: [fileURLToPath(new URL('../../playwright-tests/', import.meta.url)), fileURLToPath(new URL('.', import.meta.url))],
}));
assert.ok(process.env.WEB_CLIENT_ROOT, 'Set WEB_CLIENT_ROOT to the web-client-v2 checkout');
const client = resolve(process.env.WEB_CLIENT_ROOT);
const origin = 'https://restore.test';
const netid = runInNewContext(await readFile(resolve(client, 'network.js'), 'utf8') + '\nnetwork.netid');
const version = (await readFile(resolve(client, 'version.html'), 'utf8')).trim();
const account = (username, digit) => ({
  account: { username, netid, keys: { address: digit.repeat(40) } },
  contacts: {}, chats: [],
});
const alice = account('alice', 'a');
const bob = account('bob', 'b');
const local = account('local', 'c');
const accountKey = user => user.account.username + '_' + netid;
let browser, page, confirmations;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function newAndroidProfile() {
  const profile = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/113.0 Mobile Safari/537.36',
    serviceWorkers: 'block',
  });
  // The app, crypto and UI are real. Only checked-out assets and a synthetic network account can load.
  await profile.route('**/*', async route => {
    const { origin: target, pathname } = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.abort();
    if (target !== origin) {
      if (pathname === '/account/' + '0'.repeat(64)) {
        return route.fulfill({ json: { account: { networkId: netid, current: {} } } });
      }
      return route.abort();
    }
    const path = resolve(client, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(client + sep)) return route.abort();
    await route.fulfill({ path }).catch(() => route.abort());
  });
  profile.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') confirmations++;
    await dialog.accept();
  });
  return profile;
}

beforeEach(async () => {
  confirmations = 0;
  page = await newAndroidProfile();
  await page.addInitScript(({ netid, version, local }) => {
    localStorage.setItem('version_' + netid, version);
    localStorage.setItem('local_' + netid, JSON.stringify(local));
    localStorage.setItem('accounts', JSON.stringify({ netids: { [netid]: { usernames: {
      local: { address: local.account.keys.address },
    } } } }));
  }, { netid, version, local });
  await page.goto(origin);
  await page.locator('#openWelcomeMenu').click();
});
afterEach(async () => { await page?.close(); });

async function openRestore(profile) {
  await profile.locator('#welcomeOpenRestore').click();
  await expect(profile.locator('#importModal')).toBeVisible();
}

async function selectFile(contents, mimeType = 'application/json') {
  await page.locator('#importFile').setInputFiles({
    name: 'liberdus-backup.json', mimeType, buffer: Buffer.from(contents),
  });
}

async function restore(...users) {
  const submit = page.locator('#restoreSubmitButton');
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  await submit.click();
  const expected = users.length + (users.length === 1 ? ' account restored' : ' accounts restored');
  await expect(page.locator('.toast.success', { hasText: expected })).toBeVisible();
  assert.equal(confirmations, 1);
  const saved = await page.evaluate(() => ({ ...localStorage }));
  const registry = JSON.parse(saved.accounts).netids[netid].usernames;
  assert.deepEqual(Object.keys(registry).sort(), [local, ...users].map(user => user.account.username).sort());
  for (const user of [local, ...users]) {
    assert.deepEqual(JSON.parse(saved[accountKey(user)]), user);
    assert.equal(registry[user.account.username].address, user.account.keys.address);
  }
}

test('Android permits a legacy backup labelled as plain text in the local picker', async () => {
  await openRestore(page);
  const filePassword = page.locator('#importPassword');
  await expect(filePassword).toBeHidden();
  const accept = await page.locator('#importFile').getAttribute('accept');
  assert.ok(!accept || accept.includes('*/*'), 'Android must allow files of any reported MIME type');
  await selectFile(JSON.stringify(alice), 'text/plain');
  await expect(filePassword).toBeHidden();
  await restore(alice);
});

test('a generic binary file restores all accounts in a multi-account backup', async () => {
  await openRestore(page);
  await selectFile(JSON.stringify({
    [accountKey(alice)]: JSON.stringify(alice),
    [accountKey(bob)]: JSON.stringify(bob),
    ['version_' + netid]: version,
  }), 'application/octet-stream');
  await restore(alice, bob);
});

test('invalid selected files show a backup error and leave existing accounts untouched', async () => {
  await openRestore(page);
  await page.locator('#overwriteAccountsCheckbox').check();
  const invalid = [
    '{}', '[]', 'null', '', '{broken json', 'ordinary notes here',
    JSON.stringify({ account: { username: 'local', netid } }),
    JSON.stringify({ ['version_' + netid]: version, _avatars: {} }),
    JSON.stringify({ [accountKey(alice)]: JSON.stringify(alice), [accountKey(local)]: JSON.stringify({ unrelated: true }) }),
  ];
  for (const body of invalid) {
    await selectFile(body);
    await expect(page.locator('#restoreFileStatus')).toHaveText(/Liberdus account backup/i);
    await expect(page.locator('#importPassword')).toBeHidden();
    await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
    await expect(page.locator('#backupAccountLockGroup')).toBeHidden();
    assert.equal(confirmations, 0);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), accountKey(local));
    assert.deepEqual(saved, local);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), accountKey(alice)), null);
  }
  // Replacing a rejected selection clears its validation state.
  await selectFile(JSON.stringify(alice));
  await restore(alice);
});

test('a password-protected file containing a locked account restores with both passwords', async () => {
  await openRestore(page);
  const encrypted = await page.evaluate(async ({ key, alice }) => {
    const { encryptData, passwordToKey } = await import('/crypto.js');
    const accountKey = await passwordToKey('account passwordliberdusData');
    const locked = {
      lock: await passwordToKey('account password'),
      [key]: encryptData(JSON.stringify(alice), accountKey, true),
    };
    return encryptData(JSON.stringify(locked), 'file password');
  }, { key: accountKey(alice), alice });
  await selectFile(encrypted, 'text/plain');
  const filePassword = page.locator('#importPassword');
  const lockGroup = page.locator('#backupAccountLockGroup');
  const submit = page.locator('#restoreSubmitButton');
  await expect(filePassword).toBeVisible();
  await expect(submit).toBeDisabled();
  await filePassword.fill('incorrect file password');
  // Wait past the former 500 ms debounce to catch a password attempt triggered by typing.
  await page.waitForTimeout(750);
  await expect(page.locator('#restoreFileStatus')).not.toContainText(/unable to decrypt/i);
  await expect(lockGroup).toBeHidden();
  await submit.click();
  await expect(page.locator('#restoreFileStatus')).toContainText(/unable to decrypt/i, { timeout: 15_000 });
  await filePassword.fill('file password');
  await page.waitForTimeout(750);
  await expect(lockGroup).toBeHidden();
  await submit.click();
  await expect(lockGroup).toBeVisible({ timeout: 15_000 });
  assert.equal(confirmations, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), accountKey(alice)), null);
  await page.locator('#backupAccountLock').fill('incorrect account password');
  await submit.click();
  await expect(page.locator('.toast.error', { hasText: /account password/i })).toBeVisible({ timeout: 15_000 });
  assert.equal(confirmations, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), accountKey(alice)), null);
  await page.locator('#backupAccountLock').fill('account password');
  await restore(alice);
});

test('replacing or clearing a local file clears its password and selection state', async () => {
  await openRestore(page);
  const encrypted = await encryptFile(alice);
  const filePassword = page.locator('#importPassword');
  const submit = page.locator('#restoreSubmitButton');
  await selectFile(encrypted);
  await filePassword.fill('file password');
  await selectFile(JSON.stringify(alice));
  await expect(filePassword).toBeHidden();
  await expect(filePassword).toHaveValue('');
  await expect(submit).toBeEnabled();
  await selectFile(encrypted);
  await expect(filePassword).toBeVisible();
  await expect(filePassword).toHaveValue('');
  await expect(submit).toBeDisabled();
  await filePassword.fill('file password');
  await page.locator('#importFile').setInputFiles([]);
  await expect(filePassword).toBeHidden();
  await expect(filePassword).toHaveValue('');
  await expect(submit).toBeDisabled();
  assert.equal(confirmations, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), accountKey(alice)), null);
});

test('an encrypted All Accounts backup with a newline in another network’s version restores on a fresh profile', async t => {
  const otherNetwork = '8'.repeat(64);
  await page.evaluate(netid => {
    localStorage.setItem('version_' + netid, '2026.05.06.10.40\n');
  }, otherNetwork);
  await page.locator('#welcomeOpenBackup').click();
  await expect(page.locator('#backupAllAccounts')).toBeChecked();
  const password = ' sample file password ';
  await page.locator('#backupPassword').fill(password);
  await page.locator('#backupPasswordConfirm').fill(password);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#backupForm button[type=submit]').click(),
  ]);

  const fresh = await newAndroidProfile();
  t.after(() => fresh.close());
  await fresh.goto(origin);
  await fresh.locator('#openWelcomeMenu').click();
  assert.equal(await fresh.evaluate(() => localStorage.getItem('accounts')), null);
  await openRestore(fresh);
  await expect(fresh.locator('#importPassword')).toBeHidden();
  await fresh.locator('#importFile').setInputFiles({
    name: download.suggestedFilename(), mimeType: 'application/json', buffer: await readFile(await download.path()),
  });
  await fresh.locator('#importPassword').fill(password);
  const submit = fresh.locator('#restoreSubmitButton');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(fresh.locator('.toast.success')).toHaveText(/1 account restored/);
  assert.equal(confirmations, 1);
  await fresh.locator('#importModal .modal-title').click();
  await fresh.locator('#signInButton').click();
  await expect(fresh.locator('#signInAccountList .sign-in-account-name')).toHaveText([local.account.username]);
  const restored = await fresh.evaluate(key => JSON.parse(localStorage.getItem(key)), accountKey(local));
  assert.deepEqual(restored, local);
});

const driveName = 'liberdus-backup.json';
const filePassword = 'file password';

async function encryptFile(records) {
  return page.evaluate(async ({ records, filePassword }) => {
    const { encryptData } = await import('/crypto.js');
    return encryptData(JSON.stringify(records), filePassword);
  }, { records, filePassword });
}

async function useDrive(contents) {
  const requests = { authorizations: 0, downloads: 0, mutations: [] };
  // Keep the real authorization/picker/download flow offline.
  await page.evaluate(() => {
    window.open = () => ({ closed: false, close() { this.closed = true; } });
  });
  await page.route('**/auth/poll?*', route => {
    requests.authorizations++;
    return route.fulfill({ json: { success: true, token: 'synthetic-drive-token' } });
  });
  await page.route('https://www.googleapis.com/drive/**', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== 'GET') {
      requests.mutations.push(req.method());
      return route.abort();
    }
    if (url.pathname === '/drive/v3/files/demo' && url.searchParams.get('alt') === 'media') {
      requests.downloads++;
      return route.fulfill({ body: contents });
    }
    if (url.pathname !== '/drive/v3/files') return route.abort();
    const files = url.searchParams.get('q')?.includes('application/vnd.google-apps.folder')
      ? [{ id: 'folder' }]
      : [{ id: 'demo', name: driveName, modifiedTime: '2026-01-01T12:00:00Z' }];
    return route.fulfill({ json: { files } });
  });
  await openRestore(page);
  await page.locator('#restoreSourceLocation').selectOption('google-drive', { force: true });
  return requests;
}

async function pickDriveFile() {
  await page.locator('#pickGoogleDriveFile').click();
  await page.locator('#googleDriveFileList').getByText(driveName, { exact: true }).click();
  await expect(page.locator('#selectedGoogleDriveFile')).toContainText(driveName);
}

function savedAccounts() {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => key === 'accounts' || /_[0-9a-f]{64}$/.test(key))));
}

test('a mixed Drive backup previews skipped records and writes only after confirmation', async () => {
  const existing = account('local', 'd');
  const staleKey = 'bob_' + '8'.repeat(64);
  const contents = await encryptFile({
    [accountKey(alice)]: JSON.stringify(alice),
    [accountKey(existing)]: JSON.stringify(existing),
    [staleKey]: JSON.stringify(bob),
    ['version_' + netid]: version + '\n',
  });
  const requests = await useDrive(contents);
  await pickDriveFile();
  const before = await savedAccounts();
  const restore = page.locator('#restoreSubmitButton');
  await page.locator('#importPassword').fill(filePassword);
  await restore.click();
  const review = page.getByRole('dialog', { name: 'Review Google Drive restore' });
  await expect(review).toBeVisible();
  await expect(review.getByRole('listitem').filter({ hasText: /bob/i })).toContainText(/network/i);
  await expect(review.getByRole('listitem').filter({ hasText: /local/i })).toContainText(/already|exist/i);
  await expect(review.getByRole('button', { name: 'Restore 1 account', exact: true })).toBeVisible();
  assert.deepEqual(await savedAccounts(), before);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toBeHidden();
  assert.deepEqual(await savedAccounts(), before);

  await restore.click();
  await review.getByRole('button', { name: 'Restore 1 account', exact: true }).click();
  await expect(page.locator('.toast.success')).toContainText(/1 account restored.*2 skipped/i);
  const saved = await savedAccounts();
  assert.deepEqual(JSON.parse(saved[accountKey(alice)]), alice);
  assert.equal(saved[accountKey(local)], before[accountKey(local)]);
  assert.equal(saved[staleKey], undefined);
  assert.deepEqual(Object.keys(JSON.parse(saved.accounts).netids[netid].usernames).sort(), ['alice', 'local']);
  assert.deepEqual(requests, { authorizations: 1, downloads: 1, mutations: [] });
});

test('Drive reports all-invalid records and makes no changes', async () => {
  const staleKey = 'bob_' + '8'.repeat(64);
  const requests = await useDrive(await encryptFile({
    [staleKey]: JSON.stringify(bob),
    ['Unknown Owner_' + netid]: 'invalid data',
  }));
  await pickDriveFile();
  const before = await savedAccounts();
  await page.locator('#importPassword').fill(filePassword);
  await page.locator('#restoreSubmitButton').click();
  const status = page.locator('#restoreFileStatus');
  await expect(status).toContainText(/no accounts can be restored/i, { timeout: 15_000 });
  await expect(status.getByRole('listitem').filter({ hasText: /bob/i })).toContainText(/network/i);
  await expect(status.getByRole('listitem').filter({ hasText: /record 2/i })).toContainText(/unreadable/i);
  await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
  assert.deepEqual(await savedAccounts(), before);
  assert.equal(confirmations, 0);
  assert.deepEqual(requests.mutations, []);
});

test('Drive unlocks records individually and replaces an existing account only with consent', async () => {
  const replacement = account('local', 'd');
  const contents = await page.evaluate(async ({ replacement, localKey, staleKey, filePassword }) => {
    const { encryptData, passwordToKey } = await import('/crypto.js');
    const accountKey = await passwordToKey('account passwordliberdusData');
    const records = {
      lock: await passwordToKey('account password'),
      [localKey]: encryptData(JSON.stringify(replacement), accountKey, true),
      [staleKey]: encryptData('unreadable record', 'different account password'),
    };
    return encryptData(JSON.stringify(records), filePassword);
  }, { replacement, localKey: accountKey(local), staleKey: accountKey(bob), filePassword });
  await useDrive(contents);
  await pickDriveFile();
  await page.locator('#overwriteAccountsCheckbox').check();
  const before = await savedAccounts();
  await page.locator('#importPassword').fill(filePassword);
  const password = page.locator('#backupAccountLock');
  await expect(password).toBeHidden();
  const submit = page.locator('#restoreSubmitButton');
  await submit.click();
  await expect(password).toBeVisible({ timeout: 15_000 });
  assert.equal(confirmations, 0);
  assert.deepEqual(await savedAccounts(), before);
  await password.fill('wrong');
  await submit.click();
  await expect(page.locator('.toast.error').filter({ hasText: /backup account password/i })).toBeVisible();
  const review = page.getByRole('dialog', { name: 'Review Google Drive restore' });
  await expect(review).toBeHidden();
  assert.deepEqual(await savedAccounts(), before);
  await password.fill('account password');
  await submit.click();
  await expect(review).toContainText(/bob/i);
  await expect(review).toContainText(/unlock|decrypt/i);
  assert.deepEqual(await savedAccounts(), before);
  await review.getByRole('button', { name: 'Restore 1 account', exact: true }).click();
  await expect(page.locator('.toast.success')).toContainText(/1 account restored.*1 skipped/i);
  const saved = await savedAccounts();
  assert.deepEqual(JSON.parse(saved[accountKey(local)]), replacement);
  assert.equal(saved[accountKey(bob)], undefined);
  assert.equal(JSON.parse(saved.accounts).netids[netid].usernames.local.address, replacement.account.keys.address);
});

test('Drive prompts after download and retries the file password only on Restore', async () => {
  const requests = await useDrive(await encryptFile({ [accountKey(alice)]: JSON.stringify(alice) }));
  const password = page.locator('#importPassword');
  const submit = page.locator('#restoreSubmitButton');
  const status = page.locator('#restoreFileStatus');
  const selected = page.locator('#selectedGoogleDriveFile');
  const before = await savedAccounts();
  await expect(password).toBeHidden();
  await expect(submit).toBeDisabled();
  await pickDriveFile();
  await expect(page.locator('#googleDrivePickerModal')).toHaveCSS('opacity', '0');
  await expect(page.locator('#importModal')).toHaveCSS('opacity', '1');
  await expect(password).toBeVisible();
  await expect(submit).toBeDisabled();

  await password.fill('incorrect password');
  // Let the former 500 ms input debounce elapse without submitting.
  await page.waitForTimeout(750);
  await expect(status).not.toContainText(/unable to decrypt/i);
  await expect(submit).toBeEnabled();
  assert.equal(confirmations, 0);
  await submit.click();
  await expect(status).toContainText(/unable to decrypt/i, { timeout: 15_000 });
  await expect(selected).toContainText(driveName);
  await expect(password).toBeVisible();
  assert.equal(confirmations, 0);
  assert.deepEqual(await savedAccounts(), before);

  await password.fill(filePassword);
  await restore(alice);
  assert.deepEqual(requests, { authorizations: 1, downloads: 1, mutations: [] });
});

test('a cancelled picker or failed Drive download keeps File Password hidden', async () => {
  await useDrive('unreadable file');
  const password = page.locator('#importPassword');
  const pick = page.locator('#pickGoogleDriveFile');
  const file = page.locator('#googleDriveFileList').getByText(driveName, { exact: true });
  // Finish a download after its picker was closed.
  let releaseDownload;
  const holdDownload = new Promise(resolve => { releaseDownload = resolve; });
  const media = '**/drive/v3/files/demo?alt=media';
  await page.route(media, async route => {
    await holdDownload;
    await route.fulfill({ body: 'old selection' });
  }, { times: 1 });
  await pick.click();
  const requested = page.waitForRequest(media);
  await file.click();
  await requested;
  await page.locator('#closeGoogleDrivePicker').click();
  const completed = page.waitForResponse(media);
  releaseDownload();
  await completed;
  await expect(password).toBeHidden();
  await expect(page.locator('#selectedGoogleDriveFile')).toBeHidden();

  await page.route(media, route => route.fulfill({ status: 503 }), { times: 1 });
  await pick.click();
  await file.click();
  const error = page.locator('.toast.error').filter({ hasText: /download/i });
  await expect(error).toBeVisible();
  await expect(password).toBeHidden();
  await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
  await expect(page.locator('#selectedGoogleDriveFile')).toBeHidden();

  // A successful download reveals the field even if the file contents are unrecognized.
  await error.getByRole('button', { name: 'Close' }).click();
  await file.click();
  await expect(page.locator('#selectedGoogleDriveFile')).toContainText(driveName);
  await expect(password).toBeVisible();
  await page.locator('#clearGoogleDriveFile').click();
  await expect(password).toBeHidden();
  await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
  assert.equal(confirmations, 0);
});
