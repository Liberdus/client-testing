import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Run with WEB_CLIENT_ROOT=/absolute/client node --experimental-default-type=module <this file>.
assert.ok(process.env.WEB_CLIENT_ROOT, 'Set WEB_CLIENT_ROOT to the client checkout');
const root = process.env.WEB_CLIENT_ROOT;
const near = await import(pathToFileURL(resolve(root, 'near-assets.js')));
const sender = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const asset = { key: 'sol', assetId: 'nep141:sol.omft.near', tokenSymbol: 'SOL', tokenDecimals: 9,
  tokenAmount: '1', rawAmount: '1000000000', chainName: 'Solana' };
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };

function element(value = '') {
  return { value, textContent: '', hidden: false, disabled: false, dataset: {}, files: [],
    classList: { contains: () => true, remove() {}, replace() {} }, style: {}, focus() {} };
}

function panelFixture() {
  const panel = new near.ChatPaymentPanel();
  const account = { keys: { address: sender, secret: 'fixture' } };
  panel.getAccount = () => account;
  panel.session = { account, fromWallet: true, loading: false };
  panel.loaded = true;
  for (const key of ['modal', 'recipientInput', 'recipientStatus', 'receiptToll', 'receiptTollAmount',
    'noteInput', 'noteToggle', 'qrFileInput', 'scanQRButton', 'uploadQRButton', 'sendButton', 'statusLine', 'assetPicker']) {
    panel[key] = element();
  }
  panel.assetKey = asset.key;
  panel.selectedAsset = () => asset;
  panel.amount = { problem: () => null, tokenAmount: () => '0.25', setLocked() {}, reset() {} };
  panel.lookupUsername = async () => { throw new Error('Address must skip username lookup'); };
  panel.checkReceiptRecipient = async () => { throw new Error('Address must skip Liberdus checks'); };
  return panel;
}

test('typed address enables review and disables the note', () => {
  const panel = panelFixture();
  panel.noteInput.value = 'old note';
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  assert.equal(near.intentsAccountIdForAddress(panel.recipientAddress), recipient);
  assert.equal(panel.sendButton.disabled, false);
  assert.equal(panel.noteInput.disabled, true);
  assert.equal(panel.noteInput.value, '');
  assert.match(panel.noteInput.placeholder, /address/i);
  assert.equal(panel.receiptToll.hidden, true);
});

test('self address and malformed address block review', () => {
  const panel = panelFixture();
  for (const input of [sender, '0x1234']) {
    panel.recipientInput.value = input;
    panel.handleRecipientInput();
    assert.equal(panel.recipientAddress, null);
    assert.equal(panel.sendButton.disabled, true);
  }
});

test('wallet transfer survives reload and verifies outgoing direction', async () => {
  let saved = [];
  let options;
  const activity = new near.IntentsActivity({ verifyClaim: async (claim, expected) => {
    options = expected;
    assert.equal(claim.decimals, 9);
    return { state: 'settled', transactionHash: 'settlementHash' };
  } });
  activity.configure({ getTransfers: () => saved, saveTransfers: (_account, transfers) => {
    saved = JSON.parse(JSON.stringify(transfers));
  } });
  activity.recordTransfer(sender, { intentHash: 'intentHash', assetId: asset.assetId, amount: '0.25',
    decimals: 9, recipientAddress: recipient, initiatedAt: Date.now() });
  near.intentsDeposits.loadBridgeTokens = async () => {};
  near.intentsDeposits.describeDepositTarget = () => null;
  const { entries } = await activity.forAsset(sender, asset);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'checking');
  assert.equal(await activity.verifyPayment(entries[0], sender), 'done');
  assert.deepEqual(options, { expectedFrom: sender, expectedTo: recipient });
  assert.equal(saved[0].verified, 'settled');
  assert.equal(saved[0].transactionHash, 'settlementHash');
});

