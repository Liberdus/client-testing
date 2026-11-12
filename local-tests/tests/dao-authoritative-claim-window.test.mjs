import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDaoProposalVoteTracker,
  DAO_ACTION_TYPES,
} from '../dao.js';

class VoteFixture {
  constructor(votes = {}) {
    this.votes = votes;
    this.tracker = createDaoProposalVoteTracker({
      getDaoUserVotes: () => this.votes,
      setDaoUserVotes: (value) => { this.votes = value; },
    });
  }

  settleVote() {
    this.tracker.handleSettlement({
      type: DAO_ACTION_TYPES.VOTE,
      outcome: 'success',
      proposalNumber: 12,
    });
  }
}

test('confirmed votes remain pending until an authoritative claim window is saved', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settleVote();

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);
  assert.deepEqual(fixture.votes, { 12: {} });
});

test('an authoritative finalized window controls claim candidates', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settleVote();

  tracker.setAuthoritativeClaimWindow(12, 2_000, 3_000);

  assert.deepEqual(fixture.votes, { 12: { claimStart: 2_000, claimEnd: 3_000 } });
  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_999), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(2_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(3_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(3_001), []);
});

test('saved reminder estimates remain pending until an authoritative window is available', () => {
  const fixture = new VoteFixture({
    12: { votingEndsAt: 1_000, estimatedClaimEndsAt: 2_000, reminderExpiresAt: 3_000 },
  });
  const { tracker } = fixture;

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);

  tracker.setAuthoritativeClaimWindow(12, 2_500, 3_500);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(3_000), [12]);
  assert.deepEqual(fixture.votes, {
    12: {
      votingEndsAt: 1_000,
      estimatedClaimEndsAt: 2_000,
      reminderExpiresAt: 3_000,
      claimStart: 2_500,
      claimEnd: 3_500,
    },
  });
});

test('only tracked proposals can receive a claim window', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  tracker.setAuthoritativeClaimWindow(12, 2_000, 3_000);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(2_500), []);
  assert.deepEqual(fixture.votes, {});
});

test('expired authoritative windows are removed from account state', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settleVote();
  tracker.setAuthoritativeClaimWindow(12, 2_000, 3_000);

  assert.deepEqual(tracker.getOpenClaimProposalNumbers(3_001), []);
  assert.deepEqual(fixture.votes, {});
});

test('a confirmed claim removes a tracked proposal', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settleVote();
  tracker.setAuthoritativeClaimWindow(12, 2_000, 3_000);

  tracker.handleSettlement({
    type: DAO_ACTION_TYPES.CLAIM_REWARD,
    outcome: 'success',
    proposalNumber: 12,
  });

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(2_500), []);
  assert.deepEqual(fixture.votes, {});
});
