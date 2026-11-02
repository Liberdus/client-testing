import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDaoProposalClaimWindow,
  getDaoProposalTimeline,
  getDaoRewardClaimStatus,
} from '../dao.js';

const USER_ADDRESS = 'a'.repeat(40);

function proposal(overrides = {}) {
  return {
    status: 'voting',
    emergency: false,
    startTime: 1_000,
    reviewDuration: 100,
    votingDuration: 200,
    claimDuration: 50,
    gracePeriod: 25,
    voterRewardPool: 100n,
    claimedReward: 0n,
    voterList: [{ address: USER_ADDRESS, timestamp: 1_550 }],
    claimList: [],
    ...overrides,
  };
}

test('late review finalization moves the complete voting window', () => {
  const timeline = getDaoProposalTimeline(proposal({ votingStartedAt: 1_500 }));

  assert.deepEqual(timeline, {
    reviewStart: 1_000,
    reviewEnd: 1_100,
    votingStart: 1_500,
    votingEnd: 1_700,
    claimStart: 1_700,
    claimEnd: 1_750,
    applyEligibleAt: 1_725,
    votingDuration: 200,
  });
});

test('late vote finalization moves claim and apply timing', () => {
  const timeline = getDaoProposalTimeline(proposal({
    votingStartedAt: 1_500,
    votingEndedAt: 1_900,
  }));

  assert.equal(timeline.votingEnd, 1_700);
  assert.equal(timeline.claimStart, 1_900);
  assert.equal(timeline.claimEnd, 1_950);
  assert.equal(timeline.applyEligibleAt, 1_925);
});

test('pending transitions use the server scheduled fallbacks', () => {
  const timeline = getDaoProposalTimeline(proposal());

  assert.equal(timeline.votingStart, 1_100);
  assert.equal(timeline.votingEnd, 1_300);
  assert.equal(timeline.claimStart, 1_300);
  assert.equal(timeline.claimEnd, 1_350);
  assert.equal(timeline.applyEligibleAt, 1_325);
});

test('proposal snapshot durations win over proposed parameter changes', () => {
  const timeline = getDaoProposalTimeline(proposal({
    governance: {
      changes: [
        { key: 'votingDuration', value: 9_999 },
        { key: 'claimDuration', value: 8_888 },
      ],
    },
  }));

  assert.equal(timeline.votingEnd, 1_300);
  assert.equal(timeline.claimEnd, 1_350);
});

test('emergency proposals have no community voting duration', () => {
  const timeline = getDaoProposalTimeline(proposal({ emergency: true }));

  assert.equal(timeline.votingStart, 1_100);
  assert.equal(timeline.votingEnd, 1_100);
});

test('claim timing and its end boundary use the shared timeline', () => {
  const finalized = proposal({
    status: 'accepted',
    votingStartedAt: 1_500,
    votingEndedAt: 1_900,
  });

  assert.deepEqual(getDaoProposalClaimWindow(finalized), {
    start: 1_900,
    end: 1_950,
    votingStart: 1_500,
    votingDuration: 200,
  });
  assert.equal(getDaoRewardClaimStatus(finalized, USER_ADDRESS, 1_950), 'Claimable');
  assert.equal(getDaoRewardClaimStatus(finalized, USER_ADDRESS, 1_951), 'Claim window ended');
});
