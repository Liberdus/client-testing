import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('project funding rows use the full available width', () => {
  const selector = '#proposalInfoModal .dao-project-info-funding .proposal-info-grid';
  const start = styles.indexOf(selector);
  const end = styles.indexOf('}', start);
  const rule = styles.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(rule, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('proposal review gives the recipient address the available row width', () => {
  const selector = '#confirmProposalModal .dao-project-review-funding .proposal-info-row:first-child';
  const start = styles.indexOf(selector);
  const end = styles.indexOf('}', start);
  const rule = styles.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(rule, /grid-template-columns:\s*auto minmax\(0, 1fr\)/);
});

test('proposal review milestone copy is left aligned', () => {
  const selector = [
    '#confirmProposalModal .dao-project-review-milestone h4,',
    '#confirmProposalModal .dao-project-review-copy',
  ].join('\n');
  const start = styles.indexOf(selector);
  const end = styles.indexOf('}', start);
  const rule = styles.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(rule, /text-align:\s*left/);
});

test('project addresses stay on one horizontally scrollable line', () => {
  const addressSelector = '#proposalInfoModal .dao-project-info-funding .proposal-info-row:first-child .proposal-info-value';
  const start = styles.indexOf(addressSelector);
  const end = styles.indexOf('}', start);
  const rule = styles.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(rule, /overflow-x:\s*auto/);
  assert.match(rule, /overflow-wrap:\s*normal/);
  assert.match(rule, /white-space:\s*nowrap/);
  assert.match(rule, /word-break:\s*normal/);
});

test('centers the pending recipient address without wrapping or scrolling', () => {
  const addressSelector = '#proposalInfoModal .dao-project-info-recipient-change .proposal-info-row:first-child .proposal-info-value';
  const start = styles.indexOf(addressSelector);
  const end = styles.indexOf('}', start);
  const rule = styles.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(rule, /font-size:\s*clamp\(/);
  assert.match(rule, /text-align:\s*center/);
  assert.match(rule, /white-space:\s*nowrap/);
  assert.doesNotMatch(rule, /overflow-x:\s*auto/);
});

test('renders a pending contractor change immediately before project actions', () => {
  assert.match(appSource, /function renderDaoProjectRecipientChangeSection\(proposal\)/);
  assert.match(
    appSource,
    /renderActionGroup\('Proposal actions',[\s\S]*projectRecipientChangeSection,[\s\S]*renderActionGroup\('Project actions'/,
  );
});

test('project details use concise deliverable labels', () => {

  const rendererStart = appSource.indexOf('function renderDaoProjectMilestones');
  const rendererEnd = appSource.indexOf('class ConfirmProposalModal', rendererStart);
  const projectRenderers = appSource.slice(rendererStart, rendererEnd);
  assert.equal(projectRenderers.includes('Deliverable / Acceptance Criteria'), false);
  assert.equal(projectRenderers.match(/<span>Deliverable<\/span>/g)?.length, 2);
  assert.match(
    projectRenderers,
    /\['Duration', formatDaoDurationEstimate\(milestone\.duration\)\]/,
  );
  assert.match(
    projectRenderers,
    /\['Duration', milestone\.durationMs === null \? null : formatDaoDurationEstimate\(milestone\.durationMs\)\]/,
  );
});
