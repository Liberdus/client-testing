import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { generateIdenticon, normalizeAddress } from '../lib.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const classStart = appSource.indexOf('class SignInModal');
const classEnd = appSource.indexOf('// create a singleton instance of the SignInModal');
const classSource = appSource.slice(classStart, classEnd);

const publicAddress = 'a'.repeat(40);
const privateAddress = 'b'.repeat(40);
const context = {
  contactAvatarCache: {
    getBlobUrl: async (avatarId) => `blob:${avatarId}`,
  },
  console: { warn: () => {} },
  document: {
    createElement: () => {
      const listeners = new Map();
      const image = {
        addEventListener: (type, listener) => listeners.set(type, listener),
      };
      Object.defineProperty(image, 'src', {
        get: () => image.currentSrc,
        set: (url) => {
          image.currentSrc = url;
          queueMicrotask(() => listeners.get('load')?.());
        },
      });
      return image;
    },
  },
  escapeHtml: (value) => String(value),
  generateIdenticon,
  network: { netid: 'testnet' },
  normalizeAddress,
  reactNativeApp: {
    isReactNativeWebView: true,
    getNotificationAddresses: () => [publicAddress],
  },
};
const SignInModal = vm.runInNewContext(`${classSource}; SignInModal`, context);

function createModal() {
  const modal = new SignInModal();
  const usernames = ['public-user', 'missing-address', 'private-user'];
  const netidAccounts = {
    usernames: {
      'public-user': { address: publicAddress },
      'missing-address': { address: 'invalid' },
      'private-user': { address: privateAddress },
    },
  };
  modal.accountList = { innerHTML: '', querySelectorAll: () => [] };
  modal.getSignInUsernames = () => ({ usernames, netidAccounts });
  modal.getSignInUsernameGroups = () => ({
    usernameGroups: {
      public: ['public-user', 'missing-address'],
      private: ['private-user'],
    },
    isPrivateMap: {
      'public-user': false,
      'missing-address': false,
      'private-user': true,
    },
    avatarIdMap: {
      'public-user': 'public-avatar-id',
      'missing-address': 'missing-avatar-id',
      'private-user': null,
    },
  });
  modal.getSignInUsernameOrder = (usernameGroups) => usernameGroups;
  modal.updateRecentSignInResetButtonVisibility = () => {};
  return modal;
}

test('account avatars use normalized saved addresses and omit invalid ones', () => {
  const modal = new SignInModal();
  assert.match(modal.getSignInAccountFallbackAvatar(`0x${publicAddress}`), /<svg width="40" height="40"/);
  assert.equal(modal.getSignInAccountFallbackAvatar('invalid'), '');
  assert.equal(modal.getSignInAccountFallbackAvatar(undefined), '');
});

test('saved account state exposes only usable avatar ids', () => {
  context.loadState = (key) => ({
    account: key.startsWith('public-user')
      ? { avatarId: 'public-avatar-id' }
      : { avatarId: '', private: true },
  });
  const modal = new SignInModal();
  const result = modal.getSignInUsernameGroups(['public-user', 'private-user'], 'testnet');

  assert.equal(result.avatarIdMap['public-user'], 'public-avatar-id');
  assert.equal(result.avatarIdMap['private-user'], null);
  assert.deepEqual([...result.usernameGroups.public], ['public-user']);
  assert.deepEqual([...result.usernameGroups.private], ['private-user']);
});

test('cached uploaded avatars replace the generated fallback', async () => {
  const modal = createModal();
  let replacement;
  const item = {
    isConnected: true,
    querySelector: () => ({ replaceChildren: (image) => { replacement = image; } }),
  };

  await modal.loadUploadedSignInAvatar(item, 'uploaded-avatar-id');

  assert.equal(replacement.src, 'blob:uploaded-avatar-id');
  assert.equal(replacement.className, 'contact-avatar-img');
  assert.equal(replacement.width, 40);
  assert.equal(replacement.height, 40);
  assert.equal(replacement.alt, '');
});

test('a delayed uploaded avatar cannot update a detached row', async () => {
  const originalGetBlobUrl = context.contactAvatarCache.getBlobUrl;
  let releaseLookup;
  context.contactAvatarCache.getBlobUrl = () => new Promise((resolve) => { releaseLookup = resolve; });
  const modal = createModal();
  let replaced = false;
  const item = {
    isConnected: true,
    querySelector: () => ({ replaceChildren: () => { replaced = true; } }),
  };

  const loading = modal.loadUploadedSignInAvatar(item, 'uploaded-avatar-id');
  item.isConnected = false;
  releaseLookup('blob:uploaded-avatar-id');
  await loading;
  context.contactAvatarCache.getBlobUrl = originalGetBlobUrl;

  assert.equal(replaced, false);
});

test('sign-in rows render avatars, plain private names, badges, and keyboard semantics', () => {
  const modal = createModal();
  modal.renderAccountList();
  const html = modal.accountList.innerHTML;

  assert.match(html, /data-username="public-user" role="button" tabindex="0"/);
  assert.match(html, /sign-in-account-avatar" aria-hidden="true">\s*<svg width="40" height="40"/);
  assert.match(html, /sign-in-account-badge" aria-label="Has notifications"/);
  assert.match(html, /Private accounts/);
  assert.match(html, /sign-in-account-name">private-user</);
  assert.doesNotMatch(html, /sign-in-account-name">- private-user</);
  assert.match(html, /data-username="missing-address"[^]*sign-in-account-avatar" aria-hidden="true"><\/span>/);
});

test('keyboard and responsive avatar styles remain explicit', () => {
  assert.match(appSource, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(appSource, /event\.preventDefault\(\);\s*selectAccountItem\(item\);/);
  assert.match(styles, /\.sign-in-account-avatar\s*{[^}]*flex:\s*0 0 40px[^}]*width:\s*40px[^}]*height:\s*40px/s);
  assert.match(styles, /\.sign-in-account-avatar:empty\s*{[^}]*display:\s*none/s);
  assert.match(styles, /\.sign-in-account-name\s*{[^}]*flex:\s*1[^}]*text-overflow:\s*ellipsis/s);
  assert.match(styles, /\.sign-in-account-item:focus-visible \.sign-in-account-card\s*{[^}]*outline:/s);
  assert.match(appSource, /avatarId && hasFallbackAvatar[^]*loadUploadedSignInAvatar\(item, avatarId\)/);
});
