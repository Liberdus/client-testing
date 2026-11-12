import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_ACTION_TYPES,
  buildDaoProjectMilestoneEndTransaction,
  buildDaoProjectMilestoneStartTransaction,
  buildDaoProjectMilestoneTerminateTransaction,
  daoRepo,
  getDaoTypeForLifecycleKind,
  isDaoTransactionType,
} from '../dao.js';

const ADDRESS = 'a'.repeat(64);
const PROPOSAL_ID = 'b'.repeat(64);
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function projectProposal() {
  return {
    accountId: PROPOSAL_ID,
    proposalType: 'project',
    status: 'executing',
    project: {
      milestones: [{ status: 'pending' }, { status: 'pending' }],
    },
  };
}

for (const [type, builder] of [
  ['dao_project_milestone_start', buildDaoProjectMilestoneStartTransaction],
  ['dao_project_milestone_end', buildDaoProjectMilestoneEndTransaction],
]) {
  function request(fields = {}) {
    return {
      from: ADDRESS,
      proposal: projectProposal(),
      milestoneNumber: 2,
      timestamp: 1_000,
      networkId: 'localnet',
      ...fields,
    };
  }

  test(`${type} binds proposals and endorsements to the reviewed milestone`, () => {
    const base = {
      type,
      from: ADDRESS,
      proposalId: PROPOSAL_ID,
      milestoneNumber: 2,
      timestamp: 1_000,
      networkId: 'localnet',
    };
    assert.deepEqual(builder(request({ proposedTime: 900 })), { ...base, proposedTime: 900 });
    assert.deepEqual(builder(request({ expectedProposedTime: 900 })), {
      ...base,
      expectedProposedTime: 900,
    });
  });

  test(`${type} rejects absent, fractional, and out-of-range milestone targets`, () => {
    for (const milestoneNumber of [undefined, null, 0, -1, 3, 1.5, 'invalid']) {
      assert.throws(() => builder(request({ milestoneNumber, proposedTime: 900 })));
    }
  });

  test(`${type} requires a valid exact time for endorsements`, () => {
    for (const expectedProposedTime of [undefined, null, 0, -1, 1_001, NaN, Infinity, 'invalid']) {
      assert.throws(() => builder(request({ expectedProposedTime })));
    }
  });

  test(`${type} rejects contradictory proposal and endorsement fields`, () => {
    assert.throws(() => builder(request({ proposedTime: 900, expectedProposedTime: 900 })));
    assert.throws(() => builder(request({ proposedTime: 900, expectedProposedTime: null })));
  });

  test(`${type} rejects proposed times later than the signing timestamp`, () => {
    assert.throws(
      () => builder(request({ proposedTime: 1_001 })),
      /cannot be later than the transaction timestamp/,
    );
  });
}

test('builds a reasoned, one-based milestone termination transaction', () => {
  const transaction = buildDaoProjectMilestoneTerminateTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    milestoneNumber: 2,
    reason: '  Requirements changed.  ',
    timestamp: 1_000,
    networkId: 'localnet',
  });

  assert.deepEqual(transaction, {
    type: 'dao_project_milestone_terminate',
    timestamp: 1_000,
    networkId: 'localnet',
    from: ADDRESS,
    proposalId: PROPOSAL_ID,
    milestoneNumber: 2,
    reason: 'Requirements changed.',
  });
  assert.throws(
    () => buildDaoProjectMilestoneTerminateTransaction({
      from: ADDRESS,
      proposal: projectProposal(),
      milestoneNumber: 3,
      reason: 'Out of range',
      timestamp: 1_000,
      networkId: 'localnet',
    }),
    /between 1 and 2/,
  );
});

test('registers all milestone actions for pending settlement', () => {
  const cases = [
    ['project_milestone_start', DAO_ACTION_TYPES.PROJECT_MILESTONE_START],
    ['project_milestone_end', DAO_ACTION_TYPES.PROJECT_MILESTONE_END],
    ['project_milestone_terminate', DAO_ACTION_TYPES.PROJECT_MILESTONE_TERMINATE],
  ];
  for (const [kind, type] of cases) {
    assert.equal(getDaoTypeForLifecycleKind(kind), type);
    assert.equal(isDaoTransactionType(type), true);
  }
});

test('passes milestone-only fields through the repository boundary', async () => {
  const submitted = [];
  const common = {
    from: ADDRESS,
    proposal: projectProposal(),
    milestoneNumber: 2,
    timestamp: 1_000,
    networkId: 'localnet',
    submitTransaction: async (transaction) => {
      submitted.push(transaction);
      return { result: { success: true }, txid: `tx-${submitted.length}` };
    },
  };

  await daoRepo.startProjectMilestone({ ...common, proposedTime: 1_000 });
  await daoRepo.endProjectMilestone({ ...common, expectedProposedTime: 900 });
  await daoRepo.terminateProjectMilestone({
    ...common,
    milestoneNumber: 1,
    reason: 'Blocked',
  });

  assert.equal(submitted[0].proposedTime, 1_000);
  assert.equal(submitted[0].milestoneNumber, 2);
  assert.equal('expectedProposedTime' in submitted[0], false);
  assert.equal('proposedTime' in submitted[1], false);
  assert.equal(submitted[1].expectedProposedTime, 900);
  assert.equal(submitted[1].milestoneNumber, 2);
  assert.equal(submitted[2].milestoneNumber, 1);
  assert.equal(submitted[2].reason, 'Blocked');
});

test('renders role-aware propose, endorse, and termination controls', () => {
  const helperStart = appSource.indexOf('function getDaoProjectMilestoneTimeAction');
  const helperEnd = appSource.indexOf('function formatDaoClaimWindowLabel', helperStart);
  const helperSource = appSource.slice(helperStart, helperEnd);

  assert.match(helperSource, /isDaoProposalCommitteeMember/);
  assert.match(helperSource, /isDaoProjectContractor/);
  assert.match(helperSource, /Only a proposal committee member can endorse/);
  assert.match(helperSource, /status\?\.key !== 'pending'.*status\?\.key !== 'executing'/s);
  assert.match(appSource, /data-lifecycle-action-reason/);
  assert.match(appSource, /case 'project_milestone_start':[\s\S]*startProjectMilestone/);
  assert.match(appSource, /case 'project_milestone_end':[\s\S]*endProjectMilestone/);
  assert.match(appSource, /case 'project_milestone_terminate':[\s\S]*terminateProjectMilestone/);
});

test('makes only project actions collapsible and delegates milestone buttons through the modal', {
  skip: !appSource.includes('function isDaoProjectLifecycleAction(action)'),
}, () => {
  assert.match(appSource, /function isDaoProjectLifecycleAction\(action\)/);
  assert.match(appSource, /function shouldRenderDaoLifecycleAction\(action\)/);
  assert.match(
    appSource,
    /return !isDaoProjectLifecycleAction\(action\) \|\| action\.canSubmit !== false;/,
  );
  assert.match(appSource, /if \(!isDaoProjectLifecycleAction\(action\)\)/);
  assert.match(appSource, /proposal-lifecycle-action--static/);
  assert.match(
    appSource,
    /const isMilestoneClaim = action\.kind === 'project_milestone_claim'/,
  );
  assert.match(appSource, /proposal-lifecycle-action--claim/);
  assert.doesNotMatch(appSource, /availabilityLabel/);
  assert.match(appSource, /this\.modal\.addEventListener\('click'.*handleLifecycleActionClick/s);
  assert.match(appSource, /this\.modal\?\.querySelectorAll\('button\[data-lifecycle-action-index\]'/);
});
