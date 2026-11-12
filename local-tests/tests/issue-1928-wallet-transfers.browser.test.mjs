import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';

const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root, 'Set WEB_CLIENT_ROOT');
const require = createRequire(resolve(process.env.CLIENT_TESTING_ROOT, 'playwright-tests/package.json'));
const { chromium } = require('playwright');
const out = '/tmp/issue-1928-browser';
await mkdir(out, { recursive: true });
const fixture = `
import { intentsAssets, intentsDeposits, intentsTransfers } from './near-assets.js';
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
window.__fixture = {
  async open() {
    const account = { username: 'sender', keys: { address: '1'.repeat(40), secret: 'fixture' }, netid: network.netid };
    parameters.current.stabilityFactorStr = '0.20';
    parameters.current.transactionFeeUsdStr = '0.01';
    parameters.current.defaultTollUsdStr = '0';
    parameters.current.minTollUsdStr = '0';
    myAccount = account;
    myData = newDataRecord(account);
    isOnline = true;
    const asset = { key: 'fixture-sol', assetId: 'nep141:sol.omft.near', tokenSymbol: 'SOL', tokenName: 'Solana',
      tokenDecimals: 9, tokenAmount: '1', rawAmount: '1000000000', tokenPriceUsd: 100, chainName: 'Solana' };
    intentsAssets.refresh = async () => {};
    intentsAssets.getAssets = () => [asset];
    intentsAssets.getAsset = () => asset;
    intentsAssets.getCatalogAsset = () => asset;
    intentsAssets.getAccountId = () => '0x' + account.keys.address;
    intentsAssets.balances = {};
    intentsDeposits.loadBridgeTokens = async () => {};
    intentsDeposits.describeDepositTarget = () => null;
    chatPaymentPanel.lookupUsername = async (name) => name === 'alice' ? '2'.repeat(40) : null;
    chatPaymentPanel.checkReceiptRecipient = async () => ({ tollWei: 0n });
    chatPaymentPanel.openQRScanner = (finish) => { finish('0x' + '2'.repeat(40)); return true; };
    intentsTransfers.prepare = async ({ recipientAddress, amount }) => ({
      senderId: '0x' + account.keys.address, recipientId: recipientAddress, assetId: asset.assetId, amount, symbol: 'SOL',
    });
    // Only the signing and network boundaries are simulated. Submission and persistence use production code.
    intentsTransfers.sign = async () => ({ fixture: true });
    intentsTransfers.simulate = async () => ({ ok: true });
    window.__publishCount = 0;
    window.fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === 'publish_intent') {
        window.__publishCount++;
        return Response.json({ result: { status: 'OK', intent_hash: 'fixtureIntent' } });
      }
      if (req.method === 'get_status') return Response.json({ result: { status: 'SETTLED', data: { hash: 'fixtureTransaction' } } });
      if (req.method === 'tx') return Response.json({ result: { receipts_outcome: [{ outcome: {
        executor_id: 'intents.near', logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'dip4', event: 'transfer', data: [{
          intent_hash: 'fixtureIntent', account_id: '0x' + '1'.repeat(40), receiver_id: '0x' + '2'.repeat(40),
          tokens: { [asset.assetId]: '250000000' },
        }] })],
      } }] } });
      throw Error('Unexpected network request');
    };
    multichain.updateSummary = async () => {};
    multichain.assetsModal.render = () => {};
    multichain.assetModal.open(asset.key);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await chatPaymentPanel.open(null, null, { assetKey: asset.key });
  },
  state() { return { transfers: myData.intentsTransfers, contacts: myData.contacts, pending: myData.pending, publishes: window.__publishCount }; },
  async reloadActivity() {
    myData.intentsTransfers = JSON.parse(JSON.stringify(myData.intentsTransfers));
    await multichain.assetModal.loadActivity();
  },
};
`;
const app = (await readFile(resolve(root, 'app.js'), 'utf8'))
  .replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert.ok(path.startsWith(root + '/'));
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path.endsWith('/app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1100, height: 950 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixtureReady);
    await page.evaluate(() => __fixture.open());
    await page.locator('#chatSendRecipient').fill('missing');
    await page.waitForFunction(() => document.querySelector('#chatSendRecipientStatus').textContent.includes('not found'));
    assert.equal(await page.locator('#chatSendNote').isDisabled(), true);
    await page.locator('#chatSendRecipient').fill('alice');
    await page.waitForFunction(() => !document.querySelector('#chatSendNote').disabled);
    await page.locator('#chatSendNoteToggle').click();
    await page.locator('#chatSendNote').fill('Lunch');
    await page.locator('#chatSendRecipient').fill('0x' + '2'.repeat(40));
    assert.equal(await page.locator('#chatSendNote').inputValue(), '');
    assert.equal(await page.locator('#chatSendNote').isDisabled(), true);
    await page.locator('#chatSendAmount').fill('0.25');
    await page.waitForFunction(() => !document.querySelector('#chatSendButton').disabled);
    await page.screenshot({ path: `${out}/send-${viewport.width}.png`, animations: 'disabled' });
    await page.locator('#chatSendScanQR').click();
    assert.equal(await page.locator('#chatSendRecipient').inputValue(), '0x' + '2'.repeat(40));
    const bytes = await page.evaluate(() => Array.from(qr.encodeQR('0x' + '2'.repeat(40), 'gif', { scale: 6, border: 4 })));
    await page.locator('#chatSendQRFile').setInputFiles({ name: 'address.gif', mimeType: 'image/gif', buffer: Buffer.from(bytes) });
    await page.waitForFunction(() => document.querySelector('#chatSendQRFile').value === '');
    assert.equal(await page.locator('#chatSendRecipient').inputValue(), '0x' + '2'.repeat(40));
    await page.locator('#chatSendButton').click();
    await page.locator('#multichainConfirmModal.is-transition-complete').waitFor();
    assert.ok((await page.locator('#multichainConfirmRows').textContent()).includes('0x' + '2'.repeat(40)));
    assert.equal((await page.locator('#multichainConfirmRows').textContent()).includes('Chat message toll'), false);
    await page.screenshot({ path: `${out}/confirm-${viewport.width}.png`, animations: 'disabled' });
    await page.locator('#multichainConfirmAction').click();
    await page.waitForFunction(() => document.querySelector('#multichainConfirmStatus').textContent.includes('Sent 0.25 SOL'));
    await page.evaluate(() => __fixture.reloadActivity());
    await page.waitForFunction(() => __fixture.state().transfers[0].verified === 'settled');
    const state = await page.evaluate(() => __fixture.state());
    assert.equal(state.publishes, 1);
    assert.equal(state.transfers.length, 1);
    assert.equal(Object.keys(state.contacts).length, 0);
    assert.equal((state.pending || []).length, 0);
    await page.locator('#multichainConfirmAction').click();
    await page.waitForFunction(() => !document.querySelector('#multichainConfirmModal').classList.contains('active'));
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `${out}/activity-${viewport.width}.png`, animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}px: typed address, username, real QR upload decode, simulated camera, confirmation, single publish, saved Activity verification`);
    await context.close();
  }
} finally { await browser?.close(); server.close(); }
