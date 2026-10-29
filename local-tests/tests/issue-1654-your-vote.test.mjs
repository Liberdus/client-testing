import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

// WEB_CLIENT_ROOT=/absolute/client/checkout node --test local-tests/tests/issue-1654-your-vote.test.mjs
// Covers web-client-v2 issue #1654 PR 2: the signed-in account's own vote in Proposal Info.
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const dao = await import(pathToFileURL(join(clientRoot, 'dao.js')).href);
const {
  createDaoProposalVoteTracker,
  DAO_USER_VOTE_SUMMARY_KINDS,
  getDaoUserVoteSummary,
} = dao;

const USER = 'a'.repeat(40);
const USER_LONG = `${USER}${'0'.repeat(24)}`;
const OTHER = 'b'.repeat(40);
const TX_A = 'a1'.repeat(32);
const TX_B = 'b2'.repeat(32);
const LIB = 10n ** 18n;

function proposal(overrides = {}) {
  return { number: 12, options: ['no', 'Raise the fee', 'Lower the fee'], voterList: [], ...overrides };
}
const votedBy = (address, timestamp = 1_250) => ({ voterList: [{ address, timestamp }] });
function cast(txid, overrides = {}) {
  return { txid, weights: [0, 3, 1], spend: 40n * LIB, timestamp: 1_300, status: 'submitted', ...overrides };
}

test('nothing is shown for an account that has not voted', () => {
  assert.deepEqual(
    getDaoUserVoteSummary({ proposal: proposal(votedBy(OTHER)), address: USER, casts: [] }),
    { kind: DAO_USER_VOTE_SUMMARY_KINDS.NONE },
  );
  assert.equal(getDaoUserVoteSummary({ proposal: proposal(), address: '', casts: [cast(TX_A)] }).kind, 'none');
  assert.equal(getDaoUserVoteSummary({}).kind, 'none');
});

test('voterList participation without local casts gives the neutral voted fallback', () => {
  assert.deepEqual(
    getDaoUserVoteSummary({ proposal: proposal(votedBy(USER_LONG, 1_250)), address: USER, casts: [] }),
    { kind: DAO_USER_VOTE_SUMMARY_KINDS.VOTED, confirmed: true, timestamp: 1_250 },
  );
  // Malformed or mismatched local casts do not invent a choice.
  const summary = getDaoUserVoteSummary({
    proposal: proposal(votedBy(USER)),
    address: `0x${USER}`,
    casts: [{ txid: 'bad' }, cast(TX_A, { weights: [1, 1] })],
  });
  assert.equal(summary.kind, 'voted');
});

test('a single cast is shown per option with allocation shares and no power', () => {
  const summary = getDaoUserVoteSummary({ proposal: proposal(votedBy(USER)), address: USER_LONG, casts: [cast(TX_A)] });

  assert.equal(summary.kind, DAO_USER_VOTE_SUMMARY_KINDS.DETAIL);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.castCount, 1);
  assert.equal(summary.spend, 40n * LIB);
  assert.equal(summary.totalPower, null);
  assert.equal(summary.timestamp, 1_300);
  assert.deepEqual(summary.rows, [
    { option: 'No change', allocation: 0n, share: 0, power: null },
    { option: 'Raise the fee', allocation: 30n * LIB, share: 0.75, power: null },
    { option: 'Lower the fee', allocation: 10n * LIB, share: 0.25, power: null },
  ]);
});

test('multiple casts combine by allocated LIB rather than by adding weight arrays', () => {
  const summary = getDaoUserVoteSummary({
    proposal: proposal(votedBy(USER)),
    address: USER,
    casts: [
      cast(TX_A, { weights: [1, 0, 0], spend: 10n * LIB, timestamp: 1_000 }),
      cast(TX_B, { weights: [0, 1, 1], spend: 30n * LIB, timestamp: 2_000 }),
      cast(TX_A, { weights: [0, 0, 9], spend: 999n * LIB }), // duplicate txid is ignored
    ],
  });

  assert.equal(summary.castCount, 2);
  assert.equal(summary.spend, 40n * LIB);
  assert.equal(summary.timestamp, 2_000);
  assert.deepEqual(summary.rows.map((row) => [row.allocation, row.share]), [
    [10n * LIB, 0.25],
    [15n * LIB, 0.375],
    [15n * LIB, 0.375],
  ]);
});

test('applied power is reported only when every cast carries option weights', () => {
  const withPower = getDaoUserVoteSummary({
    proposal: proposal(),
    address: USER,
    casts: [
      cast(TX_A, { optionWeights: [0n, 30n, 10n] }),
      cast(TX_B, { weights: [2, 0, 0], spend: 20n * LIB, optionWeights: ['20', 0, { dataType: 'bi', value: '0' }] }),
    ],
  });
  assert.equal(withPower.confirmed, false);
  assert.equal(withPower.totalPower, 60n);
  assert.deepEqual(withPower.rows.map((row) => row.power), [20n, 30n, 10n]);

  const partial = getDaoUserVoteSummary({
    proposal: proposal(),
    address: USER,
    casts: [cast(TX_A, { optionWeights: [0n, 30n, 10n] }), cast(TX_B)],
  });
  assert.equal(partial.totalPower, null);
  assert.deepEqual(partial.rows.map((row) => row.power), [null, null, null]);
});

