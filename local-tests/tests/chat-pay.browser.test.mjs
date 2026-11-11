import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import test from 'node:test';

// Install the companion Playwright dependencies and Chromium, then run this file
// with node --test and WEB_CLIENT_ROOT set to the absolute client checkout.
const require = createRequire(new URL('../../playwright-tests/package.json', import.meta.url));
const { chromium } = require('playwright');
assert.ok(process.env.WEB_CLIENT_ROOT && isAbsolute(process.env.WEB_CLIENT_ROOT), 'Set absolute WEB_CLIENT_ROOT');
const clientRoot = resolve(process.env.WEB_CLIENT_ROOT);

// Attach synthetic data and stub service boundaries. Modal loading, event
// handlers, recipient validation, rendering, and browser history run as shipped.
const fixture = String.raw`
import { intentsAssets } from "./near-assets.js";
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
const senderAddress = 'a'.repeat(40);
const recipientAddress = 'b'.repeat(40);
const alternateAddress = 'c'.repeat(40);
let currentRecipientAddress = recipientAddress;
const fixtureLookup = async (username) => {
  if (username === 'recipient') return currentRecipientAddress;
  if (username === 'another') return alternateAddress;
  return null;
};
checkUsernameAvailability = async (username, owner, found) => {
  found.address = await fixtureLookup(username);
  return found.address ? 'taken' : 'available';
};
queryNetwork = async (path) => {
  if (path.endsWith('/balance')) return { balance: 1000n * wei };
  if (path.includes('/toll')) return { toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } };
  if (path.startsWith('/account/')) return { account: { private: false, data: { toll: 0n, tollUnit: 'LIB' } } };
  throw Error('Unexpected synthetic query: ' + path);
};
window.chatPayFixture = {
  async openChat() {
    parameters.current.stabilityFactorStr = '0.20';
    parameters.current.transactionFeeUsdStr = '0.01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.tollTimeout = 86_400_000;
    parameters.current.minTollUsdStr = '0';
    myAccount = { username: 'sender', keys: { address: senderAddress }, netid: network.netid };
    myData = newDataRecord(myAccount);
    myData.contacts[recipientAddress] = {
      address: recipientAddress, username: 'recipient', messages: [], friend: 2, unread: 0,
      timestamp: 0, useAvatar: 'identicon',
    };
    isOnline = true;
    welcomeScreen.close();
    header.open();
    footer.open();
    walletScreen.screen.classList.add('active');
    history.pushState({ state: 1 }, '', '.');
    window.addEventListener('popstate', handleBrowserBackButton);

    const evmAsset = { networkId: 'ethereum', chainId: 1, tokenType: 'native', contractAddress: null,
      tokenSymbol: 'ETH', tokenName: 'Ethereum', tokenDecimals: 18, tokenAmount: '2',
      tokenPriceUsd: '3000', tokenValueUsd: '6000', rawAmount: '2000000000000000000', key: 'test-eth' };
    const evmAssetsForTest = [
      evmAsset,
      { ...evmAsset, key: 'test-evm-usdc', tokenType: 'erc20', tokenSymbol: 'USDC', tokenName: 'USD Coin',
        contractAddress: '0x' + 'd'.repeat(40), tokenDecimals: 6, rawAmount: '2000000' },
    ];
    const evmCatalog = [{ id: 'ethereum', chainId: 1, name: 'Ethereum', shortName: 'ETH', nativeSymbol: 'ETH', connected: true, assets: evmAssetsForTest }];
    evmAssets.discovery.getCatalog = () => evmCatalog;
    evmAssets.discovery.refresh = async () => evmCatalog;
    evmAssets.recipients.lookupUsername = fixtureLookup;
    evmAssets.prepareChatPayment = async () => ({ toll: 0n });

    const nearAsset = { key: 'test-near-usdc', tokenSymbol: 'USDC', tokenName: 'USD Coin', blockchain: 'near',
      chainName: 'NEAR', tokenDecimals: 6, tokenAmount: '10', rawAmount: '10000000', tokenPriceUsd: '1', tokenValueUsd: '10' };
    const nearAssetsForTest = [
      nearAsset, { ...nearAsset, key: 'test-near-usdt', tokenSymbol: 'USDT', tokenName: 'Tether' },
    ];
    intentsAssets.balances = {};
    intentsAssets.network = { assets: nearAssetsForTest };
    intentsAssets.status = 'connected';
    intentsAssets.refresh = async () => intentsAssets.getCatalog();
    intentsAssets.listCatalogAssets = () => nearAssetsForTest;
    intentsActivity.forAsset = async () => ({ entries: [] });
    chatPaymentPanel.lookupUsername = fixtureLookup;
    chatPaymentPanel.checkReceiptRecipient = async () => ({ problem: null, tollWei: 0n });
    await chatModal.open(recipientAddress);
  },
  setUsernameChanged(changed) { currentRecipientAddress = changed ? alternateAddress : recipientAddress; },
};
`;

