import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { escapeHtml } from '../lib.js';

import {
  DAO_PROJECT_FILTERS,
  createDaoBackendFetcher,
  daoRepo,
  getDaoProposalListFilterKey,
  getEffectiveDaoState,
  setDaoBackendFetcher,
} from '../dao.js';
import { DaoProjectFixtures } from '../fixtures/dao-projects.mjs';

const NOW = 2_000_000_000_000;
const [markup, styles, appSource] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
]);

test('defines the three project lifecycle filters without an archive filter', () => {
  assert.deepEqual(DAO_PROJECT_FILTERS, [
    { key: 'executing', label: 'Executing' },
    { key: 'terminated', label: 'Terminated' },
    { key: 'completed', label: 'Completed' },
  ]);
  assert.equal(DAO_PROJECT_FILTERS.some(({ key }) => key === 'archived'), false);
});

test('renders a Projects context containing every project lifecycle filter', () => {
  const projectPanel = markup.slice(
    markup.indexOf('data-dao-filters="projects"'),
    markup.indexOf('class="dao-filter-placeholder'),
  );
  const filterKeys = [...projectPanel.matchAll(/data-filter-key="([^"]+)"/g)]
    .map(([, key]) => key);

  assert.match(markup, /data-dao-context="projects"[^>]*>Projects<\/button>/);
  assert.match(projectPanel, /inert aria-hidden="true"/);
  assert.deepEqual(filterKeys, ['executing', 'terminated', 'completed']);
  assert.doesNotMatch(markup, /data-filter-key="archived"/);
  assert.match(styles, /#daoModal \.dao-filter-row--projects \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('uses authoritative proposal states without deriving them from nested project fields', () => {
  for (const status of ['executing', 'terminated', 'completed', 'accepted', 'applied']) {
    const proposal = { proposalType: 'project', status, project: { status: 'started' } };
    assert.equal(getDaoProposalListFilterKey(proposal), status);
    assert.equal(getDaoProposalListFilterKey({ ...proposal, status: undefined, state: status }), status);
  }
  assert.equal(getDaoProposalListFilterKey({ proposalType: 'governance', status: 'applied' }), 'applied');
});

test('includes the project status in every fixture title', async () => {
  const fixtures = new DaoProjectFixtures({ now: NOW });
  const fetcher = createDaoBackendFetcher(fixtures.queryDaoApi);
  const metadata = await fetcher.fetchMeta();
  const proposals = Object.values(await fetcher.fetchProposals(metadata.proposals));

  assert.equal(proposals.length, 12);
  assert.ok(proposals.every((proposal) => (
    proposal.title.includes(`[Project status: ${proposal.status}]`)
  )));
});

test('classifies project detail fixtures after proposal finalization', async (t) => {
  const fixtures = new DaoProjectFixtures({ now: NOW });
  const fetcher = createDaoBackendFetcher(fixtures.queryDaoApi);
  setDaoBackendFetcher(fetcher);
  daoRepo.reset();
  t.after(() => {
    daoRepo.reset();
    setDaoBackendFetcher(null);
  });

  await daoRepo.refresh({ force: true });
  const metadata = daoRepo.getProposalMetaForUi();
  await daoRepo.loadProposalEntries(
    metadata.filter(({ status }) => ['accepted', 'applied', ...DAO_PROJECT_FILTERS.map(filter => filter.key)].includes(status)),
  );
  const proposals = daoRepo.getProposalsForUi();
  const counts = proposals.reduce((result, proposal) => {
    const filterKey = getDaoProposalListFilterKey(proposal);
    result[filterKey] = (result[filterKey] || 0) + 1;
    return result;
  }, {});
  const titlesByFilter = Object.fromEntries(
    proposals.map((proposal) => [getDaoProposalListFilterKey(proposal), proposal.title]),
  );

  assert.equal(counts.executing, 1);
  assert.equal(counts.terminated, 1);
  assert.equal(counts.completed, 1);
  assert.equal(counts.accepted, 2);
  assert.equal(counts.applied, 1); // The intentionally missing-project fixture retains its metadata state.
  assert.match(titlesByFilter.executing, /Executing/);
  assert.match(titlesByFilter.terminated, /Terminated/);
  assert.match(titlesByFilter.completed, /Completed/);
});

test('merges project fixtures with queried proposals and delegates real proposal reads', async () => {
  const calls = [];
  const upstreamEntry = {
    proposal: 42,
    status: 'voting',
    emergencyFlag: false,
    timestamp: NOW - 1,
  };
  const fixtures = new DaoProjectFixtures({
    now: NOW,
    queryUpstream: async (path) => {
      calls.push(path);
      if (path === '/dao/proposals/meta') {
        return { meta: { count: 42, proposals: [upstreamEntry] } };
      }
      if (path === '/dao/proposals/42') {
        return {
          proposal: {
            id: 'real-proposal-42',
            number: 42,
            proposalType: 'governance',
            title: 'Queried proposal',
            description: 'Loaded from the upstream query.',
            creationTime: NOW - 2,
          },
        };
      }
      return { error: `Unexpected upstream path: ${path}` };
    },
  });
  const fetcher = createDaoBackendFetcher(fixtures.queryDaoApi);
  const metadata = await fetcher.fetchMeta();
  const proposals = Object.values(await fetcher.fetchProposals(metadata.proposals));

  assert.equal(metadata.count, 42);
  assert.equal(metadata.proposals.length, 13);
  assert.equal(proposals.length, 13);
  assert.ok(proposals.some((proposal) => proposal.title === 'Queried proposal'));
  assert.ok(proposals.some((proposal) => proposal.title.includes('[Project status: executing]')));
  assert.deepEqual(calls, ['/dao/proposals/meta', '/dao/proposals/42']);
});

test('renders finalized project lifecycle labels instead of ballot-result labels', async () => {
  const start = appSource.indexOf('  renderProposalRowPreview(proposal) {');
  const end = appSource.indexOf('  async openProposal(', start);
  assert.ok(start >= 0 && end > start);
  const renderPreview = vm.runInNewContext(
    '({' + appSource.slice(start, end) + '}).renderProposalRowPreview',
    {
      DAO_PROJECT_FILTERS, getEffectiveDaoState, getDaoProposalListFilterKey, escapeHtml,
      escapeDaoFormAttribute: escapeHtml, getDaoProjectStatusTone: () => '',
      getDaoProposalResultSummary: () => ({ headline: 'Winning ballot option', tone: 'accepted' }),
      getDaoProposalRewardSummary: () => ({}), getDaoProposalLifecycleActions: () => [],
    },
  );
  const fixtures = new DaoProjectFixtures({ now: NOW });
  for (const [number, label] of [[906, 'Executing'], [907, 'Completed'], [908, 'Terminated']]) {
    const { proposal } = await fixtures.queryDaoApi(`/dao/proposals/${number}`);
    const html = renderPreview(proposal);
    assert.ok(html.includes(label));
    assert.equal(html.includes('Winning ballot option'), false);
  }
});
