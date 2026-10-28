import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDaoBackendFetcher,
  createDaoProposalVoteTracker,
  DAO_ACTION_TYPES,
  DAO_USER_VOTE_CAST_STATUSES,
  getDaoTrackedProposalMetadataEntries,
} from '../dao.js';
import { parse, stringify } from '../external/stringify-shardus.js';

const ACCOUNT_A = '11'.repeat(20);
const ACCOUNT_B = '22'.repeat(20);
const TXID_A = 'a1'.repeat(32);
const TXID_B = 'b2'.repeat(32);
const SPEND = 5n * 10n ** 18n;
const SCHEDULE = { votingEndsAt: 3_000, estimatedClaimEndsAt: 4_000, reminderExpiresAt: 5_000 };

function castInput(txid, overrides = {}) {
  return { txid, weights: [0, 3, 1], spend: SPEND, timestamp: 1_700_000_000_000, ...overrides };
}

function expectedCast(txid, overrides = {}) {
  return {
    txid,
    weights: [0, 3, 1],
    spend: SPEND,
    optionWeights: null,
    timestamp: 1_700_000_000_000,
    status: DAO_USER_VOTE_CAST_STATUSES.PENDING,
    ...overrides,
  };
}

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

test('a confirmed vote appends a pending cast with the receipt option weights', () => {
  const fixture = new VoteFixture();
  const optionWeights = ['0', 300, { dataType: 'bi', value: '64' }];

  fixture.settle({ ...SCHEDULE, ...castInput(TXID_A, { optionWeights }) });

  assert.deepEqual(fixture.getVotes(), {
    12: { ...SCHEDULE, casts: [expectedCast(TXID_A, { optionWeights: [0n, 300n, 100n] })] },
  });
  assert.equal(typeof fixture.getVotes()[12].casts[0].spend, 'bigint');
  assert.deepEqual(fixture.tracker.getPendingClaimProposalNumbers(), [12]);

  // Receipts without usable option weights still record the cast.
  for (const badOptionWeights of [undefined, [], ['1', '2'], ['x', '1', '2']]) {
    const other = new VoteFixture();
    other.settle(castInput(TXID_B, { optionWeights: badOptionWeights }));
    assert.deepEqual(other.getVotes(), { 12: { casts: [expectedCast(TXID_B)] } });
  }
});

test('repeated confirmed votes append casts and deduplicate by txid', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settle({ ...SCHEDULE, ...castInput(TXID_A) });
  // A re-settled receipt for the same txid, even with different details, keeps the earlier cast.
  fixture.settle(castInput(TXID_A.toUpperCase(), { weights: [1, 0, 0], timestamp: 1 }));
  fixture.settle(castInput(TXID_B, { weights: [2, 0, 0], timestamp: 1_700_000_100_000 }));

  assert.deepEqual(fixture.getVotes(), {
    12: {
      ...SCHEDULE,
      casts: [
        expectedCast(TXID_A),
        expectedCast(TXID_B, { weights: [2, 0, 0], timestamp: 1_700_000_100_000 }),
      ],
    },
  });

  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(1_500), [12]);
  assert.equal(fixture.getVotes()[12].casts.length, 2);
});

test('schedule-only entries stay valid and are untouched by casts on other proposals', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settle(SCHEDULE);
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);
  fixture.settle({ proposalNumber: 13, ...castInput(TXID_A) });

  assert.deepEqual(fixture.getVotes(), {
    12: { ...SCHEDULE, claimStart: 1_000, claimEnd: 2_000 },
    13: { casts: [expectedCast(TXID_A)] },
  });
  assert.equal('casts' in fixture.getVotes()[12], false);

  // A later confirmed vote on the schedule-only proposal adds its cast and keeps the window.
  fixture.settle(castInput(TXID_B));
  assert.deepEqual(fixture.getVotes()[12], {
    ...SCHEDULE,
    claimStart: 1_000,
    claimEnd: 2_000,
    casts: [expectedCast(TXID_B)],
  });
});

test('failed and timed-out votes do not record casts', () => {
  const fixture = new VoteFixture();

  fixture.settle({ outcome: 'failure', ...SCHEDULE, ...castInput(TXID_A) });
  fixture.settle({ outcome: 'timeout', ...SCHEDULE, ...castInput(TXID_B) });
  assert.deepEqual(fixture.getVotes(), {});

  fixture.settle({ ...SCHEDULE, ...castInput(TXID_A) });
  fixture.settle({ outcome: 'failure', ...castInput(TXID_B) });
  assert.deepEqual(fixture.getVotes()[12].casts, [expectedCast(TXID_A)]);
});

test('a confirmed claim removes the tracked proposal together with its casts', () => {
  const fixture = new VoteFixture();
  const { tracker } = fixture;

  fixture.settle({ ...SCHEDULE, ...castInput(TXID_A) });
  tracker.setAuthoritativeClaimWindow(12, 1_000, 2_000);

  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'failure' });
  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'timeout' });
  assert.deepEqual(fixture.getVotes()[12].casts, [expectedCast(TXID_A)]);

  fixture.settle({ type: DAO_ACTION_TYPES.CLAIM_REWARD });
  assert.deepEqual(fixture.getVotes(), {});
});

test('malformed casts are dropped while the proposal entry is kept', () => {
  const fixture = new VoteFixture();
  const valid = castInput(TXID_A, { spend: { dataType: 'bi', value: SPEND.toString(16) } });
  fixture.setVotes({
    12: {
      ...SCHEDULE,
      casts: [
        valid,
        null,
        'not-a-cast',
        castInput('not-a-txid'),
        castInput(TXID_B, { weights: [1] }),
        castInput(TXID_B, { weights: ['1', 0, 0] }),
        castInput(TXID_B, { weights: [0, 0, 0] }),
        castInput(TXID_B, { spend: 0n }),
        castInput(TXID_B, { spend: -1 }),
        castInput(TXID_B, { timestamp: 0 }),
        { ...valid, weights: [1, 0, 0] },
        castInput(TXID_B, { status: 'confirmed', optionWeights: [1n, 2n, 3n] }),
      ],
    },
    13: { casts: 'not-an-array' },
    14: { casts: [castInput(TXID_B)] },
  });

  fixture.tracker.setAuthoritativeClaimWindow(14, 1_000, 2_000);

  assert.deepEqual(fixture.getVotes(), {
    12: {
      ...SCHEDULE,
      casts: [
        expectedCast(TXID_A),
        expectedCast(TXID_B, { optionWeights: [1n, 2n, 3n] }),
      ],
    },
    13: {},
    14: { claimStart: 1_000, claimEnd: 2_000, casts: [expectedCast(TXID_B)] },
  });
  assert.deepEqual(fixture.tracker.getPendingClaimProposalNumbers(), [12, 13]);
});

test('cast bigints survive the account stringify and parse round trip', () => {
  const fixture = new VoteFixture();
  fixture.settle({ ...SCHEDULE, ...castInput(TXID_A, { optionWeights: [0n, 300n, 100n] }) });

  const serialized = stringify({ daoUserVotes: fixture.getVotes() });
  assert.match(serialized, /"dataType":"bi"/);
  const restored = parse(serialized).daoUserVotes;
  assert.deepEqual(restored, fixture.getVotes());

  fixture.setVotes(restored);
  fixture.settle(castInput(TXID_A));
  assert.deepEqual(fixture.getVotes()[12].casts, [expectedCast(TXID_A, { optionWeights: [0n, 300n, 100n] })]);
});
