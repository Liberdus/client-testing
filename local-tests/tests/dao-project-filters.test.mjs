import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DAO_PROJECT_FILTERS,
  createDaoBackendFetcher,
  daoRepo,
  getDaoProposalListFilterKey,
  setDaoBackendFetcher,
} from '../dao.js';
import { createDaoProjectProposalInfoFixtures } from '../dev-fixtures/dao-project-proposal-info-fixtures.js';

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

test('renders a labeled project filter row without an archive chip', () => {
  const projectRow = markup.slice(
    markup.indexOf('class="dao-filter-row-label"'),
    markup.indexOf('</div>', markup.indexOf('class="dao-filter-row-label"')),
  );
  const filterKeys = [...projectRow.matchAll(/data-filter-key="([^"]+)"/g)]
    .map(([, key]) => key);

  assert.match(projectRow, />Projects:<\/span>/);
  assert.deepEqual(filterKeys, ['executing', 'terminated', 'completed']);
  assert.doesNotMatch(markup, /data-filter-key="archived"/);
  assert.match(styles, /#daoModal \.dao-filter-bar \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /#daoModal \.dao-project-filter-row \{[^}]*grid-template-columns: max-content repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*#daoModal \.dao-project-filter-row \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});

test('maps nested project statuses into project filters', () => {
  const projectProposal = (status, proposalState = 'applied') => ({
    proposalType: 'project',
    status: proposalState,
    project: { status },
  });

  assert.equal(getDaoProposalListFilterKey(projectProposal('started')), 'executing');
  assert.equal(getDaoProposalListFilterKey(projectProposal('terminated')), 'terminated');
  assert.equal(getDaoProposalListFilterKey(projectProposal('completed')), 'completed');
  assert.equal(getDaoProposalListFilterKey(projectProposal('pending', 'accepted')), 'accepted');
  assert.equal(getDaoProposalListFilterKey(projectProposal('pending')), '');
  assert.equal(getDaoProposalListFilterKey({ proposalType: 'governance', status: 'applied' }), 'applied');
});

test('includes the project status in every fixture title', async () => {
  const fixtures = createDaoProjectProposalInfoFixtures({ now: NOW });
  const fetcher = createDaoBackendFetcher(fixtures.queryDaoApi);
  const metadata = await fetcher.fetchMeta();
  const proposals = Object.values(await fetcher.fetchProposals(metadata.proposals));

  assert.equal(proposals.length, 12);
  assert.ok(proposals.every((proposal) => (
    proposal.title.includes(`[Project status: ${proposal.project?.status || 'unavailable'}]`)
  )));
});

test('classifies project detail fixtures after proposal finalization', async (t) => {
  const fixtures = createDaoProjectProposalInfoFixtures({ now: NOW });
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
    metadata.filter(({ status }) => status === 'accepted' || status === 'applied'),
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
  assert.equal(counts.applied, undefined);
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
  const fixtures = createDaoProjectProposalInfoFixtures({
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
  assert.ok(proposals.some((proposal) => proposal.title.includes('[Project status: started]')));
  assert.deepEqual(calls, ['/dao/proposals/meta', '/dao/proposals/42']);
});

test('uses finalized project filter labels for proposal row status tokens', () => {
  const previewStart = appSource.indexOf('  renderProposalRowPreview(proposal) {');
  const previewEnd = appSource.indexOf('  async openProposal(', previewStart);
  const previewSource = appSource.slice(previewStart, previewEnd);

  assert.match(previewSource, /DAO_PROJECT_FILTERS\.find/);
  assert.match(previewSource, /value: projectFilter\.label/);
  assert.match(previewSource, /else if \(result && state !== 'accepted'\)/);
});
