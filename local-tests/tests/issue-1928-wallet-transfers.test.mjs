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
    'recipientHint', 'noteLabel', 'noteInput', 'noteToggle', 'qrFileInput', 'scanQRButton', 'uploadQRButton', 'sendButton', 'statusLine', 'assetPicker']) {
    panel[key] = element();
  }
  panel.noteToggle.hidden = true;
  panel.assetKey = asset.key;
  panel.selectedAsset = () => asset;
  panel.amount = { problem: () => null, tokenAmount: () => '0.25', setLocked() {}, reset() {} };
  panel.lookupUsername = async () => { throw new Error('Address must skip username lookup'); };
  panel.checkReceiptRecipient = async () => { throw new Error('Address must skip Liberdus checks'); };
  return panel;
}

test('typed address enables review and hides the note', () => {
  const panel = panelFixture();
  panel.noteInput.value = 'old note';
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  assert.equal(near.intentsAccountIdForAddress(panel.recipientAddress), recipient);
  assert.equal(panel.sendButton.disabled, false);
  assert.equal(panel.noteInput.disabled, true);
  assert.equal(panel.noteInput.hidden, true);
  assert.equal(panel.noteLabel.hidden, true);
  assert.equal(panel.noteInput.value, '');
  assert.equal(panel.recipientStatus.textContent, 'Asset transfer only');
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

test('review and confirm publish once without a Liberdus Intents payment message', async (t) => {
  const panel = panelFixture();
  let review;
  let publishCount = 0;
  let chatCount = 0;
  let polledHash;
  panel.onSent = async () => { chatCount++; };
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
    const { method, id, params } = JSON.parse(init.body);
    if (method === 'publish_intent') {
      publishCount++;
      return Response.json({ id, result: { status: 'OK', intent_hash: '  submittedIntent  ' } });
    }
    assert.equal(method, 'get_status');
    polledHash = params[0].intent_hash;
    return Response.json({ id, result: { status: 'SETTLED', data: { hash: 'settlementHash' } } });
  });
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  await panel.review();
  assert.deepEqual(review.rows.slice(0, 2), [
    ['To', recipient],
    ['Destination network', 'NEAR Intents'],
  ]);
  assert.equal(review.rows.some(([name]) => name === 'Chat message toll' || name === 'Note'), false);
  assert.match(review.note, /Asset transfer only/);
  assert.ok(review.note.includes('To send to an external wallet, use Withdraw.'));
  const results = [];
  const sheet = { session: {}, shows: () => true, setStatus() {}, finish(message) { results.push(message); }, action: element() };
  await review.run(sheet);
  assert.equal(polledHash, 'submittedIntent');
  assert.equal(results[0], 'Sent 0.25 SOL.');
  await review.run(sheet);
  assert.equal(publishCount, 1);
  assert.equal(chatCount, 0);
  assert.equal(panel.pendingReceipt, null);
});

