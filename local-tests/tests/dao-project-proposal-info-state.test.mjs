import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getDaoProposalInfoStateLabel } from '../dao.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function createProjectProposal(projectStatus, proposalStatus = 'applied') {
  return {
    proposalType: 'project',
    status: proposalStatus,
    project: { status: projectStatus },
  };
}

test('shows the runtime project state after proposal acceptance', () => {
  assert.equal(getDaoProposalInfoStateLabel(createProjectProposal('started')), 'Started');
  assert.equal(getDaoProposalInfoStateLabel(createProjectProposal('completed')), 'Completed');
  assert.equal(getDaoProposalInfoStateLabel(createProjectProposal('terminated')), 'Terminated');
  assert.equal(getDaoProposalInfoStateLabel(createProjectProposal('pending', 'accepted')), 'Accepted');
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
