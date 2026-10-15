import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf("                } else if (parsedMessage.type === 'edit') {");
const end = source.indexOf("                } else if (parsedMessage.type === 'call') {", start);
assert.ok(start >= 0 && end > start);
const incoming = source.slice(start, end).replace(/^\s*} else if \(parsedMessage.type === 'edit'\) \{/, '');
const fixture = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => parameters;
queryNetwork = async () => ({ toll: { required: [0, 0], payOnRead: [0n, 0n], payOnReply: [0n, 0n] } });
updateAssetPricesIfNeeded = async () => {};
verifyVisibleChatPayments = async () => {};
checkEvmPayments = async () => {};
validateBalance = async () => true;
saveState = () => sessionStorage.setItem('evm-note-edit-state', stringify(myData));
isOnline = false;
window.__fixture = {
  chatModal,
  get data() { return myData; },
  controls: [], assetCalls: [], outcome: 'success',
  async configure() {
    const owner = 'a'.repeat(40), peer = 'b'.repeat(40);
    myAccount = { username: 'sender', keys: { address: owner }, netid: network.netid };
    parameters.current.defaultTollUsdStr = '0';
    const saved = sessionStorage.getItem('evm-note-edit-state');
    myData = saved ? parse(saved) : newDataRecord(myAccount);
    myAccount = myData.account;
    const payment = (digit, incoming = false, note = 'Original\nEVM note <3') => ({
      type: 'evm_transfer', version: 1, chainId: 56, networkId: 'bsc',
      transactionHash: '0x' + digit.repeat(64), from: '0x' + (incoming ? peer : owner),
      to: '0x' + (incoming ? owner : peer), assetKind: 'erc20',
      contractAddress: '0x55d398326f99059ff775485246999027b3197955',
      rawAmount: '5000000000000000', decimals: 18, symbol: 'USDT', ...(note === null ? {} : { note }),
    });
    if (!saved) {
      const message = (digit, my, value, extra = {}) => ({ type: 'evm_transfer',
        txid: digit.repeat(64), payment: value, message: '', my,
        timestamp: Date.now() - 60_000, sent_timestamp: Date.now() - 60_000,
        status: 'sent', paymentVerified: 'settled', paymentMessageConfirmed: true, ...extra });
      myData.contacts[peer] = { address: peer, username: 'recipient', toll: 0n, tollUnit: 'LIB',
        tollRequiredToSend: 0, tollRequiredToReceive: 0, friend: 2, unread: 0, timestamp: 0, useAvatar: 'identicon',
        messages: [
          message('c', true, payment('c')),
          message('f', false, payment('f', true)),
          message('1', true, payment('1', false, null)),
          message('2', true, payment('2'), { timestamp: Date.now() - 16 * 60_000 }),
          message('3', true, payment('3'), { status: 'failed' }),
          { txid: '4'.repeat(64), my: true, amount: 1n, message: 'LIB original memo', timestamp: Date.now() - 60_000, status: 'sent' },
          { txid: '5'.repeat(64), my: true, type: 'message', message: 'Ordinary original text', timestamp: Date.now() - 60_000, status: 'sent' },
        ] };
      myData.chats = [{ address: peer, timestamp: Date.now() - 60_000, txid: 'c'.repeat(64) }];
      myData.wallet.history = [{ txid: '4'.repeat(64), memo: 'LIB original memo' }];
    }
    this.peer = peer;
    chatModal.prepareEncryptedChatContext = async () => ({});
    chatModal.buildEncryptedStructuredChatTx = async (address, messageObj) => ({
      payload: { sent_timestamp: Date.now() }, chatMessageObj: messageObj,
      txid: (this.controls.length + 6).toString(16).repeat(64),
    });
    injectTx = async tx => {
      this.controls.push(tx);
      if (this.outcome === 'exception') throw new Error('Simulated transport failure');
      return { result: { success: this.outcome === 'success' } };
    };
    evmAssets.sendTransfer = async () => { this.assetCalls.push('sendTransfer'); throw Error('Unexpected asset send'); };
    evmAssets.transactions.send = async () => { this.assetCalls.push('transaction.send'); throw Error('Unexpected asset send'); };
    welcomeScreen.close(); header.open(); footer.open();
    await chatModal.open(peer);
    isOnline = true;
    this.clearToasts();
  },
  message(digit) { return myData.contacts[this.peer].messages.find(message => message.txid === digit.repeat(64)); },
  settle() { myData.pending = []; saveState(); },
  clearToasts() { document.querySelectorAll('.toast').forEach(toast => hideToast(toast.id)); },
  async receiveEdit(text) {
    const contact = myData.contacts[this.peer], keys = myAccount.keys, from = this.peer;
    const parsedMessage = { type: 'edit', txid: 'f'.repeat(64), text };
    const tx = { from, timestamp: Date.now() };
    let editIncrements = 0; const inActiveChatWithSender = true;
    for (const ignored of [tx]) { INCOMING_EDIT_BRANCH }
    saveState();
  },
};
`.replace('INCOMING_EDIT_BRANCH', incoming);
const app = source.replace('  welcomeScreen.lastItem.focus();', '  welcomeScreen.lastItem.focus(); window.__fixtureReady = true;') + '\n' + fixture;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) throw Error('Outside repository');
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/')
      ? route.continue() : route.fulfill({ status: 200, body: '{}' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGEERROR', error.message); });
    const boot = async () => {
      await page.goto(origin);
      await page.waitForFunction(() => window.__fixtureReady === true);
      await page.locator('#bootSplash.hidden').waitFor({ state: 'attached' });
      await page.evaluate(() => __fixture.configure());
      await page.locator('#chatModal.is-transition-complete').waitFor();
      await page.addStyleTag({ content: '.messages-container { scroll-behavior: auto !important; } .message-context-menu { animation: none !important; transition: none !important; }' });
    };
    const card = digit => page.locator(`.message[data-txid="${digit.repeat(64)}"]`);
    const edit = page.locator('#messageContextMenu [data-action="edit"]');
    const openMenu = async digit => {
      await page.evaluate(() => { __fixture.chatModal.closeAllContextMenus(); __fixture.clearToasts(); document.activeElement?.blur(); });
      const target = card(digit).locator('.intents-payment-amount, .payment-memo, .message-content').first();
      await target.scrollIntoViewIfNeeded();
      // Let the real scroll handler close the previous menu before clicking.
      await page.waitForTimeout(150);
      if (['4', '5'].includes(digit)) await target.dispatchEvent('click');
      else await target.click();
      try {
        await page.locator('#messageContextMenu').waitFor({ state: 'visible', timeout: 3000 });
      } catch (error) {
        console.error('MENU DEBUG', digit, await page.evaluate(() => ({
          keyboard: __fixture.chatModal.isKeyboardOpen(), active: document.activeElement?.tagName,
          menu: document.getElementById('messageContextMenu').style.display,
        })));
        await page.screenshot({ path: '/tmp/evm-note-editing-menu-debug.png', fullPage: true });
        throw error;
      }
    };
    const submit = async text => {
      await page.locator('.message-input').fill(text);
      await page.evaluate(() => __fixture.chatModal.handleSendMessage());
    };
    await boot();
    const initialCount = await page.locator('.message').count();
    for (const digit of ['f', '1', '2']) {
      await openMenu(digit);
      assert.equal(await edit.isVisible(), false, `${digit} must not offer Edit`);
    }
    await openMenu('c');
    assert.equal(await edit.isVisible(), true);
    await edit.click();
    assert.equal(await page.locator('.message-input').inputValue(), 'Original\nEVM note <3');
    assert.equal(await page.locator('#editOfTxId').inputValue(), 'c'.repeat(64));
    assert.equal(await page.locator('#addAttachmentButton').isDisabled(), true);
    await page.locator('#cancelEditButton').click();
    assert.equal(await card('c').locator('.intents-payment-note').textContent(), 'Original\nEVM note <3');
    assert.equal(await page.locator('#editOfTxId').inputValue(), '');

    await openMenu('c'); await edit.click();
    await page.locator('.message-input').fill('😀'.repeat(251));
    assert.equal(await page.locator('#handleSendMessage').isDisabled(), true);
    await page.evaluate(() => __fixture.chatModal.handleSendMessage());
    assert.equal(await page.evaluate(() => __fixture.controls.length), 0);
    const updated = 'Updated\n<b>payment note</b>';
    await submit(updated);
    assert.equal(await card('c').locator('.intents-payment-note').textContent(), updated);
    assert.equal(await card('c').locator('.intents-payment-note b').count(), 0);
    assert.equal(await card('c').locator('.message-edited-label').count(), 1);
    assert.equal(await page.locator('.message').count(), initialCount);
    assert.deepEqual(await page.evaluate(() => __fixture.controls[0]), { type: 'edit', txid: 'c'.repeat(64), text: updated });
    assert.equal(await page.evaluate(() => __fixture.message('c').paymentVerified), 'settled');
    await page.evaluate(() => __fixture.settle());

    await page.evaluate(() => { __fixture.outcome = 'rejected'; });
    await openMenu('c'); await edit.click(); await submit('Rejected replacement');
    assert.equal(await card('c').locator('.intents-payment-note').textContent(), updated);
    assert.equal(await page.locator('.message-input').inputValue(), 'Rejected replacement');
    assert.equal(await page.locator('#editOfTxId').inputValue(), 'c'.repeat(64));
    await page.evaluate(() => { __fixture.outcome = 'success'; });
    await submit('Retried note');
    assert.equal(await card('c').locator('.intents-payment-note').textContent(), 'Retried note');
    await page.evaluate(() => __fixture.settle());

    await page.evaluate(() => __fixture.receiveEdit('Recipient\nupdated note'));
    assert.equal(await card('f').locator('.intents-payment-note').textContent(), 'Recipient\nupdated note');
    assert.equal(await card('f').locator('.edited-new-dot').count(), 1);

    // Exercise the existing LIB/text entry method without unrelated floating-menu scroll timing.
    await page.evaluate(() => __fixture.chatModal.startEditMessage(document.querySelector(`.message[data-txid="${'4'.repeat(64)}"]`)));
    assert.equal(await page.locator('.message-input').inputValue(), 'LIB original memo');
    await submit('Updated LIB memo');
    assert.equal(await card('4').locator('.payment-memo').textContent(), 'Updated LIB memo');
    assert.equal(await page.evaluate(() => __fixture.data.wallet.history[0].memo), 'Updated LIB memo');
    await page.evaluate(() => __fixture.settle());
    await page.evaluate(() => __fixture.chatModal.startEditMessage(document.querySelector(`.message[data-txid="${'5'.repeat(64)}"]`)));
    await submit('Updated ordinary text');
    assert.equal(await card('5').locator('.message-content').textContent(), 'Updated ordinary text');
    await page.evaluate(() => __fixture.settle());
    assert.deepEqual(await page.evaluate(() => __fixture.assetCalls), []);
    await page.evaluate(() => __fixture.clearToasts());
    await page.screenshot({ path: `/tmp/evm-note-editing-${viewport.name}.png`, fullPage: true });
    await boot();
    assert.equal(await card('c').locator('.intents-payment-note').textContent(), 'Retried note');
    assert.equal(await card('f').locator('.intents-payment-note').textContent(), 'Recipient\nupdated note');
    assert.equal(await page.locator('.message').count(), initialCount);
    assert.deepEqual(errors, []);
    console.log(`${viewport.name}: edit eligibility, prefill/cancel, UTF-8 limit, send, rollback/retry, incoming edit, LIB/text regressions, reload, and zero asset sends passed`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
