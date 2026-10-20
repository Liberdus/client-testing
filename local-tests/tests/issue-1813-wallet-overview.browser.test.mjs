import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root && isAbsolute(root), 'Set absolute WEB_CLIENT_ROOT');
const captureOnly = process.env.WALLET_CAPTURE_ONLY === '1';
const captureLabel = process.env.WALLET_CAPTURE_LABEL || 'after';
const output = '/tmp/wallet-overview-1813';
await mkdir(output, { recursive: true });

// Start the actual client with synthetic in-memory data. Nothing signs, sends,
// contacts an external service or loads a real account/profile.
const fixture = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
if (new URLSearchParams(location.search).has('mainnet')) network.name = 'Mainnet';
getNetworkParams = async () => parameters;
updateAssetPricesIfNeeded = async () => {};
window.__broadcasts = 0;
window.__signings = 0;
postAssetTransfer = async () => { window.__broadcasts++; throw Error('Fixture forbids broadcasting'); };
signObj = async () => { window.__signings++; throw Error('Fixture forbids signing'); };
let fixtureBalance = 3852338932000000000000n;
let fixtureBalanceFails = false;
queryNetwork = async (path) => {
  if (path.endsWith('/balance')) {
    window.__balanceQueries++;
    if (fixtureBalanceFails) throw Error('Synthetic balance failure');
    return { balance: fixtureBalance };
  }
  throw Error('Unexpected synthetic query: ' + path);
};
window.__fixture = {
  walletScreen, footer, sendAssetFormModal, receiveModal, historyModal,
  async configure() {
    parameters.current.stabilityFactorStr = '0.008';
    parameters.current.defaultTollUsdStr = '0';
    myAccount = { username: 'cmt1', keys: { address: 'a'.repeat(40) }, netid: network.netid };
    myData = newDataRecord(myAccount);
    const lib = walletScreen.getLibAsset();
    lib.price = 0.008;
    lib.balance = fixtureBalance;
    lib.addresses[0].balance = fixtureBalance;
    myData.wallet.balanceUpdatedAt = getCorrectedTimestamp() - 120000;
    myData.wallet.timestamp = getCorrectedTimestamp();
    window.__balanceQueries = 0;
    window.__calls = {};
    isOnline = true;
    walletScreen.firstTimeLoad = false;
    multichain.updateSummary = async () => {
      document.getElementById('multichainSummaryValue').textContent = '$0.00';
    };
    evmAssets.refresh = async () => {
      document.getElementById('evmAssetsSummaryValue').textContent = '$0.01';
      return [];
    };
    evmAssets.transactions.send = async () => { window.__signings++; throw Error('Fixture forbids EVM signing'); };
    evmAssets.transactions.broadcast = async () => { window.__broadcasts++; throw Error('Fixture forbids EVM broadcast'); };
    chatPaymentPanel.run = async () => { window.__signings++; throw Error('Fixture forbids multichain signing'); };
    welcomeScreen.close();
    header.open(); footer.open();
    header.setText('cmt1');
    await header.updateAvatar();
    chatsScreen.close(); contactsScreen.close();
    setFirstTimeTipShown('testnetWarning');
    walletScreen.open();
    footer.walletButton.classList.add('active');
    footer.newChatButton.classList.remove('visible');
    updateUIForConnectivity();
    await walletScreen.updateWalletView();
  },
  async setBalance(balance, price = '0.008') {
    const lib = walletScreen.getLibAsset();
    lib.balance = BigInt(balance);
    lib.addresses[0].balance = BigInt(balance);
    fixtureBalance = BigInt(balance);
    parameters.current.stabilityFactorStr = price;
    await walletScreen.updateWalletView();
  },
  async ageBalance(milliseconds) {
    myData.wallet.balanceUpdatedAt = getCorrectedTimestamp() - milliseconds;
    await walletScreen.updateWalletView();
  },
  prepareRefresh(fail = false) {
    fixtureBalanceFails = fail;
    isOnline = true;
    myData.wallet.timestamp = 0;
    updateUIForConnectivity();
  },
  setOffline() { isOnline = false; updateUIForConnectivity(); },
  installActionCounters() {
    const count = name => () => { window.__calls[name] = (window.__calls[name] || 0) + 1; };
    sendAssetFormModal.open = count('send');
    receiveModal.open = count('receive');
    historyModal.open = count('history');
    walletScreen.requestFromFaucet = async () => count('faucet')();
    bridgeModal.open = count('bridge');
    multichain.assetsModal.open = count('multichain');
    evmAssets.assetsModal.open = count('evm');
    window.open = url => { window.__calls[url] = (window.__calls[url] || 0) + 1; return null; };
  },
  data() { return { timestamp: myData.wallet.timestamp, balanceUpdatedAt: myData.wallet.balanceUpdatedAt }; },
};
`;
const source = await readFile(resolve(root, 'app.js'), 'utf8');
const app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(path.startsWith(root + sep));
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${server.address().port}`;
const measurements = [];

