import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = '/tmp/1817-hide-send-crypto';
await mkdir(screenshots, { recursive: true });
const source = await readFile(resolve(root, 'app.js'), 'utf8');
const fixture = String.raw`
import { intentsAssets, intentsDeposits } from './near-assets.js';
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
queryNetwork = async () => ({ toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } });
window.__transactions = 0;
postAssetTransfer = signObj = async () => { window.__transactions++; throw Error('Synthetic fixture forbids transactions'); };
window.__fixture = {
  chatModal,
  configure() {
    this.recipient = 'b'.repeat(40);
    myAccount = { username: 'sender', keys: { address: 'a'.repeat(40) }, netid: network.netid };
    parameters.current.defaultTollUsdStr = '0';
    myData = newDataRecord(myAccount);
    myData.contacts[this.recipient] = { address: this.recipient, username: 'recipient', messages: [],
      toll: 0n, tollUnit: 'LIB', tollRequiredToSend: 0, tollRequiredToReceive: 0, friend: 2,
      unread: 0, timestamp: 0, useAvatar: 'identicon' };
    isOnline = false;
    welcomeScreen.close();
    header.open(); footer.open(); walletScreen.screen.classList.add('active');
    this.actions = [];
    chatModal.capturePhotoFromCamera = () => this.actions.push('camera');
    chatModal.handleShareLocationAction = () => this.actions.push('location');
    shareContactsModal.open = address => this.actions.push(['contacts', address]);
    const asset = { key: 'intents:synthetic-usdc', assetId: 'synthetic-usdc', tokenSymbol: 'USDC',
      tokenName: 'USD Coin', tokenAmount: '0', rawAmount: '0', tokenDecimals: 6,
      tokenPriceUsd: '1', tokenValueUsd: '0', chainName: 'Ethereum', blockchain: 'eth', contractAddress: null };
    const catalog = { assets: [], totalValueUsd: '0' };
    intentsAssets.getNetwork = () => catalog;
    intentsAssets.getStatus = () => 'connected';
    intentsAssets.getAssets = () => [];
    intentsAssets.refresh = async () => catalog;
    intentsAssets.listCatalogAssets = () => [asset];
    intentsAssets.getCatalogAsset = key => key === asset.key ? asset : null;
    intentsAssets.getAccountId = () => 'synthetic.near';
    intentsDeposits.loadBridgeTokens = async () => {};
    intentsDeposits.isDepositable = id => id === asset.assetId;
    intentsDeposits.requestDepositTarget = async () => ({ address: '0x' + 'c'.repeat(40), memo: null,
      chain: 'eth:1', chainName: 'Ethereum', assetName: 'USDC', siblings: 0 });
    multichain.receiveModal.startWatching = () => {};
    chatPaymentPanel.run = async () => { window.__transactions++; throw Error('Synthetic fixture forbids payments'); };
  },
  openChat() { return chatModal.open(this.recipient); },
  openPreservedPayment() { chatModal.handleAttachmentOptionsContextMenuAction('intents-payment'); },
};
`;
const app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    assert.ok(path.startsWith(root + sep));
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1100, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 600,
      hasTouch: viewport.width < 600, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
    await page.evaluate(() => __fixture.configure());
    await page.evaluate(() => __fixture.openChat());
    await page.locator('#chatModal.is-transition-complete').waitFor();
    const menu = page.locator('#attachmentOptionsContextMenu');
    const showMenu = async () => {
      await page.locator('#addAttachmentButton').click();
      await menu.waitFor({ state: 'visible' });
    };
    await showMenu();
    assert.equal(await menu.locator('[data-action="intents-payment"]').count(), 0, 'chat + menu has no actionable Send Crypto entry');
    assert.equal(await menu.getByText('Send Crypto', { exact: true }).count(), 0);
    const actions = await menu.locator('.context-menu-option:visible').evaluateAll(options => options.map(option => option.dataset.action));
    for (const action of ['camera', 'files', 'contacts', 'location']) assert.ok(actions.includes(action), `${action} remains available`);
    await page.screenshot({ path: `${screenshots}/chat-menu-${viewport.width}.png`, fullPage: true });
    await menu.locator('[data-action="contacts"]').click();
    assert.equal(await menu.isVisible(), false);
    await showMenu();
    await menu.locator('[data-action="location"]').click();
    await showMenu();
    await menu.locator('[data-action="camera"]').click();
    assert.deepEqual(await page.evaluate(() => __fixture.actions), [['contacts', 'b'.repeat(40)], 'location', 'camera']);
    await showMenu();
    const chooser = page.waitForEvent('filechooser');
    await menu.locator('[data-action="files"]').click();
    assert.equal(await (await chooser).element().getAttribute('id'), 'chatFilesInput', 'Files still opens its native attachment picker');

    // The hidden entry point's action and its real payment/receive screens remain usable.
    await page.evaluate(() => __fixture.openPreservedPayment());
    await page.locator('#chatSendModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#chatSendTitle').textContent(), 'Send to recipient');
    await page.locator('#chatSendEmpty').waitFor({ state: 'visible' });
    await page.locator('#chatSendReceive').click();
    await page.locator('#multichainTokenPickerModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#multichainTokenPickerTitle').textContent(), 'Receive');
    await page.locator('#closeMultichainTokenPickerModal').click();
    await page.locator('#closeChatModal').click();

    await page.locator('#multichainSummary').click();
    await page.locator('#multichainModal.is-transition-complete').waitFor();
    await page.locator('#multichainReceiveAny').click();
    await page.locator('#multichainTokenPickerModal.is-transition-complete').waitFor();
    await page.locator('#multichainTokenResults [data-asset-key="intents:synthetic-usdc"]').click();
    await page.locator('#multichainReceiveModal.is-transition-complete').waitFor();
    assert.equal(await page.locator('#multichainReceiveTitle').textContent(), 'Receive USDC (Ethereum)');
    assert.match(await page.locator('#multichainReceiveBody').innerText(), /0xcccccccc/);
    assert.equal(await page.locator('#multichainReceiveBody canvas, #multichainReceiveBody img').count(), 1, 'wallet receive still renders its address QR');
    assert.equal(await page.evaluate(() => __transactions), 0);
    assert.deepEqual(external, [], 'regression uses only local synthetic data');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${viewport.width}px: chat menu hides Send Crypto; attachment actions, retained payment handler and wallet Multichain Receive still work`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
