import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_CONFIG_CHANGE_OPTIONS,
  isValidDaoDecimalString,
} from '../dao.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const configOptions = Object.values(DAO_CONFIG_CHANGE_OPTIONS).flat();

test('renders the DAO path and backend-aligned value type', () => {
  assert.match(
    appSource,
    /<div class="dao-form-meta">\$\{escapeHtml\(option\.path\)\} · \$\{escapeHtml\(option\.valueType\)\}<\/div>/,
  );
});

test('separates backend value types from frontend validation rules', () => {
  const optionsByKey = new Map(configOptions.map((option) => [option.key, option]));

  assert.deepEqual(
    [optionsByKey.get('claimDuration').valueType, optionsByKey.get('claimDuration').validation],
    ['number', 'integer'],
  );
  assert.deepEqual(
    [optionsByKey.get('voteExponent').valueType, optionsByKey.get('voteExponent').validation],
    ['number', 'decimal'],
  );
  assert.deepEqual(
    [optionsByKey.get('proposalFeeUsdStr').valueType, optionsByKey.get('proposalFeeUsdStr').validation],
    ['string', 'decimalString'],
  );
  assert.equal(optionsByKey.get('txPause').valueType, 'boolean');
  assert.equal(optionsByKey.get('txPause').validation, 'boolean');
  assert.equal(configOptions.some((option) => option.valueType === 'float' || !option.validation), false);
  assert.deepEqual(
    [...new Set(configOptions.map((option) => `${option.valueType}:${option.validation}`))].sort(),
    ['array:committeeAddresses', 'boolean:boolean', 'number:decimal', 'number:integer', 'string:decimalString'],
  );
});

test('accepts only canonical non-negative decimal strings with up to 18 decimals', () => {
  for (const value of ['0', '50', '50.0', '0.25', '1.000000000000000001']) {
    assert.equal(isValidDaoDecimalString(value), true, `${value} should be valid`);
  }

  for (const value of [
    '',
    'words',
    '12abc',
    '1e3',
    '-5',
    'Infinity',
    'NaN',
    '01.5',
    '1.',
    '.5',
    '1.0000000000000000001',
  ]) {
    assert.equal(isValidDaoDecimalString(value), false, `${value} should be invalid`);
  }
});

test('renders decimal strings as text and runtime decimals as number inputs', () => {
  assert.match(
    appSource,
    /case 'string:decimalString':[\s\S]*type="text" inputmode="decimal"/,
  );
  assert.match(
    appSource,
    /case 'number:decimal':[\s\S]*type="number" step="any" inputmode="decimal"/,
  );
  assert.match(appSource, /isValidDaoDecimalString\(value\)/);
});
