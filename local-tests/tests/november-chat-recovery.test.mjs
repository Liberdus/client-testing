import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

assert.ok(process.env.WEB_CLIENT_ROOT, 'Set WEB_CLIENT_ROOT to the client checkout to test.');
const app = await readFile(resolve(process.env.WEB_CLIENT_ROOT, 'app.js'), 'utf8');
const source = ['class ChatsScreen', 'class SignInModal', 'function loadState', 'function saveState']
  .map(name => {
    const declaration = app.match(new RegExp('^' + name + '\\b[^]*?^}', 'm'));
    assert.ok(declaration, 'Missing client declaration: ' + name);
    return declaration[0];
  }).join('\n');
const cutoff = Date.parse('2026-11-18T17:31:19Z');

function snapshot(chatTimestamp) {
  return { account: { username: 'alice', netid: 'fixture', chatTimestamp, migrations: { earlier: true } } };
}

// Start a fresh page with only the saved account data. Observe the persisted
// account as the real sign-in handler schedules its first poll.
async function signIn(record, { pathname = '/test/', name = 'Testnet' } = {}) {
  const key = 'alice_fixture';
  const store = new Map([
    ['accounts', JSON.stringify({ netids: { fixture: { usernames: { alice: {} } } } })],
    [key, JSON.stringify(record)],
  ]);
  const reachedPoll = new Error('Reached first poll');
  let writes = 0;
  const context = vm.createContext({
    assert: assert.ok, myData: null, myAccount: null, parse: JSON.parse, stringify: JSON.stringify,
    network: { name, netid: 'fixture' }, window: { location: { pathname }, addEventListener() {} },
    history: { pushState() {} }, handleBrowserBackButton() {}, enterFullscreen() {},
    localStorage: {
      getItem: k => store.get(k),
      setItem(k, value) {
        assert.equal(k, key);
        writes++;
        store.set(k, value);
      },
    },
    logsModal: { log() {} }, chatModal: { resetPendingMessageConfirmations() {} },
    migrateFriendStatusToConnection: () => false, migrateAttachmentKeysToEncKey: () => false,
    migrateDeletedMessageStates: () => false, reactNativeApp: { isReactNativeWebView: false },
    useLongPolling: true, longPoll() {},
    setTimeout(handler) { assert.equal(handler, context.longPoll); throw reachedPoll; },
  });
  await assert.rejects(vm.runInContext(source + `
    const chatsScreen = new ChatsScreen();
    SignInModal.prototype.handleSignIn.call({ selectedUsername: 'alice', recordRecentSignInUsername() {} });
  `, context), err => err === reachedPoll);
  return { saved: JSON.parse(store.get(key)), writes };
}

for (const timestamp of [cutoff - 100, cutoff, cutoff + 100, 0, undefined]) {
  test('sign-in migrates cursor ' + String(timestamp) + ' before the first poll', async () => {
    const { saved, writes } = await signIn(snapshot(timestamp));
    assert.equal(writes, 1, 'commit marker and cursor in one account record');
    assert.equal(saved.account.chatTimestamp, timestamp > cutoff ? cutoff - 1 : timestamp);
    assert.equal(saved.account.migrations.earlier, true);

    // A later poll advanced this account. Restoring its post-migration snapshot
    // on a fresh page must preserve that progress, even for older initial cursors.
    saved.account.chatTimestamp = cutoff + 12345;
    const restored = await signIn(structuredClone(saved));
    assert.equal(restored.writes, 0);
    assert.deepEqual(restored.saved, saved);
  });
}

test('Testnet recovery is scoped to the test deployment', async () => {
  for (const [pathname, name] of [['/dev/', 'Testnet'], ['/testing/', 'Testnet'], ['/test/', 'Mainnet']]) {
    const original = snapshot(cutoff + 100);
    const { saved, writes } = await signIn(original, { pathname, name });
    assert.equal(writes, 0);
    assert.deepEqual(saved, original);
  }
});
