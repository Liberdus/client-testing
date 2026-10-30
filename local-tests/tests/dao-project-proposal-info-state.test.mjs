import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getDaoProposalInfoStateLabel } from '../dao.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('shows authoritative top-level lifecycle state instead of nested legacy status', () => {
  for (const [status, label] of [
    ['executing', 'Executing'], ['completed', 'Completed'], ['terminated', 'Terminated'],
    ['accepted', 'Accepted'], ['applied', 'Applied'],
  ]) {
    const proposal = { proposalType: 'project', status, project: { status: 'started' } };
    assert.equal(getDaoProposalInfoStateLabel(proposal), label);
    assert.equal(getDaoProposalInfoStateLabel({ ...proposal, status: undefined, state: status }), label);
  }
  assert.equal(getDaoProposalInfoStateLabel({ proposalType: 'project', status: 'applied' }), 'Applied');
  assert.match(appSource, /this\.setTitle\(getDaoProposalInfoStateLabel\(proposal\)\)/);
});

test('moves project proposal options and results into the details disclosure', () => {
  const renderProposalStart = appSource.indexOf('  renderProposal(proposal) {');
  const renderProposalEnd = appSource.indexOf('  getReviewCapabilities(', renderProposalStart);
  const renderProposalSource = appSource.slice(renderProposalStart, renderProposalEnd);
  const renderDetailsStart = appSource.indexOf('  renderProposalDetails({');
  const renderDetailsEnd = appSource.indexOf('  setTitle(', renderDetailsStart);
  const renderDetailsSource = appSource.slice(renderDetailsStart, renderDetailsEnd);

  assert.match(renderProposalSource, /const isProjectProposal = proposal\.proposalType === DAO_PROJECT_TYPE/);
  assert.match(renderProposalSource, /isProjectProposal \? '' : proposalOptionsSection/);
  assert.match(renderProposalSource, /isProjectProposal \? '' : proposalResultsSection/);
  assert.match(renderProposalSource, /\? \[proposalOptionsSection, proposalResultsSection\]/);
  assert.match(renderDetailsSource, /\.\.\.projectProposalSections/);
  assert.ok(
    renderDetailsSource.indexOf('...projectProposalSections')
      < renderDetailsSource.indexOf("renderDaoProposalSection('Overview'"),
  );
});
