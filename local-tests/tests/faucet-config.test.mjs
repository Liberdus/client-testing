// Run: WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/tests/faucet-config.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');

const flows = [
  { name: 'wallet', className: 'WalletScreen', instanceName: 'walletScreen' },
  { name: 'validator', className: 'StakeValidatorModal', instanceName: 'stakeModal' },
];

function extractRequestMethod({ className, instanceName }) {
  const classStart = appSource.indexOf(`class ${className} {`);
  const classEnd = appSource.indexOf(`\nconst ${instanceName} = new ${className}();`, classStart);
  assert.ok(classStart >= 0 && classEnd > classStart, `Locate ${className}`);
  const classSource = appSource.slice(classStart, classEnd);
  const methodStart = classSource.lastIndexOf('\n  async requestFromFaucet() {');
  assert.ok(methodStart >= 0, `Locate ${className}.requestFromFaucet`);
  return classSource.slice(methodStart, classSource.lastIndexOf('\n}'));
}

function createHarness(flow, faucetUrl, responseKind = 'success') {
  const requests = [];
  const signed = [];
  const toasts = [];
  const hiddenToasts = [];
  let closed = false;
  const address = 'a'.repeat(40);
  const account = { username: 'synthetic-user', keys: { address } };
  const context = vm.createContext({
    network: { netid: 'synthetic-network', faucetUrl },
    myAccount: account,
    myData: { wallet: { assets: [{ symbol: 'LIB', balance: '0' }] } },
    isOnline: true,
    wei: 10n ** 18n,
    longAddress: (value) => value.padEnd(64, '0'),
    signObj: async (payload, keys) => {
      signed.push({ payload, keys });
      payload.sign = { owner: address, sig: 'synthetic-signature' };
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (responseKind === 'network-error') throw new Error('Synthetic connection failure');
      return {
        ok: responseKind === 'success',
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ message: 'Synthetic faucet unavailable' }),
      };
    },
    showToast: (message, duration, type) => {
      toasts.push({ message, duration, type });
      return toasts.length;
    },
    hideToast: (id) => hiddenToasts.push(id),
    console: { error() {} },
  });
  const requestFromFaucet = vm.runInContext(`({${extractRequestMethod(flow)}\n}).requestFromFaucet`, context);
  const receiver = {
    isFaucetRequestInProgress: false,
    nodeAddressInput: { value: '  synthetic-node  ' },
    close: () => { closed = true; },
  };
  return {
    run: () => requestFromFaucet.call(receiver),
    requests, signed, toasts, hiddenToasts, receiver, account, address,
    get closed() { return closed; },
  };
}

for (const flow of flows) {
  test(`${flow.name}: uses the configured faucet URL and signs the expected payload`, async () => {
    const faucetUrl = 'https://custom-faucet.example.test/claim';
    const harness = createHarness(flow, faucetUrl);
    await harness.run();

    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].url, faucetUrl);
    assert.equal(harness.requests[0].options.method, 'POST');
    assert.equal(harness.requests[0].options.headers['Content-Type'], 'application/json');
    assert.equal(harness.signed.length, 1);
    assert.equal(harness.signed[0].keys, harness.account.keys);
    const payload = JSON.parse(harness.requests[0].options.body);
    assert.deepEqual(payload, {
      username: 'synthetic-user',
      userAddress: harness.address.padEnd(64, '0'),
      networkId: 'synthetic-network',
      ...(flow.name === 'validator' ? { nodeAddress: 'synthetic-node' } : {}),
      sign: { owner: harness.address, sig: 'synthetic-signature' },
    });
    assert.ok(harness.toasts.some(({ type }) => type === 'success'));
    assert.equal(harness.hiddenToasts.length, 1);
    assert.equal(harness.receiver.isFaucetRequestInProgress, false);
    assert.equal(harness.closed, flow.name === 'validator');
  });

  for (const faucetUrl of [undefined, null, '']) {
    test(`${flow.name}: missing faucet URL (${String(faucetUrl) || 'empty'}) errors before signing or fetching`, async () => {
      const harness = createHarness(flow, faucetUrl);
      await harness.run();

      assert.equal(harness.signed.length, 0, 'An unconfigured faucet must not sign a request');
      assert.equal(harness.requests.length, 0, 'An unconfigured faucet must not use a default endpoint');
      assert.ok(harness.toasts.some(({ message, type }) => type === 'error' && /faucet/i.test(message)));
      assert.ok(!harness.toasts.some(({ type }) => type === 'success'));
      assert.equal(harness.hiddenToasts.length, 1);
      assert.equal(harness.receiver.isFaucetRequestInProgress, false);
      assert.equal(harness.closed, false);
    });
  }

  for (const responseKind of ['network-error', 'http-error']) {
    test(`${flow.name}: a configured faucet ${responseKind} does not retry another endpoint`, async () => {
      const faucetUrl = 'https://unavailable-faucet.example.test/claim';
      const harness = createHarness(flow, faucetUrl, responseKind);
      await harness.run();

      assert.equal(harness.requests.length, 1);
      assert.equal(harness.requests[0].url, faucetUrl);
      assert.equal(harness.signed.length, 1);
      assert.ok(harness.toasts.some(({ type }) => type === 'error'));
      assert.ok(!harness.toasts.some(({ type }) => type === 'success'));
      assert.equal(harness.hiddenToasts.length, 1);
      assert.equal(harness.receiver.isFaucetRequestInProgress, false);
      assert.equal(harness.closed, false);
    });
  }
}

for (const filename of ['network.js', 'network.js_dev', 'network.js_web', 'network.js_loc', 'network.js_test']) {
  test(`${filename}: declares the intended network faucet`, () => {
    const source = readFileSync(join(clientRoot, filename), 'utf8');
    const network = vm.runInNewContext(`${source}\nnetwork`);
    const expected = filename === 'network.js_test'
      ? 'https://faucet.liberdus.com/faucet'
      : 'https://fac-dev.liberdus.com/faucet';
    assert.equal(network.faucetUrl, expected);
  });
}
