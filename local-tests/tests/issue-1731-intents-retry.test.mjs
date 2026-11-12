import '../fixtures/near-rpc.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  INTENTS_CHAT_MESSAGE_TYPE,
  IntentsActivity,
  IntentsChatPayments,
  buildTransferMessage,
  parseTransferMessage,
  paymentEntry,
  paymentStatusLabel,
  verifyTransferClaim,
} from '../near-assets.js';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const originalTime = 1_700_000_000_000;
const retryTime = originalTime + 3 * 86_400_000;
const intentHash = 'testIntentHash';
const asset = { assetId: 'nep141:sol.omft.near', tokenDecimals: 9, chainName: 'Solana' };

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from !== -1 && to > from, `Missing chat code between ${start} and ${end}`);
  return app.slice(from, to);
}

// Execute the app's receipt methods and bubble verifier without booting its UI.
// Signing/encryption, Liberdus submission, the DOM, and storage are test doubles.
const chatSource = [
  sourceBetween('const intentsReceiptsInFlight = ', '// While a payment in the open chat'),
  sourceBetween('async function verifyPaymentBubbles()', 'function reconcilePendingMessageEdit('),
  sourceBetween('function isRecipientTollTooLowFailure(', '\n\n/**'),
  'class ReceiptModal {',
  sourceBetween('  async sendIntentsPaymentMessage(', '  /**\n   * Cancel editing mode'),
  '}',
  '({ ReceiptModal, verifyPaymentBubbles });',
].join('\n');

class ChatSession {
  constructor(owner, peer, { saved, acceptsReceipt = true } = {}) {
    this.state = saved ? JSON.parse(saved) : { contacts: { [peer]: { address: peer, messages: [] } }, chats: [] };
    this.contact = this.state.contacts[peer];
    const { ReceiptModal, verifyPaymentBubbles } = runInNewContext(chatSource, {
      INTENTS_CHAT_MESSAGE_TYPE, buildTransferMessage, parseTransferMessage, paymentStatusLabel, verifyTransferClaim,
      assert, normalizeAddress: address => address, intentsAccountIdForAddress: address => address,
      myAccount: { keys: { address: owner } }, myData: this.state,
      intentsPaymentVerifications: new Map(),
      getNetworkParams: async () => {},
      getLibBalanceWei: () => 1n,
      getTransactionFeeWei: () => 1n,
      insertSorted: (rows, row) => rows.push(row),
      chatsScreen: { updateChatList() {} },
      saveState: () => { this.saved = JSON.stringify(this.state); },
      showToast: (message) => assert.fail(message),
      updateTransactionStatus: (txid, address, status) => {
        this.state.contacts[address].messages.find(message => message.txid === txid).status = status;
      },
      injectTx: async (receipt) => {
        if (!acceptsReceipt) return { result: { success: false, reason: 'fixture delivery failure' } };
        this.delivered = receipt;
        return { result: { success: true } };
      },
      document: { querySelectorAll: (selector) => {
        const card = this.contact.messages[0];
        if (!card || !selector.includes(`data-verified="${card.paymentVerified}"`)) return [];
        return [{
          dataset: { intentHash: card.payment.intentHash },
          closest: () => ({ dataset: { messageTimestamp: card.timestamp } }),
          querySelector: () => this.label,
        }];
      } },
    });
    this.label = {};
    this.verify = verifyPaymentBubbles;
    this.modal = Object.assign(new ReceiptModal(), {
      appendChatModal() {},
      paymentMessageToll: () => 0n,
      checkPaymentRecipient: async () => ({ problem: null }),
      prepareEncryptedChatContext: async () => ({}),
      buildEncryptedStructuredChatTx: async (_address, receipt) => {
        const sent_timestamp = Date.now();
        const payload = { sent_timestamp, message: JSON.stringify(receipt) };
        return { payload, chatMessageObj: payload, txid: `receipt-${sent_timestamp}` };
      },
    });
  }
}

test('a delayed receipt retry after sender reload keeps the original payment age', async ({ mock }) => {
  let now = originalTime;
  let publishes = 0;
  let lateLookups = 0;
  mock.method(Date, 'now', () => now);
  mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const request = JSON.parse(body);
    if (request.method === 'publish_intent') {
      publishes += 1;
      return Response.json({ result: { status: 'OK', intent_hash: intentHash } });
    }
    assert.equal(request.method, 'get_status');
    assert.equal(request.params[0].intent_hash, intentHash);
    if (now === originalTime) {
      now += 30_000;
      return Response.json({ error: { message: 'settlement lookup unavailable' } });
    }
    lateLookups += 1;
    return Response.json({ result: { status: 'NOT_FOUND_OR_NOT_VALID' } });
  });

  const payments = new IntentsChatPayments({ transfers: {
    sign: async () => ({}),
    simulate: async () => ({ ok: true }),
  } });
  const { message } = await payments.send({ assetId: asset.assetId, symbol: 'SOL', amount: '1' }, 'test-key', { asset });
  assert.equal(message.transactionHash, undefined, 'the first receipt has only the intent hash');

  const sender = new ChatSession('sender', 'recipient', { acceptsReceipt: false });
  await assert.rejects(sender.modal.sendIntentsPaymentMessage('recipient', message, 0n), /fixture delivery failure/);
  assert.equal(JSON.parse(sender.saved).contacts.recipient.messages[0].status, 'failed');

  now = retryTime;
  const reloaded = new ChatSession('sender', 'recipient', { saved: sender.saved });
  await reloaded.modal.retryIntentsPaymentMessage('recipient', reloaded.contact.messages[0]);
  assert.equal(reloaded.contact.messages.length, 1);
  assert.equal(reloaded.delivered.sent_timestamp, retryTime, 'the receipt gets a fresh message timestamp');
  assert.equal(publishes, 1, 'retry never republishes the intent');

  const recipient = new ChatSession('recipient', 'sender');
  const payment = parseTransferMessage(JSON.parse(reloaded.delivered.message));
  const received = { payment, my: false, timestamp: retryTime, paymentVerified: 'unchecked' };
  recipient.contact.messages.push(received);
  recipient.state.contacts.other = { address: 'other', messages: [{ ...received, paymentVerified: 'failed' }] };
  await recipient.verify();
  assert.equal(recipient.label.textContent, 'Too old to check');
  assert.equal(JSON.parse(recipient.saved).contacts.sender.messages[0].paymentVerified, 'expired');
  assert.equal(payment.initiatedAt, originalTime, 'the original payment time survives both receipt sends');
  assert.equal(payment.intentHash, intentHash);

  const reopened = new ChatSession('recipient', 'sender', { saved: recipient.saved });
  await reopened.verify();
  assert.equal(reopened.contact.messages[0].paymentVerified, 'expired');
  assert.equal(reopened.state.contacts.other.messages[0].paymentVerified, 'failed', 'the older saved verdict stays put');
  assert.equal(lateLookups, 1, 'a resting chat verdict survives recipient reload');

  const wallet = new IntentsActivity();
  const entry = paymentEntry({ ...payment, time: retryTime, peerAccount: 'sender' });
  assert.equal(entry.time, retryTime, 'wallet activity keeps the message time for ordering');
  assert.equal(await wallet.verifyPayment(entry, 'recipient'), 'expired');
});
