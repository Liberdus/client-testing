import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root && isAbsolute(root), 'Set absolute WEB_CLIENT_ROOT');
const out = '/tmp/lib-send-receive-browser';
await mkdir(out, { recursive: true });
const source = await readFile(resolve(root, 'app.js'), 'utf8');
const fixture = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
window.__broadcasts = 0;
postAssetTransfer = async () => { window.__broadcasts++; throw Error('Fixture forbids broadcasting'); };
queryNetwork = async (path) => {
  if (path.endsWith('/balance')) return { balance: 1000n * wei };
  if (path.includes('/toll')) return { toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } };
  if (path.startsWith('/account/')) return { account: { private: false, data: { toll: 0n, tollUnit: 'LIB' } } };
  throw Error('Unexpected synthetic query: ' + path);
};
checkUsernameAvailability = async (username, owner, found) => {
  if (username !== 'recipient') return 'available';
  found.address = 'b'.repeat(40);
  return 'taken';
};
window.__fixture = {
  sendAssetFormModal, sendAssetConfirmModal, receiveModal, evmAssets,
  configure() {
    parameters.current.stabilityFactorStr = '0.20';
    parameters.current.transactionFeeUsdStr = '0.01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.minTollUsdStr = '0';
    myAccount = { username: 'sender', keys: { address: 'a'.repeat(40) }, netid: network.netid };
    myData = newDataRecord(myAccount);
    myData.contacts['b'.repeat(40)] = { address: 'b'.repeat(40), username: 'recipient', messages: [], friend: 2, unread: 0, timestamp: 0, useAvatar: 'identicon' };
    myData.wallet.assets[0].price = 0.2;
    myData.wallet.assets[0].balance = 1000n * wei;
    myData.wallet.assets[0].addresses[0].balance = 1000n * wei;
    // Retain real balance-refresh logic and deliberately place LIB after a non-native row.
    myData.wallet.assets.unshift({ id: 'evm-test', name: 'Ethereum', symbol: 'ETH', balance: 2n * wei, addresses: [] });
    isOnline = true;
    welcomeScreen.close();
    header.open(); footer.open(); walletScreen.screen.classList.add('active');
    const asset = { key: 'ethereum-native', networkId: 'ethereum', chainId: 1, tokenType: 'native', contractAddress: null,
      tokenSymbol: 'ETH', tokenName: 'Ethereum', tokenDecimals: 18, tokenAmount: '2', tokenPriceUsd: '3000', rawAmount: '2000000000000000000' };
    const walletNetwork = { id: 'ethereum', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', assets: [asset] };
    evmAssets.discovery.getCatalog = () => [walletNetwork];
    evmAssets.discovery.refresh = async () => [walletNetwork];
    this.evmSelection = { networkId: 'ethereum', assetKey: asset.key };
  },
  qrData() { return receiveModal.createQRPaymentData(); },
};
`;
const app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) throw Error('Outside client');
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Chicago', serviceWorkers: 'block' });
    const errors = [], external = [];
    await context.route('**/*', async route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(() => __fixture.configure());
    await page.locator('#openSendAssetFormModal').click();
    await page.locator('#sendAssetFormModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#sendAssetFormModal .modal-title').textContent(), 'Send LIB');
    assert.equal(await page.locator('#sendAsset').count(), 0);
    assert.equal(await page.locator('#sendAssetFormModal label').filter({ hasText: /^Asset$/ }).count(), 0);
    await page.locator('#sendToAddress').fill('recipient');
    await page.locator('#sendAmount').fill('10');
    await page.locator('#sendMemo').fill('Lunch');
    await page.waitForFunction(() => document.querySelector('#sendToAddressError').textContent === 'found');
    await page.waitForFunction(() => !document.querySelector('#sendForm button[type="submit"]').disabled);
    assert.match(await page.locator('#balanceAmount').textContent(), /1000/);
    assert.equal(await page.locator('#balanceSymbol').textContent(), 'LIB');
    await page.screenshot({ path: `${out}/send-${viewport.name}.png`, fullPage: true });
    await page.locator('#toggleBalance').click();
    await page.waitForFunction(() => document.querySelector('#balanceSymbol').textContent === 'USD');
    assert.equal(await page.locator('#sendAmount').inputValue(), '2');
    await page.locator('#toggleBalance').click();
    await page.waitForFunction(() => document.querySelector('#balanceSymbol').textContent === 'LIB');
    assert.equal(await page.locator('#sendAmount').inputValue(), '10');
    await page.waitForFunction(() => !document.querySelector('#sendForm button[type="submit"]').disabled);
    await page.locator('#sendForm button[type="submit"]').click();
    await page.locator('#sendAssetConfirmModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#confirmRecipient').textContent(), 'recipient');
    assert.equal(await page.locator('#confirmAmount').textContent(), '10');
    assert.match(await page.locator('#confirmAsset').textContent(), /LIB/);
    assert.equal(await page.locator('#confirmMemo').textContent(), 'Lunch');
    await page.screenshot({ path: `${out}/confirm-${viewport.name}.png`, fullPage: true });
    await page.locator('#cancelSendButton').click();
    await page.waitForFunction(() => !document.querySelector('#sendAssetConfirmModal').classList.contains('active'));
    assert.equal(await page.locator('#sendAmount').inputValue(), '10');
    await page.locator('#closeSendAssetFormModal').click();
    await page.locator('#openReceiveModal').click();
    await page.locator('#receiveModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#receiveModal .modal-title').textContent(), 'Receive LIB');
    assert.equal(await page.locator('#receiveAsset').count(), 0);
    assert.equal(await page.locator('#receiveModal label').filter({ hasText: /^Asset$/ }).count(), 0);
    assert.equal(await page.locator('#displayAddress').textContent(), '0x' + 'a'.repeat(40));
    await page.locator('#receiveAmount').fill('10');
    await page.locator('#receiveMemo').fill('Lunch');
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => __fixture.qrData()), { u: 'sender', i: 'liberdus', s: 'LIB', d: 'LIB', a: '10', m: 'Lunch' });
    assert.equal(await page.locator('#qrcode img').count(), 1);
    assert.match(await page.locator('#qrcode img').getAttribute('src'), /^data:image\/gif;base64,/);
    await page.screenshot({ path: `${out}/receive-${viewport.name}.png`, fullPage: true });
    await page.locator('#toggleReceiveBalance').click();
    await page.waitForFunction(() => document.querySelector('#receiveBalanceSymbol').textContent === 'USD');
    assert.equal(await page.locator('#receiveAmount').inputValue(), '2');
    assert.deepEqual(await page.evaluate(() => __fixture.qrData()), { u: 'sender', i: 'liberdus', s: 'LIB', d: 'USD', a: '2', m: 'Lunch' });
    await page.locator('#closeReceiveModal').click();
    // The unchanged EVM forms still select their own network/asset through the wallet catalog.
    await page.evaluate(() => __fixture.evmAssets.sendModal.open(__fixture.evmSelection));
    await page.locator('#evmSendModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#evmSendModal .modal-title').textContent(), 'Send');
    assert.equal(await page.locator('#evmSendAssetLabel').textContent(), 'Ethereum (ETH) · Ethereum');
    assert.equal(await page.locator('#evmSendSymbol').textContent(), 'ETH');
    await page.locator('#closeEvmSendModal').click();
    await page.evaluate(() => __fixture.evmAssets.receiveModal.open(__fixture.evmSelection));
    await page.locator('#evmReceiveModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#evmReceiveModal .modal-title').textContent(), 'Receive');
    assert.equal(await page.locator('#evmReceiveAssetLabel').textContent(), 'Ethereum (ETH) · Ethereum');
    assert.equal(await page.locator('#evmReceiveSymbol').textContent(), 'ETH');
    assert.equal(await page.locator('#evmReceiveQRCode img').count(), 1);
    assert.equal(await page.evaluate(() => __fixture.evmAssets.receiveModal.createQRPaymentData().n), 'ethereum');
    await page.locator('#closeEvmReceiveModal').click();
    assert.equal(await page.evaluate(() => __broadcasts), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.name}: actual startup/buttons; Send LIB/Receive LIB; no Asset row; native lookup with LIB at wallet index 1; recipient/balance/memo; LIB/USD conversion; LIB confirmation and Cancel; payment QR; separate EVM send/receive and Ethereum QR; zero broadcasts; blocked external attempts=${external.length}`);
    await context.close();
  }
  console.log(`Screenshots: ${out}`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
