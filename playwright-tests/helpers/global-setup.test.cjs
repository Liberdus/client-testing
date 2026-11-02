const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('global setup discovers the network from the resolved project URL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liberdus-global-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'global-setup.js'), 'utf8'), {
    require, module, Buffer, __dirname: path.join(root, 'helpers'),
  });

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/app/network.js') {
      res.end(`const network = { gateways: [{ web: 'http://127.0.0.1:${server.address().port}' }] };`);
    } else if (req.url === '/account/' + '0'.repeat(64)) {
      res.end(JSON.stringify({ account: { current: {
        stabilityFactorStr: '0.008', transactionFeeUsdStr: '0.01',
        minTollUsdStr: '0.05', tollNetworkTaxPercent: 1,
      } } }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseURL = `http://127.0.0.1:${server.address().port}/app/`;
  // A stale source config must not override the effective CI project URL.
  fs.writeFileSync(path.join(root, 'playwright.config.ts'),
    `export default { use: { baseURL: 'http://127.0.0.1:${server.address().port}/stale/' } };`);
  await module.exports({ projects: [{ use: { baseURL } }] });
  const cache = JSON.parse(fs.readFileSync(path.join(root, '.cache/network-params.json'), 'utf8'));
  assert.equal(cache.baseURL, baseURL);
  assert.equal(cache.gatewayWeb, `http://127.0.0.1:${server.address().port}`);
  assert.equal(cache.networkFeeLib, 1.25);
  assert.equal(cache.defaultTollLib, 6.25);
  assert.equal(cache.networkTollTax, 0.01);
  assert.deepEqual(requests, ['/app/network.js', '/account/' + '0'.repeat(64)]);

  await assert.rejects(module.exports({ projects: [{ use: {} }] }),
    /baseURL not found in resolved Playwright project config/);
});
