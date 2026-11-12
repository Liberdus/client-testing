import assert from 'node:assert/strict';

class NearRpcFixture {
  static async fetch(url, options = {}) {
    const request = JSON.parse(options.body ?? '{}');
    assert.ok(
      request.method === 'query' &&
      request.params?.account_id === 'intents.near' &&
      request.params?.method_name === 'current_salt',
      `Unexpected request in offline NEAR tests: ${url}`,
    );
    // Fixed contract-vector salt; every other request fails without using the network.
    const result = Array.from(new TextEncoder().encode(JSON.stringify('252812b3')));
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { result } });
  }
}

globalThis.fetch = NearRpcFixture.fetch;
