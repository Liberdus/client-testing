import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_ACTION_TYPES,
  buildDaoProjectMilestoneClaimTransaction,
  daoRepo,
  getDaoProjectMilestonePayout,
  getDaoTypeForLifecycleKind,
  isDaoTransactionType,
} from '../dao.js';

const WEI = 10n ** 18n;
const ADDRESS = 'a'.repeat(64);
const PROPOSAL_ID = 'b'.repeat(64);
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function projectProposal() {
  return {
    accountId: PROPOSAL_ID,
    proposalType: 'project',
    status: 'executing',
    project: {
      milestones: [{ status: 'completed' }, { status: 'pending' }],
    },
  };
}

function payoutProject() {
  return {
    rateUsdStr: '2',
    durationBonusPercentage: 20,
    durationPenaltyPercentage: 20,
  };
}

function payoutMilestone(actualDuration) {
  return {
    durationMs: 1_000,
    startTime: 1_000,
    endTime: 1_000 + actualDuration,
    costUsdStr: '100',
    penaltyUsdStr: '20',
    bonusUsdStr: '10',
  };
}

test('builds the exact one-based milestone claim transaction', () => {
  assert.deepEqual(buildDaoProjectMilestoneClaimTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    milestoneNumber: 1,
    timestamp: 1_000,
    networkId: 'localnet',
  }), {
    type: 'dao_project_milestone_claim',
    timestamp: 1_000,
    networkId: 'localnet',
    from: ADDRESS,
    proposalId: PROPOSAL_ID,
    milestoneNumber: 1,
  });
});

test('matches fixed-rate early, on-time, and late payout arithmetic', () => {
  assert.deepEqual(getDaoProjectMilestonePayout(payoutProject(), payoutMilestone(700)), {
    amountWei: 55n * WEI,
    speed: 'early',
  });
  assert.deepEqual(getDaoProjectMilestonePayout(payoutProject(), payoutMilestone(1_000)), {
    amountWei: 50n * WEI,
    speed: 'ontime',
  });
  assert.deepEqual(getDaoProjectMilestonePayout(payoutProject(), payoutMilestone(1_300)), {
    amountWei: 40n * WEI,
    speed: 'late',
  });
  assert.equal(getDaoProjectMilestonePayout({
    ...payoutProject(),
    durationBonusPercentage: null,
  }, payoutMilestone(700)), null);
});

test('registers and submits milestone claims through the repository', async () => {
  assert.equal(DAO_ACTION_TYPES.PROJECT_MILESTONE_CLAIM, 'dao_project_milestone_claim');
  assert.equal(getDaoTypeForLifecycleKind('project_milestone_claim'), 'dao_project_milestone_claim');
  assert.equal(isDaoTransactionType('dao_project_milestone_claim'), true);

  let submitted = null;
  const result = await daoRepo.claimProjectMilestone({
    from: ADDRESS,
    proposal: projectProposal(),
    milestoneNumber: 1,
    timestamp: 1_000,
    networkId: 'localnet',
    submitTransaction: async (transaction) => {
      submitted = transaction;
      return { result: { success: true }, txid: 'tx-1' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(submitted.type, 'dao_project_milestone_claim');
  assert.equal(submitted.milestoneNumber, 1);
});

test('shows claims only to the contractor for completed, unpaid milestones', () => {
  const start = appSource.indexOf('function getDaoProjectMilestoneClaimActions');
  const end = appSource.indexOf('function formatDaoClaimWindowLabel', start);
  const helperSource = appSource.slice(start, end);

  assert.match(helperSource, /state !== 'executing'.*state !== 'completed'.*state !== 'terminated'/s);
  assert.match(helperSource, /isDaoProjectContractor\(project, currentAddress\)/);
  assert.match(helperSource, /status\?\.key !== 'completed' \|\| milestone\.paidWei !== 0n/);
  assert.match(helperSource, /payout\.amountWei <= project\.balanceWei/);
  assert.match(appSource, /case 'project_milestone_claim':[\s\S]*claimProjectMilestone/);
});
