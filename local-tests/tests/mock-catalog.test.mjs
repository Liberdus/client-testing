import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const production = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const catalogSource = await readFile(new URL('../mock/modal-catalog-data.js', import.meta.url), 'utf8');
const globals = { window: {} };
runInNewContext(catalogSource, globals);
const { MODAL_CATALOG: catalog, MODAL_CATALOG_SOURCE: hash, PRODUCTION_WALLET_MARKUP: wallet } = globals.window;

test('mock catalog was generated from the selected client revision', () => {
  assert.equal(hash, createHash('sha256').update(production).digest('hex'), 'Run node mock/generate-modal-catalog.mjs after production HTML changes');
});

test('mock catalog covers every production modal once, including separate EVM transfer forms', () => {
  const productionIds = [...production.matchAll(/<div\b[^>]*>/g)]
    .filter(([tag]) => (tag.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).includes('modal'))
    .map(([tag]) => tag.match(/\bid="([^"]+)"/)?.[1]);
  const catalogIds = Array.from(catalog, ({ id }) => id);
  assert.equal(new Set(catalogIds).size, catalogIds.length, 'Duplicate catalog modal IDs');
  assert.deepEqual(catalogIds.sort(), productionIds.sort());
  for (const id of ['sendAssetFormModal', 'sendAssetConfirmModal', 'receiveModal', 'evmSendModal', 'evmSendConfirmModal', 'evmReceiveModal']) {
    assert.ok(catalogIds.includes(id), `Missing distinct transfer modal: ${id}`);
  }
  for (const id of ['evmSendModal', 'evmSendConfirmModal', 'evmReceiveModal']) {
    assert.equal(catalog.find(entry => entry.id === id).category, 'EVM Assets');
  }
  for (const id of ['evmAssetsSummaryValue', 'multichainSummaryValue', 'assetsList', 'refreshBalance']) {
    assert.ok(wallet.includes(`id="${id}"`), `Wallet overview must preserve production hook ${id}`);
  }
});
