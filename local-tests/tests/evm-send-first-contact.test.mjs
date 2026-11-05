import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { generateAddress, getPublicKey } from '../crypto.js';
import { parseEvmTransferMessage } from '../evm-assets.js';
import { big2str, bin2hex, hex2bin, longAddress, normalizeAddress, normalizeUsername } from '../lib.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const SENDER = 'a'.repeat(40);
const PUBLIC_KEY = bin2hex(getPublicKey(hex2bin('2'.padStart(64, '0'))));
const RECIPIENT = bin2hex(generateAddress(hex2bin(PUBLIC_KEY)));
const FEE = 50_000_000_000_000_000n;
const TOLL = 250_000_000_000_000_000n;

function excerpt(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing app source for ${start}`);
  return source.slice(first, last);
}

class FirstContactFixture {
  constructor({ toll = TOLL, balance = FEE + TOLL } = {}) {
    this.account = { username: 'sender', keys: { address: SENDER, secret: '1'.padStart(64, '0') } };
    this.contacts = {};
    this.requests = [];
    this.savedPayments = [];
    this.resolution = { address: `0x${RECIPIENT}`, username: 'recipient' };
    this.receiptFee = FEE;
    const chatMethods = excerpt('  async prepareEvmPaymentRecipient(', '  async sendEvmPaymentMessage(');
    const createContact = excerpt('function createNewContact(', 'class ScanQRModal');
    this.chat = runInNewContext(`${createContact}\nnew class { ${chatMethods} }`, {
      myAccount: this.account,
      myData: { contacts: this.contacts },
      big2str, bin2hex, hex2bin, normalizeAddress, longAddress, generateAddress, parseEvmTransferMessage,
      normalizeUsername, isFaucetAddress: () => false,
      hashBytes: () => 'synthetic-chat',
      queryNetwork: async (path) => {
        this.requests.push(path);
        if (path === `/account/${longAddress(RECIPIENT)}`) {
          return { account: { data: { toll, tollUnit: 'LIB' }, publicKey: PUBLIC_KEY, pqPublicKey: 'synthetic-pq' } };
        }
        if (path === '/messages/synthetic-chat/toll') return { error: 'No account with the given chatId' };
        if (path === `/account/${longAddress(SENDER)}/balance`) return { balance };
        assert.fail(`Unexpected query: ${path}`);
      },
      getNetworkParams: async () => true,
      getTransactionFeeWei: () => FEE,
      getEffectiveTollLibWei: value => value,
      normalizeTollToLibWei: value => value,
      dhkeyCombined: () => ({ dhkey: 'synthetic-key', cipherText: 'synthetic-ciphertext' }),
      saveEvmPayment: record => this.savedPayments.push(record),
    });
    this.chat.buildEncryptedStructuredChatTx = async (address, _payment, amount, _keys, cryptoContext) => {
      assert.equal(address, RECIPIENT);
      assert.deepEqual(Object.keys(this.contacts), [], 'Preparing a receipt has no address book side effect yet');
      assert.equal(cryptoContext.contact.friend, 2, 'A first-time receipt uses the Connection profile-sharing policy');
      return {
        payload: { sent_timestamp: 1000 },
        chatMessageObj: { amount, fee: this.receiptFee },
        txid: 'synthetic-receipt',
      };
    };
  }

  record() {
    return {
      kind: 'outgoing',
      payment: {
        type: 'evm_transfer', version: 1, chainId: 1, networkId: 'ethereum',
        transactionHash: `0x${'d'.repeat(64)}`, from: `0x${SENDER}`, to: this.resolution.address,
        assetKind: 'native', rawAmount: '1', decimals: 18, symbol: 'ETH',
      },
      username: this.resolution.username,
      assetState: 'unknown',
      broadcastState: 'not_started',
      messageCostLimit: (FEE + TOLL).toString(),
    };
  }
}

for (const toll of [0n, TOLL]) {
  test(`quotes an unsaved recipient's fee and ${toll === 0n ? 'zero' : 'required'} toll without creating a contact`, async () => {
    const fixture = new FirstContactFixture({ toll });
    const quote = await fixture.chat.prepareEvmPaymentRecipient(fixture.resolution, fixture.account);

    assert.equal(quote.fee, FEE.toString());
    assert.equal(quote.toll, toll.toString());
    assert.equal(quote.totalRequired, (FEE + toll).toString());
    assert.deepEqual(fixture.contacts, {});
    assert.deepEqual(fixture.savedPayments, []);
  });
}

test('an insufficient LIB balance still reports the required recipient toll', async () => {
  const fixture = new FirstContactFixture({ balance: FEE });
  await assert.rejects(fixture.chat.prepareEvmPaymentRecipient(fixture.resolution, fixture.account), error => {
    assert.match(error.message, /not enough LIB/i);
    assert.equal(error.recipientToll, TOLL);
    return true;
  });
  assert.deepEqual(fixture.contacts, {});
});

test('creates a Connection for a first-time recipient when preparing the confirmed payment', async () => {
  const fixture = new FirstContactFixture();
  const record = fixture.record();
  assert.equal(await fixture.chat.prepareEvmPaymentMessage(record, fixture.account), true);

  const contact = fixture.contacts[RECIPIENT];
  assert.equal(contact.username, 'recipient');
  assert.equal(contact.friend, 2);
  assert.equal(contact.public, PUBLIC_KEY);
  assert.equal(contact.pqPublic, 'synthetic-pq');
  assert.equal(contact.tollRequiredToSend, 1);
  assert.equal(record.attempt.txid, 'synthetic-receipt');
  assert.deepEqual(fixture.savedPayments, [record]);
});

test('a payment preserves an existing Tolled contact and its receipt profile-sharing policy', async () => {
  const fixture = new FirstContactFixture();
  const contact = { address: RECIPIENT, username: 'recipient', friend: 1 };
  fixture.contacts[RECIPIENT] = contact;
  fixture.chat.buildEncryptedStructuredChatTx = async (_address, _payment, amount, _keys, cryptoContext) => {
    assert.equal(cryptoContext.contact, contact);
    assert.equal(cryptoContext.contact.friend, 1);
    return {
      payload: { sent_timestamp: 1000 },
      chatMessageObj: { amount, fee: fixture.receiptFee },
      txid: 'synthetic-receipt',
    };
  };

  assert.equal(await fixture.chat.prepareEvmPaymentMessage(fixture.record(), fixture.account), true);
  assert.equal(fixture.contacts[RECIPIENT], contact);
  assert.equal(contact.friend, 1);
});

test('does not create a contact when the prepared receipt exceeds the approved LIB cost', async () => {
  const fixture = new FirstContactFixture();
  fixture.receiptFee += 1n;
  await assert.rejects(fixture.chat.prepareEvmPaymentMessage(fixture.record(), fixture.account), /cost exceeds the approved amount/i);

  assert.deepEqual(fixture.contacts, {});
  assert.deepEqual(fixture.savedPayments, []);
});

test('an exact username cannot bypass an existing local block', async () => {
  const fixture = new FirstContactFixture();
  fixture.contacts[RECIPIENT] = { address: RECIPIENT, username: 'recipient', friend: 0 };
  await assert.rejects(fixture.chat.prepareEvmPaymentRecipient(fixture.resolution, fixture.account), /block/i);
  assert.deepEqual(fixture.requests, []);
});