test('address send can retry after a definite publish refusal but not an uncertain submission', async (t) => {
  const refusedReason = 'The relay refused this transfer';
  const refusal = { status: 'FAILED', reason: refusedReason, intent_hash: 'refusedIntent' };
  const refusedResponse = (id) => Response.json({ id, result: refusal });
  const cases = [
    { name: 'explicit relay refusal', firstResponse: refusedResponse, canRetry: true },
    {
      name: 'explicit refusal after closing confirmation',
      firstResponse: refusedResponse,
      dismissConfirmation: true,
      canRetry: true,
    },
    {
      name: 'relay refusal is missing the request ID',
      firstResponse: () => Response.json({ result: refusal }),
      canRetry: false,
    },
    {
      name: 'relay refusal belongs to a different request',
      firstResponse: (id) => refusedResponse(id + 1),
      canRetry: false,
    },
    {
      name: 'relay says the intent was already processed',
      firstResponse: (id) => Response.json({
        id,
        result: { status: 'FAILED', reason: 'already processed', intent_hash: 'submittedIntent' },
      }),
      canRetry: false,
    },
    {
      name: 'missing relay response result',
      firstResponse: (id) => Response.json({ id }),
      canRetry: false,
    },
    {
      name: 'missing hash in the success response',
      firstResponse: (id) => Response.json({ id, result: { status: 'OK' } }),
      canRetry: false,
    },
    {
      name: 'object hash in the success response',
      firstResponse: (id) => Response.json({ id, result: { status: 'OK', intent_hash: {} } }),
      canRetry: false,
    },
    {
      name: 'blank hash in the success response',
      firstResponse: (id) => Response.json({ id, result: { status: 'OK', intent_hash: '   ' } }),
      canRetry: false,
    },
    {
      name: 'connection dropped during submission',
      firstResponse: () => { throw new Error('Connection dropped'); },
      canRetry: false,
    },
  ];
  for (const { name, firstResponse, canRetry, dismissConfirmation } of cases) {
    await t.test(name, async (t) => {
      const panel = panelFixture();
      const sheet = new near.multichain.confirmModal.constructor({});
      for (const key of ['modal', 'title', 'hero', 'rows', 'action', 'note', 'status']) {
        sheet[key] = element();
      }
      t.mock.method(sheet, 'show', () => {});
      t.mock.method(near.multichain.confirmModal, 'open', (review) => sheet.open(review));
      t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
      t.mock.method(near.intentsTransfers, 'prepare', async () => ({ amount: '0.25', symbol: 'SOL' }));
      t.mock.method(near.intentsTransfers, 'sign', async () => ({ fixture: true }));
      t.mock.method(near.intentsTransfers, 'simulate', async () => ({ ok: true }));
      t.mock.method(console, 'warn', () => {});

      const requests = [];
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const { method, id } = JSON.parse(init.body);
        requests.push(method);
        if (method === 'publish_intent') {
          if (requests.length === 1) {
            if (dismissConfirmation) sheet.close();
            return firstResponse(id);
          }
          return Response.json({ id, result: { status: 'OK', intent_hash: 'submittedIntent' } });
        }
        assert.equal(method, 'get_status');
        return Response.json({ id, result: { status: 'SETTLED', data: { hash: 'settlementHash' } } });
      });

      panel.recipientInput.value = recipient;
      panel.handleRecipientInput();
      await panel.review();
      await sheet.confirm();
      assert.deepEqual(requests, ['publish_intent']);
      if (dismissConfirmation) {
        assert.equal(panel.statusLine.textContent, refusedReason);
        assert.equal(panel.statusLine.dataset.kind, 'error');
        assert.equal(panel.recipientInput.disabled, false);
        assert.equal(panel.sendButton.disabled, false);
        await panel.primaryAction();
        assert.equal(sheet.action.textContent, 'Send SOL');
        await sheet.confirm();
        assert.deepEqual(requests, ['publish_intent', 'publish_intent', 'get_status']);
        assert.equal(sheet.status.textContent, 'Sent 0.25 SOL.');
        return;
      }
      assert.equal(sheet.action.disabled, false);
      assert.equal(sheet.status.dataset.kind, 'error');
      if (canRetry) {
        assert.equal(sheet.status.textContent, refusedReason);
        assert.equal(sheet.action.textContent, 'Send SOL');
        await sheet.confirm();
        assert.deepEqual(requests, ['publish_intent', 'publish_intent', 'get_status']);
        assert.equal(sheet.status.textContent, 'Sent 0.25 SOL.');
        assert.equal(sheet.action.textContent, 'Done');
      } else {
        assert.equal(sheet.action.textContent, 'Done');
        assert.match(sheet.status.textContent, /Sending again could transfer the funds twice/);
      }
    });
  }
});

test('address transfer result stays on Send when confirmation closes during settlement', async (t) => {
  const panel = panelFixture();
  let review;
  t.mock.method(near.multichain.confirmModal, 'open', (value) => { review = value; });
  t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
  t.mock.method(near.intentsTransfers, 'prepare', async () => ({ amount: '0.25', symbol: 'SOL' }));
  t.mock.method(near.intentsTransfers, 'sign', async () => ({ fixture: true }));
  t.mock.method(near.intentsTransfers, 'simulate', async () => ({ ok: true }));
  let statusRequested;
  const checkingStatus = new Promise((resolve) => { statusRequested = resolve; });
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  let publishCount = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (method === 'publish_intent') {
      publishCount++;
      return Response.json({ id, result: { status: 'OK', intent_hash: 'submittedIntent' } });
    }
    assert.equal(method, 'get_status');
    statusRequested();
    await settlement;
    return Response.json({ id, result: { status: 'SETTLED', data: { hash: 'settlementHash' } } });
  });
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  await panel.review();
  let showing = true;
  const sheet = {
    session: 1,
    shows: () => showing,
    setStatus() {},
    finish() { assert.fail('A dismissed confirmation must not receive the result'); },
    action: element(),
  };
  const sending = review.run(sheet);
  await checkingStatus;
  showing = false;
  review.onClose();
  const lockedDuringSettlement = panel.sendButton.disabled;
  settle();
  await sending;

  assert.equal(lockedDuringSettlement, true);
  assert.ok(panel.session, 'Send remains open for the transfer result');
  assert.equal(panel.statusLine.textContent, 'Sent 0.25 SOL.');
  assert.equal(panel.recipientInput.disabled, true);
  assert.equal(panel.sendButton.textContent, 'Done');
  assert.equal(panel.sendButton.disabled, false);
  await panel.primaryAction();
  assert.equal(panel.session, null, 'Done closes Send');
  assert.equal(publishCount, 1);
});

