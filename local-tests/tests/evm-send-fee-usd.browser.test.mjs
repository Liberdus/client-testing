import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = index.indexOf('      <!-- Send Asset Confirmation Modal -->');
const end = index.indexOf('      <!-- Remove Account Modal -->', start);
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>${index.slice(start, end)}</body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, locale: 'en-US' });
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith('http://127.0.0.1:8765/')) {
      externalRequests.push(url);
      return route.abort();
    }
    if (url.endsWith('/tests/fee-preview')) return route.fulfill({ contentType: 'text/html', body: html });
    return route.continue();
  });
  await page.goto('http://127.0.0.1:8765/tests/fee-preview');
  await page.evaluate(async () => {
    const { EvmSendConfirmationModal, EvmTransactionService } = await import('/evm-assets.js');
    const { installModalTransitionListeners } = await import('/lib.js');
    installModalTransitionListeners();
    window.confirmation = new EvmSendConfirmationModal();
    confirmation.load();
    confirmation.load();
    window.rpcCalls = 0;
    window.service = new EvmTransactionService({ confirmTransfer: (...args) => confirmation.confirm(...args) });
    service.request = async () => { window.rpcCalls++; throw Error('Unexpected RPC'); };
    window.preview = (options = {}) => {
      const networkId = options.networkId || 'bsc';
      const chainId = networkId === 'bsc' ? 56 : 1;
      const symbol = networkId === 'bsc' ? 'BNB' : 'ETH';
      const native = { networkId, chainId, tokenType: 'native', contractAddress: null,
        tokenSymbol: symbol, tokenName: symbol, tokenPriceUsd: '600' };
      if (Object.hasOwn(options, 'nativePrice')) native.tokenPriceUsd = options.nativePrice;
      const asset = options.token ? { ...native, tokenType: 'erc20', contractAddress: `0x${'b'.repeat(40)}`,
        tokenSymbol: 'USDT', tokenName: 'Tether', tokenPriceUsd: '1' } : { ...native };
      if (Object.hasOwn(options, 'tokenPrice')) asset.tokenPriceUsd = options.tokenPrice;
      const network = { id: networkId, chainId, name: networkId === 'bsc' ? 'BNB Smart Chain' : 'Ethereum',
        nativeSymbol: symbol, assets: options.missingNative ? [asset].filter(a => a.contractAddress) : [native] };
      if (options.wrongNetwork) network.assets.unshift({ ...native, networkId: 'wrong', chainId: 999, tokenPriceUsd: '99999' });
      const prepared = { network, asset, validation: { recipient: `0x${'a'.repeat(40)}` },
        maximumFee: BigInt(options.maximumFee || '100000000000000'), displayAmount: '10' };
      prepared.duplicatePaymentWarning = options.warning;
      service.prepare = async () => prepared;
      window.result = service.send({ network, asset, amount: '10', chat: options.chat || null });
    };
  });
  async function preview(options) {
    await page.evaluate(options => window.preview(options), options);
    await page.locator('#sendAssetConfirmModal.is-transition-complete').waitFor();
  }
  async function cancel() {
    await page.locator('#cancelSendButton').click();
    assert.deepEqual(await page.evaluate(() => window.result), { status: 'cancelled', transactionHash: null });
    assert.equal(await page.locator('#confirmAmountUSD').evaluate(e => e.style.display), '');
    assert.equal(await page.locator('#evmConfirmFeeGroup').isVisible(), false);
  }
  await preview({ token: true, wrongNetwork: true });
  assert.equal(await page.locator('#confirmAmountUSD').textContent(), '≈ $10.00');
  assert.equal(await page.locator('#evmConfirmFee').textContent(), '0.0001 BNB');
  assert.equal(await page.locator('#evmConfirmFeeUSD').textContent(), '≈ $0.06');
  assert.equal(await page.locator('#evmConfirmFeeUSD').count(), 1);
  const amountBox = await page.locator('#confirmAmount').boundingBox();
  const amountEstimate = await page.locator('#confirmAmountUSD').boundingBox();
  const assetBox = await page.locator('#confirmAsset').boundingBox();
  assert.ok(amountEstimate.y >= amountBox.y + amountBox.height);
  assert.ok(amountEstimate.y + amountEstimate.height < assetBox.y);
  await page.screenshot({ path: '/tmp/evm-fee-usd-desktop.png', fullPage: true });
  await cancel();

  for (const options of [
    { token: true, tokenPrice: null }, { token: true, nativePrice: null },
    { token: true, tokenPrice: null, nativePrice: null }, { token: true, missingNative: true },
    { token: true, nativePrice: 'bad' },
  ]) {
    await preview(options);
    assert.equal(await page.locator('#evmConfirmFee').textContent(), '0.0001 BNB');
    assert.equal(await page.locator('#confirmSendButton').isEnabled(), true);
    assert.equal(await page.locator('#confirmAmountUSD').evaluate(e => e.style.display !== 'none'), options.tokenPrice !== null);
    const feeAvailable = !Object.hasOwn(options, 'nativePrice') && !options.missingNative;
    assert.equal(await page.locator('#evmConfirmFeeUSD').isVisible(), feeAvailable);
    await cancel();
  }
  await preview({ networkId: 'ethereum', nativePrice: '3000' });
  assert.equal(await page.locator('#evmConfirmFee').textContent(), '0.0001 ETH');
  assert.equal(await page.locator('#evmConfirmFeeUSD').textContent(), '≈ $0.30');
  await page.locator('#closeSendAssetConfirmModal').click();
  assert.equal((await page.evaluate(() => window.result)).status, 'cancelled');

  await page.setViewportSize({ width: 390, height: 844 });
  await preview({ maximumFee: '1000000000000' });
  assert.equal(await page.locator('#evmConfirmFeeUSD').textContent(), '≈ $0.0006');
  await page.locator('#evmConfirmFeeUSD').scrollIntoViewIfNeeded();
  const fee = await page.locator('#evmConfirmFee').boundingBox();
  const estimate = await page.locator('#evmConfirmFeeUSD').boundingBox();
  const notice = await page.locator('#evmConfirmSigningNotice').boundingBox();
  assert.ok(estimate.y >= fee.y + fee.height);
  assert.ok(estimate.x >= 0 && estimate.x + estimate.width <= 390);
  assert.ok(notice.y >= estimate.y + estimate.height);
  await page.screenshot({ path: '/tmp/evm-fee-usd-mobile.png', fullPage: true });
  await cancel();

  await preview({ token: true, chat: { totalRequired: '1000000000000000000', note: 'Lunch\nThanks <3' }, warning: 'An earlier payment is still pending.' });
  assert.equal(await page.locator('#confirmMemo').textContent(), 'Lunch\nThanks <3');
  assert.equal(await page.locator('#confirmMemoGroup').isVisible(), true);
  assert.equal(await page.locator('#evmConfirmFeeUSD').textContent(), '≈ $0.06');
  assert.match(await page.locator('#evmConfirmSigningNotice').textContent(), /1 LIB/);
  assert.match(await page.locator('#evmConfirmSigningNotice').textContent(), /An earlier payment is still pending/);
  await page.screenshot({ path: '/tmp/evm-fee-usd-with-note.png', fullPage: true });
  await cancel();

  await preview({ tokenPrice: null });
  await page.evaluate(() => confirmation.modal.classList.remove('active'));
  assert.equal((await page.evaluate(() => window.result)).status, 'cancelled');
  assert.equal(await page.locator('#confirmMemo').textContent(), '');
  assert.equal(await page.locator('#confirmAmountUSD').evaluate(e => e.style.display), '');
  assert.equal(await page.evaluate(() => window.rpcCalls), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: real confirmation DOM/CSS at desktop/mobile; native/ERC-20, missing/invalid prices, chain switch, small fees, repeat load, Cancel/close/dismiss, shared visibility, notes, LIB costs, and duplicate warnings. Mocked preparation; zero broadcast RPC calls.');
  console.log(`External resource requests during page load: ${externalRequests.length}`);
} finally {
  await browser.close();
}
