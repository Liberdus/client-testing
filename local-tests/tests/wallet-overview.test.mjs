import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { big2str, escapeHtml } from '../lib.js';

const [appSource, markup, nearSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../near-assets.js', import.meta.url), 'utf8'),
]);
const wei = 10n ** 18n;

function sourceBetween(start, end, source = appSource) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Cannot locate ${start}`);
  return source.slice(first, last);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const settleMicrotasks = () => new Promise(setImmediate);

class ElementFixture {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    };
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelector() { return new ElementFixture(); }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) {
    this.attributes.set(name.toLowerCase(), String(value));
    this[name === 'datetime' ? 'dateTime' : name] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name.toLowerCase()) ?? null; }
  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
    delete this[name === 'datetime' ? 'dateTime' : name];
  }
  blur() {}
}

class WalletFixture {
  constructor() {
    this.now = 1_800_000_000_000;
    this.account = { username: 'alice', keys: { address: 'a'.repeat(40) } };
    this.lib = {
      id: 'liberdus', name: 'Liberdus', symbol: 'LIB', price: 0.008,
      balance: 30n * wei, networth: 0.24,
      addresses: [
        { address: 'a'.repeat(40), balance: 10n * wei },
        { address: 'b'.repeat(40), balance: 20n * wei },
      ],
    };
    this.data = {
      wallet: {
        assets: [this.lib], timestamp: 0, balanceUpdatedAt: this.now - 120_000,
        overviewUpdatedAt: this.now - 120_000, networth: 0.24,
      },
    };
    this.elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)]
      .map(([, id]) => [id, new ElementFixture()]));
    this.queries = [];
    this.toasts = [];
    this.intervals = new Map();
    this.clearedIntervals = [];
    this.nextTimer = 0;
    this.externalRefreshes = [];
    this.context = {
      document: this, myAccount: this.account, myData: this.data,
      network: { name: 'Testnet' }, parameters: { current: { stabilityFactorStr: '0.008' } },
      wei, big2str, escapeHtml, isOnline: true,
      getCorrectedTimestamp: () => this.now,
      longAddress: address => address,
      updateAssetPricesIfNeeded: async () => {},
      queryNetwork: async path => {
        this.queries.push(path);
        return { balance: 50n * wei };
      },
      showToast: (...args) => { this.toasts.push(args); return `toast-${this.toasts.length}`; },
      hideToast() {},
      multichain: { reset() {}, updateSummary: async () => { this.externalRefreshes.push('multichain'); return true; } },
      evmAssets: {
        reset() {}, refresh: async () => { this.externalRefreshes.push('evm'); }, getStatus: () => 'connected',
      },
      setInterval: (callback, delay) => {
        const id = ++this.nextTimer;
        this.intervals.set(id, { callback, delay });
        return id;
      },
      clearInterval: id => { this.clearedIntervals.push(id); this.intervals.delete(id); },
      setTimeout: callback => { callback(); return ++this.nextTimer; }, clearTimeout() {},
      checkFirstTimeTip: () => true, setFirstTimeTipShown() {},
      withButtonCooldown: (_button, _delay, _finish, listener) => listener,
      BUTTON_COOLDOWN_MS: 1000, FAUCET_COOLDOWN_MS: 1000,
      sendAssetFormModal: { open() {}, reset() {} }, receiveModal: { open() {}, close() {} }, historyModal: { open() {} },
      bridgeModal: { open() {} }, window: { open() {} },
      chatModal: { resetPendingMessageConfirmations() {} },
      stopEvmPaymentChecks() {}, daoRepo: { reset() {} },
      daoModal: { resetNotificationState() {} }, resetDaoNotificationSummary() {},
      console: { error() {}, warn() {} },
    };
    runInNewContext([
      sourceBetween('function formatDisplayAmount(', 'function formatRawAmount(', nearSource),
      sourceBetween('function getStabilityFactor(', 'function getNetworkMinTollLibWei('),
      sourceBetween('function isLibAsset(', 'async function updateAssetPricesIfNeeded('),
      sourceBetween('class WalletScreen', 'const walletScreen'),
      'globalThis.walletScreen = new WalletScreen();',
      sourceBetween('function clearMyData()', 'function migrateFriendStatusToConnection('),
      'globalThis.clearMyData = clearMyData;',
    ].join('\n'), this.context);
    this.wallet = this.context.walletScreen;
    this.wallet.load();
  }
  getElementById(id) {
    assert.ok(this.elements.has(id), `Client markup is missing ${id}`);
    return this.elements.get(id);
  }
  createElement() { return new ElementFixture(); }
  snapshot(wallet = this.data.wallet) {
    return {
      balanceUpdatedAt: wallet.balanceUpdatedAt,
      overviewUpdatedAt: wallet.overviewUpdatedAt,
      networth: wallet.networth,
      assets: wallet.assets.map(asset => ({
        balance: asset.balance, networth: asset.networth,
        addresses: asset.addresses.map(address => address.balance),
      })),
    };
  }
  async pauseQuery() {
    let resolve;
    let started;
    const pending = new Promise(accept => { resolve = accept; });
    const reached = new Promise(accept => { started = accept; });
    this.context.queryNetwork = async path => {
      this.queries.push(path);
      started();
      return pending;
    };
    return { resolve, reached };
  }
}

test('a complete native balance refresh updates all balances and its dedicated freshness time', async () => {
  const fixture = new WalletFixture();
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.queries, [
    `/account/${'a'.repeat(40)}/balance`, `/account/${'b'.repeat(40)}/balance`,
  ]);
  assert.equal(fixture.lib.addresses[0].balance, 50n * wei);
  assert.equal(fixture.lib.addresses[1].balance, 50n * wei);
  assert.equal(fixture.lib.balance, 100n * wei);
  assert.equal(fixture.lib.networth, 0.8);
  assert.equal(fixture.data.wallet.networth, 0.8);
  assert.equal(fixture.data.wallet.balanceUpdatedAt, fixture.now);
});

test('a valid zero balance is fresh and clears an old cached balance', async () => {
  const fixture = new WalletFixture();
  fixture.context.queryNetwork = async () => ({ balance: 0n });
  await fixture.wallet.updateWalletBalances();
  assert.equal(fixture.lib.balance, 0n);
  assert.deepEqual(fixture.lib.addresses.map(address => address.balance), [0n, 0n]);
  assert.equal(fixture.data.wallet.networth, 0);
  assert.equal(fixture.data.wallet.balanceUpdatedAt, fixture.now);
});

for (const [label, response] of [
  ['null response', null],
  ['missing balance', {}],
  ['null balance', { balance: null }],
  ['undefined balance', { balance: undefined }],
  ['invalid balance', { balance: 'bad' }],
  ['noncanonical numeric balance', { balance: 0 }],
  ['fractional balance', { balance: 1.5 }],
  ['nonfinite balance', { balance: NaN }],
  ['negative balance', { balance: -1n }],
]) {
  test(`${label} preserves cached balances and the last successful timestamp`, async () => {
    const fixture = new WalletFixture();
    const before = fixture.snapshot();
    fixture.context.queryNetwork = async () => response;
    await fixture.wallet.updateWalletBalances();
    assert.deepEqual(fixture.snapshot(), before);
  });
}

test('a thrown balance query preserves cached balances and the last successful timestamp', async () => {
  const fixture = new WalletFixture();
  const before = fixture.snapshot();
  fixture.context.queryNetwork = async () => { throw new Error('Synthetic unavailable account'); };
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
});

test('a partial address refresh commits no balances and does not claim freshness', async () => {
  const fixture = new WalletFixture();
  const before = fixture.snapshot();
  fixture.context.queryNetwork = async path => path.includes('a'.repeat(40)) ? { balance: 0n } : null;
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
});

test('a failure in a later asset preserves cached values for the whole wallet', async () => {
  const fixture = new WalletFixture();
  fixture.data.wallet.assets.push({
    id: 'synthetic', symbol: 'SYN', price: 1,
    balance: 5n * wei, networth: 5,
    addresses: [{ address: 'c'.repeat(40), balance: 5n * wei }],
  });
  fixture.data.wallet.networth = 5.24;
  const before = fixture.snapshot();
  fixture.context.queryNetwork = async path => path.includes('c'.repeat(40)) ? null : { balance: 50n * wei };
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
});

test('offline and throttled attempts leave successful freshness unchanged', async () => {
  const fixture = new WalletFixture();
  const before = fixture.snapshot();
  fixture.context.isOnline = false;
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(fixture.queries, []);
  fixture.context.isOnline = true;
  fixture.data.wallet.timestamp = fixture.now - 2000;
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(fixture.queries, []);
});

test('a price refresh cannot make an unsuccessful native refresh appear fresh', async () => {
  const fixture = new WalletFixture();
  const originalUpdatedAt = fixture.data.wallet.balanceUpdatedAt;
  fixture.context.updateAssetPricesIfNeeded = async () => { fixture.data.wallet.priceTimestamp = fixture.now; };
  fixture.context.queryNetwork = async () => null;
  await fixture.wallet.updateWalletBalances();
  assert.equal(fixture.data.wallet.priceTimestamp, fixture.now);
  assert.equal(fixture.data.wallet.balanceUpdatedAt, originalUpdatedAt);
});

test('a failed native refresh permits a successful retry without waiting for the throttle', async () => {
  const fixture = new WalletFixture();
  fixture.context.queryNetwork = async () => null;
  await fixture.wallet.updateWalletBalances();
  fixture.context.queryNetwork = async () => ({ balance: 0n });
  await fixture.wallet.updateWalletBalances();
  assert.equal(fixture.lib.balance, 0n);
  assert.equal(fixture.data.wallet.balanceUpdatedAt, fixture.now);
});

test('switching accounts during a balance query cannot mutate either account wallet', async () => {
  const fixture = new WalletFixture();
  const before = fixture.snapshot();
  const deferred = await fixture.pauseQuery();
  const refreshing = fixture.wallet.updateWalletBalances();
  await deferred.reached;
  const replacement = new WalletFixture();
  replacement.lib.balance = 7n * wei;
  const replacementBefore = replacement.snapshot();
  fixture.context.myAccount = { username: 'bob', keys: { address: 'd'.repeat(40) } };
  fixture.context.myData = replacement.data;
  deferred.resolve({ balance: 90n * wei });
  await refreshing;
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(fixture.snapshot(replacement.data.wallet), replacementBefore);
});

test('switching the wallet while refreshing the view cannot render the old account balances', async () => {
  const fixture = new WalletFixture();
  const deferred = await fixture.pauseQuery();
  const refreshing = fixture.wallet.updateWalletView();
  await deferred.reached;
  fixture.context.myAccount = { username: 'bob', keys: { address: 'd'.repeat(40) } };
  fixture.context.myData = { wallet: { assets: [], networth: 0, balanceUpdatedAt: null } };
  fixture.wallet.assetsList.innerHTML = 'Current account view';
  deferred.resolve({ balance: 90n * wei });
  await refreshing;
  assert.equal(fixture.wallet.assetsList.innerHTML, 'Current account view');
  assert.deepEqual(fixture.externalRefreshes.sort(), ['evm', 'multichain']);
});

test('no configured addresses cannot manufacture a successful balance timestamp', async () => {
  const fixture = new WalletFixture();
  fixture.lib.addresses = [];
  const before = fixture.snapshot();
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
});

test('switching wallet data during the price refresh cannot query or alter the old account', async () => {
  const fixture = new WalletFixture();
  const before = fixture.snapshot();
  fixture.context.updateAssetPricesIfNeeded = async () => {
    fixture.context.myData = { wallet: { assets: [], balanceUpdatedAt: null } };
  };
  await fixture.wallet.updateWalletBalances();
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(fixture.queries, []);
});

test('successful freshness uses the time the balance refresh completes', async () => {
  const fixture = new WalletFixture();
  const deferred = await fixture.pauseQuery();
  const refreshing = fixture.wallet.updateWalletBalances();
  await deferred.reached;
  fixture.now += 30_000;
  deferred.resolve({ balance: 50n * wei });
  await refreshing;
  assert.equal(fixture.data.wallet.balanceUpdatedAt, fixture.now);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated 2m ago');
});

test('an older overlapping refresh cannot replace the latest completed balance batch', async () => {
  const fixture = new WalletFixture();
  fixture.lib.addresses = [fixture.lib.addresses[0]];
  const olderQuery = await fixture.pauseQuery();
  const olderRefresh = fixture.wallet.updateWalletBalances();
  await olderQuery.reached;
  const latestQuery = await fixture.pauseQuery();
  const latestRefresh = fixture.wallet.updateWalletBalances();
  await latestQuery.reached;
  fixture.now += 30_000;
  latestQuery.resolve({ balance: 90n * wei });
  await latestRefresh;
  assert.equal(fixture.lib.balance, 90n * wei);
  const latestSnapshot = fixture.snapshot();
  fixture.now += 30_000;
  olderQuery.resolve({ balance: 10n * wei });
  await olderRefresh;
  assert.deepEqual(fixture.snapshot(), latestSnapshot);
});

for (const [age, expected] of [
  [0, 'Updated just now'],
  [59_999, 'Updated just now'],
  [60_000, 'Updated 1m ago'],
  [120_000, 'Updated 2m ago'],
  [3_599_999, 'Updated 59m ago'],
  [3_600_000, 'Updated 1h ago'],
  [86_400_000, 'Updated 1d ago'],
  [259_200_000, 'Updated 3d ago'],
]) {
  test(`balance freshness formats an age of ${age}ms as ${expected}`, () => {
    const fixture = new WalletFixture();
    assert.equal(fixture.wallet.getBalanceUpdatedText(fixture.now - age, fixture.now), expected);
  });
}

for (const timestamp of [undefined, null, 0, -1, NaN, Infinity, 8_640_000_000_000_001, 'invalid']) {
  test(`balance freshness reports unknown for ${String(timestamp)}`, () => {
    const fixture = new WalletFixture();
    assert.equal(fixture.wallet.getBalanceUpdatedText(timestamp, fixture.now), 'Not updated yet');
  });
}

test('future clock skew does not display a negative balance age', () => {
  const fixture = new WalletFixture();
  assert.equal(fixture.wallet.getBalanceUpdatedText(fixture.now + 60_000, fixture.now), 'Updated just now');
});

test('the visible freshness label uses only the complete overview timestamp', () => {
  const fixture = new WalletFixture();
  fixture.data.wallet.timestamp = fixture.now;
  fixture.data.wallet.priceTimestamp = fixture.now;
  fixture.data.wallet.balanceUpdatedAt = fixture.now;
  fixture.wallet.updateBalanceUpdatedAt();
  const label = fixture.elements.get('walletBalanceUpdated');
  assert.equal(label.textContent, 'Updated 2m ago');
  assert.equal(label.dateTime, new Date(fixture.data.wallet.overviewUpdatedAt).toISOString());
  assert.ok(label.title, 'The exact update time is available');
  const oldTitle = label.title;
  fixture.data.wallet.overviewUpdatedAt = null;
  fixture.wallet.updateBalanceUpdatedAt();
  assert.equal(label.textContent, 'Not updated yet');
  assert.equal(label.dateTime, undefined);
  assert.notEqual(label.title, oldTitle, 'Unknown freshness does not retain the previous exact date');
});

test('opening the wallet starts one age timer, updates it locally, and closing stops it', () => {
  const fixture = new WalletFixture();
  const label = fixture.elements.get('walletBalanceUpdated');
  fixture.wallet.open();
  fixture.wallet.open();
  assert.equal(fixture.intervals.size, 1);
  assert.equal(label.textContent, 'Updated 2m ago');
  const [{ callback, delay }] = fixture.intervals.values();
  assert.equal(delay, 30_000);
  fixture.now += 60_000;
  callback();
  assert.equal(label.textContent, 'Updated 3m ago');
  assert.deepEqual(fixture.queries, [], 'The age timer does not refresh network balances');
  fixture.wallet.close();
  assert.equal(fixture.intervals.size, 0);
  assert.equal(fixture.clearedIntervals.length, 1);
  fixture.wallet.open();
  assert.equal(fixture.intervals.size, 1);
  fixture.wallet.close();
});

test('clearing account data stops the wallet timer and clears the old freshness label', () => {
  const fixture = new WalletFixture();
  fixture.wallet.firstTimeLoad = false;
  fixture.wallet.open();
  assert.equal(fixture.intervals.size, 1);
  fixture.context.clearMyData();
  assert.equal(fixture.intervals.size, 0);
  assert.equal(fixture.context.myAccount, null);
  assert.equal(fixture.context.myData, null);
  assert.equal(fixture.wallet.firstTimeLoad, true);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Not updated yet');
});

test('overview freshness waits for all three sources while native balances render immediately', async () => {
  const fixture = new WalletFixture();
  const label = fixture.elements.get('walletBalanceUpdated');
  fixture.wallet.open();
  const native = await fixture.pauseQuery();
  const multichain = deferred();
  const evm = deferred();
  fixture.context.multichain.updateSummary = () => multichain.promise;
  fixture.context.evmAssets.refresh = () => evm.promise;
  const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
  const refreshing = fixture.wallet.updateWalletView();
  assert.equal(label.textContent, 'Updating…');
  assert.equal(label.dateTime, undefined);
  assert.ok(!label.title, 'The pending label does not retain a stale exact date');
  await native.reached;
  native.resolve({ balance: 50n * wei });
  await settleMicrotasks();
  assert.equal(fixture.lib.balance, 100n * wei);
  assert.match(fixture.wallet.assetsList.innerHTML, /100 LIB/);
  assert.equal(fixture.data.wallet.overviewUpdatedAt, previousUpdatedAt);
  assert.equal(label.textContent, 'Updating…');
  for (const { callback } of fixture.intervals.values()) callback();
  assert.equal(label.textContent, 'Updating…', 'The age timer cannot replace the pending state');
  multichain.resolve(true);
  await settleMicrotasks();
  assert.equal(label.textContent, 'Updating…');
  fixture.now += 40_000;
  evm.resolve([]);
  await refreshing;
  assert.equal(fixture.data.wallet.overviewUpdatedAt, fixture.now);
  assert.equal(label.textContent, 'Updated just now');
  assert.equal(label.dateTime, new Date(fixture.now).toISOString());
  fixture.wallet.close();
});

for (const failure of ['native', 'multichain false', 'multichain rejection', 'evm partial', 'evm unavailable', 'evm rejection']) {
  test(`${failure} does not advance complete overview freshness`, async () => {
    const fixture = new WalletFixture();
    if (failure === 'native') fixture.context.queryNetwork = async () => null;
    if (failure === 'multichain false') fixture.context.multichain.updateSummary = async () => false;
    if (failure === 'multichain rejection') {
      fixture.context.multichain.updateSummary = async () => { throw new Error('Synthetic multichain failure'); };
    }
    if (failure === 'evm partial') fixture.context.evmAssets.getStatus = () => 'partial';
    if (failure === 'evm unavailable') fixture.context.evmAssets.getStatus = () => 'unavailable';
    if (failure === 'evm rejection') {
      fixture.context.evmAssets.refresh = async () => { throw new Error('Synthetic EVM failure'); };
    }
    const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
    await fixture.wallet.updateWalletView();
    assert.equal(fixture.data.wallet.overviewUpdatedAt, previousUpdatedAt);
    assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated 2m ago');
    assert.equal(fixture.wallet.isUpdating, false);
  });
}

test('unknown overview freshness remains unknown after a native-only balance refresh', async () => {
  const fixture = new WalletFixture();
  delete fixture.data.wallet.overviewUpdatedAt;
  await fixture.wallet.updateWalletBalances();
  assert.equal(fixture.data.wallet.balanceUpdatedAt, fixture.now);
  assert.equal(fixture.data.wallet.overviewUpdatedAt, undefined);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Not updated yet');
});

test('an offline overview refresh cannot make cached balances appear fresh', async () => {
  const fixture = new WalletFixture();
  fixture.context.isOnline = false;
  const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
  await fixture.wallet.updateWalletView();
  assert.equal(fixture.data.wallet.overviewUpdatedAt, previousUpdatedAt);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated 2m ago');
  assert.equal(fixture.wallet.isUpdating, false);
});

test('a recent successful native refresh can complete the overview without repeating its query', async () => {
  const fixture = new WalletFixture();
  fixture.data.wallet.timestamp = fixture.now - 2000;
  fixture.data.wallet.balanceUpdatedAt = fixture.now - 2000;
  await fixture.wallet.updateWalletView();
  assert.deepEqual(fixture.queries, []);
  assert.equal(fixture.data.wallet.overviewUpdatedAt, fixture.now);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated just now');
});

test('a legacy throttle timestamp without successful native freshness cannot complete the overview', async () => {
  const fixture = new WalletFixture();
  fixture.data.wallet.timestamp = fixture.now - 2000;
  delete fixture.data.wallet.balanceUpdatedAt;
  const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
  await fixture.wallet.updateWalletView();
  assert.deepEqual(fixture.queries, []);
  assert.equal(fixture.data.wallet.overviewUpdatedAt, previousUpdatedAt);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated 2m ago');
});

test('an older overview cannot replace the latest completed status', async () => {
  const fixture = new WalletFixture();
  const older = deferred();
  fixture.context.multichain.updateSummary = () => older.promise;
  const olderRefresh = fixture.wallet.updateWalletView();
  await settleMicrotasks();
  fixture.now += 6000;
  fixture.context.multichain.updateSummary = async () => true;
  const latestRefresh = fixture.wallet.updateWalletView();
  await latestRefresh;
  const latestUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
  assert.equal(latestUpdatedAt, fixture.now);
  fixture.now += 60_000;
  older.resolve(true);
  await olderRefresh;
  assert.equal(fixture.data.wallet.overviewUpdatedAt, latestUpdatedAt);
  assert.equal(fixture.wallet.isUpdating, false);
  fixture.wallet.updateBalanceUpdatedAt();
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated 1m ago');
});

test('an old overview completing cannot clear a newer overview pending state', async () => {
  const fixture = new WalletFixture();
  const older = deferred();
  fixture.context.multichain.updateSummary = () => older.promise;
  const olderRefresh = fixture.wallet.updateWalletView();
  await settleMicrotasks();
  fixture.now += 6000;
  const latest = deferred();
  fixture.context.multichain.updateSummary = () => latest.promise;
  const latestRefresh = fixture.wallet.updateWalletView();
  await settleMicrotasks();
  older.resolve(true);
  await olderRefresh;
  assert.equal(fixture.wallet.isUpdating, true);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updating…');
  latest.resolve(true);
  await latestRefresh;
  assert.equal(fixture.wallet.isUpdating, false);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updated just now');
});

test('clearing the account during an overview refresh invalidates its pending status and timestamp', async () => {
  const fixture = new WalletFixture();
  const external = deferred();
  fixture.context.multichain.updateSummary = () => external.promise;
  const refreshing = fixture.wallet.updateWalletView();
  await settleMicrotasks();
  const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
  fixture.context.clearMyData();
  assert.equal(fixture.wallet.isUpdating, false);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Not updated yet');
  external.resolve(true);
  await refreshing;
  assert.equal(fixture.data.wallet.overviewUpdatedAt, previousUpdatedAt);
  assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Not updated yet');
});

for (const [completedStatus, laterStatus, succeeded] of [
  ['connected', 'partial', true],
  ['partial', 'connected', false],
]) {
  test(`EVM completion status ${completedStatus} remains authoritative after it later becomes ${laterStatus}`, async () => {
    const fixture = new WalletFixture();
    const multichain = deferred();
    let evmStatus = completedStatus;
    fixture.context.evmAssets.getStatus = () => evmStatus;
    fixture.context.multichain.updateSummary = () => multichain.promise;
    const previousUpdatedAt = fixture.data.wallet.overviewUpdatedAt;
    const refreshing = fixture.wallet.updateWalletView();
    await settleMicrotasks();
    assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, 'Updating…');
    evmStatus = laterStatus;
    fixture.now += 30_000;
    multichain.resolve(true);
    await refreshing;
    assert.equal(fixture.data.wallet.overviewUpdatedAt, succeeded ? fixture.now : previousUpdatedAt);
    assert.equal(fixture.elements.get('walletBalanceUpdated').textContent, succeeded ? 'Updated just now' : 'Updated 2m ago');
  });
}
