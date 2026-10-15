import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_ACTION_TYPES,
  DAO_PROJECT_RECLAIM_DELAY_MS,
  buildDaoProjectChangeAddressTransaction,
  buildDaoProjectEndTransaction,
  buildDaoProjectReclaimBalanceTransaction,
  daoRepo,
  getDaoTypeForLifecycleKind,
  isDaoTransactionType,
} from '../dao.js';

const ADDRESS = 'a'.repeat(64);
const NEW_ADDRESS = 'c'.repeat(40);
const PROPOSAL_ID = 'b'.repeat(64);
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function projectProposal() {
  return {
    accountId: PROPOSAL_ID,
    proposalType: 'project',
    status: 'executing',
    project: {
      milestones: [{ status: 'completed' }, { status: 'terminated' }],
    },
  };
}

function baseTransaction(type) {
  return {
    type,
    timestamp: 1_000,
    networkId: 'localnet',
    from: ADDRESS,
    proposalId: PROPOSAL_ID,
  };
}

test('builds exact contractor proposal and endorsement transactions', () => {
  assert.deepEqual(buildDaoProjectChangeAddressTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    proposedAddress: `0x${NEW_ADDRESS}`,
    timestamp: 1_000,
    networkId: 'localnet',
  }), {
    ...baseTransaction('dao_project_change_address'),
    proposedAddress: `${NEW_ADDRESS}${'0'.repeat(24)}`,
  });

  assert.deepEqual(buildDaoProjectChangeAddressTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    expectedProposedAddress: `0x${NEW_ADDRESS.toUpperCase()}`,
    timestamp: 1_000,
    networkId: 'localnet',
  }), {
    ...baseTransaction('dao_project_change_address'),
    expectedProposedAddress: `${NEW_ADDRESS}${'0'.repeat(24)}`,
  });

  assert.throws(() => buildDaoProjectChangeAddressTransaction({
    from: ADDRESS,
    proposal: {
      ...projectProposal(),
      project: { ...projectProposal().project, address: `${NEW_ADDRESS}${'0'.repeat(24)}` },
    },
    proposedAddress: NEW_ADDRESS,
    timestamp: 1_000,
    networkId: 'localnet',
  }), /already the contractor address/);
});

test('requires an exact valid expected address for endorsements', () => {
  const request = {
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
  };
  for (const expectedProposedAddress of [undefined, null, '', 'invalid', 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(64)]) {
    assert.throws(() => buildDaoProjectChangeAddressTransaction({ ...request, expectedProposedAddress }));
  }
  assert.deepEqual(buildDaoProjectChangeAddressTransaction({
    ...request,
    expectedProposedAddress: `${NEW_ADDRESS}${'0'.repeat(24)}`,
  }), {
    ...baseTransaction('dao_project_change_address'),
    expectedProposedAddress: `${NEW_ADDRESS}${'0'.repeat(24)}`,
  });
});

test('rejects mixed address proposal and endorsement fields', () => {
  for (const expectedProposedAddress of [NEW_ADDRESS, null]) {
    assert.throws(() => buildDaoProjectChangeAddressTransaction({
      from: ADDRESS,
      proposal: projectProposal(),
      proposedAddress: NEW_ADDRESS,
      expectedProposedAddress,
      timestamp: 1_000,
      networkId: 'localnet',
    }));
  }
});

test('builds exact project end and reclaim transactions', () => {
  assert.deepEqual(buildDaoProjectEndTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
  }), baseTransaction('dao_project_end'));
  assert.deepEqual(buildDaoProjectReclaimBalanceTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
  }), baseTransaction('dao_project_reclaim_balance'));
});

test('registers every closeout transaction and the 90-day reclaim delay', () => {
  assert.equal(DAO_PROJECT_RECLAIM_DELAY_MS, 90 * 24 * 60 * 60 * 1_000);
  for (const [kind, type] of [
    ['project_change_address', DAO_ACTION_TYPES.PROJECT_CHANGE_ADDRESS],
    ['project_end', DAO_ACTION_TYPES.PROJECT_END],
    ['project_reclaim_balance', DAO_ACTION_TYPES.PROJECT_RECLAIM_BALANCE],
  ]) {
    assert.equal(getDaoTypeForLifecycleKind(kind), type);
    assert.equal(isDaoTransactionType(type), true);
  }
});

test('submits project closeout transactions through the repository', async () => {
  const submitted = [];
  const request = {
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
    submitTransaction: async (transaction) => {
      submitted.push(transaction);
      return { result: { success: true }, txid: `tx-${submitted.length}` };
    },
  };

  assert.equal((await daoRepo.changeProjectAddress({ ...request, proposedAddress: NEW_ADDRESS })).ok, true);
  assert.equal((await daoRepo.changeProjectAddress({ ...request, expectedProposedAddress: NEW_ADDRESS })).ok, true);
  assert.equal((await daoRepo.endProject(request)).ok, true);
  assert.equal((await daoRepo.reclaimProjectBalance(request)).ok, true);
  assert.deepEqual(submitted.map((transaction) => transaction.type), [
    'dao_project_change_address',
    'dao_project_change_address',
    'dao_project_end',
    'dao_project_reclaim_balance',
  ]);
  assert.equal('expectedProposedAddress' in submitted[0], false);
  assert.equal('proposedAddress' in submitted[1], false);
  assert.equal(submitted[1].expectedProposedAddress, `${NEW_ADDRESS}${'0'.repeat(24)}`);
});

test('missing address endorsement target is rejected before signing', async () => {
  let signatures = 0;
  const result = await daoRepo.changeProjectAddress({
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
    submitTransaction: async () => { signatures += 1; },
  });

  assert.equal(result.ok, false);
  assert.equal(signatures, 0);
});

test('matches server eligibility and routes every closeout UI action', () => {
  const start = appSource.indexOf('function getDaoProjectAddressChangeActions');
  const end = appSource.indexOf('function formatDaoClaimWindowLabel', start);
  const helperSource = appSource.slice(start, end);

  assert.match(helperSource, /state === 'executing'/);
  assert.match(helperSource, /state === 'completed'.*state === 'terminated'/s);
  assert.match(helperSource, /project\.balanceWei > 0n/);
  assert.match(helperSource, /milestone\.status\?\.key === 'completed'.*milestone\.status\?\.key === 'terminated'/s);
  assert.match(helperSource, /project\.endTime \+ DAO_PROJECT_RECLAIM_DELAY_MS/);
  assert.match(appSource, /case 'project_change_address':[\s\S]*changeProjectAddress/);
  assert.match(appSource, /case 'project_end':[\s\S]*endProject/);
  assert.match(appSource, /case 'project_reclaim_balance':[\s\S]*reclaimProjectBalance/);
});