test('signing out during address settlement closes the old form and its confirmation', async (t) => {
  const panel = panelFixture();
  let account = panel.getAccount();
  panel.getAccount = () => account;
  let review;
  t.mock.method(near.multichain.confirmModal, 'open', (value) => { review = value; });
  const refresh = t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
  t.mock.method(near.intentsTransfers, 'prepare', async () => ({ amount: '0.25', symbol: 'SOL' }));
  let publicationStarted;
  const published = new Promise((resolve) => { publicationStarted = resolve; });
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  t.mock.method(near.intentsTransfers, 'send', async (_prepared, _key, { beforePublish }) => {
    beforePublish();
    publicationStarted();
    return settlement;
  });

  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  await panel.review();
  let showing = true;
  let finished = false;
  const sheet = {
    session: 1,
    shows: () => showing,
    setStatus() {},
    finish() { finished = true; },
    close() { showing = false; review.onClose(); },
    action: element(),
  };
  const sending = review.run(sheet);
  await published;
  account = null;
  settle({ status: 'SETTLED', settled: true });
  await sending;

  assert.equal(panel.session, null, 'The old account’s Send form closes');
  assert.equal(panel.sending, false, 'The send lock is released');
  assert.equal(showing, false, 'The old confirmation closes');
  assert.equal(finished, false, 'No completion is shown for the old account');
  assert.equal(refresh.mock.callCount(), 0);
});

test('address settlement distinguishes definitive failure from unconfirmed replies', async (t) => {
  const settled = { status: 'SETTLED', data: { hash: 'settlementHash' } };
  const cases = [
    {
      name: 'settlement lookup loses its connection',
      response: () => { throw new Error('Connection dropped'); },
    },
    {
      name: 'settlement lookup reports NOT_FOUND_OR_NOT_VALID',
      response: (id) => Response.json({ id, result: { status: 'NOT_FOUND_OR_NOT_VALID' } }),
    },
    {
      name: 'settlement result lacks the request ID',
      response: () => Response.json({ result: settled }),
    },
    {
      name: 'settlement result belongs to a different request',
      response: (id) => Response.json({ id: id + 1, result: settled }),
    },
    {
      name: 'settlement failure status is an array',
      response: (id) => Response.json({ id, result: { status: ['FAILED'] } }),
    },
    {
      name: 'settled status is an array',
      response: (id) => Response.json({ id, result: { ...settled, status: ['SETTLED'] } }),
    },
    {
      name: 'settled status lacks a transaction hash',
      response: (id) => Response.json({ id, result: { status: 'SETTLED' } }),
    },
    {
      name: 'settled status has a non-string transaction hash',
      response: (id) => Response.json({ id, result: { status: 'SETTLED', data: { hash: {} } } }),
    },
    {
      name: 'settled status has a blank transaction hash',
      response: (id) => Response.json({ id, result: { status: 'SETTLED', data: { hash: '  ' } } }),
    },
    {
      name: 'settlement reply explicitly reports failure',
      response: (id) => Response.json({ id, result: { status: 'FAILED' } }),
      message: 'The transfer did not go through.',
    },
  ];
  for (const { name, response, message } of cases) {
    await t.test(name, async (t) => {
      const panel = panelFixture();
      const sheet = new near.multichain.confirmModal.constructor({});
      for (const key of ['modal', 'title', 'hero', 'rows', 'action', 'note', 'status']) {
        sheet[key] = element();
      }
      t.mock.method(sheet, 'show', () => {});
      t.mock.method(near.multichain.confirmModal, 'open', (review) => sheet.open(review));
      t.mock.method(near.multichain, 'refreshAfterMove', async () => {});
      t.mock.method(near.intentsTransfers, 'prepare', async () => ({ amount: '0.25', symbol: 'SOL' }));
      t.mock.method(near.intentsTransfers, 'sign', async () => ({ fixture: true }));
      t.mock.method(near.intentsTransfers, 'simulate', async () => ({ ok: true }));
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const { method, id } = JSON.parse(init.body);
        if (method === 'publish_intent') {
          return Response.json({ id, result: { status: 'OK', intent_hash: 'submittedIntent' } });
        }
        assert.equal(method, 'get_status');
        return response(id);
      });

      panel.recipientInput.value = recipient;
      panel.handleRecipientInput();
      await panel.review();
      await sheet.confirm();
      assert.equal(sheet.status.textContent, message ?? 'Transfer submitted. It may still settle. Sending again could transfer the funds twice.');
      assert.equal(sheet.action.textContent, 'Done');
    });
  }
});

