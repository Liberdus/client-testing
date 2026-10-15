import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDaoBackendFetcher,
  getDaoProjectPresentation,
} from '../dao.js';
import { createDaoProjectProposalInfoFixtures } from '../dev-fixtures/dao-project-proposal-info-fixtures.js';

const NOW = 2_000_000_000_000;
const fixtures = createDaoProjectProposalInfoFixtures({ now: NOW });
const [appSource, styles, fixturePatch] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../dev-patches/dao-project-proposal-info-fixtures.patch', import.meta.url), 'utf8'),
]);

async function getFixtureProposals() {
  const { meta } = await fixtures.queryDaoApi('/dao/proposals/meta');
  return Promise.all(meta.proposals.map(async (entry) => {
    const { proposal } = await fixtures.queryDaoApi(`/dao/proposals/${entry.proposal}`);
    return { entry, proposal };
  }));
}

test('provides a read-only Project fixture for every proposal state', async () => {
  const proposals = await getFixtureProposals();
  const states = new Set(proposals.map(({ entry }) => entry.status));

  assert.deepEqual(states, new Set([
    'review',
    'voting',
    'accepted',
    'withheld',
    'rejected',
    'applied',
    'canceled',
  ]));
  assert.ok(proposals.every(({ proposal }) => proposal.proposalType === 'project'));
  assert.ok(proposals.every(({ proposal }) => proposal.title.startsWith('[Fixture')));
  assert.deepEqual(fixtures.getClaimableProposalNumbers(NOW), [910]);
});

test('normalizes a prefixed current-account address in claimable fixtures', async () => {
  const prefixedAddress = `0x${'a'.repeat(40)}`;
  const addressFixtures = createDaoProjectProposalInfoFixtures({
    now: NOW,
    getCurrentAddress: () => prefixedAddress,
  });
  const { proposal } = await addressFixtures.queryDaoApi('/dao/proposals/910');

  assert.equal(proposal.voterList[0].address, 'a'.repeat(40));
});

test('loads Project fixtures through the production DAO backend adapter', async () => {
  const fetcher = createDaoBackendFetcher(fixtures.queryDaoApi);
  const metadata = await fetcher.fetchMeta();
  const proposals = Object.values(await fetcher.fetchProposals(metadata.proposals));
  const startedFixture = proposals.find((proposal) => proposal.title.includes('Project started'));
  const maximumFixture = proposals.find((proposal) => proposal.title.includes('pending activation'));
  const presentations = proposals.map(getDaoProjectPresentation);

  assert.equal(metadata.count, 12);
  assert.equal(proposals.length, metadata.proposals.length);
  assert.equal(presentations.filter((project) => project.kind === 'available').length, 11);
  assert.equal(startedFixture.state, 'applied');
  assert.equal(startedFixture.project.status, 'started');
  assert.equal(getDaoProjectPresentation(startedFixture).completeness, 'complete');
  assert.equal(getDaoProjectPresentation(maximumFixture).milestones.length, 10);
});

test('normalizes complete Project runtime data for Proposal Info', async () => {
  const proposals = await getFixtureProposals();
  const startedFixture = proposals.find(({ proposal }) => proposal.title.includes('Project started'));
  const project = getDaoProjectPresentation(startedFixture.proposal);

  assert.equal(project.kind, 'available');
  assert.equal(project.completeness, 'complete');
  assert.equal(project.status.key, 'started');
  assert.equal(project.balanceWei, 125000000000000000000n);
  assert.equal(project.claimableBalanceWei, 1000000000000000000n);
  assert.deepEqual(project.budget, {
    baseCostUsdStr: '6000',
    maximumBonusUsdStr: '300',
    maximumAuthorizedUsdStr: '6300',
  });
  assert.deepEqual(project.milestones.map((milestone) => milestone.status.key), [
    'completed',
    'started',
    'pending',
  ]);
  assert.equal(project.milestones[0].paid, true);
  assert.equal(project.milestones[0].payoutWei, 1000000000000000000n);
});

test('returns intentional partial and unavailable Project states', async () => {
  const proposals = await getFixtureProposals();
  const partialFixture = proposals.find(({ proposal }) => proposal.title.includes('partial malformed'));
  const missingFixture = proposals.find(({ proposal }) => proposal.title.includes('missing Project data'));
  const partialProject = getDaoProjectPresentation(partialFixture.proposal);
  const missingProject = getDaoProjectPresentation(missingFixture.proposal);

  assert.equal(partialProject.kind, 'available');
  assert.equal(partialProject.completeness, 'partial');
  assert.ok(partialProject.issueCount > 0);
  assert.equal(partialProject.address, null);
  assert.equal(partialProject.budget, null);
  assert.equal(partialProject.milestones.length, 2);
  assert.equal(missingProject.kind, 'unavailable');
  assert.match(missingProject.message, /unavailable/);
});

test('renders Project details through the production Proposal Info path', () => {
  const renderProposalStart = appSource.indexOf('  renderProposal(proposal) {');
  const renderProposalEnd = appSource.indexOf('    if (this.detailsContent) {', renderProposalStart);
  const renderProposalSource = appSource.slice(renderProposalStart, renderProposalEnd);

  assert.match(appSource, /function renderDaoProjectProposalInfo\(proposal, proposalState\)/);
  assert.match(appSource, /getDaoProjectPresentation\(proposal\)/);
  assert.match(appSource, /renderDaoProjectProposalInfo\(proposal, state\)/);
  assert.match(appSource, /getDaoProposalOptionLabels\(proposal\)/);
  assert.match(appSource, /this\.renderLoading\(\)/);
  assert.match(appSource, /Project Funding/);
  assert.match(appSource, /Milestone status/);
  assert.match(appSource, /proposal\?\.proposalType === DAO_PROJECT_TYPE\) return null/);
  assert.match(styles, /#proposalInfoModal \.dao-project-review-milestone/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-notice--partial/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-runtime/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*#proposalInfoModal \.dao-project-info-funding \.proposal-info-row/);
  assert.ok(
    renderProposalSource.indexOf('renderDaoProjectProposalInfo(proposal, state)')
      < renderProposalSource.indexOf('renderDaoProposalOptions(proposal)'),
  );
});

test('documents an applyable and reversible read-only fixture patch', () => {
  assert.match(fixturePatch, /git apply --check dev-patches\/dao-project-proposal-info-fixtures\.patch/);
  assert.match(fixturePatch, /git apply --check --reverse dev-patches\/dao-project-proposal-info-fixtures\.patch/);
  assert.match(fixturePatch, /DAO_PROJECT_FIXTURE_MODE = true/);
  assert.match(fixturePatch, /DAO fixture mode is read-only/);
  assert.match(fixturePatch, /createDaoProjectProposalInfoFixtures/);
});
