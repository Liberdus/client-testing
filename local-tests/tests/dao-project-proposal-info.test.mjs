import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import * as dao from '../dao.js';
import { escapeHtml, EthNum } from '../lib.js';
import { DaoProjectFixtures } from '../fixtures/dao-projects.mjs';

const NOW = 2_000_000_000_000;
const fixtures = new DaoProjectFixtures({ now: NOW });
const [appSource, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

class ProjectInfoHarness {
  static async proposals() {
    const { meta } = await fixtures.queryDaoApi('/dao/proposals/meta');
    return Promise.all(meta.proposals.map(async (entry) => {
      const { proposal } = await fixtures.queryDaoApi(`/dao/proposals/${entry.proposal}`);
      return { entry, proposal };
    }));
  }

  static functionSource(name) {
    const start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing production helper: ${name}`);
    const next = /\n(?:function |class |const )/.exec(appSource.slice(start + 1));
    assert.ok(next, `Missing end of production helper: ${name}`);
    return appSource.slice(start, start + 1 + next.index);
  }

  static renderer() {
    const start = appSource.indexOf('function formatDaoDurationSummary(');
    const end = appSource.indexOf('class ConfirmProposalModal', start);
    assert.ok(start >= 0 && end > start);
    const helpers = [
      'formatDaoProposalTitle', 'formatDaoTimestamp', 'formatDaoDetailTimestamp',
      'formatDaoShortNumber', 'formatDaoLibWei', 'formatDaoDetailValue',
      'isDaoProjectLifecycleAction', 'shouldRenderDaoLifecycleAction',
    ];
    return vm.runInNewContext([
      appSource.slice(start, end),
      ...helpers.map(name => this.functionSource(name)),
      'renderDaoProjectProposalInfo',
    ].join('\n'), { ...dao, escapeHtml, EthNum, stringify: JSON.stringify });
  }
}

const renderProject = ProjectInfoHarness.renderer();

test('provides read-only Project fixtures across proposal and project lifecycle states', async () => {
  const proposals = await ProjectInfoHarness.proposals();
  assert.deepEqual(new Set(proposals.map(({ entry }) => entry.status)), new Set([
    'review', 'voting', 'accepted', 'withheld', 'rejected', 'executing',
    'completed', 'terminated', 'canceled', 'applied',
  ]));
  assert.ok(proposals.every(({ proposal }) => proposal.proposalType === 'project'));
  assert.ok(proposals.every(({ proposal }) => proposal.title.startsWith('[Fixture')));
  const claimable = proposals.filter(({ proposal }) => (
    dao.getDaoRewardClaimStatus(proposal, fixtures.address, NOW) === 'Claimable'
  ));
  assert.deepEqual(claimable.map(({ proposal }) => proposal.number), [910]);
});

test('normalizes a prefixed current-account address in claimable fixtures', async () => {
  const addressFixtures = new DaoProjectFixtures({ now: NOW, address: `0x${'a'.repeat(40)}` });
  const { proposal } = await addressFixtures.queryDaoApi('/dao/proposals/910');
  assert.equal(proposal.voterList[0].address, 'a'.repeat(40));
  assert.equal(dao.getDaoRewardClaimStatus(proposal, `0x${'a'.repeat(40)}`, NOW), 'Claimable');
});

test('loads Project fixtures through the production DAO backend adapter', async () => {
  const fetcher = dao.createDaoBackendFetcher(fixtures.queryDaoApi);
  const metadata = await fetcher.fetchMeta();
  const proposals = Object.values(await fetcher.fetchProposals(metadata.proposals));
  const executing = proposals.find(proposal => proposal.status === 'executing');
  const maximum = proposals.find(proposal => proposal.title.includes('pending activation'));
  assert.equal(metadata.count, 12);
  assert.equal(proposals.length, metadata.proposals.length);
  assert.equal(proposals.map(dao.getDaoProjectPresentation).filter(project => project.kind === 'available').length, 11);
  assert.equal(executing.state, 'executing');
  assert.equal(dao.getDaoProjectPresentation(executing).completeness, 'complete');
  assert.equal(dao.getDaoProjectPresentation(maximum).milestones.length, dao.DAO_PROJECT_MAX_MILESTONES);
});

test('normalizes complete server Project runtime data for Proposal Info', async () => {
  const { proposal } = await fixtures.queryDaoApi('/dao/proposals/906');
  const project = dao.getDaoProjectPresentation(proposal);
  assert.equal(project.kind, 'available');
  assert.equal(project.completeness, 'complete');
  assert.deepEqual(project.status, { key: 'executing', label: 'Executing' });
  assert.equal(project.balanceWei, 125000000000000000000n);
  assert.equal(project.rateUsdStr, '0.5');
  assert.deepEqual(project.budget, {
    baseCostUsdStr: '6000', maximumBonusUsdStr: '300', maximumAuthorizedUsdStr: '6300',
  });
  assert.deepEqual(project.milestones.map(milestone => milestone.status.key), [
    'completed', 'executing', 'pending',
  ]);
  assert.equal(project.milestones[0].durationMs, 16 * dao.DAO_PROPOSAL_DAY_MS);
  assert.equal(project.milestones[0].paidWei, 1000000000000000000n);
  assert.equal(project.milestones[0].endTime, NOW - 2 * 60 * 60 * 1000);
  assert.equal(project.milestones[1].paidWei, 0n);
});

test('returns intentional partial and unavailable Project states', async () => {
  const { proposal: partial } = await fixtures.queryDaoApi('/dao/proposals/912');
  const { proposal: missing } = await fixtures.queryDaoApi('/dao/proposals/911');
  const partialProject = dao.getDaoProjectPresentation(partial);
  const missingProject = dao.getDaoProjectPresentation(missing);
  assert.equal(partialProject.kind, 'available');
  assert.equal(partialProject.completeness, 'partial');
  assert.ok(partialProject.issueCount > 0);
  assert.equal(partialProject.address, null);
  assert.equal(partialProject.budget, null);
  assert.equal(partialProject.milestones.length, 2);
  assert.equal(missingProject.kind, 'unavailable');
  assert.match(missingProject.message, /unavailable/);
});

test('renders funding, milestone runtime and incomplete states with production helpers', async () => {
  const { proposal } = await fixtures.queryDaoApi('/dao/proposals/906');
  const html = renderProject(proposal, proposal.status, [], () => assert.fail('Unexpected lifecycle action'));
  assert.match(html, /Project Funding/);
  assert.match(html, /Milestone status/);
  assert.match(html, /125 LIB/);
  assert.match(html, /6000 USD/);
  assert.match(html, /16 days/);
  assert.match(html, /Completed/);
  assert.match(html, /Executing/);
  assert.match(html, /dao-project-info-runtime/);
  assert.doesNotMatch(html, /Some project details are unavailable/);
  const { proposal: partial } = await fixtures.queryDaoApi('/dao/proposals/912');
  assert.match(renderProject(partial, partial.status, [], () => ''), /Some project details are unavailable/);
  const { proposal: missing } = await fixtures.queryDaoApi('/dao/proposals/911');
  assert.match(renderProject(missing, missing.status, [], () => ''), /Project details unavailable/);
  const hostile = structuredClone(proposal);
  hostile.project.milestones[0].title = '<img src=x onerror=alert(1)>';
  const escaped = renderProject(hostile, hostile.status, [], () => '');
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(escaped.includes('<img src=x'), false);
  assert.match(appSource, /projectProposalInfoSection = isProjectProposal\s*\? renderDaoProjectProposalInfo\(/);
  assert.match(styles, /#proposalInfoModal \.dao-project-review-milestone/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-notice--partial/);
  assert.match(styles, /#proposalInfoModal \.dao-project-info-runtime/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*#proposalInfoModal \.dao-project-info-funding \.proposal-info-row/);
});

test('rejects transaction and non-DAO paths before any upstream callback', async () => {
  const readOnly = new DaoProjectFixtures({
    now: NOW, queryUpstream: () => assert.fail('Unsupported paths must not reach upstream'),
  });
  for (const path of ['/inject', '/dao/proposals/906/vote', '/account/example']) {
    await assert.rejects(readOnly.queryDaoApi(path), /Unsupported fixture read/);
  }
});
