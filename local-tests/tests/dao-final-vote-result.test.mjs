import assert from 'node:assert/strict';
import test from 'node:test';

import {
  daoRepo,
  getDaoFinalVoteResult,
  setDaoBackendFetcher,
} from '../dao.js';

function proposal(overrides = {}) {
  return {
    status: 'rejected',
    options: ['no', 'Raise burn rate'],
    totalVote: [10n, 2n],
    ...overrides,
  };
}

test('negative-first rejection reports index zero as rejected', () => {
  assert.deepEqual(getDaoFinalVoteResult(proposal({ winningOptionIndex: 0 })), {
    outcome: 'Rejected',
    tone: 'rejected',
    totalWeight: 12n,
    winnerIndex: 0,
  });
});

test('negative-first action winner reports an accepted result', () => {
  assert.deepEqual(getDaoFinalVoteResult(proposal({
    status: 'accepted',
    totalVote: [2n, 10n],
    winningOptionIndex: 1,
  })), {
    outcome: 'Accepted',
    tone: 'accepted',
    totalWeight: 12n,
    winnerIndex: 1,
  });
});

test('stored winner index is authoritative after finalization', () => {
  assert.equal(getDaoFinalVoteResult(proposal({
    status: 'accepted',
    totalVote: [10n, 2n],
    winningOptionIndex: 1,
  })).winnerIndex, 1);
});

test('missing winner index falls back to totals and favors the lower index on ties', () => {
  assert.equal(getDaoFinalVoteResult(proposal({ totalVote: [5n, 5n] })).winnerIndex, 0);
  assert.equal(getDaoFinalVoteResult(proposal({ totalVote: [0n, 0n] })).winnerIndex, 0);
});

test('final status preserves legacy affirmative-first outcomes', () => {
  assert.deepEqual(getDaoFinalVoteResult(proposal({
    status: 'accepted',
    options: ['yes', 'no'],
    totalVote: [8n, 3n],
    winningOptionIndex: 0,
  })), {
    outcome: 'Accepted',
    tone: 'accepted',
    totalWeight: 11n,
    winnerIndex: 0,
  });
});

test('non-final and incomplete proposals have no final vote result', () => {
  assert.equal(getDaoFinalVoteResult(proposal({ status: 'voting' })), null);
  assert.equal(getDaoFinalVoteResult(proposal({ totalVote: [] })), null);
});

test('proposal list rows retain the authoritative winner index', async (t) => {
  const metadataEntry = {
    proposal: 1,
    status: 'rejected',
    emergencyFlag: false,
    timestamp: 1_000,
  };

  setDaoBackendFetcher({
    fetchMeta: async () => ({ count: 1, proposals: [metadataEntry] }),
    fetchProposals: async () => ({
      '1_proposal-1': {
        ...proposal({ winningOptionIndex: 0 }),
        number: 1,
        nonce: 'proposal-1',
      },
    }),
  });
  daoRepo.reset();
  t.after(() => {
    setDaoBackendFetcher(null);
    daoRepo.reset();
  });

  await daoRepo.refresh({ force: true });
  await daoRepo.loadProposalEntries([metadataEntry]);

  assert.equal(daoRepo.getProposalsForUi()[0].winningOptionIndex, 0);
});
