import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildDaoProjectProposalCreateDraft,
  getDaoProjectBudgetSummary,
  getDaoProposalOptionLabels,
} from '../dao.js';

const [appSource, markup, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

function createMilestone(overrides = {}) {
  return {
    uiId: 'milestone-1',
    title: 'Public beta',
    description: 'Implement and deploy the initial explorer.',
    deliverable: 'A public deployment and source release.',
    durationDays: '30',
    costUsdStr: '10000',
    penaltyUsdStr: '1000',
    bonusUsdStr: '500',
    ...overrides,
  };
}

function createPreview(overrides = {}) {
  return buildDaoProjectProposalCreateDraft({
    from: 'b'.repeat(64),
    displayTitle: 'Build a block explorer',
    description: 'Fund delivery of a public network explorer.',
    project: {
      address: 'a'.repeat(40),
      milestones: [
        createMilestone(),
        createMilestone({
          uiId: 'milestone-2',
          title: 'Production release',
          durationDays: '45',
          costUsdStr: '20000.25',
          penaltyUsdStr: '1500',
          bonusUsdStr: '750.5',
        }),
      ],
    },
    proposalFeeUsdStr: '5',
    reviewStartTimeMs: 0,
    gracePeriodMs: 604800000,
    maxGracePeriodMs: 604800000,
    ...overrides,
  });
}

test('builds a normalized Project draft', () => {
  const draft = createPreview();

  assert.equal(draft.transaction.proposalType, 'project');
  assert.equal(draft.transaction.emergency, false);
  assert.deepEqual(draft.transaction.options, ['no', 'Fund project']);
  assert.equal(draft.transaction.project.address, `${'a'.repeat(40)}${'0'.repeat(24)}`);
  assert.deepEqual(
    draft.transaction.project.milestones.map((milestone) => milestone.title),
    ['Public beta', 'Production release'],
  );
  assert.equal('uiId' in draft.transaction.project.milestones[0], false);
  assert.deepEqual(getDaoProjectBudgetSummary(draft.transaction.project.milestones), {
    baseCostUsdStr: '30000.25',
    maximumBonusUsdStr: '1250.5',
    maximumAuthorizedUsdStr: '31250.75',
  });
});

test('uses Project-specific labels without changing stored options', () => {
  assert.deepEqual(getDaoProposalOptionLabels({
    proposalType: 'project',
    options: ['no', 'Fund project'],
  }), ['Reject', 'Fund project']);
  assert.deepEqual(getDaoProposalOptionLabels({
    proposalType: 'governance',
    options: ['no', 'Option 1'],
  }), ['No change', 'Option 1']);
});

test('identifies the invalid Project milestone and field', () => {
  assert.throws(
    () => createPreview({
      project: {
        address: 'a'.repeat(40),
        milestones: [createMilestone(), createMilestone({ description: '' })],
      },
    }),
    (error) => {
      assert.match(error.message, /Milestone 2 description is required/);
      assert.equal(error.daoProjectField, 'description');
      assert.equal(error.daoProjectMilestoneIndex, 1);
      return true;
    },
  );
});

test('opens Project Review Draft before parameter-only validation', () => {
  const addStart = appSource.indexOf('class AddProposalModal');
  const addEnd = appSource.indexOf('const addProposalModal', addStart);
  const addSource = appSource.slice(addStart, addEnd);
  const createStart = addSource.indexOf('async handleCreate()');
  const createSource = addSource.slice(createStart);

  assert.match(addSource, /getProjectValidationTarget\(error\)/);
  assert.match(createSource, /buildDaoProjectProposalCreateDraft\([\s\S]*confirmProposalModal\.open\(draft\)[\s\S]*return;/);
  assert.ok(createSource.indexOf('buildDaoProjectProposalCreateDraft') < createSource.indexOf('getValidatedOptions'));
  assert.match(createSource, /e\.validationTarget = this\.getProjectValidationTarget\(e\)/);
});

test('renders every Project preview section without using Proposal Info', () => {
  const confirmStart = appSource.indexOf('class ConfirmProposalModal');
  const confirmEnd = appSource.indexOf('const confirmProposalModal', confirmStart);
  const confirmSource = appSource.slice(confirmStart, confirmEnd);
  const projectRenderStart = confirmSource.indexOf('renderProjectProposal(draft)');
  const projectRender = confirmSource.slice(projectRenderStart);

  assert.match(projectRender, /renderDaoProposalHeading\(proposal\)/);
  assert.match(projectRender, /renderDaoProposalOptions\(proposal\)/);
  assert.match(appSource, /getDaoProposalOptionLabels\(proposal\)/);
  assert.match(projectRender, /Project Funding/);
  assert.match(projectRender, /dao-project-review-funding/);
  assert.match(projectRender, /\['Recipient', normalizeDaoAddress\(project\.address\)\]/);
  assert.match(projectRender, /renderDaoProjectMilestones\(project\.milestones\)/);
  assert.match(projectRender, /Proposal fee/);
  assert.match(projectRender, /Scheduled review start/);
  assert.match(projectRender, /Grace period/);
  assert.match(appSource, /Deliverable \/ Acceptance Criteria/);
  assert.match(styles, /#confirmProposalModal \.dao-project-review-milestone/);
  assert.match(styles, /#confirmProposalModal \.dao-project-review-funding \.proposal-info-row[\s\S]*flex-basis: 100%/);
  assert.match(styles, /#confirmProposalModal \.proposal-info > \*[\s\S]*min-width: 0/);
  assert.match(styles, /#confirmProposalModal \.proposal-info-title[\s\S]*overflow-wrap: anywhere/);
});

test('routes Project submission through the shared signing flow', () => {
  const confirmStart = appSource.indexOf('class ConfirmProposalModal');
  const confirmEnd = appSource.indexOf('const confirmProposalModal', confirmStart);
  const confirmSource = appSource.slice(confirmStart, confirmEnd);
  const signStart = confirmSource.indexOf('async handleSign()');
  const signEnd = confirmSource.indexOf('\n  render()', signStart);
  const signSource = confirmSource.slice(signStart, signEnd);

  assert.match(confirmSource, /this\.signButton\.disabled = this\.isSubmitting/);
  assert.doesNotMatch(confirmSource, /Project submission unavailable|DAO_PROJECT_PREVIEW_KIND/);
  assert.match(signSource, /loadDaoProposalDefaults/);
  assert.match(signSource, /daoRepo\.createProposal/);
  assert.match(markup, /id="backConfirmProposal"/);
  assert.match(confirmSource, /this\.backButton\.addEventListener\('click', \(\) => this\.close\(\)\)/);
});