test('option labels fall back to numbered options when the proposal has none', () => {
  const summary = getDaoUserVoteSummary({ proposal: { number: 12 }, address: USER, casts: [cast(TX_A)] });
  assert.deepEqual(summary.rows.map((row) => row.option), ['Option 1', 'Option 2', 'Option 3']);
});

test('the tracker exposes normalized casts for a proposal without exposing other state', () => {
  const myData = { daoUserVotes: {} };
  const tracker = createDaoProposalVoteTracker({
    getDaoUserVotes: () => myData.daoUserVotes,
    setDaoUserVotes: (votes) => { myData.daoUserVotes = votes; },
  });
  assert.deepEqual(tracker.getCasts(12), []);
  tracker.recordSubmittedVote({ proposalNumber: 12, txid: TX_A, weights: [0, 3, 1], spend: 40n * LIB, timestamp: 1_300 });
  myData.daoUserVotes[12].casts.push({ txid: 'malformed' });

  const casts = tracker.getCasts(12);
  assert.equal(casts.length, 1);
  assert.equal(casts[0].txid, TX_A);
  assert.equal(casts[0].status, 'submitted');
  assert.deepEqual(tracker.getCasts('nope'), []);
  assert.deepEqual(tracker.getCasts(13), []);
});

// Render checks: evaluate the real ProposalInfoModal class with simple, deterministic
// formatter stubs so assertions stay about structure and fallbacks, not number formatting.
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');
const modalStart = appSource.indexOf('class ProposalInfoModal {');
const modalEnd = appSource.indexOf('const proposalInfoModal = new ProposalInfoModal();', modalStart);
assert.ok(modalStart >= 0 && modalEnd > modalStart, 'ProposalInfoModal must exist in app.js');
const modalSource = `${appSource.slice(modalStart, modalEnd)}\n({ ProposalInfoModal });`;

function renderWith({ proposalData, casts, address = USER_LONG }) {
  const context = {
    ...dao,
    daoProposalVoteTracker: { getCasts: (number) => (number === proposalData.number ? casts : []) },
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeDaoFormAttribute: (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    formatDaoPercent: (share) => `${Math.round(share * 100)}%`,
    formatDaoLibWei: (wei) => `${wei / LIB} LIB`,
    formatDaoVotingPower: (power) => `${power} power`,
    formatDaoCompactTimestamp: (ts) => (ts ? `t${ts}` : ''),
  };
  const { ProposalInfoModal } = vm.runInNewContext(modalSource, context);
  const modal = new ProposalInfoModal();
  return modal.renderUserVote(proposalData, address);
}

test('render: hidden when nothing shows the account voted', () => {
  assert.equal(renderWith({ proposalData: proposal(votedBy(OTHER)), casts: [] }), '');
});

test('render: Vote recorded fallback names no option or amount', () => {
  const html = renderWith({ proposalData: proposal(votedBy(USER, 1_250)), casts: [] });
  assert.match(html, /<h3>Your vote<\/h3>/);
  assert.match(html, /Vote recorded/);
  assert.match(html, /Voted: t1250/);
  assert.doesNotMatch(html, /Raise the fee|LIB|power/);
});

test('render: local casts show option rows, spend, status, and escape long labels', () => {
  const longLabel = `Raise the fee ${'x'.repeat(120)} <b>&"</b>`;
  const html = renderWith({
    proposalData: proposal({ options: ['no', longLabel, 'Lower the fee'], ...votedBy(USER) }),
    casts: [cast(TX_A), cast(TX_B, { weights: [0, 0, 1], spend: 20n * LIB })],
  });

  assert.match(html, /proposal-user-vote-status--confirmed">Confirmed</);
  assert.match(html, /<span>0%<\/span>\s*<span>No change<\/span>\s*<strong>0 LIB<\/strong>/);
  assert.match(html, /<span>50%<\/span>\s*<span>Raise the fee x+ &lt;b&gt;&amp;&quot;&lt;\/b&gt;<\/span>\s*<strong>30 LIB<\/strong>/);
  assert.match(html, /<span>50%<\/span>\s*<span>Lower the fee<\/span>\s*<strong>30 LIB<\/strong>/);
  assert.match(html, /<span>Spend<\/span><strong>60 LIB<\/strong>/);
  assert.doesNotMatch(html, /Voting power/);
  assert.match(html, /Combined from 2 votes\./);
  assert.doesNotMatch(html, /<b>/);
});

test('render: unconfirmed casts are labeled and power appears once option weights exist', () => {
  const html = renderWith({
    proposalData: proposal(),
    casts: [cast(TX_A, { optionWeights: [0n, 30n, 10n] })],
  });
  assert.match(html, /proposal-user-vote-status">Awaiting confirmation</);
  assert.match(html, /<span>Voting power<\/span><strong>40 power<\/strong>/);
  assert.match(html, /<strong>30 power<\/strong>/);
  assert.doesNotMatch(html, /Combined from/);
});
