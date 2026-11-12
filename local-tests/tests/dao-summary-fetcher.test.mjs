import assert from 'node:assert/strict';
import test from 'node:test';

import { createDaoBackendFetcher } from '../dao.js';

test('loads indexed proposals from meta and preserves their index metadata', async (t) => {
  const calls = [];
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);

    if (path === '/dao/proposals/meta') {
      return {
        meta: {
          count: 42,
          proposals: [
            { proposal: 42, status: 'review', emergencyFlag: false, timestamp: 4200 },
            { proposal: 41, status: 'accepted', emergencyFlag: true, timestamp: 4100 },
          ],
        },
      };
    }

    if (path === '/dao/proposals/42') {
      return {
        proposal: {
          id: 'proposal-42',
          number: 42,
          proposalType: 'governance',
          status: 'voting',
          emergency: true,
          creationTime: 4000,
          timestamp: 4001,
          title: 'Proposal 42',
        },
      };
    }

    return null;
  });

  t.mock.method(console, 'warn', () => {});
  const meta = await fetcher.fetchMeta();
  assert.deepEqual(calls, ['/dao/proposals/meta']);
  const proposals = await fetcher.fetchProposals(meta.proposals);

  assert.deepEqual(calls, [
    '/dao/proposals/meta',
    '/dao/proposals/42',
    '/dao/proposals/41',
  ]);
  assert.equal(meta.count, 42);
  assert.deepEqual(Object.keys(proposals), ['42_proposal-42']);

  const proposal = proposals['42_proposal-42'];
  assert.equal(proposal.status, 'review');
  assert.equal(proposal.state_changed, 4200);
  assert.equal(proposal.emergency, false);
});

test('does not request proposal details for an empty metadata index', async () => {
  const calls = [];
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    return { meta: { count: 0, proposals: [] } };
  });

  const meta = await fetcher.fetchMeta();
  const proposals = await fetcher.fetchProposals(meta.proposals);

  assert.deepEqual(calls, ['/dao/proposals/meta']);
  assert.equal(meta.count, 0);
  assert.deepEqual(meta.proposals, []);
  assert.deepEqual(proposals, {});
});

test('does not enumerate 1..N when the metadata index is incomplete', async () => {
  const calls = [];
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      return { meta: { count: 5, proposals: [] } };
    }
    throw new Error(`Unexpected query ${path}`);
  });

  const meta = await fetcher.fetchMeta();
  const proposals = await fetcher.fetchProposals(meta.proposals);

  assert.deepEqual(calls, ['/dao/proposals/meta']);
  assert.equal(meta.count, 5);
  assert.deepEqual(meta.proposals, []);
  assert.deepEqual(proposals, {});
});
