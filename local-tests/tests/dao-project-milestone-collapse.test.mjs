import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  shouldOpenDaoProjectMilestoneByDefault,
  shouldShowDaoProjectRuntime,
} from '../dao.js';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

const MILESTONES = [
  { status: { key: 'completed' } },
  { status: { key: 'executing' } },
  { status: { key: 'pending' } },
];

test('opens only the current milestone for an executing project', () => {
  const project = {
    status: { key: 'executing' },
    milestones: MILESTONES,
  };

  assert.deepEqual(
    MILESTONES.map((_, index) => shouldOpenDaoProjectMilestoneByDefault(project, 'executing', index)),
    [false, true, false],
  );
});

test('opens every milestone during review and voting', () => {
  const project = {
    status: { key: 'accepted' },
    milestones: MILESTONES,
  };

  for (const proposalState of ['review', 'voting']) {
    assert.ok(MILESTONES.every((_, index) => (
      shouldOpenDaoProjectMilestoneByDefault(project, proposalState, index)
    )));
  }
});

test('keeps milestones collapsed outside project execution', () => {
  for (const status of ['accepted', 'terminated', 'completed']) {
    assert.equal(shouldOpenDaoProjectMilestoneByDefault({
      status: { key: status },
      milestones: MILESTONES,
    }, status, 1), false);
  }
});

test('keeps milestones collapsed when there is no current milestone', () => {
  assert.equal(shouldOpenDaoProjectMilestoneByDefault({
    status: { key: 'executing' },
    milestones: MILESTONES.filter((milestone) => milestone.status.key !== 'executing'),
  }, 'executing', 0), false);
});

test('shows runtime fields only after project execution begins', () => {
  assert.equal(shouldShowDaoProjectRuntime({ status: { key: 'accepted' } }), false);
  for (const status of ['executing', 'terminated', 'completed']) {
    assert.equal(shouldShowDaoProjectRuntime({ status: { key: status } }), true);
  }
});

test('uses native independent disclosure controls only in Proposal Info', () => {
  const infoRendererStart = appSource.indexOf('function renderDaoProjectInfoMilestones(');
  const infoRendererEnd = appSource.indexOf('function renderDaoProjectProposalInfo', infoRendererStart);
  const infoRenderer = appSource.slice(infoRendererStart, infoRendererEnd);
  const reviewRendererStart = appSource.indexOf('function renderDaoProjectMilestones(milestones)');
  const reviewRendererEnd = appSource.indexOf('function formatDaoProjectUsd', reviewRendererStart);
  const reviewRenderer = appSource.slice(reviewRendererStart, reviewRendererEnd);

  assert.match(infoRenderer, /<details class="dao-project-review-milestone dao-project-info-milestone"/);
  assert.match(infoRenderer, /<summary>/);
  assert.match(infoRenderer, /dao-project-info-milestone-status/);
  assert.match(infoRenderer, /showRuntimeStatus \? `/);
  assert.match(reviewRenderer, /<article class="dao-project-review-milestone">/);
  assert.doesNotMatch(reviewRenderer, /<details/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-milestone\[open\] > summary/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-milestone > summary:focus-visible/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-milestone > summary \{[\s\S]*?text-align: left/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-milestone \.dao-project-review-copy \{[^}]*text-align: left/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-milestone\[open\] > summary::after \{[^}]*transform: rotate\(225deg\)/);
  assert.doesNotMatch(styles, /#proposalInfoModal \.dao-project-info-milestone > summary::after \{[^}]*transition:/);
});

test('animates lifecycle action chevrons between open and closed states', () => {
  assert.match(
    styles,
    /#proposalInfoModal \.proposal-lifecycle-action > summary::after \{[^}]*transition: transform 0\.2s ease/,
  );
  assert.match(
    styles,
    /#proposalInfoModal \.proposal-lifecycle-action\[open\] > summary::after \{[^}]*transform: rotate\(225deg\)/,
  );
});

test('uses the tinted background only for milestone claim actions', () => {
  assert.match(
    styles,
    /#proposalInfoModal \.proposal-lifecycle-action \{[^}]*background: transparent/,
  );
  assert.match(
    styles,
    /#proposalInfoModal \.proposal-lifecycle-action--claim \{[^}]*background: var\(--input-background\)/,
  );
});

test('omits the redundant Project Status section from Proposal Info', () => {
  const projectInfoStart = appSource.indexOf('function renderDaoProjectProposalInfo(');
  const projectInfoEnd = appSource.indexOf('class ConfirmProposalModal', projectInfoStart);
  const projectInfoRenderer = appSource.slice(projectInfoStart, projectInfoEnd);

  assert.doesNotMatch(projectInfoRenderer, /renderDaoProposalSection\('Project Status'/);
  assert.match(projectInfoRenderer, /renderDaoProjectInfoMilestones\(/);
});

test('renders Project Funding as a compact key-value list', () => {
  assert.match(styles, /#proposalInfoModal \.dao-project-info-funding \.proposal-info-grid,[\s\S]*?\{[^}]*display: grid;[^}]*gap: 0/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-funding \.proposal-info-row,[\s\S]*?\{[^}]*background: transparent;[^}]*grid-template-columns:/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-funding \.proposal-info-value,[\s\S]*?\{[^}]*text-align: right/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-funding \.proposal-info-row:first-child,[\s\S]*?\{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-funding \.proposal-info-row:first-child \.proposal-info-value \{[^}]*white-space: nowrap/);
});

test('renders actions below milestone cards without forcing the card open', () => {
  const infoRendererStart = appSource.indexOf('function renderDaoProjectInfoMilestones(');
  const infoRendererEnd = appSource.indexOf('function renderDaoProjectProposalInfo', infoRendererStart);
  const infoRenderer = appSource.slice(infoRendererStart, infoRendererEnd);

  assert.match(infoRenderer, /action\.milestoneNumber === milestoneNumber/);
  assert.match(infoRenderer, /const isDefaultOpen = shouldOpenDaoProjectMilestoneByDefault/);
  assert.doesNotMatch(infoRenderer, /milestoneActions\.length > 0\s*\|\|/);
  assert.match(infoRenderer, /class="dao-project-info-milestone-group"/);
  assert.match(infoRenderer, /<\/details>\s*\$\{milestoneActions\.length > 0 \? `\s*<section class="dao-project-milestone-actions"/);
  assert.match(infoRenderer, /class="dao-project-milestone-actions"/);
  assert.match(infoRenderer, /renderLifecycleAction\(action, actionIndex\)/);
});
