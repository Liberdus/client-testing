import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDaoProjectPresentation,
  getDaoProposalInfoStateLabel,
  getDaoProposalListFilterKey,
  getDaoRewardClaimStatus,
  shouldOpenDaoProjectMilestoneByDefault,
  shouldShowDaoProjectRuntime,
} from '../dao.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_ADDRESS = 'a'.repeat(40);
const ADDRESS = `${SHORT_ADDRESS}${'0'.repeat(24)}`;

function projectProposal(overrides = {}) {
  return {
    proposalType: 'project',
    status: 'executing',
    options: ['no', 'Fund project'],
    startTime: 1_000,
    reviewDuration: 100,
    votingDuration: 100,
    votingStartedAt: 1_100,
    votingEndedAt: 1_200,
    claimDuration: 10_000,
    gracePeriod: 0,
    voterRewardPool: '100',
    claimedReward: '0',
    voterList: [{ address: ADDRESS, timestamp: 1_150 }],
    claimList: [],
    project: {
      address: ADDRESS,
      balance: '5000000000000000000',
      rateUsdStr: '0.5',
      durationBonusPercentage: 20,
      durationPenaltyPercentage: 20,
      startTime: 1_300,
      endorsedAddress: [],
      milestones: [{
        title: 'Release',
        description: 'Build the release.',
        deliverable: 'Publish the release.',
        duration: 30 * DAY_MS,
        costUsdStr: '1000',
        penaltyUsdStr: '100',
        bonusUsdStr: '50',
        startTime: 1_400,
        proposedTime: 1_500,
        endorsedTime: [ADDRESS],
        terminateVotes: [{ address: ADDRESS, reason: 'Blocked', timestamp: 1_450 }],
        status: 'executing',
        paid: '0',
      }],
    },
    ...overrides,
  };
}

test('uses top-level project states for filters and labels', () => {
  for (const status of ['executing', 'completed', 'terminated']) {
    const proposal = projectProposal({ status });
    assert.equal(getDaoProposalListFilterKey(proposal), status);
    assert.equal(getDaoProposalInfoStateLabel(proposal), status[0].toUpperCase() + status.slice(1));
  }
});

test('normalizes the server project account shape', () => {
  const presentation = getDaoProjectPresentation(projectProposal());
  const [milestone] = presentation.milestones;

  assert.equal(presentation.kind, 'available');
  assert.equal(presentation.completeness, 'complete');
  assert.deepEqual(presentation.status, { key: 'executing', label: 'Executing' });
  assert.equal(presentation.balanceWei, 5_000_000_000_000_000_000n);
  assert.equal(presentation.rateUsdStr, '0.5');
  assert.equal(milestone.durationMs, 30 * DAY_MS);
  assert.deepEqual(milestone.status, { key: 'executing', label: 'Executing' });
  assert.equal(milestone.startTime, 1_400);
  assert.equal(milestone.endTime, null);
  assert.equal(milestone.proposedTime, 1_500);
  assert.deepEqual(milestone.endorsedTime, [SHORT_ADDRESS]);
  assert.equal(milestone.terminateVotes[0].reason, 'Blocked');
  assert.equal(milestone.paidWei, 0n);
});

test('opens only the executing milestone once a project is executing', () => {
  const project = getDaoProjectPresentation(projectProposal());

  assert.equal(shouldShowDaoProjectRuntime(project), true);
  assert.equal(shouldOpenDaoProjectMilestoneByDefault(project, 'executing', 0), true);
});

test('keeps voter rewards available after a project starts', () => {
  assert.equal(getDaoRewardClaimStatus(projectProposal(), ADDRESS, 1_500), 'Claimable');
});
