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

beforeEach(async () => {
  page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/113.0 Mobile Safari/537.36',
    serviceWorkers: 'block',
  });
  // The app, crypto and UI are real. Only checked-out assets and a synthetic network account can load.
  await page.route('**/*', async route => {
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
  await page.addInitScript(({ netid, version, local }) => {
    localStorage.setItem('version_' + netid, version);
    localStorage.setItem('local_' + netid, JSON.stringify(local));
    localStorage.setItem('accounts', JSON.stringify({ netids: { [netid]: { usernames: {
      local: { address: local.account.keys.address },
    } } } }));
  }, { netid, version, local });
  confirmations = 0;
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') confirmations++;
    await dialog.accept();
  });
  await page.goto(origin);
  await page.locator('#openWelcomeMenu').click();
  await page.locator('#welcomeOpenRestore').click();
  await expect(page.locator('#importModal')).toBeVisible();
});
afterEach(async () => { await page?.close(); });

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
  const accept = await page.locator('#importFile').getAttribute('accept');
  assert.ok(!accept || accept.includes('*/*'), 'Android must allow files of any reported MIME type');
  await selectFile(JSON.stringify(alice), 'text/plain');
  await restore(alice);
});

test('a generic binary file restores all accounts in a multi-account backup', async () => {
  await selectFile(JSON.stringify({
    [accountKey(alice)]: JSON.stringify(alice),
    [accountKey(bob)]: JSON.stringify(bob),
    ['version_' + netid]: version,
  }), 'application/octet-stream');
  await restore(alice, bob);
});

test('invalid selected files show a backup error and leave existing accounts untouched', async () => {
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
  await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
  await page.locator('#importPassword').fill('incorrect file password');
  await expect(page.locator('#restoreFileStatus')).toContainText(/unable to decrypt/i, { timeout: 15_000 });
  await expect(page.locator('#restoreSubmitButton')).toBeDisabled();
  await page.locator('#importPassword').fill('file password');
  await expect(page.locator('#backupAccountLockGroup')).toBeVisible({ timeout: 15_000 });
  assert.equal(confirmations, 0);
  await page.locator('#backupAccountLock').fill('incorrect account password');
  await page.locator('#restoreSubmitButton').click();
  await expect(page.locator('.toast.error', { hasText: /account password/i })).toBeVisible({ timeout: 15_000 });
  assert.equal(confirmations, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), accountKey(alice)), null);
  // Correct the password immediately and click as soon as Load Account is enabled.
  await page.locator('#backupAccountLock').fill('account password');
  await restore(alice);
});
