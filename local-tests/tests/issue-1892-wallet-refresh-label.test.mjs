// Standalone offline coverage for the Wallet "Updated ... ago" label; no account, signing, or external requests.
// WEB_CLIENT_ROOT=/absolute/client/checkout node local-tests/tests/issue-1892-wallet-refresh-label.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the implementation checkout');
const root = process.env.WEB_CLIENT_ROOT;
globalThis.fetch = async () => { throw new Error('Unexpected external request'); };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { location: { href: 'https://client.example/', origin: 'https://client.example' } };
const lib = await import(pathToFileURL(join(root, 'lib.js')));
const { formatDisplayAmount } = await import(pathToFileURL(join(root, 'near-assets.js')));

const START = 1_800_000_000_000;

/** The <time> label, counting every write the page would have to apply. */
class LabelFixture {
  #text = 'Not updated yet';
  #title = '';
  constructor() {
    this.attributes = new Map();
    this.writes = 0;
  }
  get textContent() { return this.#text; }
  set textContent(value) { this.#text = String(value); this.writes++; }
  get title() { return this.#title; }
  set title(value) { this.#title = String(value); this.writes++; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.writes++; }
  removeAttribute(name) { this.attributes.delete(name); this.writes++; }
}

/**
 * The real WalletScreen class with synthetic balance groups. `groups` decides
 * how each of the three refreshes ends, as the live services would report it.
 */
class WalletFixture {
  constructor() {
    this.now = START;
    this.timers = [];
    this.groups = { native: true, multichain: true, evmStatus: 'connected', evmRefresh: async () => {} };
    const app = readFileSync(join(root, 'app.js'), 'utf8');
    const start = app.indexOf('\nclass WalletScreen {');
    const end = app.indexOf('\nconst walletScreen =', start);
    const helperStart = app.indexOf('\nfunction isLibAsset(');
    const helperEnd = app.indexOf('\nasync function updateAssetPricesIfNeeded(', helperStart);
    assert.ok(start >= 0 && end > start && helperEnd > helperStart, 'WalletScreen source was not found');
    this.account = { keys: { address: 'a'.repeat(40) } };
    this.data = this.walletData();
    const environment = {
      ...lib, formatDisplayAmount, myAccount: this.account, myData: this.data,
      wei: 10n ** 18n, isOnline: false, getStabilityFactor: () => null,
      getCorrectedTimestamp: () => this.now,
      multichain: { updateSummary: async () => this.groups.multichain },
      evmAssets: { refresh: () => this.groups.evmRefresh(), getStatus: () => this.groups.evmStatus },
      setInterval: (callback, delay) => { this.timers.push({ callback, delay }); return this.timers.length; },
      clearInterval: (id) => { this.timers[id - 1] = null; },
      console: { error() {}, warn() {} },
    };
    const harness = new Function(...Object.keys(environment), `
      ${app.slice(helperStart, helperEnd)}
      ${app.slice(start, end)}
      return { screen: new WalletScreen(), switchAccount(account, data) { myAccount = account; myData = data; } };
    `)(...Object.values(environment));
    this.screen = harness.screen;
    this.switchAccount = harness.switchAccount;
    this.label = new LabelFixture();
    this.screen.balanceUpdatedLabel = this.label;
    this.screen.assetsList = { innerHTML: '' };
    this.screen.firstTimeLoad = false;
    this.screen.updateWalletBalances = async () => this.groups.native;
  }

  walletData() {
    return {
      wallet: {
        overviewUpdatedAt: 0,
        assets: [{ id: 'liberdus', name: 'Liberdus', symbol: 'LIB', balance: 2n * 10n ** 18n }],
      },
    };
  }

  refresh() { return this.screen.updateWalletView(); }

  /** Advance the corrected clock and run the open screen's label timer as the browser would. */
  elapse(ms) {
    const timer = this.timers.find(Boolean);
    assert.ok(timer, 'The label timer is not running');
    for (let passed = timer.delay; passed <= ms; passed += timer.delay) {
      this.now += timer.delay;
      timer.callback();
    }
  }
}

test('a refresh that leaves some prices unavailable still reports when it ran', async () => {
  const h = new WalletFixture();
  h.screen.updateBalanceUpdatedAt();
  assert.equal(h.label.textContent, 'Not updated yet');

  h.groups.evmStatus = 'partial';
  await h.refresh();

  assert.equal(h.label.textContent, 'Updated just now');
  assert.equal(h.data.wallet.overviewUpdatedAt, START);
  assert.equal(h.label.attributes.get('datetime'), new Date(START).toISOString());
});

test('the label tracks the refresh attempt whichever balance group could not be updated', async (t) => {
  const failures = {
    'native balances not refreshed': { native: undefined },
    'native balance request failed': { native: false },
    'Intents balances unavailable': { multichain: false },
    'EVM service unavailable': { evmStatus: 'unavailable' },
    'EVM refresh rejected': { evmRefresh: async () => { throw new Error('probe offline'); } },
    'every group failed': { native: undefined, multichain: false, evmStatus: 'unavailable' },
  };
  for (const [name, outcome] of Object.entries(failures)) {
    await t.test(name, async () => {
      const h = new WalletFixture();
      Object.assign(h.groups, outcome);
      await h.refresh();
      assert.equal(h.label.textContent, 'Updated just now');
      assert.equal(h.data.wallet.overviewUpdatedAt, START);
    });
  }
});

test('the label counts seconds, then minutes, hours and days since the last refresh', async () => {
  const h = new WalletFixture();
  h.groups.evmStatus = 'partial';
  await h.refresh();
  h.screen.startBalanceUpdatedTimer();

  h.elapse(1_000);
  assert.equal(h.label.textContent, 'Updated 1s ago');
  h.elapse(9_000);
  assert.equal(h.label.textContent, 'Updated 10s ago');
  h.elapse(49_000);
  assert.equal(h.label.textContent, 'Updated 59s ago');
  h.elapse(1_000);
  assert.equal(h.label.textContent, 'Updated 1m ago');
  h.elapse(60_000);
  assert.equal(h.label.textContent, 'Updated 2m ago');

  const text = (ms) => h.screen.getBalanceUpdatedText(START, START + ms);
  assert.equal(text(59 * 60_000 + 59_000), 'Updated 59m ago');
  assert.equal(text(60 * 60_000), 'Updated 1h ago');
  assert.equal(text(23 * 3_600_000), 'Updated 23h ago');
  assert.equal(text(24 * 3_600_000), 'Updated 1d ago');
  assert.equal(text(-5_000), 'Updated just now');
  for (const missing of [0, undefined, null, NaN, -1]) {
    assert.equal(h.screen.getBalanceUpdatedText(missing, START), 'Not updated yet');
  }
});

test('a repeated refresh restarts the count and shows progress while it runs', async () => {
  const h = new WalletFixture();
  await h.refresh();
  h.screen.startBalanceUpdatedTimer();
  h.elapse(42_000);
  assert.equal(h.label.textContent, 'Updated 42s ago');

  let finishEvm;
  h.groups.evmStatus = 'partial';
  h.groups.evmRefresh = () => new Promise((resolve) => { finishEvm = resolve; });
  const refreshing = h.refresh();
  assert.equal(h.label.textContent, 'Updating…');
  assert.equal(h.label.attributes.has('datetime'), false);
  h.elapse(3_000);
  assert.equal(h.label.textContent, 'Updating…');
  finishEvm();
  await refreshing;

  assert.equal(h.label.textContent, 'Updated just now');
  assert.equal(h.data.wallet.overviewUpdatedAt, START + 45_000);
  h.elapse(10_000);
  assert.equal(h.label.textContent, 'Updated 10s ago');
});

test('a refresh that finishes after the account changed does not mark either wallet', async () => {
  const h = new WalletFixture();
  let finishEvm;
  h.groups.evmRefresh = () => new Promise((resolve) => { finishEvm = resolve; });
  const refreshing = h.refresh();

  const first = h.data;
  const second = h.walletData();
  h.switchAccount({ keys: { address: 'b'.repeat(40) } }, second);
  h.screen.reset();
  assert.equal(h.label.textContent, 'Not updated yet');
  finishEvm();
  await refreshing;

  assert.equal(first.wallet.overviewUpdatedAt, 0);
  assert.equal(second.wallet.overviewUpdatedAt, 0);
  assert.equal(h.label.textContent, 'Not updated yet');
});

test('ticks that leave the label unchanged do not touch the page', async () => {
  const h = new WalletFixture();
  await h.refresh();
  h.screen.startBalanceUpdatedTimer();
  h.elapse(60_000);
  assert.equal(h.label.textContent, 'Updated 1m ago');

  h.label.writes = 0;
  h.elapse(59_000);
  assert.equal(h.label.textContent, 'Updated 1m ago');
  assert.equal(h.label.writes, 0);
  h.elapse(1_000);
  assert.equal(h.label.textContent, 'Updated 2m ago');
  assert.ok(h.label.writes > 0);
});

test('switching to a wallet refreshed at another moment updates the timestamp behind the same text', async () => {
  const h = new WalletFixture();
  await h.refresh();
  h.screen.startBalanceUpdatedTimer();
  h.elapse(5_000);
  assert.equal(h.label.textContent, 'Updated 5s ago');
  assert.equal(h.label.attributes.get('datetime'), new Date(START).toISOString());

  const second = h.walletData();
  second.wallet.overviewUpdatedAt = START - 300;
  h.switchAccount({ keys: { address: 'b'.repeat(40) } }, second);
  h.screen.reset();

  assert.equal(h.label.textContent, 'Updated 5s ago');
  assert.equal(h.label.attributes.get('datetime'), new Date(START - 300).toISOString());
  assert.equal(h.label.title, `Balances updated ${new Date(START - 300).toLocaleString()}`);
});
