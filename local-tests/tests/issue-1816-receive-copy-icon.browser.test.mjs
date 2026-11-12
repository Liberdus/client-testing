import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const modal = index.match(/<div class="modal fixed-header" id="multichainReceiveModal">[\s\S]*?(?=\s*<div class="modal fixed-header")/)[0];
const address = `u1${'abcdefghjkmnpqrstuvwxyz23456789'.repeat(7)}`;
const memo = '12345678901234567890';
const fixture = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Receive copy control regression</title><link rel="stylesheet" href="/styles.css">
  <script src="/external/qr.js"></script><div class="container">${modal}</div>
  <script type="module">
    import { multichain } from '/near-assets.js';
    // Render the real receive screen without opening a wallet or requesting a deposit address.
    multichain.receiveModal.load();
    multichain.receiveModal.modal.classList.add('active');
    document.getElementById('multichainReceiveTitle').textContent = 'Receive ZEC';
    window.renderReceive = () => multichain.receiveModal.render({
      address: ${JSON.stringify(address)}, memo: ${JSON.stringify(memo)},
      chain: 'zec:mainnet', chainName: 'Zcash', assetName: 'ZEC', siblings: 0,
    }, { tokenSymbol: 'ZEC', assetId: 'synthetic-zec' });
    renderReceive();
    window.fixtureReady = true;
  </script>`;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const external = [];
const errors = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture);
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    assert.ok(path.startsWith(root + sep));
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 320]) {
    const colorScheme = width === 320 ? 'dark' : 'light';
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady);
    const addressButton = page.getByRole('button', { name: `Copy address ${address}`, exact: true });
    const memoButton = page.getByRole('button', { name: `Copy memo ${memo}`, exact: true });
    const copyLabels = page.locator('.multichain-address-copy');
    await page.screenshot({ path: `/tmp/issue-1816-receive-copy-${width}-initial.png`, fullPage: true });
    const assertIcons = async () => {
      for (const label of await copyLabels.all()) {
        assert.equal(await label.innerText(), '', 'idle controls show an icon rather than Copy text');
        const icon = await label.evaluate(element => {
          const style = getComputedStyle(element, '::before');
          const box = element.getBoundingClientRect();
          return { content: style.content, background: style.backgroundImage, width: parseFloat(style.width), height: parseFloat(style.height), boxWidth: box.width, boxHeight: box.height };
        });
        assert.ok(icon.content !== 'none' && icon.background !== 'none', JSON.stringify(icon));
        assert.ok(icon.width > 0 && icon.height > 0 && icon.boxWidth > 0 && icon.boxHeight > 0, 'copy icon occupies visible space');
      }
    };
    await assertIcons();
    const shown = await addressButton.locator('.multichain-address-value').innerText();
    assert.notEqual(shown, address, 'long addresses retain their shortened display');
    assert.ok(shown.startsWith(address.slice(0, 10)) && shown.endsWith(address.slice(-8)));
    await addressButton.locator('.multichain-address-value').click();
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address, 'clicking the value copies the full address');
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === '');
    await assertIcons();
    await page.evaluate(() => navigator.clipboard.writeText('Before Space activation'));
    await addressButton.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address);
    await memoButton.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.multichain-address-copy')[1].textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), memo, 'keyboard activation copies the full memo');

    await page.evaluate(() => {
      renderReceive();
      window.clipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async () => { throw new DOMException('Synthetic clipboard denial', 'NotAllowedError'); };
    });
    await addressButton.click();
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === 'Press and hold to copy');
    assert.equal(await addressButton.getAttribute('aria-label'), `Copy address ${address}`);
    await page.evaluate(() => { navigator.clipboard.writeText = clipboardWrite; });
    await addressButton.press('Enter');
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address, 'clipboard failures remain retryable');
    await page.waitForFunction(() => document.querySelector('.multichain-address-copy').textContent === '');
    await assertIcons();
    const layout = await page.locator('.multichain-address').evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      const value = button.querySelector('.multichain-address-value').getBoundingClientRect();
      return { left: box.left, right: box.right, client: button.clientWidth, scroll: button.scrollWidth, valueWidth: value.width };
    }));
    assert.ok(layout.every(box => box.left >= 0 && box.right <= width && box.scroll <= box.client + 1 && box.valueWidth > 0), JSON.stringify(layout));
    await page.screenshot({ path: `/tmp/issue-1816-receive-copy-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS receive copy icons, full values, keyboard, feedback, retry and layout at ${width}px (${colorScheme} preference)`);
  }
  assert.deepEqual(external, [], 'receive regression stays offline');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