test('Chat Pay opens each send flow with an editable recipient and clears Wallet prefills on exit', { timeout: 45_000 }, async t => {
  const app = await readFile(resolve(clientRoot, 'app.js'), 'utf8') + '\n' + fixture;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const origin = 'http://127.0.0.1';
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const { origin: requestOrigin, pathname } = new URL(route.request().url());
    if (requestOrigin !== origin || route.request().method() !== 'GET') return route.abort();
    const file = resolve(clientRoot, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    if (!file.startsWith(clientRoot + sep)) return route.abort();
    try {
      const body = file === resolve(clientRoot, 'app.js') ? app : await readFile(file);
      return route.fulfill({ contentType: types[extname(file)] || 'application/octet-stream', body });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(3000);
  await page.goto(origin);
  await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
  await page.evaluate(() => window.chatPayFixture.openChat());

  const shown = id => page.locator(`#${id}.active.is-transition-complete`).waitFor({ state: 'attached' });
  const closed = id => page.locator(`#${id}.active`).waitFor({ state: 'detached' });
  const click = id => page.locator(`#${id}`).click();
  const input = id => page.locator(`#${id}`);
  const back = async id => {
    await page.evaluate(() => history.back());
    await closed(id);
  };
  const showPayMenu = async () => {
    await shown('chatModal');
    await click('chatHeaderMenuButton');
  };
  const openPay = async () => {
    await showPayMenu();
    await page.locator('#chatHeaderContextMenu [data-action="pay"]').click();
    await shown('payChoiceModal');
  };
  const waitForStatus = (id, pattern) => page.locator(`#${id}`).filter({ hasText: pattern }).waitFor();

  await openPay();
  assert.equal(await input('payChoiceRecipient').textContent(), 'To @recipient');
  const focusedId = () => page.evaluate(() => document.activeElement.id);
  assert.equal(await focusedId(), 'closePayChoiceModal');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusedId(), 'cancelPayChoice');
  await page.keyboard.press('Tab');
  assert.equal(await focusedId(), 'closePayChoiceModal');
  await page.keyboard.press('Escape');
  await closed('payChoiceModal');
  assert.equal(await focusedId(), 'chatHeaderMenuButton');

  await openPay();
  await click('cancelPayChoice');
  await closed('payChoiceModal');
  await openPay();
  await back('payChoiceModal');
  await showPayMenu();
  const selectedBeforeTransition = await page.evaluate(() => {
    document.querySelector('#chatHeaderContextMenu [data-action="pay"]').click();
    const chooser = document.getElementById('payChoiceModal');
    const stillOpening = chooser.classList.contains('active') && !chooser.classList.contains('is-transition-complete');
    document.getElementById('payChoiceLibBtn').click();
    return stillOpening;
  });
  assert.ok(selectedBeforeTransition);
  await shown('sendAssetFormModal');
  assert.equal(await input('sendToAddress').inputValue(), 'recipient');
  await waitForStatus('sendToAddressError', /^found$/);
  await input('sendToAddress').fill('another');
  await waitForStatus('sendToAddressError', /^found$/);
  await back('sendAssetFormModal');

  const assetFlows = [
    { choice: 'payChoiceEvmBtn', wallet: 'evmAssetsSummary', overview: 'assetsModal', details: 'assetDetailsModal',
      send: 'evmSendModal', sendButton: 'assetDetailsSend', closeDetails: 'closeAssetDetailsModal', closeList: 'closeAssetsModal',
      first: 'test-eth', second: 'test-evm-usdc', recipient: 'evmSendRecipient',
      label: 'evmSendAssetLabel', secondSymbol: 'USDC', status: 'evmSendRecipientStatus',
      verified: /^Username verified$/, changed: /wallet associated with this username changed/ },
    { choice: 'payChoiceNearBtn', wallet: 'multichainSummary', overview: 'multichainModal', details: 'multichainAssetModal',
      send: 'nearIntentsSendModal', sendButton: 'multichainAssetSend', closeDetails: 'closeMultichainAssetModal',
      closeList: 'closeMultichainModal', first: 'test-near-usdc', second: 'test-near-usdt', recipient: 'chatSendRecipient',
      label: 'chatSendAssetLabel', secondSymbol: 'USDT', status: 'chatSendRecipientStatus',
      verified: /^Verified @/, changed: /username no longer matches the saved contact/ },
  ];
  const openAssetSend = async (flow, asset) => {
    await shown(flow.overview);
    await page.locator(`#${flow.overview} button[data-asset-key="${asset}"]`).click();
    await shown(flow.details);
    await click(flow.sendButton);
    await shown(flow.send);
  };

  for (const flow of assetFlows) {
    await openPay();
    await click(flow.choice);
    await openAssetSend(flow, flow.first);
    assert.equal(await input(flow.recipient).inputValue(), 'recipient');
    await waitForStatus(flow.status, flow.verified);
    await input(flow.recipient).fill('another');
    await waitForStatus(flow.status, flow.verified);
    await back(flow.send);
    await click(flow.closeDetails);
    await closed(flow.details);
    await page.evaluate(() => window.chatPayFixture.setUsernameChanged(true));
    await openAssetSend(flow, flow.second);
    assert.equal(await input(flow.recipient).inputValue(), 'recipient');
    await waitForStatus(flow.label, flow.secondSymbol);
    await waitForStatus(flow.status, flow.changed);
    await page.evaluate(() => window.chatPayFixture.setUsernameChanged(false));
    await back(flow.send);
    await back(flow.details);
    await back(flow.overview);
    await shown('chatModal');
  }

  // A renamed recipient must not silently direct the initial prefill to a new address.
  await page.evaluate(() => window.chatPayFixture.setUsernameChanged(true));
  await openPay();
  await click('payChoiceLibBtn');
  await shown('sendAssetFormModal');
  await waitForStatus('sendToAddressError', /contact changed/i);
  await back('sendAssetFormModal');
  await click('closeChatModal');
  await closed('chatModal');

  for (const flow of assetFlows) {
    await click(flow.wallet);
    await openAssetSend(flow, flow.first);
    assert.equal(await input(flow.recipient).inputValue(), '');
    await back(flow.send);
    await back(flow.details);
    await click(flow.closeList);
    await closed(flow.overview);
  }
  assert.deepEqual(errors, []);
});
