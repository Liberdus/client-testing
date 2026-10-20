import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { EthNum } from '../lib.js';

const wei = 10n ** 18n;
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const daoStart = appSource.indexOf('function getDaoUsdAsLibWei(');
const daoEnd = appSource.indexOf('// Snapshotted proposal USD rule', daoStart);
assert.ok(daoStart >= 0 && daoEnd > daoStart, 'DAO USD conversion wrapper exists');

class DaoConversionFixture {
  static create(price) {
    const context = { EthNum, parameters: { current: { stabilityFactorStr: price } } };
    runInNewContext(appSource.slice(daoStart, daoEnd), context);
    return context;
  }
}

for (const { usd, price, expected } of [
  { usd: '0.04', price: '0.008', expected: 5n * wei },
  { usd: '10', price: '0.2', expected: 50n * wei },
  { usd: '1', price: '0.3', expected: 3333333333333333333n },
  { usd: '0.000000000000000001', price: '0.2', expected: 5n },
  { usd: '0.000000000000000001', price: '2', expected: 0n },
  { usd: '0', price: '0.3', expected: 0n },
  { usd: '0001.00', price: '0.50', expected: 2n * wei },
  { usd: '.5', price: '1.', expected: wei / 2n },
  { usd: '10000000000000000.000000000000000001', price: '1', expected: 10000000000000000000000000000000001n },
  { usd: '1', price: '0.000000000000000001', expected: 10n ** 36n },
]) {
  test(`shared USD conversion keeps ${usd} / ${price} exact through native wei`, () => {
    assert.equal(EthNum.usdToWei(usd, price), expected);
  });
}

test('shared USD conversion rejects invalid amounts instead of accepting numeric coercion', () => {
  for (const amount of [
    undefined, null, 1, 1n, true, {}, [], NaN, Infinity,
    '', ' ', ' 1', '1 ', '-1', '+1', '1e-18', '1.2.3', '0x10', '1_000', '.', 'NaN', 'Infinity',
    '0.0000000000000000001',
  ]) {
    assert.throws(() => EthNum.usdToWei(amount, '0.2'), undefined, String(amount));
  }
});

test('shared USD conversion requires a strictly positive decimal quote even for zero USD', () => {
  for (const price of [
    undefined, null, 1, 1n, true, {}, [], NaN, Infinity,
    '', ' ', ' 1', '1 ', '0', '0.000000000000000000', '-0.2', '+0.2', '2e-1', '0.1.2', '0x10', '.',
    '0.0000000000000000001',
  ]) {
    assert.throws(() => EthNum.usdToWei('1', price), undefined, String(price));
    assert.throws(() => EthNum.usdToWei('0', price), undefined, `zero USD at ${String(price)}`);
  }
});

test('DAO conversion preserves trim and string normalization around the shared decimal API', () => {
  for (const { usd, price, expected } of [
    { usd: ' 0.04 ', price: ' 0.008 ', expected: 5n * wei },
    { usd: 0.04, price: 0.008, expected: 5n * wei },
    { usd: 0, price: '0.3', expected: 0n },
    { usd: '1', price: '0.3', expected: 3333333333333333333n },
    { usd: '0.000000000000000001', price: '2', expected: 0n },
  ]) {
    const fixture = DaoConversionFixture.create(price);
    assert.equal(fixture.getDaoUsdAsLibWei(usd), expected, String(usd));
  }
});

test('DAO conversion contains invalid amount and quote failures at its null boundary', () => {
  const fixture = DaoConversionFixture.create('0.2');
  for (const amount of [undefined, null, '', 'bad', -1, NaN, Infinity, true, {}, '1e-18', '1.0000000000000000001']) {
    assert.equal(fixture.getDaoUsdAsLibWei(amount), null, String(amount));
  }
  for (const price of [undefined, null, '', '0', '-0.2', 'bad', Infinity, '0.0000000000000000001']) {
    fixture.parameters.current.stabilityFactorStr = price;
    assert.equal(fixture.getDaoUsdAsLibWei('1'), null, String(price));
  }
});

test('DAO conversion reads the current quote and returns null when network parameters disappear', () => {
  const fixture = DaoConversionFixture.create('0.008');
  assert.equal(fixture.getDaoUsdAsLibWei('0.04'), 5n * wei);
  fixture.parameters.current.stabilityFactorStr = '0.01';
  assert.equal(fixture.getDaoUsdAsLibWei('0.04'), 4n * wei);
  fixture.parameters.current = null;
  assert.equal(fixture.getDaoUsdAsLibWei('0.04'), null);
  fixture.parameters = null;
  assert.equal(fixture.getDaoUsdAsLibWei('0.04'), null);
});
