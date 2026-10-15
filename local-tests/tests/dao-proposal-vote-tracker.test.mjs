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

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    getStoredValues() {
      return [...values.values()].map((value) => JSON.parse(value));
    },
  };
}

function settle(tracker, overrides = {}) {
  tracker.handleSettlement({
    type: DAO_ACTION_TYPES.VOTE,
    outcome: 'success',
    networkId: 'network-a',
    accountAddress: ACCOUNT_A,
    proposalNumber: 12,
    claimStart: 1_000,
    claimEnd: 2_000,
    ...overrides,
  });
}

test('confirmed votes are deduplicated and isolated by network and account', () => {
  const storage = createMemoryStorage();
  const tracker = createDaoProposalVoteTracker(storage);

  settle(tracker);
  settle(tracker);

  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-b', ACCOUNT_A, 1_500), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_B, 1_500), []);
  assert.deepEqual(storage.getStoredValues(), [[{
    proposalNumber: 12,
    claimStart: 1_000,
    claimEnd: 2_000,
  }]]);
});

test('only proposals with an open saved claim window are returned', () => {
  const tracker = createDaoProposalVoteTracker(createMemoryStorage());
  settle(tracker);

  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 999), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 2_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 2_001), []);
});

test('a repeated confirmed vote preserves the original saved claim window', () => {
  const tracker = createDaoProposalVoteTracker(createMemoryStorage());
  settle(tracker);
  settle(tracker, { claimStart: 3_000, claimEnd: 4_000 });

  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 3_500), []);
});

test('only a confirmed successful claim removes a tracked proposal', () => {
  const tracker = createDaoProposalVoteTracker(createMemoryStorage());
  settle(tracker);

  settle(tracker, { type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'failure' });
  settle(tracker, { type: DAO_ACTION_TYPES.CLAIM_REWARD, outcome: 'timeout' });
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), [12]);

  settle(tracker, { type: DAO_ACTION_TYPES.CLAIM_REWARD });
  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), []);
});

test('failed and timed-out votes are not tracked', () => {
  const tracker = createDaoProposalVoteTracker(createMemoryStorage());

  settle(tracker, { outcome: 'failure' });
  settle(tracker, { outcome: 'timeout' });

  assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), []);
});

test('malformed and unavailable storage fail safely', () => {
  const malformedStorage = {
    getItem() {
      return '{bad json';
    },
    setItem() {
      throw new Error('unavailable');
    },
  };
  const unavailableStorage = {
    getItem() {
      throw new Error('unavailable');
    },
    setItem() {
      throw new Error('unavailable');
    },
  };

  for (const storage of [null, malformedStorage, unavailableStorage]) {
    const tracker = createDaoProposalVoteTracker(storage);
    assert.deepEqual(tracker.getOpenClaimProposalNumbers('network-a', ACCOUNT_A, 1_500), []);
    assert.doesNotThrow(() => settle(tracker));
  }
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