async function measureWallet(page, scenario) {
  const geometry = await page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector);
      const { x, y, width, height, top, right, bottom, left } = element.getBoundingClientRect();
      return { x, y, width, height, top, right, bottom, left, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    };
    const selectors = {
      title: '.wallet-heading h2', refresh: '#refreshBalance', updated: '#walletBalanceUpdated',
      card: '.wallet-native-balance', name: '#assetsList .asset-name', rate: '#assetsList .asset-symbol',
      info: '#assetsList .asset-info', balance: '#assetsList .asset-balance',
      quantity: '#assetsList .wallet-native-quantity', usd: '#assetsList .wallet-native-usd',
      actions: '.wallet-actions', trade: '.wallet-text-actions', other: '.wallet-assets',
    };
    return {
      boxes: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, rect(selector)])),
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      quantityFont: parseFloat(getComputedStyle(document.querySelector(selectors.quantity)).fontSize),
      usdFont: parseFloat(getComputedStyle(document.querySelector(selectors.usd)).fontSize),
      rateFont: parseFloat(getComputedStyle(document.querySelector(selectors.rate)).fontSize),
      updatedFont: parseFloat(getComputedStyle(document.querySelector(selectors.updated)).fontSize),
      controls: [...document.querySelectorAll('#walletScreen button')].map(element => {
        const { width, height, left, right } = element.getBoundingClientRect();
        return { id: element.id, width, height, left, right };
      }),
    };
  });
  const { boxes } = geometry;
  if (scenario.endsWith('-long')) {
    await page.screenshot({ path: `${output}/${scenario}.png`, fullPage: true, animations: 'disabled' });
    await writeFile(`${output}/${scenario}-geometry.json`, JSON.stringify(geometry, null, 2));
  }
  const center = box => box.top + box.height / 2;
  assert.ok(Math.abs(center(boxes.title) - center(boxes.refresh)) <= 2, `${scenario}: refresh aligns with Wallet`);
  assert.ok(boxes.updated.top >= boxes.refresh.bottom - 1, `${scenario}: timestamp is beneath refresh`);
  assert.ok(boxes.card.top - boxes.updated.bottom <= 20, `${scenario}: timestamp leaves a compact card gap`);
  assert.ok(boxes.name.bottom <= boxes.rate.top + 1, `${scenario}: unit rate is beneath Liberdus`);
  assert.ok(boxes.quantity.bottom <= boxes.usd.top + 1, `${scenario}: LIB quantity is above USD`);
  const separateColumns = boxes.info.right <= boxes.balance.left + 1;
  const separateRows = boxes.info.bottom <= boxes.balance.top + 1;
  assert.ok(separateColumns || separateRows, `${scenario}: token details do not overlap balance`);
  if (!scenario.endsWith('-long')) {
    assert.ok(separateColumns && boxes.info.top < boxes.balance.bottom && boxes.balance.top < boxes.info.bottom, `${scenario}: token details and amounts share a row`);
  }
  assert.ok(geometry.quantityFont < geometry.usdFont, `${scenario}: LIB balance is smaller than dollars`);
  assert.ok(geometry.rateFont <= 12 && geometry.updatedFont <= 12, `${scenario}: quote and timestamp are compact`);
  assert.ok(boxes.actions.top >= boxes.card.bottom, `${scenario}: native actions follow native card`);
  assert.ok(boxes.trade.top >= boxes.actions.bottom, `${scenario}: trade links follow native actions`);
  assert.ok(boxes.other.top >= boxes.trade.bottom, `${scenario}: Other assets follows native actions and links`);
  for (const name of ['name', 'rate', 'quantity', 'usd']) {
    const box = boxes[name];
    assert.ok(box.left >= boxes.card.left && box.right <= boxes.card.right + 1, `${scenario}: ${name} remains inside native card`);
    assert.ok(box.scrollWidth <= box.clientWidth + 1, `${scenario}: ${name} does not clip its text`);
  }
  assert.ok(geometry.documentWidth <= geometry.width, `${scenario}: no horizontal page overflow`);
  for (const control of geometry.controls) {
    assert.ok(control.width >= 43 && control.height >= 43, `${scenario}: ${control.id} has a touch-size target`);
    assert.ok(control.left >= 0 && control.right <= geometry.width, `${scenario}: ${control.id} stays inside viewport`);
  }
  measurements.push({ scenario, ...geometry });
}

