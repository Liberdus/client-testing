import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAO_PROPOSAL_CREATE_TYPE,
  DAO_PROPOSAL_DAY_MS,
  buildDaoProjectProposalCreateDraft,
  buildDaoProposalCreateTransaction,
  getDaoProposalAccountId,
  getDaoProposalsMetaId,
} from '../dao.js';

const SHORT_ADDRESS = 'a'.repeat(40);
const LONG_ADDRESS = `${SHORT_ADDRESS}${'0'.repeat(24)}`;

function projectForm(overrides = {}) {
  return {
    address: SHORT_ADDRESS,
    ignoredRuntimeField: 'not submitted',
    milestones: [{
      title: 'Release',
      description: 'Build the release.',
      deliverable: 'Publish the release.',
      durationDays: '30',
      costUsdStr: '1000.25',
      penaltyUsdStr: '100.5',
      bonusUsdStr: '25',
      status: 'executing',
    }],
    ...overrides,
  };
}

function createDraft(project = projectForm()) {
  return buildDaoProjectProposalCreateDraft({
    from: LONG_ADDRESS,
    displayTitle: 'Fund a release',
    description: 'Ship the next release.',
    project,
    proposalFeeUsdStr: '10',
    reviewStartTimeMs: 0,
    gracePeriodMs: 5_000,
    maxGracePeriodMs: 10_000,
  });
}

test('builds a project draft with the exact server payload shape', () => {
  const draft = createDraft();

  assert.deepEqual(draft.transaction, {
    from: LONG_ADDRESS,
    proposalType: 'project',
    emergency: false,
    title: 'Fund a release',
    description: 'Ship the next release.',
    options: ['no', 'Fund project'],
    gracePeriod: 5_000,
    project: {
      address: LONG_ADDRESS,
      milestones: [{
        title: 'Release',
        description: 'Build the release.',
        deliverable: 'Publish the release.',
        duration: 30 * DAO_PROPOSAL_DAY_MS,
        costUsdStr: '1000.25',
        penaltyUsdStr: '100.5',
        bonusUsdStr: '25',
      }],
    },
  });
});

test('builds a signed-transaction payload without copying extra draft fields', () => {
  const draft = createDraft();
  draft.transaction.unexpected = true;
  draft.transaction.project.balance = '100';
  draft.transaction.project.milestones[0].paid = '100';

  const transaction = buildDaoProposalCreateTransaction({
    draft,
    timestamp: 1_000,
    networkId: 'localnet',
    proposalNumber: 7,
    maxGracePeriodMs: 10_000,
    proposalDurations: {
      reviewDuration: 1_000,
      votingDuration: 2_000,
      claimDuration: 3_000,
    },
  });

  assert.deepEqual(transaction, {
    type: DAO_PROPOSAL_CREATE_TYPE,
    timestamp: 1_000,
    networkId: 'localnet',
    from: LONG_ADDRESS,
    emergency: false,
    proposalType: 'project',
    title: 'Fund a release',
    description: 'Ship the next release.',
    options: ['no', 'Fund project'],
    gracePeriod: 5_000,
    project: {
      address: LONG_ADDRESS,
      milestones: [{
        title: 'Release',
        description: 'Build the release.',
        deliverable: 'Publish the release.',
        duration: 30 * DAO_PROPOSAL_DAY_MS,
        costUsdStr: '1000.25',
        penaltyUsdStr: '100.5',
        bonusUsdStr: '25',
      }],
    },
    proposalId: getDaoProposalAccountId(7),
    metaId: getDaoProposalsMetaId(),
  });
  assert.equal('unexpected' in transaction, false);
  assert.equal('balance' in transaction.project, false);
  assert.equal('paid' in transaction.project.milestones[0], false);
});

test('rejects a late penalty equal to or greater than milestone cost', () => {
  assert.throws(
    () => createDraft(projectForm({
      milestones: [{
        ...projectForm().milestones[0],
        costUsdStr: '10.0',
        penaltyUsdStr: '10',
      }],
    })),
    /late penalty must be less than its cost/,
  );
});

test('revalidates project-only proposal rules before signing', () => {
  const draft = createDraft();
  draft.transaction.emergency = true;

  assert.throws(
    () => buildDaoProposalCreateTransaction({
      draft,
      timestamp: 1_000,
      networkId: 'localnet',
      proposalNumber: 7,
      maxGracePeriodMs: 10_000,
      proposalDurations: {
        reviewDuration: 1_000,
        votingDuration: 2_000,
        claimDuration: 3_000,
      },
    }),
    /cannot be emergency proposals/,
  );
});
