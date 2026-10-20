import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEvmAssetHistoryUrl, evmAssets } from '../evm-assets.js';

const WALLET_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_ADDRESS = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

test('configures explorers for the baseline EVM networks', () => {
  const explorers = Object.fromEntries(
    evmAssets.getEvmCatalog().map((network) => [network.id, network.explorerUrl]),
  );

  assert.deepEqual(explorers, {
    ethereum: 'https://etherscan.io',
    bsc: 'https://bscscan.com',
    polygon: 'https://polygonscan.com',
  });
});

test('builds native asset transaction URLs for the wallet address', () => {
  const url = buildEvmAssetHistoryUrl(
    { explorerUrl: 'https://etherscan.io' },
    { contractAddress: null },
    WALLET_ADDRESS,
  );

  assert.equal(
    url,
    'https://etherscan.io/address/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#transactions',
  );
});

test('builds token transaction URLs with the token and wallet addresses', () => {
  const url = buildEvmAssetHistoryUrl(
    { explorerUrl: 'https://bscscan.com' },
    { contractAddress: TOKEN_ADDRESS },
    WALLET_ADDRESS,
  );

  assert.equal(
    url,
    'https://bscscan.com/token/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?a=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#transactions',
  );
});

test('supports configured HTTPS explorers for discovered networks', () => {
  const url = buildEvmAssetHistoryUrl(
    { explorerUrl: 'https://explorer.example/network' },
    { contractAddress: null },
    WALLET_ADDRESS,
  );

  assert.equal(
    url,
    'https://explorer.example/network/address/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#transactions',
  );
});

test('rejects missing and unsafe explorer configurations', () => {
  assert.equal(
    buildEvmAssetHistoryUrl({}, { contractAddress: null }, WALLET_ADDRESS),
    null,
  );
  assert.equal(
    buildEvmAssetHistoryUrl(
      { explorerUrl: 'http://explorer.example' },
      { contractAddress: null },
      WALLET_ADDRESS,
    ),
    null,
  );
});
