import assert from 'node:assert/strict';
import test from 'node:test';

import { getDaoPendingFinalizationOutcome } from '../dao.js';

function proposal(overrides = {}) {
  return {
    status: 'review',
    emergency: false,
    startTime: 1_000,
    reviewDuration: 100,
    votingDuration: 200,
    claimDuration: 50,
    gracePeriod: 25,
    committeeVotes: [],
    totalVote: [0n, 0n],
    ...overrides,
  };
}

test('regular review with no committee votes moves to voting after the deadline', () => {
  assert.deepEqual(getDaoPendingFinalizationOutcome(proposal(), 1_101), {
    nextState: 'voting',
    message: 'No committee votes were cast. Finalizing the review moves this proposal to Voting.',
  });
});

test('emergency review with no committee votes is withheld after the deadline', () => {
  assert.deepEqual(getDaoPendingFinalizationOutcome(proposal({ emergency: true }), 1_101), {
    nextState: 'withheld',
    message: 'No committee votes were cast. Finalizing the review withholds this proposal.',
  });
});

test('voting with zero recorded weight is rejected after the deadline', () => {
  assert.deepEqual(getDaoPendingFinalizationOutcome(proposal({ status: 'voting' }), 1_301), {
    nextState: 'rejected',
    message: 'No votes were cast. Finalizing the vote result rejects this proposal because the default No change option wins.',
  });
});

test('Project voting with zero recorded weight names the Reject option', () => {
  assert.deepEqual(getDaoPendingFinalizationOutcome(proposal({
    status: 'voting',
    proposalType: 'project',
  }), 1_301), {
    nextState: 'rejected',
    message: 'No votes were cast. Finalizing the vote result rejects this proposal because the default Reject option wins.',
  });
});
