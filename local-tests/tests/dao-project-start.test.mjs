import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_ACTION_TYPES,
  buildDaoProjectStartTransaction,
  daoRepo,
  getDaoTransactionMessage,
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
    status: 'accepted',
  };
}

test('builds the exact project-start transaction', () => {
  assert.deepEqual(buildDaoProjectStartTransaction({
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
  }), {
    type: 'dao_project_start',
    timestamp: 1_000,
    networkId: 'localnet',
    from: ADDRESS,
    proposalId: PROPOSAL_ID,
  });
});

test('registers project start for pending settlement messages', () => {
  assert.equal(DAO_ACTION_TYPES.PROJECT_START, 'dao_project_start');
  assert.equal(getDaoTypeForLifecycleKind('project_start'), 'dao_project_start');
  assert.equal(isDaoTransactionType('dao_project_start'), true);
  assert.equal(getDaoTransactionMessage('dao_project_start', 'success'), 'Project started');
});

test('submits project start through the DAO repository boundary', async () => {
  let submitted = null;
  const result = await daoRepo.startProject({
    from: ADDRESS,
    proposal: projectProposal(),
    timestamp: 1_000,
    networkId: 'localnet',
    submitTransaction: async (transaction) => {
      submitted = transaction;
      return { result: { success: true }, txid: 'tx-1' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(submitted.type, 'dao_project_start');
  assert.equal(submitted.proposalId, PROPOSAL_ID);
});

test('shows project start only when accepted, committee-authorized, and grace-ready', () => {
  const start = appSource.indexOf('function getDaoProjectStartLifecycleAction');
  const end = appSource.indexOf('function formatDaoClaimWindowLabel', start);
  const helperSource = appSource.slice(start, end);

  assert.match(helperSource, /getEffectiveDaoState\(proposal\) !== 'accepted'/);
  assert.match(helperSource, /proposal\?\.proposalType !== DAO_PROJECT_TYPE/);
  assert.match(helperSource, /isDaoProposalCommitteeMember\(proposal, currentAddress\)/);
  assert.match(helperSource, /getDaoProposalApplyWindow\(proposal, now\)/);
  assert.match(helperSource, /rowPreviewLabel: 'Ready to start'/);
  assert.match(helperSource, /canSubmit: true/);
  assert.match(appSource, /case 'project_start':[\s\S]*daoRepo\.startProject\(request\)/);
});