test('unknown username blocks review, verified username allows note, stale lookup cannot replace address', async () => {
  const panel = panelFixture();
  panel.lookupUsername = async () => null;
  panel.recipientInput.value = 'missing';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.sendButton.disabled, true);
  assert.equal(panel.noteInput.hidden, true);
  assert.equal(panel.noteLabel.hidden, true);
  panel.lookupUsername = async () => recipient;
  panel.checkReceiptRecipient = async () => ({ tollWei: 1n });
  panel.recipientInput.value = 'alice';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.sendButton.disabled, false);
  assert.equal(panel.noteInput.disabled, false);
  assert.equal(panel.noteInput.hidden, false);
  assert.equal(panel.noteLabel.hidden, false);
  assert.equal(panel.noteToggle.hidden, true);
  assert.equal(panel.receiptToll.hidden, false);
  panel.noteInput.value = 'For Alice';
  let finishLookup;
  panel.lookupUsername = () => new Promise((resolve) => { finishLookup = resolve; });
  const checking = panel.handleRecipientInput(recipient);
  panel.recipientInput.value = recipient;
  panel.handleRecipientInput();
  finishLookup(recipient);
  await checking;
  assert.equal(panel.recipientLookup.kind, 'address');
  assert.equal(panel.noteInput.disabled, true);
  assert.equal(panel.noteInput.hidden, true);
  assert.equal(panel.noteInput.value, '');
  panel.lockForm(true);
  panel.lockForm(false);
  assert.equal(panel.noteInput.disabled, true);
});

test('editing the spelling of the same username preserves its note, but a different username clears it', async () => {
  const panel = panelFixture();
  const bobAddress = '0x' + '3'.repeat(40);
  panel.lookupUsername = async (username) => ({ alice: recipient, bob: bobAddress })[username] ?? null;
  panel.checkReceiptRecipient = async () => ({ tollWei: 0n });

  panel.recipientInput.value = 'alice';
  await panel.handleRecipientInput(recipient);
  panel.noteInput.value = 'For Alice';

  panel.recipientInput.value = '@alice';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.noteInput.hidden, false);
  assert.equal(panel.noteInput.value, 'For Alice');

  panel.recipientInput.value = '  @ALICE  ';
  await panel.handleRecipientInput(recipient);
  assert.equal(panel.noteInput.value, 'For Alice');

  panel.recipientInput.value = 'bob';
  await panel.handleRecipientInput(bobAddress);
  assert.equal(panel.recipientName, '@bob');
  assert.equal(panel.noteInput.hidden, false);
  assert.equal(panel.noteInput.value, '');
});

test('username confirmation still sends the Liberdus Intents payment message with note and toll', async (t) => {
  const panel = panelFixture();
  let review;
  let received;
  panel.lookupUsername = async () => recipient;
  panel.checkReceiptRecipient = async () => ({ tollWei: 2n });
  panel.onSent = async (...args) => { received = args; };
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
  assert.equal(received[1].intentHash, 'chatIntent');
  assert.equal(received[2], 2n);
});

test('shared send simulates before publishing and reports an unconfirmed settlement', async (t) => {
  const service = new near.IntentsTransferService();
  t.mock.method(service, 'sign', async () => ({}));
  t.mock.method(service, 'simulate', async () => ({ ok: false, reason: 'insufficient balance' }));
  await assert.rejects(service.send({}, 'fixture'), { code: 'WOULD_FAIL' });
  service.simulate = async () => ({ ok: true });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'publish_intent') return Response.json({ id: request.id, result: { status: 'OK', intent_hash: 'accepted' } });
    throw new Error('offline');
  });
  const result = await service.send({}, 'fixture');
  assert.equal(result.intentHash, 'accepted');
  assert.equal(result.settled, false);
});

test('camera and uploaded address QR use the same recipient flow', async (t) => {
  const lib = await import(pathToFileURL(resolve(root, 'lib.js')));
  const scanned = panelFixture();
  scanned.openQRScanner = (finish) => { finish(recipient); return true; };
  scanned.scanQR();
  assert.equal(scanned.recipientAddress, recipient);
  assert.equal(scanned.noteInput.hidden, true);
  const uploaded = panelFixture();
  uploaded.qrFileInput.files = [{}];
  t.mock.method(lib.QRImageDecoder, 'decode', async () => recipient);
  await uploaded.readQRFile({ target: uploaded.qrFileInput });
  assert.equal(uploaded.recipientAddress, recipient);
  assert.equal(uploaded.recipientLookup.kind, 'address');
  assert.equal(uploaded.noteInput.hidden, true);
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
  assert.equal(panel.noteInput.hidden, false);
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
