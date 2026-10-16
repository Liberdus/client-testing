import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The runner overlays the chosen client, including mock/, into this directory.
// The mock is entirely synthetic: never load app.js or permit external services.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname}`);
    assert.ok(path.startsWith(root + sep));
    const contents = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    response.end(contents);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let cases = 0;
const failures = [];
const errors = [];
const prohibitedRequests = [];
async function check(name, run) {
  cases++;
  try {
    await run();
    console.log(`ok ${cases} - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok ${cases} - ${name}\n${error.stack}`);
  }
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const request = route.request();
    if (request.url().startsWith(origin + '/') && request.method() === 'GET' && !new URL(request.url()).pathname.endsWith('/app.js')) return route.continue();
    prohibitedRequests.push(`${request.method()} ${request.url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/mock/index.html?tab=wallet`);
  await page.waitForFunction(() => {
    const screens = [...document.querySelectorAll('.screen[data-app-modal]')];
    return screens.length > 80 && screens.every(screen => screen.querySelector('iframe')?.contentDocument?.body?.children.length);
  });
  const frame = (scope, id) => page.frameLocator(`${scope} .screen[data-app-modal="${id}"] iframe`);
  const lib = id => frame('[data-wallet-type="lib"]', id);
  const evm = id => page.frameLocator(`[data-wallet-type="evm"] .screen[data-app-modal="${id}"]:not([data-wallet-recipient="address"]) iframe`);
  const multichain = id => frame('[data-wallet-type="multichain"]', id);
  const text = async (preview, selector) => (await preview.locator(selector).textContent()).trim();
  const activate = async name => {
    await page.locator('[data-zoom-reset]').click();
    await page.locator(`[data-showcase-tab="${name}"]`).click();
  };

  await check('all production modal previews mount without missing fixture hooks', async () => {
    assert.deepEqual(errors, []);
    const result = await page.evaluate(async () => {
      const production = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
      return {
        production: [...production.querySelectorAll('.modal[id]')].map(modal => modal.id).sort(),
        catalog: window.MODAL_CATALOG.map(entry => entry.id).sort(),
        missingFrames: window.MODAL_CATALOG.filter(entry => ![...document.querySelectorAll(`.screen[data-app-modal="${entry.id}"] iframe`)].some(frame => frame.contentDocument?.getElementById(entry.id))).map(entry => entry.id),
        staleStyles: [...document.querySelectorAll('.device-frame')].filter(frame => ![...frame.contentDocument.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === new URL('../styles.css', location.href).href)).map(frame => frame.title),
      };
    });
    assert.deepEqual(result.catalog, result.production);
    assert.deepEqual(result.missingFrames, []);
    assert.deepEqual(result.staleStyles, []);
    assert.equal(await page.locator('[data-showcase-panel="wallet"]').getAttribute('hidden'), null, 'The tab query parameter selects Wallet');
  });

  await check('wallet uses current LIB holdings and separate EVM and multichain summaries', async () => {
    const wallet = lib('walletScreen');
    assert.equal(await text(wallet, '#evmAssetsSummaryValue'), '$750.00');
    assert.equal(await text(wallet, '#multichainSummaryValue'), '$275.00');
    assert.match(await text(wallet, '#assetsList .asset-balance'), /295\.120000\s*\$248\.420803/);
    assert.equal(await wallet.locator('#assetsList .asset-item').count(), 1);
    assert.equal(await wallet.locator('#assetsList .asset-item #refreshBalance').count(), 1);
    assert.equal(await wallet.locator('#walletTotalBalance').count(), 0, 'Current main does not use the old combined wallet total');
    const assets = evm('assetsModal');
    assert.equal(await text(assets, '#assetsTotalBalance'), '750.00');
    assert.match(await text(assets, '#connectedAssetsList'), /0\.25 ETH[\s\S]*\$750\.00/);
    assert.match(await text(assets, '#evmPaymentRecoveryList'), /Retry message/);
    assert.equal(await assets.locator('#evmPaymentRecovery').getAttribute('hidden'), null);
  });

  await check('LIB send, receive, and confirmation preserve populated form state inside frames', async () => {
    const send = lib('sendAssetFormModal');
    assert.equal(await send.locator('#sendToAddress').inputValue(), 'ari');
    assert.equal(await send.locator('#sendAmount').inputValue(), '10');
    assert.equal(await send.locator('#sendMemo').inputValue(), 'Dinner share');
    assert.equal(await text(send, '#balanceSymbol'), 'LIB');
    assert.equal(await text(send, '#balanceAmount'), '295.120000 LIB');
    assert.equal(await send.locator('#sendNetworkGroup').count(), 0);
    const confirm = lib('sendAssetConfirmModal');
    assert.equal(await text(confirm, '#confirmRecipient'), 'ari');
    assert.equal(await text(confirm, '#confirmAmount'), '10');
    assert.equal(await text(confirm, '#confirmAsset'), 'LIB');
    assert.equal(await text(confirm, '#confirmAmountUSD'), '≈ $8.417620 USD');
    assert.equal(await text(confirm, '#confirmMemo'), 'Dinner share');
    const receive = lib('receiveModal');
    assert.equal(await text(receive, '#receiveBalanceSymbol'), 'LIB');
    assert.equal(await receive.locator('#receiveAmount').inputValue(), '10');
    assert.equal(await receive.locator('#receiveMemo').inputValue(), 'Dinner share');
    assert.match(await text(receive, '#displayAddress'), /^0x1{40}$/);
    assert.equal(await receive.locator('#qrcode img[alt="Illustrative QR code, not a payment address"]').count(), 1);
  });

  await check('EVM gallery uses dedicated transfer forms and current contact-payment confirmation', async () => {
    for (const id of ['sendAssetFormModal', 'sendAssetConfirmModal', 'receiveModal']) {
      assert.equal(await page.locator(`[data-wallet-type="evm"] .screen[data-app-modal="${id}"]`).count(), 0, 'EVM must not clone a LIB form');
    }
    const send = evm('evmSendModal');
    assert.equal(await send.locator('#evmSendRecipient').inputValue(), 'ari');
    assert.equal(await send.locator('#evmSendAmount').inputValue(), '0.01');
    assert.equal(await send.locator('#evmSendMemo').inputValue(), 'Dinner share');
    assert.equal(await text(send, '#evmSendSymbol'), 'ETH');
    assert.match(await text(send, '#evmSendRecipientStatus'), /Contact found/);
    const confirm = evm('evmSendConfirmModal');
    assert.equal(await text(confirm, '#evmConfirmRecipient'), 'ari');
    assert.equal(await text(confirm, '#evmConfirmAmount'), '0.01 ETH');
    assert.equal(await text(confirm, '#evmConfirmAmountUSD'), '≈ $30.00');
    assert.equal(await text(confirm, '#evmConfirmNetwork'), 'Ethereum (Chain ID 1)');
    assert.equal(await text(confirm, '#evmConfirmFee'), '0.0001 ETH');
    assert.equal(await text(confirm, '#evmConfirmFeeUSD'), '≈ $0.30');
    assert.match(await text(confirm, '#evmConfirmSigningNotice'), /Message fee and toll: 0\.001 LIB/);
    const receive = evm('evmReceiveModal');
    assert.match(await text(receive, '#evmReceiveAddress'), /^0x1{40}$/);
    assert.equal(await receive.locator('#evmReceiveAmount').inputValue(), '0.01');
    assert.equal(await text(receive, '#evmReceiveSymbol'), 'ETH');
    assert.equal(await receive.locator('#evmReceiveQRCode img').getAttribute('width'), '200');
    assert.equal(await receive.locator('#evmReceiveQRCode img').getAttribute('height'), '200');
  });

  await check('direct-address EVM transfers omit contact notes and chat fees', async () => {
    const send = page.frameLocator('[data-wallet-type="evm"] .screen[data-app-modal="evmSendModal"][data-wallet-recipient="address"] iframe');
    assert.match(await send.locator('#evmSendRecipient').inputValue(), /^0x1{40}$/);
    assert.match(await text(send, '#evmSendRecipientStatus'), /Valid address/);
    assert.equal(await send.locator('#evmSendMemoGroup').getAttribute('hidden'), '');
    const confirm = page.frameLocator('[data-wallet-type="evm"] .screen[data-app-modal="evmSendConfirmModal"][data-wallet-recipient="address"] iframe');
    assert.match(await text(confirm, '#evmConfirmRecipient'), /^0x1{40}$/);
    assert.equal(await text(confirm, '#evmConfirmAmount'), '0.01 ETH');
    assert.equal(await confirm.locator('#evmConfirmMemoGroup').evaluate(element => getComputedStyle(element).display), 'none');
    assert.match(await text(confirm, '#evmConfirmSigningNotice'), /Wallet transfer only; no chat message/);
    assert.doesNotMatch(await text(confirm, '#evmConfirmSigningNotice'), /fee and toll/);
  });

  await check('multichain previews retain holdings, quote, and guaranteed swap details', async () => {
    const overview = multichain('multichainModal');
    assert.equal(await text(overview, '#multichainTotalBalance'), '$275.00');
    assert.equal(await overview.locator('#multichainAssetsList .multichain-asset-button').count(), 3);
    const swap = multichain('multichainSwapModal');
    assert.equal(await swap.locator('#multichainSwapAmount').inputValue(), '25');
    assert.equal(await text(swap, '#multichainSwapOut'), '0.165');
    assert.equal(await swap.locator('#multichainSwapPreview').isEnabled(), true);
    const confirm = multichain('multichainConfirmModal');
    assert.match(await text(confirm, '#multichainConfirmRows'), /Guaranteed at least0\.164 SOL/);
    assert.equal(await text(confirm, '#multichainConfirmAction'), 'Swap USDC');
  });

  await check('wallet category controls isolate the selected preview group', async () => {
    for (const type of ['evm', 'multichain', 'lib']) {
      await page.locator(`[data-wallet-filter="${type}"]`).click();
      assert.equal(await page.locator(`[data-wallet-filter="${type}"]`).getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await page.locator('[data-wallet-type]:not([hidden])').evaluateAll(sections => sections.map(section => section.dataset.walletType)), [type]);
      assert.match(await page.locator('[data-wallet-filter-status]').textContent(), /\d+ previews/);
    }
    await page.locator('[data-wallet-filter="all"]').click();
    assert.equal(await page.locator('[data-wallet-type]:not([hidden])').count(), 3);
  });

  await check('DAO phone previews retain current navigation inside the scroll pane', async () => {
    const states = await page.locator('.screen[data-app-modal="daoModal"] iframe').evaluateAll(frames => frames.map(frame => {
      const doc = frame.contentDocument;
      return {
        title: doc.querySelector('#daoModal .modal-title')?.textContent.trim(),
        toolbarInPane: !!doc.querySelector('.dao-list-pane > .dao-toolbar'),
        contexts: [...doc.querySelectorAll('[data-dao-context]')].map(button => [button.dataset.daoContext, button.getAttribute('aria-pressed')]),
        contextFilters: [...doc.querySelectorAll('[data-dao-filters]')].map(group => ({ context: group.dataset.daoFilters, inert: group.inert, hidden: group.getAttribute('aria-hidden') === 'true' })),
        filters: [...doc.querySelectorAll('.dao-filter-chip')].map(button => ({ key: button.dataset.filterKey, pressed: button.getAttribute('aria-pressed'), count: button.querySelector('.dao-filter-chip-count')?.textContent.trim() })),
      };
    }));
    assert.ok(states.length >= 3, 'Include a focused project-list preview');
    for (const state of states) {
      assert.equal(state.title, 'DAO');
      assert.equal(state.toolbarInPane, true);
      assert.deepEqual(state.contexts.map(([context]) => context), ['proposals', 'projects']);
      assert.equal(state.contexts.filter(([, pressed]) => pressed === 'true').length, 1);
      const activeContext = state.contexts.find(([, pressed]) => pressed === 'true')[0];
      for (const filters of state.contextFilters) {
        assert.equal(filters.inert, filters.context !== activeContext);
        assert.equal(filters.hidden, filters.context !== activeContext);
      }
      assert.equal(state.filters.filter(({ pressed }) => pressed === 'true').length, 1);
      for (const filter of state.filters) {
        assert.ok(filter.key);
        assert.match(filter.pressed, /^(true|false)$/);
        assert.match(filter.count, /^\d+$/);
      }
    }
    assert.ok(states.some(state => state.contexts.some(([context, pressed]) => context === 'projects' && pressed === 'true')));
  });

  await check('EVM chat filter displays all verification states with production payment cards', async () => {
    await activate('chat');
    await page.locator('[data-chat-filter="evm"]').click();
    assert.equal(await page.locator('[data-chat-filter="evm"]').getAttribute('aria-pressed'), 'true');
    const preview = page.frameLocator('[data-chat-gallery] .screen[data-chat-types="evm"] iframe');
    assert.equal(await preview.locator('.evm-payment-message').count(), 7);
    assert.deepEqual(await preview.locator('.evm-payment-message').evaluateAll(cards => cards.map(card => card.dataset.verified)), ['settled', 'settled', 'unchecked', 'pending', 'failed', 'expired', 'unverifiable']);
    assert.equal(await preview.locator('.evm-payment-message[data-verified="settled"] .intents-payment-verified').first().textContent(), 'Confirmed');
    assert.ok(await preview.locator('.message.sent .evm-payment-message').count());
    assert.ok(await preview.locator('.message.received .evm-payment-message').count());
    assert.equal(await preview.locator('[data-chat-message-types]:not([data-chat-message-types~="evm"])').count(), 0);
    const visibleTypes = await page.locator('[data-chat-gallery] .screen:not([hidden])').evaluateAll(screens => screens.map(screen => screen.dataset.chatTypes.split(' ')));
    assert.ok(visibleTypes.every(types => types.includes('evm')));
    const check = page.frameLocator('.screen[data-chat-overlay="evm-check"] iframe');
    assert.equal(await text(check, '[data-action="evm-check"]'), 'Check again');
    assert.equal(await check.locator('.evm-payment-message').getAttribute('data-verified'), 'pending');
    const retry = page.frameLocator('.screen[data-chat-overlay="evm-retry"] iframe');
    assert.equal(await text(retry, '[data-action="evm-review"]'), 'Retry transfer');
    assert.equal(await retry.locator('.evm-payment-message').getAttribute('data-verified'), 'failed');
  });

  await check('canvas zoom, toolbar keyboard movement, and drag-to-pan remain usable', async () => {
    await activate('dao');
    await page.locator('[data-zoom-in]').click();
    assert.equal(await page.locator('[data-zoom-reset]').textContent(), '112%');
    await page.locator('[data-zoom-out]').click();
    assert.equal(await page.locator('[data-zoom-reset]').textContent(), '100%');
    const toolbar = page.locator('.zoom-controls');
    const beforeToolbar = await toolbar.boundingBox();
    await page.locator('.zoom-drag-handle').focus();
    await page.keyboard.press('ArrowUp');
    const afterToolbar = await toolbar.boundingBox();
    assert.ok(afterToolbar.y < beforeToolbar.y, 'The zoom toolbar moves by keyboard');
    await page.keyboard.press('Home');
    const viewport = page.locator('[data-pan-viewport]');
    await viewport.evaluate(element => { element.scrollLeft = 400; element.scrollTop = 100; });
    const beforePan = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
    const point = await page.evaluate(() => {
      const viewport = document.querySelector('[data-pan-viewport]');
      for (let y = 80; y < innerHeight - 120; y += 35) {
        for (let x = 180; x < innerWidth - 120; x += 35) {
          const target = document.elementFromPoint(x, y);
          if (viewport.contains(target) && !target.closest('.screen, button, input, select, textarea, summary, [data-flow-source], .transition-connector, .zoom-controls')) return { x, y };
        }
      }
      throw Error('No empty canvas area available for dragging');
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x - 70, point.y - 40, { steps: 5 });
    await page.mouse.up();
    const afterPan = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
    assert.ok(afterPan.x > beforePan.x + 40 && afterPan.y > beforePan.y + 20, 'Dragging moves both canvas scroll axes');
    await page.locator('[data-zoom-reset]').click();
    assert.deepEqual(await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]), [0, 0]);
  });

  await check('mock stays offline and free of runtime exceptions', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(prohibitedRequests, []);
  });
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}

console.log(`Mock cases: ${cases}; passed: ${cases - failures.length}; failed: ${failures.length}`);
assert.deepEqual(failures, []);
