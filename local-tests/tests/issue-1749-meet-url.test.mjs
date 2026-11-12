// Run directly with Node 20.19+: WEB_CLIENT_ROOT=/absolute/client node --test this-file.mjs
// Companion main currently has no local-tests/run.mjs. All fixtures are offline.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const root = process.env.WEB_CLIENT_ROOT;
assert.ok(isAbsolute(root || ''), 'Set WEB_CLIENT_ROOT to the implementation checkout');
const source = await readFile(join(root, 'app.js'), 'utf8');
const { bin2hex, normalizeHttpsUrl, normalizeResourceUrl } = await import(pathToFileURL(join(root, 'lib.js')));

class CallFixture {
  static section(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Cannot locate ${start}`);
    return source.slice(first, last);
  }

  static method(signature) {
    return this.section(signature, '\n  }\n') + '\n  }';
  }

  constructor(meetUrl, callTime = 0) {
    this.messages = [];
    this.opened = [];
    this.toasts = [];
    this.randomLengths = [];
    this.context = {
      URL, normalizeHttpsUrl, normalizeResourceUrl, bin2hex,
      network: { meetUrl },
      myAccount: { username: 'A & B "caller"' },
      myData: { contacts: { recipient: { username: 'recipient' } } },
      getFeeBalanceStatus: async () => ({ success: true }),
      generateRandomBytes: length => { this.randomLengths.push(length); return new Uint8Array(length).fill(0xab); },
      window: { open: (...args) => this.opened.push(args) },
      showToast: (...args) => this.toasts.push(args),
      console: { error: error => assert.fail(String(error)) },
    };
    runInNewContext([
      CallFixture.section('const callUrlParams =', '\nfunction encodeAttachmentName('),
      'class ChatModal {',
      CallFixture.method('  async handleCallUser() {'),
      CallFixture.method('  getShareableCallUrl(messageEl) {'),
      CallFixture.method('  handleJoinCall(messageEl) {'),
      '}',
      'globalThis.chat = new ChatModal();',
      'globalThis.normalizeCallUrl = normalizeCallUrl;',
    ].join('\n'), this.context);
    this.chat = this.context.chat;
    Object.assign(this.chat, {
      address: 'recipient',
      canSendWithZeroToll: () => true,
      openCallTimeChooser: async () => callTime,
      sendCallMessage: async (...args) => { this.messages.push(args); return true; },
      formatLocalDateTime: time => `scheduled:${time}`,
      getMessageRecordFromElement: element => element.record,
      isMessageInDeleteForAllGuard: () => false,
      gateScheduledCall: () => false,
      closeContextMenu() {},
    });
  }

  storedCall(url) {
    return {
      record: { type: 'call', message: url },
      querySelector: selector => {
        assert.equal(selector, '.call-message a');
        return { href: url };
      },
    };
  }

  assertJoin(url) {
    assert.equal(this.opened.length, 1);
    const [opened, target, features] = this.opened[0];
    assert.equal(opened, url + CallFixture.parameters + '"A%20%26%20B%20%22caller%22"');
    assert.equal(target, '_blank');
    assert.equal(features, 'noopener,noreferrer');
  }

  static parameters = '#config.toolbarButtons=["camera","microphone","desktop","hangup"]&config.disableDeepLinking=true&config.prejoinPageEnabled=false&config.startWithAudioMuted=false&startWithVideoMuted=false&userInfo.displayName=';
}

test('all environment configurations preserve the default Meet service', async () => {
  for (const filename of ['network.js', 'network.js_dev', 'network.js_loc', 'network.js_test', 'network.js_web']) {
    const config = await readFile(join(root, filename), 'utf8');
    const network = runInNewContext(config + '\nnetwork');
    assert.equal(network.meetUrl, 'https://meet.liberdus.com', filename);
  }
});

for (const base of [
  'https://meet.liberdus.com',
  'https://calls.example.test:8443/deployment/meet',
  'https://calls.example.test:8443/deployment/meet/',
  'https://calls.example.test:8443/deployment/meet///',
  'http://localhost:8080/meet/',
]) {
  const roomUrl = base.replace(/\/+$/, '') + '/' + 'ab'.repeat(10);
  test(`immediate call uses ${base} with the existing room ID and parameters`, async () => {
    const fixture = new CallFixture(base);
    await fixture.chat.handleCallUser();
    assert.deepEqual(fixture.messages, [[roomUrl, 0]]);
    assert.deepEqual(fixture.randomLengths, [32]);
    fixture.assertJoin(roomUrl);
  });
}

test('scheduled calls use the configured deployment path without opening a window', async () => {
  for (const suffix of ['', '/']) {
    const fixture = new CallFixture('https://calls.example.test/meet' + suffix, 1_900_000_000_000);
    await fixture.chat.handleCallUser();
    assert.deepEqual(fixture.messages, [['https://calls.example.test/meet/' + 'ab'.repeat(10), 1_900_000_000_000]]);
    assert.deepEqual(fixture.opened, []);
    assert.deepEqual(fixture.toasts, [['Call scheduled for scheduled:1900000000000', 3000, 'success']]);
  }
});

test('joining and sharing preserve stored destinations after configuration changes', () => {
  for (const stored of ['https://meet.liberdus.com/old-room?key=old', 'https://calls.example.test/meet/existing-room']) {
    const fixture = new CallFixture('https://calls.example.test/meet');
    const element = fixture.storedCall(stored + '#old-parameters');
    fixture.chat.handleJoinCall(element);
    fixture.assertJoin(stored);
    assert.equal(fixture.chat.getShareableCallUrl(element), stored + CallFixture.parameters);
  }
});

test('only the configured service and the legacy HTTPS origin are allowed', () => {
  const fixture = new CallFixture('https://calls.example.test/meet');
  for (const invalid of [
    'javascript:alert(1)', 'https://untrusted.example/room',
    'https://user:pass@calls.example.test/room', 'http://calls.example.test/room',
    'http://meet.liberdus.com/room', 'https://calls.example.test.evil/room',
    '/relative-room', '#', '', null,
  ]) {
    assert.equal(fixture.context.normalizeCallUrl(invalid), '', invalid);
  }
});
