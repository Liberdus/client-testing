import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDaoBackendFetcher,
  createDaoProposalVoteTracker,
  DAO_ACTION_TYPES,
  getDaoTrackedProposalMetadataEntries,
} from '../dao.js';

const ACCOUNT_A = '11'.repeat(20);
const ACCOUNT_B = '22'.repeat(20);

class VoteFixture {
  constructor() {
    this.accounts = new Map();
    this.selectAccount('network-a', ACCOUNT_A);
    this.tracker = createDaoProposalVoteTracker({
      getDaoUserVotes: () => this.getVotes(),
      setDaoUserVotes: (votes) => this.setVotes(votes),
    });
  }

  selectAccount(networkId, address) {
    const key = `${networkId}:${address}`;
    if (!this.accounts.has(key)) this.accounts.set(key, { daoUserVotes: {} });
    this.account = this.accounts.get(key);
  }

  getVotes() {
    return this.account.daoUserVotes;
  }

  setVotes(votes) {
    this.account.daoUserVotes = votes;
  }

  settle(overrides = {}) {
    this.tracker.handleSettlement({
      type: DAO_ACTION_TYPES.VOTE,
      outcome: 'success',
      proposalNumber: 12,
      ...overrides,
    });
  }
}

test('confirmed votes are deduplicated and isolated by network and account', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settle();
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);
  fixture.settle();

  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), [12]);
  assert.deepEqual(fixture.getVotes(), { 12: { claimStart: 1_000, claimEnd: 2_000 } });
  fixture.selectAccount('network-b', ACCOUNT_A);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);
  fixture.selectAccount('network-a', ACCOUNT_B);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);
  fixture.selectAccount('network-a', ACCOUNT_A);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), [12]);
});

test('only proposals with an open saved claim window are returned', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settle();
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);

  assert.deepEqual(tracker.getOpenClaimProposalNumbers(999), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(2_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(2_001), []);
});

test('a repeated confirmed vote preserves the original saved claim window', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settle();
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);
  fixture.settle({ votingEndsAt: 3_000, estimatedClaimEndsAt: 4_000, reminderExpiresAt: 5_000 });

  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), [12]);
  assert.equal(fixture.getVotes()[12].claimStart, 1_000);
  assert.equal(fixture.getVotes()[12].claimEnd, 2_000);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(3_500), []);
});

test('only a confirmed successful claim removes a tracked proposal', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;
  fixture.settle();
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);

  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'failure' });
  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'timeout' });
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), [12]);

  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD });
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);
  assert.deepEqual(fixture.getVotes(), {});
});

test('failed and timed-out votes are not tracked', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settle({ outcome: 'failure' });
  fixture.settle({ outcome: 'timeout' });

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), []);
  assert.deepEqual(fixture.getVotes(), {});
});

test('malformed account state and unavailable callbacks fail safely', (t) => {
  assert.throws(() => createDaoProposalVoteTracker({}), /account vote state accessors/);
  for (const votes of [null, '{bad json', [], { 12: null }]) {
    const fixture = new VoteFixture();
    fixture.setVotes(votes);
    assert.deepEqual(fixture.tracker.getOpenClaimProposalNumbers(1_500), []);
    assert.doesNotThrow(() => fixture.settle());
    assert.deepEqual(fixture.tracker.getPendingClaimProposalNumbers(), [12]);
  }

  const unreadable = new VoteFixture();
  t.mock.method(unreadable, 'getVotes', () => { throw new Error('unavailable'); });
  assert.deepEqual(unreadable.tracker.getOpenClaimProposalNumbers(1_500), []);
  assert.doesNotThrow(() => unreadable.settle());

  const unwritable = new VoteFixture();
  t.mock.method(unwritable, 'setVotes', () => { throw new Error('unavailable'); });
  assert.doesNotThrow(() => unwritable.settle());
  assert.deepEqual(unwritable.tracker.getPendingClaimProposalNumbers(), []);
  assert.deepEqual(unwritable.getVotes(), {});
});

test('tracked metadata candidates are selected without filtering by status', () => {
  const entries = [
    { proposal: 3, status: 'voting', emergencyFlag: false, timestamp: 300 },
    { proposal: 2, status: 'accepted', emergencyFlag: false, timestamp: 200 },
    { proposal: 1, status: 'rejected', emergencyFlag: false, timestamp: 100 },
  ];

  const selected = getDaoTrackedProposalMetadataEntries(entries, [3, 1, 999]);

  assert.deepEqual(selected.map((entry) => entry.proposal), [3, 1]);
  assert.deepEqual(selected.map((entry) => entry.status), ['voting', 'rejected']);
});

test('claim candidates request details only for tracked proposal numbers', async () => {
  const calls = [];
  const entries = [
    { proposal: 3, status: 'voting', emergencyFlag: false, timestamp: 300 },
    { proposal: 2, status: 'accepted', emergencyFlag: false, timestamp: 200 },
    { proposal: 1, status: 'rejected', emergencyFlag: false, timestamp: 100 },
  ];
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    const number = Number(path.split('/').at(-1));
    return {
      proposal: {
        id: `proposal-${number}`,
        number,
        proposalType: 'governance',
        creationTime: number,
      },
    };
  });

  const candidates = getDaoTrackedProposalMetadataEntries(entries, [3, 1]);
  await fetcher.fetchProposals(candidates);

  assert.deepEqual(calls, ['/dao/proposals/3', '/dao/proposals/1']);
});
