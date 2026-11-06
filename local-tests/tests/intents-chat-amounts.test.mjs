import '../fixtures/near-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IntentsChatPayments, normalizeIntentsToken, parseTransferMessage } from '../near-assets.js';

// Published Ganache test key: all RPC/relay requests below are intercepted.
const SECRET = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const SENDER = '0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
const RECIPIENT = '0x0551f7c9a91ee579c9e40444ffc490001c323108';
const INTENT_HASH = '8LKE47o44ybZQR9ozLyDnvMDTh4Ao5ipy2mJWsYByG5Q';
const TRANSACTION_HASH = '9B1FBNKGRFZQicHABTivUvG6Mf9jJaAcDyddNouNHKp8';
const BNB = normalizeIntentsToken({
  assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
  symbol: 'BNB', blockchain: 'bsc', decimals: 18, price: 500,
}, '999999999999999999999999999999');
const saltFetch = globalThis.fetch;

for (const scenario of [
  { name: 'leading-dot BNB without a note', input: '.00002', amount: '0.00002', raw: '20000000000000' },
  { name: 'leading-dot BNB with a note', input: '.00002', amount: '0.00002', raw: '20000000000000', note: 'for lunch' },
  { name: 'trailing-dot BNB', input: '2.', amount: '2', raw: '2000000000000000000' },
  {
    name: 'BNB with eighteen fractional digits', input: '123456789.123456789012345678',
    amount: '123456789.123456789012345678', raw: '123456789123456789012345678',
  },
]) {
  test(`${scenario.name} produces a valid receipt for the exact transfer`, async t => {
    const requests = [];
    let simulated;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const request = JSON.parse(options.body);
      const method = request.method === 'query' ? request.params.method_name : request.method;
      requests.push(method);
      if (method === 'current_salt') return saltFetch(url, options);
      if (method === 'simulate_intents') {
        const args = JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString());
        assert.equal(args.signed.length, 1);
        simulated = args.signed[0];
        assert.equal(simulated.standard, 'erc191');
        assert.match(simulated.signature, /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);
        const payload = JSON.parse(simulated.payload);
        assert.equal(payload.signer_id, SENDER);
        assert.deepEqual(payload.intents, [{
          intent: 'transfer', receiver_id: RECIPIENT,
          tokens: { [BNB.assetId]: scenario.raw }, memo: 'liberdus chat payment',
        }]);
        const result = Array.from(new TextEncoder().encode('{}'));
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { result } });
      }
      if (method === 'publish_intent') {
        assert.deepEqual(request.params, [{ quote_hashes: null, signed_data: simulated }]);
        return Response.json({ result: { status: 'OK', intent_hash: INTENT_HASH } });
      }
      if (method === 'get_status') {
        assert.deepEqual(request.params, [{ intent_hash: INTENT_HASH }]);
        return Response.json({ result: { status: 'SETTLED', data: { hash: TRANSACTION_HASH } } });
      }
      assert.fail(`Unexpected offline payment request: ${method} at ${url}`);
    });
    const payments = new IntentsChatPayments({ getAccount: () => ({ keys: { address: SENDER } }) });
    const prepared = await payments.prepare({ asset: BNB, recipientAddress: RECIPIENT, amount: scenario.input });
    assert.equal(prepared.rawAmount, scenario.raw);
    assert.equal(prepared.payload.intents[0].tokens[BNB.assetId], scenario.raw);

    const { message } = await payments.send(prepared, SECRET, { asset: BNB, note: scenario.note });
    assert.deepEqual(requests, ['current_salt', 'simulate_intents', 'publish_intent', 'get_status']);
    assert.equal(message.note, scenario.note);
    assert.equal(Object.hasOwn(message, 'note'), scenario.note !== undefined);
    const receipt = parseTransferMessage(message);
    assert.ok(receipt, 'The production receipt parser accepts the payment that was sent');
    assert.equal(receipt.amount, scenario.amount);
    assert.equal(receipt.note, scenario.note ?? null);
    assert.equal(receipt.assetId, BNB.assetId);
    assert.equal(receipt.symbol, 'BNB');
    assert.equal(receipt.decimals, 18);
    assert.equal(receipt.transactionHash, TRANSACTION_HASH);
    assert.equal(prepared.amount, scenario.amount);
    assert.equal(message.amount, scenario.amount);
  });
}
