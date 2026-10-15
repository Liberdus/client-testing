import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDaoProposalVoteTracker,
  DAO_ACTION_TYPES,
} from '../dao.js';

const ACCOUNT = '11'.repeat(20);
const NETWORK = 'network-a';

function createMemoryStorage(initialValue = null) {
  const values = new Map();
  return {
    getItem(key) {
      if (values.has(key)) return values.get(key);
      return initialValue;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    getStoredEntries() {
      return JSON.parse([...values.values()][0]);
    },
  };
}

function settleVote(tracker) {
  tracker.handleSettlement({
    type: DAO_ACTION_TYPES.VOTE,
    outcome: 'success',
    networkId: NETWORK,
    accountAddress: ACCOUNT,
    proposalNumber: 12,
  });
}

test('confirmed votes remain pending until an authoritative claim window is saved', () => {
  const storage = createMemoryStorage();
  const tracker = createDaoProposalVoteTracker(storage);

  settleVote(tracker);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 1_500), []);
  assert.deepEqual(storage.getStoredEntries(), [{ proposalNumber: 12 }]);
});

test('an authoritative finalized window controls claim candidates', () => {
  const storage = createMemoryStorage();
  const tracker = createDaoProposalVoteTracker(storage);
  settleVote(tracker);

  tracker.setAuthoritativeClaimWindow(NETWORK, ACCOUNT, 12, 2_000, 3_000);

  assert.deepEqual(storage.getStoredEntries(), [{
    proposalNumber: 12,
    finalized: true,
    claimStart: 2_000,
    claimEnd: 3_000,
  }]);
  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 1_999), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 2_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 3_000), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 3_001), []);
});

test('estimated windows saved by older code are rechecked as pending', () => {
  const storage = createMemoryStorage(JSON.stringify([{
    proposalNumber: 12,
    claimStart: 1_000,
    claimEnd: 2_000,
  }]));
  const tracker = createDaoProposalVoteTracker(storage);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), [12]);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 1_500), []);

  tracker.setAuthoritativeClaimWindow(NETWORK, ACCOUNT, 12, 2_500, 3_500);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 3_000), [12]);
});

test('only tracked proposals can receive a claim window', () => {
  const storage = createMemoryStorage();
  const tracker = createDaoProposalVoteTracker(storage);

  tracker.setAuthoritativeClaimWindow(NETWORK, ACCOUNT, 12, 2_000, 3_000);

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 2_500), []);
});

test('expired authoritative windows are removed from storage', () => {
  const storage = createMemoryStorage();
  const tracker = createDaoProposalVoteTracker(storage);
  settleVote(tracker);
  tracker.setAuthoritativeClaimWindow(NETWORK, ACCOUNT, 12, 2_000, 3_000);

  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 3_001), []);
  assert.deepEqual(storage.getStoredEntries(), []);
});

test('a confirmed claim removes a tracked proposal', () => {
  const tracker = createDaoProposalVoteTracker(createMemoryStorage());
  settleVote(tracker);
  tracker.setAuthoritativeClaimWindow(NETWORK, ACCOUNT, 12, 2_000, 3_000);

  tracker.handleSettlement({
    type: DAO_ACTION_TYPES.CLAIM_REWARD,
    outcome: 'success',
    networkId: NETWORK,
    accountAddress: ACCOUNT,
    proposalNumber: 12,
  });

  assert.deepEqual(tracker.getPendingClaimProposalNumbers(NETWORK, ACCOUNT), []);
  assert.deepEqual(tracker.getOpenClaimProposalNumbers(NETWORK, ACCOUNT, 2_500), []);
});
