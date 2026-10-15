import assert from 'node:assert/strict';
import test from 'node:test';

import { createDaoBackendFetcher, daoRepo, setDaoBackendFetcher } from '../dao.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function proposalAccount(number, overrides = {}) {
  return {
    id: `proposal-${number}`,
    number,
    proposalType: 'governance',
    status: 'voting',
    emergency: true,
    creationTime: number * 100,
    title: `Proposal ${number}`,
    ...overrides,
  };
}

function indexEntry(number, overrides = {}) {
  return {
    proposal: number,
    status: 'review',
    emergencyFlag: false,
    timestamp: number * 1000,
    ...overrides,
  };
}

test('second fetch with an unchanged summary hits summary only', async () => {
  const calls = [];
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      return { meta: { count: 2, proposals: [indexEntry(2), indexEntry(1)] } };
    }
    if (path === '/dao/proposals/summary') {
      return { count: 2, proposals: [indexEntry(2), indexEntry(1)] };
    }
    const number = Number(path.split('/').at(-1));
    return { proposal: proposalAccount(number) };
  }, { storage, getNetId: () => 'testnet' });

  await fetcher();
  calls.length = 0;
  const store = await fetcher();

  assert.deepEqual(calls, ['/dao/proposals/summary']);
  assert.equal(store.meta.count, 2);
  assert.equal(Object.keys(store.proposals).length, 2);
});

test('summary timestamp change refetches that one detail and updates cached meta', async () => {
  const calls = [];
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      return { meta: { count: 1, proposals: [indexEntry(7, { status: 'review', timestamp: 700 })] } };
    }
    if (path === '/dao/proposals/summary') {
      return { count: 1, proposals: [indexEntry(7, { status: 'voting', timestamp: 800 })] };
    }
    if (path === '/dao/proposals/7') {
      return { proposal: proposalAccount(7, { title: `Proposal 7 at ${calls.filter((call) => call === path).length}` }) };
    }
    return null;
  }, { storage, getNetId: () => 'testnet' });

  const first = await fetcher();
  assert.equal(first.proposals['7_proposal-7'].status, 'review');
  assert.equal(first.proposals['7_proposal-7'].state_changed, 700);

  calls.length = 0;
  const second = await fetcher();

  assert.deepEqual(calls, ['/dao/proposals/summary', '/dao/proposals/7']);
  assert.equal(second.proposals['7_proposal-7'].status, 'voting');
  assert.equal(second.proposals['7_proposal-7'].state_changed, 800);
  assert.equal(second.proposals['7_proposal-7'].emergency, false);
});

test('count mismatch re-fetches meta', async () => {
  const calls = [];
  let metaCount = 1;
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      const proposals = Array.from({ length: metaCount }, (_, index) => indexEntry(index + 1));
      return { meta: { count: metaCount, proposals } };
    }
    if (path === '/dao/proposals/summary') {
      return { count: 2, proposals: [indexEntry(2), indexEntry(1)] };
    }
    const number = Number(path.split('/').at(-1));
    return { proposal: proposalAccount(number) };
  }, { storage, getNetId: () => 'testnet' });

  await fetcher();
  metaCount = 2;
  calls.length = 0;
  const store = await fetcher();

  assert.equal(calls[0], '/dao/proposals/summary');
  assert.ok(calls.includes('/dao/proposals/meta'));
  assert.ok(calls.includes('/dao/proposals/2'));
  assert.equal(store.meta.count, 2);
  assert.equal(Object.keys(store.proposals).length, 2);
});

test('failed detail is not persisted and is retried', async (t) => {
  const calls = [];
  let failDetail = true;
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      return { meta: { count: 1, proposals: [indexEntry(3)] } };
    }
    if (path === '/dao/proposals/summary') {
      return { count: 1, proposals: [indexEntry(3)] };
    }
    if (path === '/dao/proposals/3') {
      if (failDetail) return null;
      return { proposal: proposalAccount(3) };
    }
    return null;
  }, { storage, getNetId: () => 'testnet' });

  t.mock.method(console, 'warn', () => {});
  const first = await fetcher();
  assert.deepEqual(first.proposals, {});

  failDetail = false;
  calls.length = 0;
  const second = await fetcher();

  assert.deepEqual(calls, ['/dao/proposals/summary', '/dao/proposals/3']);
  assert.equal(second.proposals['3_proposal-3'].title, 'Proposal 3');
});

test('getNetId change reads a different storage key', async () => {
  const calls = [];
  let netid = 'alpha';
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(`${netid}:${path}`);
    if (path === '/dao/proposals/meta') {
      const number = netid === 'alpha' ? 1 : 2;
      return { meta: { count: 1, proposals: [indexEntry(number)] } };
    }
    const number = Number(path.split('/').at(-1));
    return { proposal: proposalAccount(number, { title: `${netid} ${number}` }) };
  }, { storage, getNetId: () => netid });

  const first = await fetcher();
  assert.equal(first.proposals['1_proposal-1'].title, 'alpha 1');

  netid = 'beta';
  calls.length = 0;
  const second = await fetcher();

  assert.deepEqual(calls, ['beta:/dao/proposals/meta', 'beta:/dao/proposals/2']);
  assert.equal(second.proposals['2_proposal-2'].title, 'beta 2');
  assert.equal(storage.getItem('daoProposalMeta:alpha') != null, true);
  assert.equal(storage.getItem('daoProposalMeta:beta') != null, true);
});

test('invalidateProposalDetails causes the next refresh to refetch that proposal', async () => {
  const calls = [];
  const storage = createMemoryStorage();
  const fetcher = createDaoBackendFetcher(async (path) => {
    calls.push(path);
    if (path === '/dao/proposals/meta') {
      return { meta: { count: 1, proposals: [indexEntry(9)] } };
    }
    if (path === '/dao/proposals/summary') {
      return { count: 1, proposals: [indexEntry(9)] };
    }
    return { proposal: proposalAccount(9, { title: `fetch ${calls.filter((call) => call === path).length}` }) };
  }, { storage, getNetId: () => 'testnet' });

  setDaoBackendFetcher(fetcher);
  daoRepo.reset();
  await daoRepo.refresh({ force: true });
  calls.length = 0;

  daoRepo.invalidateProposalDetails(9);
  const store = await daoRepo.refresh({ force: true });

  assert.deepEqual(calls, ['/dao/proposals/summary', '/dao/proposals/9']);
  assert.equal(store.proposals['9_proposal-9'].title, 'fetch 1');
});