test('review and confirm publish once, save before settlement, and skip Liberdus payment', async (t) => {
  const panel = panelFixture();
  let review;
  let saved = [];
  let publishCount = 0;
  let chatCount = 0;
  panel.onSent = async () => { chatCount++; };
  near.intentsActivity.configure({ getTransfers: () => saved, saveTransfers: (_id, items) => { saved = items; } });
  t.mock.method(near.multichain.confirmModal, 'open', (value) => { review = value; });
  t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
  t.mock.method(near.intentsTransfers, 'prepare', async (input) => {
    assert.equal(input.recipientAddress, recipient);
    assert.equal(input.memo, undefined);
    return { senderId: sender, recipientId: recipient, assetId: asset.assetId, amount: '0.25', symbol: 'SOL' };
  });
  t.mock.method(near.intentsTransfers, 'sign', async () => ({ fixture: true }));
  t.mock.method(near.intentsTransfers, 'simulate', async () => ({ ok: true }));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (method === 'publish_intent') {
      publishCount++;
      return Response.json({ id, result: { status: 'OK', intent_hash: 'submittedIntent' } });
    }
    assert.equal(method, 'get_status');
    assert.equal(saved[0].intentHash, 'submittedIntent');
    assert.equal(saved[0].decimals, 9);
    return Response.json({ id, result: { status: 'SETTLED', data: { hash: 'settlementHash' } } });
  });
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  await panel.review();
  assert.equal(review.rows.find(([name]) => name === 'To')[1], recipient);
  assert.equal(review.rows.some(([name]) => name === 'Chat message toll' || name === 'Note'), false);
  assert.match(review.note, /Asset transfer only/);
  const sheet = { session: {}, shows: () => true, setStatus() {}, finish() {}, action: element() };
  await review.run(sheet);
  await review.run(sheet);
  assert.equal(publishCount, 1);
  assert.equal(chatCount, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].transactionHash, 'settlementHash');
  assert.equal(panel.pendingReceipt, null);
});

test('unknown username blocks review, verified username allows note, stale lookup cannot replace address', async () => {
  const panel = panelFixture();
  panel.lookupUsername = async () => null;
  panel.recipientInput.value = 'missing';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.sendButton.disabled, true);
  assert.match(panel.noteInput.placeholder, /invalid username/);
  panel.lookupUsername = async () => recipient;
  panel.checkReceiptRecipient = async () => ({ tollWei: 1n });
  panel.recipientInput.value = 'alice';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.sendButton.disabled, false);
  assert.equal(panel.noteInput.disabled, false);
  assert.equal(panel.receiptToll.hidden, false);
  let finishLookup;
  panel.lookupUsername = () => new Promise((resolve) => { finishLookup = resolve; });
  const checking = panel.handleRecipientInput(recipient);
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  finishLookup(recipient);
  await checking;
  assert.equal(panel.recipientLookup.kind, 'address');
  assert.equal(panel.noteInput.disabled, true);
  panel.lockForm(true);
  panel.lockForm(false);
  assert.equal(panel.noteInput.disabled, true);
});

test('username confirmation still sends the Liberdus Intents payment with note and toll', async (t) => {
  const panel = panelFixture();
  let review;
  let savedCount = 0;
  let received;
  panel.lookupUsername = async () => recipient;
  panel.checkReceiptRecipient = async () => ({ tollWei: 2n });
  panel.onSent = async (...args) => { received = args; };
  near.intentsActivity.configure({ getTransfers: () => [], saveTransfers: () => { savedCount++; } });
  t.mock.method(near.multichain.confirmModal, 'open', (value) => { review = value; });
  t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
  t.mock.method(near.intentsChatPayments, 'prepare', async () => ({ amount: '0.25', symbol: 'SOL' }));
  t.mock.method(near.intentsChatPayments, 'send', async (_prepared, _key, options) => {
    options.beforePublish();
    assert.equal(options.note, 'Lunch');
    return { message: { intentHash: 'chatIntent' }, transactionHash: 'settled' };
  });
  panel.recipientInput.value = 'alice';
  await panel.handleRecipientInput(recipient);
  panel.noteInput.value = 'Lunch';
  await panel.review();
  assert.equal(review.rows.some(([name]) => name === 'Chat message toll'), true);
  await review.run({ session: {}, shows: () => true, setStatus() {}, close() {}, finish() {} });
  assert.equal(savedCount, 0);
  assert.equal(received[1].intentHash, 'chatIntent');
  assert.equal(received[2], 2n);
});

test('shared send simulates before publishing and keeps accepted intent after lookup failure', async (t) => {
  const service = new near.IntentsTransferService();
  t.mock.method(service, 'sign', async () => ({}));
  t.mock.method(service, 'simulate', async () => ({ ok: false, reason: 'insufficient balance' }));
  await assert.rejects(service.send({}, 'fixture'), { code: 'WOULD_FAIL' });
  service.simulate = async () => ({ ok: true });
  let persisted = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'publish_intent') return Response.json({ result: { status: 'OK', intent_hash: 'accepted' } });
    assert.equal(persisted, true);
    throw new Error('offline');
  });
  const result = await service.send({}, 'fixture', { onPublished: () => { persisted = true; } });
  assert.equal(result.intentHash, 'accepted');
  assert.equal(result.settled, false);
});

