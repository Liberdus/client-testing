import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accumulateDaoUserVoteCasts,
  getDaoUserVoteSummary,
  normalizeDaoUserVoteCast,
} from '../dao.js';

const USER_ADDRESS = 'a'.repeat(40);
const OTHER_ADDRESS = 'b'.repeat(40);

function proposal(overrides = {}) {
  return {
    options: ['yes', 'no'],
    voterList: [],
    ...overrides,
  };
}

test('normalizeDaoUserVoteCast requires matching weights and positive spend', () => {
  assert.equal(normalizeDaoUserVoteCast({ weights: [1, 0], spend: 0n }, 2), null);
  assert.equal(normalizeDaoUserVoteCast({ weights: [1], spend: 10n }, 2), null);
  assert.deepEqual(
    normalizeDaoUserVoteCast({
      weights: [3, 1],
      spend: 25n,
      optionWeights: [12n, 4n],
      timestamp: 1_500,
      txid: 'abc',
    }, 2),
    {
      txid: 'abc',
      weights: [3, 1],
      spend: 25n,
      optionWeights: [12n, 4n],
      timestamp: 1_500,
    }
  );
});

test('accumulateDaoUserVoteCasts sums spend and power across casts', () => {
  const accumulated = accumulateDaoUserVoteCasts([
    { weights: [1, 0], spend: 10n, optionWeights: [5n, 0n], timestamp: 1_000 },
    { weights: [1, 1], spend: 20n, optionWeights: [3n, 3n], timestamp: 2_000 },
  ], 2);

  assert.deepEqual(accumulated, {
    weights: [1, 1],
    spend: 30n,
    optionWeights: [8n, 3n],
    timestamp: 2_000,
  });
});

test('getDaoUserVoteSummary returns none when the user has not voted', () => {
  assert.deepEqual(
    getDaoUserVoteSummary({
      proposal: proposal({
        voterList: [{ address: OTHER_ADDRESS, timestamp: 1_000 }],
      }),
      address: USER_ADDRESS,
      casts: [],
    }),
    { kind: 'none' }
  );
});

test('getDaoUserVoteSummary returns voted-only when network lists the user without local casts', () => {
  assert.deepEqual(
    getDaoUserVoteSummary({
      proposal: proposal({
        voterList: [{ address: USER_ADDRESS, timestamp: 1_250 }],
      }),
      address: USER_ADDRESS,
      casts: [],
    }),
    { kind: 'voted', timestamp: 1_250 }
  );
});

test('getDaoUserVoteSummary returns option rows with spend and power when casts exist', () => {
  const summary = getDaoUserVoteSummary({
    proposal: proposal({
      voterList: [{ address: USER_ADDRESS, timestamp: 1_250 }],
    }),
    address: USER_ADDRESS,
    casts: [{
      weights: [3, 1],
      spend: 40n,
      optionWeights: [30n, 10n],
      timestamp: 1_300,
    }],
  });

  assert.equal(summary.kind, 'detail');
  assert.equal(summary.spend, 40n);
  assert.equal(summary.totalPower, 40n);
  assert.deepEqual(summary.rows, [
    { option: 'yes', weight: 3, share: 0.75, power: 30n },
    { option: 'no', weight: 1, share: 0.25, power: 10n },
  ]);
});

test('getDaoUserVoteSummary falls back to allocation shares when power is unavailable', () => {
  const summary = getDaoUserVoteSummary({
    proposal: proposal(),
    address: USER_ADDRESS,
    casts: [{ weights: [1, 1], spend: 12n, timestamp: 900 }],
  });

  assert.equal(summary.kind, 'detail');
  assert.equal(summary.totalPower, null);
  assert.deepEqual(summary.rows, [
    { option: 'yes', weight: 1, share: 0.5, power: null },
    { option: 'no', weight: 1, share: 0.5, power: null },
  ]);
});
