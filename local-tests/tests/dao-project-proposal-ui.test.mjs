import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_PROJECT_DURATION_MAX_DAYS,
  DAO_PROJECT_MAX_MILESTONES,
  DAO_PROJECT_MILESTONE_TEXT_MAX_LENGTH,
  DAO_PROJECT_MILESTONE_TITLE_MAX_LENGTH,
  addDaoDecimalStrings,
  buildDaoProposalCreateDraft,
  getDaoProjectBudgetSummary,
  getDaoTypeLabel,
  isDaoParameterProposalTypeKey,
  normalizeDaoProjectDraft,
} from '../dao.js';

const [appSource, daoSource, markup, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../dao.js', import.meta.url), 'utf8'),
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

function createProjectDraft(overrides = {}) {
  return {
    address: 'a'.repeat(40),
    milestones: [createMilestone()],
    ...overrides,
  };
}

test('recognizes Project as a UI type but not a parameter proposal type', () => {
  assert.equal(getDaoTypeLabel('project'), 'Project');
  assert.equal(isDaoParameterProposalTypeKey('project'), false);
  assert.equal(isDaoParameterProposalTypeKey('governance'), true);
  assert.equal(isDaoParameterProposalTypeKey('economic'), true);
  assert.equal(isDaoParameterProposalTypeKey('protocol'), true);
});

test('normalizes a Project draft without UI-only milestone ids', () => {
  const normalized = normalizeDaoProjectDraft(createProjectDraft());

  assert.equal(normalized.address, `${'a'.repeat(40)}${'0'.repeat(24)}`);
  assert.equal(normalized.milestones.length, 1);
  assert.equal(normalized.milestones[0].durationDays, 30);
  assert.equal(normalized.milestones[0].costUsdStr, '10000');
  assert.equal('uiId' in normalized.milestones[0], false);
});

test('validates Project recipient and milestone bounds', () => {
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ address: 'invalid' })),
    /recipient must be a valid Liberdus address/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [] })),
    /at least one milestone/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({
      milestones: Array.from({ length: DAO_PROJECT_MAX_MILESTONES + 1 }, () => createMilestone()),
    })),
    /at most 10 milestones/,
  );
});

test('validates required Project milestone text and configured limits', () => {
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ title: ' ' })] })),
    /Milestone 1 title is required/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({
      milestones: [createMilestone({ title: 'x'.repeat(DAO_PROJECT_MILESTONE_TITLE_MAX_LENGTH + 1) })],
    })),
    /Milestone 1 title must be 100 characters or less/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ description: '' })] })),
    /Milestone 1 description is required/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({
      milestones: [createMilestone({ deliverable: 'x'.repeat(DAO_PROJECT_MILESTONE_TEXT_MAX_LENGTH + 1) })],
    })),
    /Milestone 1 deliverable must be 1000 characters or less/,
  );
});

test('validates Project duration and USD values', () => {
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ durationDays: '0' })] })),
    /duration must be a positive whole number/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({
      milestones: [createMilestone({ durationDays: String(DAO_PROJECT_DURATION_MAX_DAYS + 1) })],
    })),
    /duration must not exceed 3650 days/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ costUsdStr: '0.00' })] })),
    /cost must be greater than zero/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ penaltyUsdStr: '-1' })] })),
    /late penalty must be a non-negative USD amount/,
  );
  assert.throws(
    () => normalizeDaoProjectDraft(createProjectDraft({ milestones: [createMilestone({ bonusUsdStr: 'one' })] })),
    /early bonus must be a non-negative USD amount/,
  );
});

test('calculates Project budgets with exact decimal-string arithmetic', () => {
  const summary = getDaoProjectBudgetSummary([
    createMilestone({ costUsdStr: '0.1', bonusUsdStr: '0.03' }),
    createMilestone({ costUsdStr: '0.2', bonusUsdStr: '1.002' }),
    createMilestone({ costUsdStr: 'invalid', bonusUsdStr: '' }),
  ]);

  assert.deepEqual(summary, {
    baseCostUsdStr: '0.3',
    maximumBonusUsdStr: '1.032',
    maximumAuthorizedUsdStr: '1.332',
  });
  assert.equal(addDaoDecimalStrings(['999999999999999.9', '0.1']), '1000000000000000');
  assert.deepEqual(getDaoProjectBudgetSummary([]), {
    baseCostUsdStr: '0',
    maximumBonusUsdStr: '0',
    maximumAuthorizedUsdStr: '0',
  });
});

test('keeps Project out of the proposal transaction builders', () => {
  assert.throws(() => buildDaoProposalCreateDraft({
    from: 'a'.repeat(64),
    displayTitle: 'Project preview',
    emergency: false,
    proposalType: 'project',
    description: 'This must remain UI-only.',
    options: ['no', 'Fund project'],
    changes: [],
    proposalFeeUsdStr: '5',
    reviewStartTimeMs: 0,
    gracePeriodMs: 0,
    maxGracePeriodMs: 1000,
  }), /proposal type is not supported/);
});

test('labels the unfunded Project ballot choice as Reject', () => {
  assert.match(markup, /class="proposal-option-label">Reject<\/span>[\s\S]*Project is not funded/);
});

