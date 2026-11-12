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

// Attach synthetic chats and stub service boundaries. The message context menu,
// asset lookup, asset details, Send forms and recipient validation run as shipped.
const fixture = String.raw`
import { intentsAssets } from "./near-assets.js";
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
const senderAddress = 'a'.repeat(40);
const contacts = {
  recipient: { address: 'b'.repeat(40), username: 'recipient' },
  another: { address: 'c'.repeat(40), username: 'another' },
  addressOnly: { address: 'e'.repeat(40), username: null, name: 'Address-only contact' },
};
const usdcContract = '0x' + 'd'.repeat(40);
const nearAssetId = 'nep141:usdc.fixture.near';
const fixtureLookup = async (username) =>
  Object.values(contacts).find((contact) => contact.username === username)?.address || null;
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

// One received EVM token payment and one sent NEAR Intents payment per chat.
function paymentMessages(contactAddress, seed) {
  const now = Date.now() - 60_000;
  return [
    {
      type: 'evm_transfer', my: false, paymentVerified: 'settled', timestamp: now,
      txid: seed.repeat(64),
      payment: { type: 'evm_transfer', version: 1, chainId: 1, networkId: 'ethereum',
        transactionHash: '0x' + seed.repeat(64), from: '0x' + contactAddress, to: '0x' + senderAddress,
        assetKind: 'erc20', contractAddress: usdcContract, rawAmount: '2500000', decimals: 6, symbol: 'USDC' },
    },
    {
      type: 'intents_transfer', my: true, paymentVerified: 'settled', timestamp: now - 1000,
      txid: seed.repeat(63) + 'f',
      payment: { type: 'intents_transfer', assetId: nearAssetId, symbol: 'USDC', chainName: 'NEAR',
        amount: '1.5', decimals: 6, intentHash: '8LKE47o44ybZQR9ozLyDnvMDTh4Ao5ipy2mJWsYByG5Q' },
    },
  ];
}

window.paymentWalletFixture = {
  setup() {
    parameters.current.stabilityFactorStr = '0.20';
    parameters.current.transactionFeeUsdStr = '0.01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.tollTimeout = 86_400_000;
    parameters.current.minTollUsdStr = '0';
    myAccount = { username: 'sender', keys: { address: senderAddress }, netid: network.netid };
    myData = newDataRecord(myAccount);
    Object.values(contacts).forEach(({ address, username, name }, index) => {
      myData.contacts[address] = {
        address, username, name, messages: paymentMessages(address, String(index + 1)),
        toll: 0n, tollUnit: 'LIB', tollRequiredToSend: 0, tollRequiredToReceive: 0,
        friend: 2, unread: 0, timestamp: 0, useAvatar: 'identicon',
      };
    });
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
        contractAddress: usdcContract, tokenDecimals: 6, rawAmount: '2000000' },
    ];
    const evmCatalog = [{ id: 'ethereum', chainId: 1, name: 'Ethereum', shortName: 'ETH', nativeSymbol: 'ETH', connected: true, assets: evmAssetsForTest }];
    evmAssets.discovery.getCatalog = () => evmCatalog;
    evmAssets.discovery.refresh = async () => evmCatalog;
    evmAssets.recipients.lookupUsername = fixtureLookup;
    evmAssets.prepareChatPayment = async () => ({ toll: 0n });

    const nearAsset = { key: 'intents:' + nearAssetId, assetId: nearAssetId, tokenSymbol: 'USDC', tokenName: 'USD Coin',
      blockchain: 'near', chainName: 'NEAR', tokenDecimals: 6, tokenAmount: '10', rawAmount: '10000000',
      tokenPriceUsd: '1', tokenValueUsd: '10' };
    intentsAssets.balances = {};
    intentsAssets.network = { assets: [nearAsset] };
    intentsAssets.status = 'connected';
    intentsAssets.refresh = async () => intentsAssets.getCatalog();
    intentsAssets.listCatalogAssets = () => [nearAsset];
    intentsActivity.forAsset = async () => ({ entries: [] });
    chatPaymentPanel.lookupUsername = fixtureLookup;
    chatPaymentPanel.checkReceiptRecipient = async () => ({ problem: null, tollWei: 0n });
  },
  openChat(contact) { return chatModal.open(contacts[contact].address); },
};
`;