test('verification saves discovered hash on archive failure and retries without relay', async () => {
  const claim = { intentHash: 'accepted', assetId: asset.assetId, amount: '0.25', decimals: 9 };
  const first = await near.verifyTransferClaim(claim, {
    getStatus: async () => ({ status: 'SETTLED', transactionHash: 'settlementHash' }),
    getTransfers: async () => { throw new Error('offline'); },
  });
  assert.equal(first.state, 'unverifiable');
  assert.equal(first.transactionHash, 'settlementHash');
  const second = await near.verifyTransferClaim({ ...claim, transactionHash: first.transactionHash }, {
    expectedFrom: sender, expectedTo: recipient,
    getStatus: async () => { throw new Error('Must use saved transaction hash'); },
    getTransfers: async () => [{ intentHash: 'accepted', from: sender, to: recipient, tokens: { [asset.assetId]: '250000000' } }],
  });
  assert.equal(second.state, 'settled');
});

test('Activity retries pending after reload and preserves a terminal result against a slow check', async () => {
  let saved = [{ intentHash: 'pending', assetId: asset.assetId, amount: '0.25', decimals: 9,
    recipientAddress: recipient, initiatedAt: Date.now(), verified: 'unchecked' }];
  const activity = new near.IntentsActivity({ verifyClaim: async () => ({ state: 'pending' }) });
  activity.configure({ getTransfers: () => saved, saveTransfers: (_id, transfers) => { saved = transfers; } });
  const first = (await activity.forAsset(sender, asset)).entries[0];
  assert.equal(await activity.verifyPayment(first, sender), 'checking');
  assert.equal(saved[0].verified, 'pending');
  const second = (await activity.forAsset(sender, asset)).entries[0];
  activity.verifyClaim = async () => ({ state: 'settled', transactionHash: 'settled' });
  assert.equal(await activity.verifyPayment(second, sender), 'done');
  activity.updateTransfer(sender, 'pending', { verified: 'pending', transactionHash: null });
  assert.equal(saved[0].verified, 'settled');
  assert.equal(saved[0].transactionHash, 'settled');
  assert.equal((await activity.forAsset(sender, asset)).entries[0].status, 'done');
});

test('camera and uploaded address QR use the same recipient flow', async (t) => {
  const lib = await import(pathToFileURL(resolve(root, 'lib.js')));
  const scanned = panelFixture();
  scanned.openQRScanner = (finish) => { finish(recipient); return true; };
  scanned.scanQR();
  assert.equal(scanned.recipientAddress, recipient);
  assert.equal(scanned.noteInput.disabled, true);
  const uploaded = panelFixture();
  uploaded.qrFileInput.files = [{}];
  t.mock.method(lib.QRImageDecoder, 'decode', async () => recipient);
  await uploaded.readQRFile({ target: uploaded.qrFileInput });
  assert.equal(uploaded.recipientAddress, recipient);
  assert.equal(uploaded.recipientLookup.kind, 'address');
  assert.equal(uploaded.noteInput.disabled, true);
});

test('structured QR verifies username, address, and asset, retaining its amount and note', async () => {
  const { PaymentQR } = await import(pathToFileURL(resolve(root, 'lib.js')));
  const panel = panelFixture();
  let amount;
  const errors = [];
  panel.showToast = (message) => errors.push(message);
  panel.amount.reset = (value) => { amount = value; };
  panel.lookupUsername = async () => recipient;
  panel.checkReceiptRecipient = async () => ({ tollWei: 0n });
  const request = { t: 'intents', u: 'alice', address: recipient, i: asset.assetId, s: 'SOL', a: '0.1', m: 'Lunch' };
  await panel.fillFromQR(PaymentQR.encode(request), panel.session);
  assert.equal(panel.recipientName, '@alice');
  assert.equal(panel.noteInput.disabled, false);
  assert.equal(panel.noteInput.value, 'Lunch');
  assert.equal(amount, '0.1');
  await panel.fillFromQR(PaymentQR.encode({ ...request, address: '0x' + '3'.repeat(40) }), panel.session);
  assert.match(errors.at(-1), /no longer matches/);
  await panel.fillFromQR(PaymentQR.encode({ ...request, i: 'nep141:other.near' }), panel.session);
  assert.match(errors.at(-1), /switch/);
  await panel.fillFromQR('invalid QR', panel.session);
  assert.match(errors.at(-1), /Invalid payment QR/);
  assert.equal(panel.recipientName, '@alice');
  assert.equal(panel.noteInput.value, 'Lunch');
});

test('late QR upload and account change cannot change the new form', async (t) => {
  const { QRImageDecoder } = await import(pathToFileURL(resolve(root, 'lib.js')));
  const panel = panelFixture();
  let finishDecode;
  t.mock.method(QRImageDecoder, 'decode', () => new Promise((resolve) => { finishDecode = resolve; }));
  panel.qrFileInput.files = [{}];
  const reading = panel.readQRFile({ target: panel.qrFileInput });
  panel.session = { account: { keys: { address: sender } }, fromWallet: true };
  panel.recipientInput.value = 'new entry';
  finishDecode(recipient);
  await reading;
  assert.equal(panel.recipientInput.value, 'new entry');
});
