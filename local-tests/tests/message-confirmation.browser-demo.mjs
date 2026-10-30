import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, isAbsolute, resolve, sep } from 'node:path';

// Manual browser fixture: keep production files and receipt/send functions intact.
// Only the served module gets a synthetic-account bootstrap appended to it.
const root = process.env.WEB_CLIENT_ROOT;
assert.ok(root && isAbsolute(root), 'Set absolute WEB_CLIENT_ROOT');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const source = await readFile(resolve(root, 'app.js'), 'utf8');
assert.match(source, /checkPendingMessageReceipt\(/, 'Selected client must support message confirmation');
const events = [];
let mode = 'null';

const fixture = String.raw`
checkVersion = async () => {};
timeDifference = async () => {};
setupConnectivityDetection = () => {};
getNetworkParams = async () => true;
updateAssetPricesIfNeeded = async () => {};

async function bootReceiptDemo() {
  if (!chatModal.messageInput || !welcomeScreen.bootSplash?.classList.contains('hidden')) {
    setTimeout(bootReceiptDemo, 50);
    return;
  }
  Object.assign(parameters.current, {
    stabilityFactorStr: '0.20', transactionFeeUsdStr: '0.01',
    defaultTollUsdStr: '0', minTollUsdStr: '0',
    tollTimeout: 24 * 60 * 60 * 1000
  });
  const senderSecret = '1'.repeat(64);
  const recipientPublic = getPublicKey(hex2bin('2'.repeat(64)));
  const senderPublic = getPublicKey(hex2bin(senderSecret));
  const recipientAddress = bin2hex(generateAddress(recipientPublic));
  myAccount = {
    username: 'receipt-demo-sender', netid: network.netid,
    keys: {
      address: bin2hex(generateAddress(senderPublic)), public: bin2hex(senderPublic),
      secret: senderSecret, pqSeed: '3'.repeat(128)
    }
  };
  myData = newDataRecord(myAccount);
  network.gateways = [{ name: 'Local test gateway', web: location.origin + '/__demo/gateway' }];
  network.defaultGatewayIndex = 0;
  myData.network = parse(stringify(network));
  myData.wallet.assets[0].price = 0.2;
  myData.wallet.assets[0].balance = 1000n * wei;
  myData.wallet.assets[0].addresses[0].balance = 1000n * wei;
  myData.wallet.timestamp = Date.now();
  myData.wallet.priceTimestamp = Date.now();
  myData.contacts[recipientAddress] = {
    address: recipientAddress, username: 'Receipt test recipient',
    public: bin2hex(recipientPublic), pqPublic: bin2base64(generatePQKeys('4'.repeat(128)).publicKey),
    messages: [], friend: 2, unread: 0, timestamp: 0, useAvatar: 'identicon',
    tollRequiredToSend: 0, tollRequiredToReceive: 0
  };
  isOnline = true;
  updateUIForConnectivity();
  welcomeScreen.close();
  header.open(); footer.open();
  chatsScreen.screen.classList.add('active');
  await chatModal.open(recipientAddress);
  checkPendingTransactionsIntervalId = setInterval(checkPendingTransactions, 5000);

  const panel = document.createElement('aside');
  panel.id = 'receiptDemoPanel';
  panel.innerHTML = '<strong>Message confirmation test</strong>' +
    '<p>Client revision: __REVISION__</p>' +
    '<p>Real app and clock. Synthetic accounts; local responses only. Nothing is broadcast.</p>' +
    '<button type="button" id="demoFullNull">Prepare full null</button> ' +
    '<button type="button" id="demoTransactionNull">Prepare transaction null</button>' +
    '<p id="demoMode">Choose a case, then press the app’s Send arrow.</p>' +
    '<p>The first receipt lookup starts a 30-second window, usually about 10 seconds after Send.</p>' +
    '<div id="demoResults" aria-live="polite"></div>';
  const style = document.createElement('style');
  style.textContent = '#receiptDemoPanel {position:fixed;z-index:9000;left:16px;top:20px;width:280px;padding:16px;background:#f4f4ff;color:#17182e;border:1px solid #c5c5df;border-radius:10px;font:14px/1.5 system-ui} #receiptDemoPanel button {padding:8px;margin:3px 0;cursor:pointer} #receiptDemoPanel p {margin:10px 0} #receiptDemoPanel pre {white-space:pre-wrap;font:13px/1.5 monospace} @media(max-width:960px) {#receiptDemoPanel {position:relative;left:auto;top:auto;width:auto;margin:12px} body {display:block} .container {margin:auto}}';
  document.head.append(style);
  document.body.append(panel);
  const records = new Map();
  let selectedMode = 'null';
  async function prepare(nextMode) {
    if (myData.pending.length) return;
    await fetch('/__demo/mode', { method: 'POST', body: nextMode });
    selectedMode = nextMode;
    const label = nextMode === 'null' ? 'Full response null' : 'Response { transaction: null }';
    document.getElementById('demoMode').textContent = label + ' — ready. Press the Send arrow.';
    chatModal.messageInput.value = label + ' — browser timeout test';
    chatModal.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    chatModal.toggleSendButtonVisibility();
    chatModal.messageInput.focus();
  }
  document.getElementById('demoFullNull').addEventListener('click', () => prepare('null'));
  document.getElementById('demoTransactionNull').addEventListener('click', () => prepare('transaction-null'));
  setInterval(() => {
    const messages = myData.contacts[recipientAddress].messages;
    for (const message of messages) {
      if (!records.has(message.txid)) records.set(message.txid, { mode: selectedMode, sentAt: Date.now(), windowAt: 0, failedAt: 0 });
      const record = records.get(message.txid);
      const pending = myData.pending.find(item => item.txid === message.txid);
      if (pending?.checkedts && !record.windowAt) {
        record.windowAt = pending.checkedts;
        console.log('[Receipt demo] first lookup', record.mode, message.txid);
      }
      if (message.status === 'failed' && !record.failedAt) {
        record.failedAt = Date.now();
        const result = { mode: record.mode, txid: message.txid, status: message.status,
          windowElapsedMs: record.failedAt - record.windowAt, sendElapsedMs: record.failedAt - record.sentAt,
          pendingRemoved: !pending, contentPreserved: !!message.message };
        console.log('[Receipt demo] failed', JSON.stringify(result));
        void fetch('/__demo/result', { method: 'POST', body: JSON.stringify(result) });
      }
    }
    document.getElementById('demoFullNull').disabled = myData.pending.length > 0;
    document.getElementById('demoTransactionNull').disabled = myData.pending.length > 0;
    const lines = messages.map(message => {
      const record = records.get(message.txid);
      const label = record.mode === 'null' ? 'Full null' : 'Transaction null';
      const end = record.failedAt || Date.now();
      const clock = record.windowAt ? ((end - record.windowAt) / 1000).toFixed(1) + ' / 30 s' : 'waiting for first receipt lookup';
      return label + '\nStatus: ' + message.status + '\nConfirmation: ' + clock;
    });
    document.getElementById('demoResults').replaceChildren(...lines.map(text => {
      const element = document.createElement('pre'); element.textContent = text; return element;
    }));
  }, 250);
  console.log('[Receipt demo] ready; actual send, inject, checker and queryNetwork functions retained');
}
window.addEventListener('load', () => { void bootReceiptDemo(); });
`;

const app = source + '\n' + fixture.replace('__REVISION__', revision.slice(0, 8));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  const body = async () => { let value = ''; for await (const part of request) value += part; return value; };
  try {
    if (url.pathname === '/__demo/mode' && request.method === 'POST') {
      const next = await body();
      assert.ok(['null', 'transaction-null'].includes(next));
      mode = next; return json({ mode });
    }
    if (url.pathname === '/__demo/result' && request.method === 'POST') {
      const result = JSON.parse(await body()); events.push({ kind: 'result', ...result });
      console.log('RESULT', JSON.stringify(result)); return json({ recorded: true });
    }
    if (url.pathname === '/__demo/events') return json({ clientRevision: revision, mode, events });
    if (url.pathname.startsWith('/__demo/gateway/')) {
      const path = url.pathname.slice('/__demo/gateway'.length);
      if (path === '/inject' && request.method === 'POST') {
        const tx = JSON.parse(JSON.parse(await body()).tx);
        assert.equal(tx.type, 'message', 'Fixture accepts message submissions only');
        events.push({ kind: 'submission', mode, at: Date.now() });
        return json({ result: { success: true } });
      }
      if (path.startsWith('/transaction/') || path === '/collector/api/transaction') {
        const receipt = mode === 'null' ? null : { transaction: null };
        events.push({ kind: 'receipt', mode, at: Date.now(), path: path + url.search, response: receipt });
        console.log('RECEIPT', JSON.stringify({ mode, at: Date.now(), path: path + url.search, response: receipt }));
        return json(receipt);
      }
      if (path.endsWith('/balance')) return json({ balance: { dataType: 'bi', value: (1000n * 10n ** 18n).toString(16) } });
      if (path.includes('/toll')) return json({ toll: { required: [0, 0], payOnRead: [0, 0], payOnReply: [0, 0] } });
      if (path.startsWith('/account/')) return json({ account: { private: false, data: { toll: '0', tollUnit: 'LIB' } } });
      if (path.includes('/chats/')) return json({ chats: {} });
      return json({});
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(path.startsWith(root + sep));
    response.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'");
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(path === resolve(root, 'app.js') ? app : await readFile(path));
  } catch (error) {
    console.error('Fixture request failed:', url.pathname, error.message);
    response.writeHead(400).end(error.message);
  }
});
await new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(Number(process.env.RECEIPT_DEMO_PORT || 5502), '127.0.0.1', accept);
});
console.log('Receipt browser demo: http://127.0.0.1:' + server.address().port + '/');
console.log('Client revision: ' + revision);
console.log('No live requests, broadcasts, source edits, or accelerated timers. Ctrl+C stops the demo.');
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
