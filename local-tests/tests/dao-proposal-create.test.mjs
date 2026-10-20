import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDaoProposalCreateDraft,
  buildDaoProposalCreateTransaction,
  DAO_PROPOSAL_CREATE_TYPE,
} from '../dao.js';

const TIMESTAMP = 1_700_000_000_000;
const proposalDurations = {
  reviewDuration: 60_000,
  votingDuration: 60_000,
  claimDuration: 60_000,
};

function createDraft(overrides = {}) {
  return buildDaoProposalCreateDraft({
    from: 'a'.repeat(64),
    displayTitle: 'Update grace period',
    emergency: false,
    proposalType: 'governance',
    description: 'Adjust the grace period for regular proposals.',
    options: ['no', 'Shorter grace period', 'Longer grace period'],
    changes: [
      [{ key: 'graceDuration', value: '120000', current: '240000' }],
      [{ key: 'graceDuration', value: '360000', current: '240000' }],
    ],
    proposalFeeUsdStr: '5',
    reviewStartTimeMs: TIMESTAMP,
    gracePeriodMs: '120000',
    maxGracePeriodMs: '999999999999',
    ...overrides,
  });
}

test('builds a nested DAO proposal create transaction', () => {
  const draft = createDraft();
  const transaction = buildDaoProposalCreateTransaction({
    draft,
    timestamp: TIMESTAMP,
    networkId: 'testnet',
    proposalNumber: 7,
    maxGracePeriodMs: '999999999999',
    proposalDurations,
  });

  assert.equal(transaction.type, DAO_PROPOSAL_CREATE_TYPE);
  assert.deepEqual(transaction.options, ['no', 'Shorter grace period', 'Longer grace period']);
  assert.equal(transaction.governance.changes.length, 2);
  assert.equal(transaction.governance.changes[1][0].value, '360000');
});

test('rejects action options with a different parameter template', () => {
  assert.throws(() => createDraft({
    changes: [
      [{ key: 'graceDuration', value: '120000' }],
      [{ key: 'proposalFee', value: '5' }],
    ],
  }), /same parameters/);
});

test('rejects a change-set count that does not match action options', () => {
  assert.throws(() => createDraft({
    changes: [[{ key: 'graceDuration', value: '120000' }]],
  }), /must match its action options/);
});

test('keeps project proposals out of the parameter transaction builder', () => {
  assert.throws(() => createDraft({ proposalType: 'project' }), /type is not supported/);
});

test('rejects a review start time before the transaction timestamp', () => {
  const draft = createDraft({ reviewStartTimeMs: TIMESTAMP - 1 });
  assert.throws(() => buildDaoProposalCreateTransaction({
    draft,
    timestamp: TIMESTAMP,
    networkId: 'testnet',
    proposalNumber: 7,
    maxGracePeriodMs: '999999999999',
    proposalDurations,
  }), /must not be earlier/);
});