test('Send from a payment message\'s Wallet asset is prefilled with that chat\'s username', { timeout: 90_000 }, async t => {
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
  await page.evaluate(() => window.paymentWalletFixture.setup());

  const shown = id => page.locator(`#${id}.active.is-transition-complete`).waitFor({ state: 'attached' });
  const closed = id => page.locator(`#${id}.active`).waitFor({ state: 'detached' });
  const click = id => page.locator(`#${id}`).click();
  const input = id => page.locator(`#${id}`);
  const back = async id => {
    await page.evaluate(() => history.back());
    await closed(id);
  };
  const waitForStatus = (id, pattern) => page.locator(`#${id}`).filter({ hasText: pattern }).waitFor();

  const flows = [
    { name: 'EVM', message: '.evm-payment-message', wallet: 'evmAssetsSummary', overview: 'assetsModal',
      details: 'assetDetailsModal', title: 'assetDetailsModalTitle', send: 'evmSendModal', sendButton: 'assetDetailsSend',
      closeList: 'closeAssetsModal', asset: 'test-evm-usdc', recipient: 'evmSendRecipient',
      status: 'evmSendRecipientStatus', verified: /^Username verified$/ },
    { name: 'NEAR', message: '.intents-payment-receipt', wallet: 'multichainSummary', overview: 'multichainModal',
      details: 'multichainAssetModal', title: 'multichainAssetTitle', send: 'nearIntentsSendModal',
      sendButton: 'multichainAssetSend', closeList: 'closeMultichainModal', asset: 'intents:nep141:usdc.fixture.near',
      recipient: 'chatSendRecipient', status: 'chatSendRecipientStatus', verified: /^Verified @/ },
  ];

  const openChat = async contact => {
    await page.evaluate(name => window.paymentWalletFixture.openChat(name), contact);
    await shown('chatModal');
  };
  const closeChat = async () => {
    await click('closeChatModal');
    await closed('chatModal');
  };
  // Message context menu -> Wallet -> asset details -> Send.
  const openSendFromPaymentMessage = async flow => {
    await page.locator(`#chatModal ${flow.message} .intents-payment-amount`).click();
    await page.locator('#messageContextMenu [data-action="wallet"]').click();
    await shown(flow.details);
    await waitForStatus(flow.title, /USDC/);
    await click(flow.sendButton);
    await shown(flow.send);
  };
  const leaveSend = async flow => {
    await back(flow.send);
    await back(flow.details);
    await shown('chatModal');
  };

  for (const flow of flows) {
    await t.test(`${flow.name} payment message`, async () => {
      await openChat('recipient');
      await openSendFromPaymentMessage(flow);
      assert.equal(await input(flow.recipient).inputValue(), 'recipient');
      await waitForStatus(flow.status, flow.verified);
      assert.ok(await input(flow.recipient).isEditable(), 'the prefilled recipient can be changed');
      await leaveSend(flow);
      await closeChat();

      // The prefill follows the chat it was opened from, not the previous one.
      await openChat('another');
      await openSendFromPaymentMessage(flow);
      assert.equal(await input(flow.recipient).inputValue(), 'another');
      await waitForStatus(flow.status, flow.verified);
      await leaveSend(flow);
      await closeChat();

      // A contact without a username leaves the recipient for the user to enter.
      await openChat('addressOnly');
      await openSendFromPaymentMessage(flow);
      assert.equal(await input(flow.recipient).inputValue(), '');
      await leaveSend(flow);

      // Reaching the same asset through the Wallet afterward starts with no recipient.
      await openChat('recipient');
      await openSendFromPaymentMessage(flow);
      assert.equal(await input(flow.recipient).inputValue(), 'recipient');
      await leaveSend(flow);
      await closeChat();
      await click(flow.wallet);
      await shown(flow.overview);
      await page.locator(`#${flow.overview} button[data-asset-key="${flow.asset}"]`).click();
      await shown(flow.details);
      await click(flow.sendButton);
      await shown(flow.send);
      assert.equal(await input(flow.recipient).inputValue(), '');
      await back(flow.send);
      await back(flow.details);
      await click(flow.closeList);
      await closed(flow.overview);
    });
  }

  assert.deepEqual(errors, []);
});