async function verifyInteractions(page) {
  await page.evaluate(() => { __fixture.installActionCounters(); __fixture.prepareRefresh(); });
  await page.locator('#refreshBalance').click();
  await page.waitForFunction(() => window.__balanceQueries === 1);
  await page.waitForFunction(() => /just now/.test(document.querySelector('#walletBalanceUpdated').textContent));
  const refreshed = await page.evaluate(() => __fixture.data().balanceUpdatedAt);
  assert.ok(refreshed > 0);
  assert.equal(await page.locator('#walletBalanceUpdated').getAttribute('datetime'), new Date(refreshed).toISOString());

  const keyboardOrder = ['openSendAssetFormModal', 'openReceiveModal', 'openHistoryModal', 'openFaucetBridgeButton',
    'openBuyButton', 'openSellButton', 'multichainSummary', 'evmAssetsSummary'];
  // Redrawing balances must not replace action controls or duplicate listeners.
  await page.evaluate(async () => {
    await __fixture.walletScreen.updateWalletView();
    await __fixture.walletScreen.updateWalletView();
  });
  await page.locator('#openSendAssetFormModal').focus();
  for (const id of keyboardOrder) {
    assert.equal(await page.evaluate(() => document.activeElement.id), id, `${id} follows native keyboard order`);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
  }
  assert.deepEqual(await page.evaluate(() => window.__calls), {
    send: 1, receive: 1, history: 1, faucet: 1,
    'https://liberdus.com/buy': 1, 'https://liberdus.com/sell': 1, multichain: 1, evm: 1,
  });
  for (const id of ['openBuyButton', 'openSellButton']) {
    assert.equal(await page.locator(`#${id}`).evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', `${id} looks like a link`);
  }
  await page.evaluate(() => document.querySelector('#openHistoryModal').classList.add('has-notification'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#openHistoryModal'), '::after').opacity === '1');
  await page.locator('#switchToContacts').click();
  await page.waitForFunction(() => document.querySelector('#contactsScreen').classList.contains('active'));
  assert.equal(await page.evaluate(() => __fixture.walletScreen.balanceUpdatedTimer), null, 'Leaving wallet stops timestamp timer');
  await page.evaluate(() => __fixture.setOffline());
  assert.equal(await page.locator('#offlineIndicator').isVisible(), true, 'Other screens retain Offline indicator');
  await page.locator('#switchToWallet').click();
  await page.waitForFunction(() => document.querySelector('#walletScreen').classList.contains('active'));
  assert.equal(await page.locator('#offlineIndicator').isVisible(), false, 'Returning to wallet hides Offline indicator');
  assert.equal(await page.evaluate(() => __fixture.walletScreen.balanceUpdatedTimer !== null), true, 'Returning to wallet restarts timestamp timer');
  assert.equal(await page.locator('#switchToWallet').evaluate(element => element.classList.contains('active')), true);
}

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const viewports = [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1100, height: 1000 }];
  for (const viewport of viewports) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.width < 600, hasTouch: viewport.width < 600, reducedMotion: 'reduce',
        locale: 'en-US', timezoneId: 'America/Chicago', colorScheme, serviceWorkers: 'block' });
      const external = [], errors = [];
      await context.route('**/*', route => {
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
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#switchToWallet').waitFor({ state: 'visible' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // Let fixed mobile navigation finish painting before taking a viewport capture.
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${output}/${captureLabel}-${viewport.name}-${colorScheme}.png`, animations: 'disabled' });
      assert.match(await page.locator('#assetsList').innerText(), /3852[.,]338932|3,852[.]338932/);
      assert.equal(await page.locator('#multichainSummaryValue').textContent(), '$0.00');
      assert.equal(await page.locator('#evmAssetsSummaryValue').textContent(), '$0.01');
      if (!captureOnly) {
        await page.evaluate(() => __fixture.setOffline());
        assert.equal(await page.locator('#offlineIndicator').isVisible(), false, 'Wallet hides Offline indicator');
        assert.match(await page.locator('#assetsList .asset-symbol').textContent(), /1 LIB = \$0\.008/);
        assert.equal(await page.locator('#assetsList .wallet-native-usd').textContent(), '$30.82');
        assert.equal(await page.locator('.wallet-assets .section-title').textContent(), 'Other assets');
        assert.equal(await page.locator('#openBuyButton').getAttribute('aria-label'), 'Buy LIB (opens in a new tab)');
        assert.equal(await page.locator('#openSellButton').getAttribute('aria-label'), 'Sell LIB (opens in a new tab)');
        assert.deepEqual(await page.locator('#walletScreen .wallet-actions .action-label').allTextContents(), ['Send', 'Receive', 'History', 'Faucet']);
        const icons = await page.locator('.wallet-asset-group-icon').evaluateAll(elements => elements.map(element => {
          const style = getComputedStyle(element, '::before');
          return [style.maskImage, style.backgroundImage];
        }));
        assert.equal(icons.length, 2);
        assert.match(icons[0][0], /^url\("data:image\/svg\+xml/, 'Shared asset icon has a real SVG mask');
        assert.deepEqual(icons[0], icons[1], 'External asset groups share the same icon');
        await measureWallet(page, `${viewport.name}-${colorScheme}`);
        await page.evaluate(() => __fixture.walletScreen.stopBalanceUpdatedTimer());
        await page.clock.install();
        await page.evaluate(() => __fixture.walletScreen.startBalanceUpdatedTimer());
        await page.evaluate(() => __fixture.ageBalance(120000));
        assert.match(await page.locator('#walletBalanceUpdated').textContent(), /2m ago/);
        await page.clock.fastForward(61000);
        assert.match(await page.locator('#walletBalanceUpdated').textContent(), /3m ago/, 'Relative timestamp ages while wallet stays open');
        await verifyInteractions(page);
        await page.evaluate(() => __fixture.setOffline());
        await page.evaluate(() => __fixture.setBalance('0'));
        assert.equal(await page.locator('#assetsList .wallet-native-usd').textContent(), '$0.00');
        await measureWallet(page, `${viewport.name}-${colorScheme}-zero`);
        await page.evaluate(() => __fixture.setBalance('3852338932000000000000', null));
        assert.match(await page.locator('#assetsList .asset-symbol').textContent(), /N\/A|unavailable/i);
        assert.match(await page.locator('#assetsList .wallet-native-usd').textContent(), /N\/A|unavailable/i);
        await measureWallet(page, `${viewport.name}-${colorScheme}-missing-price`);
        await page.evaluate(() => __fixture.setBalance('123456789012345123456000000000000'));
        await measureWallet(page, `${viewport.name}-${colorScheme}-long`);
        if (viewport.name === 'mobile') {
          await page.setViewportSize({ width: 320, height: 844 });
          await measureWallet(page, `320-${colorScheme}-long`);
          await page.evaluate(() => __fixture.setBalance('3852338932000000000000'));
          await measureWallet(page, `320-${colorScheme}`);
          await page.setViewportSize({ width: 375, height: 844 });
          await measureWallet(page, `375-${colorScheme}`);
        }
        if (viewport.name === 'desktop' && colorScheme === 'light') {
          await page.goto(origin + '/?mainnet');
          await page.waitForFunction(() => window.__fixtureReady === true);
          await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
          await page.evaluate(async () => { await __fixture.configure(); __fixture.installActionCounters(); __fixture.prepareRefresh(); });
          assert.equal(await page.locator('#openFaucetBridgeButton .action-label').textContent(), 'Bridge');
          await page.locator('#openFaucetBridgeButton').click();
          assert.deepEqual(await page.evaluate(() => window.__calls), { bridge: 1 });
        }
      }
      assert.equal(await page.evaluate(() => window.__signings), 0);
      assert.equal(await page.evaluate(() => window.__broadcasts), 0);
      assert.deepEqual(external, [], 'No external requests');
      assert.deepEqual(errors, [], 'No uncaught client errors');
      console.log(`PASS ${captureLabel} ${viewport.name} ${colorScheme}: ${captureOnly ? 'actual client capture' : 'wallet geometry, amounts, timestamp aging/lifecycle, keyboard actions, navigation and responsive fallback'}; zero signing/broadcast/external requests`);
      await context.close();
    }
  }
  await writeFile(`${output}/${captureLabel}-geometry.json`, JSON.stringify(measurements, null, 2));
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