test('includes the Project editor and accessible milestone controls', () => {
  assert.match(markup, /<option value="project">Project<\/option>/);
  assert.match(markup, /id="addProposalParameterEditor"/);
  assert.match(markup, /class="dao-project-editor hidden" id="addProposalProjectEditor"/);
  assert.match(markup, /data-dao-project-field="address"[\s\S]*required/);
  assert.match(markup, /class="proposal-option-cards dao-project-ballot"/);
  assert.doesNotMatch(markup, /dao-project-ballot[\s\S]*proposal-option-section--no-change/);
  assert.match(markup, /class="proposal-option-label">Reject<\/span>[\s\S]*<div class="proposal-option-changes">[\s\S]*Project is not funded/);
  assert.match(markup, /class="proposal-option-label">Fund project/);
  assert.match(markup, /id="addProposalProjectMilestones"/);
  assert.match(markup, /id="addProposalProjectAddMilestone"/);
  assert.match(markup, /id="addProposalProjectLive" aria-live="polite"/);
  assert.match(markup, /class="proposal-info-grid dao-project-budget"/);
  assert.match(markup, /class="proposal-info-row dao-project-budget-item"/);
  assert.match(markup, /class="proposal-info-value dao-project-budget-value"><span class="dao-project-budget-amount" id="addProposalProjectBaseCost">0<\/span><span>USD<\/span>/);
  assert.ok(
    markup.indexOf('id="addProposalProjectMilestones"') < markup.indexOf('id="addProposalProjectAddress"'),
    'Project milestones should appear before the recipient address',
  );
  assert.ok(
    markup.indexOf('class="proposal-info-grid dao-project-budget"') < markup.indexOf('class="proposal-option-cards dao-project-ballot"'),
    'Project budget should appear before proposal options',
  );
  assert.doesNotMatch(markup, /id="addProposalProjectReviewHelp"/);
  assert.match(styles, /#addProposalModal \.dao-project-milestone-fields/);
  assert.match(styles, /#addProposalModal \.proposal-option-section/);
  assert.match(styles, /#addProposalModal \.dao-project-ballot \.proposal-option-section \{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(styles, /#addProposalModal \.dao-project-budget-value span[\s\S]*font-weight: var\(--font-weight-normal\)/);
  assert.match(styles, /#addProposalModal \.proposal-info-row\.dao-project-budget-item[\s\S]*background: transparent[\s\S]*box-shadow: none/);
  assert.match(styles, /#addProposalModal \.dao-form-section\.hidden/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.dao-project-milestone-fields/);
});

test('branches Project away from config loading and parameter draft creation', () => {
  const classStart = appSource.indexOf('class AddProposalModal');
  const classEnd = appSource.indexOf('const addProposalModal', classStart);
  const classSource = appSource.slice(classStart, classEnd);
  const typeHandlerStart = classSource.indexOf('\n  handleProposalTypeChange() {');
  const typeHandlerEnd = classSource.indexOf('\n  resetConfigCache()', typeHandlerStart);
  const typeHandler = classSource.slice(typeHandlerStart, typeHandlerEnd);
  const createHandlerStart = classSource.indexOf('async handleCreate()');
  const createHandler = classSource.slice(createHandlerStart);

  assert.match(typeHandler, /if \(this\.isProjectProposal\(\)\) \{[\s\S]*return;[\s\S]*\}/);
  assert.ok(typeHandler.indexOf('return;') < typeHandler.indexOf('refreshSelectedConfigOptions()'));
  assert.doesNotMatch(classSource, /this\.submitButton\.disabled = this\.isProjectProposal\(\)/);
  assert.match(classSource, /this\.projectDraft = \{[\s\S]*milestones: \[this\.createProjectMilestone\(\)\]/);
  assert.match(classSource, /data-dao-milestone-move="-1"/);
  assert.match(classSource, /data-dao-remove-milestone/);
  assert.match(createHandler, /if \(proposalType === DAO_PROJECT_TYPE\) \{[\s\S]*buildDaoProjectProposalPreviewDraft[\s\S]*confirmProposalModal\.open\(draft\)[\s\S]*return;/);
  assert.ok(createHandler.indexOf('buildDaoProjectProposalPreviewDraft') < createHandler.indexOf('getValidatedOptions'));
  assert.match(daoSource, /if \(!isDaoParameterProposalTypeKey\(safeProposalType\)\)/);
});

test('uses accessible inline milestone action icons beside the heading', () => {
  const classStart = appSource.indexOf('class AddProposalModal');
  const classEnd = appSource.indexOf('const addProposalModal', classStart);
  const classSource = appSource.slice(classStart, classEnd);

  assert.equal((classSource.match(/class="dao-project-milestone-action-icon"/g) || []).length, 3);
  assert.match(classSource, /aria-label="Move milestone \$\{milestoneNumber\} up"/);
  assert.match(classSource, /aria-label="Move milestone \$\{milestoneNumber\} down"/);
  assert.match(classSource, /aria-label="Remove milestone \$\{milestoneNumber\}"/);
  assert.match(styles, /\.dao-project-milestone > \.dao-form-row-title \{[^}]*flex-wrap: nowrap/);
  assert.match(styles, /\.dao-project-milestone-actions \{[^}]*display: flex[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.dao-project-milestone-actions \.btn \{[^}]*height: 32px[^}]*width: 32px/);
});
