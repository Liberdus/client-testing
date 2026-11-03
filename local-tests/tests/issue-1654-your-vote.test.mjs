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
  // Malformed or option-count-mismatched local casts do not invent a choice.
  const summary = getDaoUserVoteSummary({
    proposal: proposal(votedBy(USER)),
    address: `0x${USER}`,
    casts: [{ txid: 'bad' }, cast(TX_A, { weights: [1, 1] })],
  });
  assert.equal(summary.kind, 'voted');
});

test('a single cast is listed with weight shares, allocated LIB, its status and no power', () => {
  const summary = getDaoUserVoteSummary({ proposal: proposal(votedBy(USER, 1_250)), address: USER_LONG, casts: [cast(TX_A)] });

  assert.equal(summary.kind, DAO_USER_VOTE_SUMMARY_KINDS.DETAIL);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.timestamp, 1_250);
  assert.equal(summary.casts.length, 1);
  const [only] = summary.casts;
  assert.equal(only.txid, TX_A);
  assert.equal(only.status, 'submitted');
  assert.equal(only.timestamp, 1_300);
  assert.equal(only.spend, 40n * LIB);
  assert.equal(only.totalPower, null);
  assert.deepEqual(only.rows, [
    { option: 'No change', weight: 0, share: 0, allocation: 0n, power: null },
    { option: 'Raise the fee', weight: 3, share: 0.75, allocation: 30n * LIB, power: null },
    { option: 'Lower the fee', weight: 1, share: 0.25, allocation: 10n * LIB, power: null },
  ]);
});

test('multiple casts are listed separately in time order and are never combined', () => {
  const summary = getDaoUserVoteSummary({
    proposal: proposal(),
    address: USER,
    casts: [
      cast(TX_B, { weights: [0, 1, 1], spend: 30n * LIB, timestamp: 2_000 }),
      cast(TX_A, { weights: [1, 0, 0], spend: 10n * LIB, timestamp: 1_000 }),
      cast(TX_A, { weights: [0, 0, 9], spend: 999n * LIB, timestamp: 1 }), // duplicate txid is ignored
    ],
  });

  assert.equal(summary.confirmed, false);
  assert.equal(summary.timestamp, 0);
  assert.deepEqual(summary.casts.map((entry) => [entry.txid, entry.timestamp, entry.spend]), [
    [TX_A, 1_000, 10n * LIB],
    [TX_B, 2_000, 30n * LIB],
  ]);
  assert.deepEqual(summary.casts[0].rows.map((row) => [row.share, row.allocation]), [[1, 10n * LIB], [0, 0n], [0, 0n]]);
  assert.deepEqual(summary.casts[1].rows.map((row) => [row.share, row.allocation]), [[0, 0n], [0.5, 15n * LIB], [0.5, 15n * LIB]]);
  assert.equal('rows' in summary, false);
});

test('applied power is reported per cast only when that cast carries option weights', () => {
  const summary = getDaoUserVoteSummary({
    proposal: proposal(),
    address: USER,
    casts: [
      cast(TX_A, { timestamp: 1_000, optionWeights: ['0', 30n, { dataType: 'bi', value: 'a' }] }),
      cast(TX_B, { timestamp: 2_000, weights: [2, 0, 0], spend: 20n * LIB }),
    ],
  });

  assert.equal(summary.casts[0].totalPower, 40n);
  assert.deepEqual(summary.casts[0].rows.map((row) => row.power), [0n, 30n, 10n]);
  assert.equal(summary.casts[1].totalPower, null);
  assert.deepEqual(summary.casts[1].rows.map((row) => row.power), [null, null, null]);
});

test('option labels fall back to numbered options when the proposal has none', () => {
  const summary = getDaoUserVoteSummary({ proposal: { number: 12 }, address: USER, casts: [cast(TX_A)] });
  assert.deepEqual(summary.casts[0].rows.map((row) => row.option), ['Option 1', 'Option 2', 'Option 3']);
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

function buildModal({ proposalData, casts, address = USER_LONG, contextOverrides = {} }) {
  const context = {
    ...dao,
    getDaoCurrentAccountAddress: () => address,
    daoProposalVoteTracker: { getCasts: (number) => (number === proposalData.number ? casts : []) },
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeDaoFormAttribute: (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    formatDaoPercent: (share) => `${Math.round(share * 100)}%`,
    formatDaoLibWei: (wei) => `${wei / LIB} LIB`,
    formatDaoVotingPower: (power) => `${power} power`,
    formatDaoCompactTimestamp: (ts) => (ts ? `t${ts}` : ''),
    ...contextOverrides,
  };
  const { ProposalInfoModal } = vm.runInNewContext(modalSource, context);
  return new ProposalInfoModal();
}

function renderWith(options) {
  return buildModal(options).renderUserVote(options.proposalData, options.address ?? USER_LONG);
}

function readVoteDisclosure(html) {
  const match = /<details\b([^>]*)>\s*<summary\b[^>]*>(.*?)<\/summary>/s.exec(html);
  assert.ok(match, 'saved vote details have a native disclosure');
  return { open: /\bopen\b/.test(match[1]), summary: match[2] };
}

function createVoteContent() {
  let html = '';
  let disclosure = null;
  return {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      disclosure = /<details\b/.test(value) ? readVoteDisclosure(value) : null;
      if (disclosure) {
        disclosure.firstElementChild = {
          focused: false,
          matches(selector) { return selector === ':focus' && this.focused; },
          focus() { this.focused = true; },
        };
      }
    },
    querySelector(selector) {
      if (selector === '.proposal-user-vote-slot') return this;
      if (selector === '.proposal-user-vote-section') return disclosure;
      if (selector === '.proposal-user-vote-heading') return disclosure?.firstElementChild ?? null;
      return null;
    },
  };
}

test('render: hidden when nothing shows the account voted', () => {
  assert.equal(renderWith({ proposalData: proposal(votedBy(OTHER)), casts: [] }), '');
});

test('render: Vote recorded fallback names no option or amount', () => {
  const html = renderWith({ proposalData: proposal(votedBy(USER, 1_250)), casts: [] });
  const disclosure = readVoteDisclosure(html);
  assert.equal(disclosure.open, true);
  assert.match(disclosure.summary, /Your vote/);
  assert.match(disclosure.summary, /Voted: t1250/);
  assert.match(html, /Vote recorded/);
  assert.doesNotMatch(html, /Raise the fee|LIB|power|Submitted/);
});

test('render: each cast gets its own card with rows, spend, status, and escaped long labels', () => {
  const longLabel = `Raise the fee ${'x'.repeat(120)} <b>&"</b>`;
  const html = renderWith({
    proposalData: proposal({ options: ['no', longLabel, 'Lower the fee'], ...votedBy(USER, 1_250) }),
    casts: [cast(TX_A, { timestamp: 1_300 }), cast(TX_B, { weights: [0, 0, 1], spend: 20n * LIB, timestamp: 1_400 })],
  });

  assert.match(html, /Voted: t1250/);
  assert.equal((html.match(/proposal-user-vote-card"/g) || []).length, 2);
  assert.equal((html.match(/>Submitted</g) || []).length, 2);
  assert.match(html, /Vote 1 · t1300<\/span>\s*<span[^>]*>Submitted<\/span>/);
  assert.match(html, /Vote 2 · t1400<\/span>\s*<span[^>]*>Submitted<\/span>/);
  assert.match(html, /<span[^>]*>No change<\/span>\s*<span[^>]*>0%<\/span>\s*<strong>0 LIB<\/strong>/);
  assert.match(html, /<span[^>]*>Raise the fee x+ &lt;b&gt;&amp;&quot;&lt;\/b&gt;<\/span>\s*<span[^>]*>75%<\/span>\s*<strong>30 LIB<\/strong>/);
  assert.match(html, /<span[^>]*>Lower the fee<\/span>\s*<span[^>]*>100%<\/span>\s*<strong>20 LIB<\/strong>/);
  assert.match(html, /<span>Spend<\/span><strong>40 LIB<\/strong>/);
  assert.match(html, /<span>Spend<\/span><strong>20 LIB<\/strong>/);
  assert.match(readVoteDisclosure(html).summary, /60 LIB/);
  assert.doesNotMatch(html, /Voting power|Combined|Confirmed|Awaiting/);
  assert.doesNotMatch(html, /<b>/);
});

test('render: a single cast is labeled Vote, and power appears for a cast with option weights', () => {
  const html = renderWith({
    proposalData: proposal(),
    casts: [cast(TX_A, { optionWeights: [0n, 30n, 10n] })],
  });
  assert.doesNotMatch(html, /Voted:/);
  const disclosure = readVoteDisclosure(html);
  assert.equal(disclosure.open, true);
  assert.match(disclosure.summary, /Your vote/);
  assert.match(disclosure.summary, /40 LIB/);
  assert.doesNotMatch(disclosure.summary, /Raise the fee|Lower the fee|Voting power/);
  assert.match(html, /<span[^>]*>Vote · t1300<\/span>\s*<span[^>]*>Submitted<\/span>/);
  assert.match(html, /<span>Voting power<\/span><strong>40 power<\/strong>/);
  assert.match(html, /<strong>30 power<\/strong>/);
  assert.doesNotMatch(html, /Vote 1/);
});

test('refreshUserVote replaces only the slot in the open modal, so a saved cast shows at once', () => {
  const saved = [];
  const proposalData = proposal();
  const modal = buildModal({ proposalData, casts: saved });
  const slot = createVoteContent();
  const untouched = { innerHTML: '<h3>Current Vote</h3>' };
  modal.content = { querySelector: (selector) => (selector === '.proposal-user-vote-slot' ? slot : untouched) };

  modal.refreshUserVote(proposalData);
  assert.equal(slot.innerHTML, '', 'nothing saved yet: slot stays empty');

  saved.push(cast(TX_A));
  modal.refreshUserVote(proposalData);
  assert.match(readVoteDisclosure(slot.innerHTML).summary, /Your vote/);
  assert.match(slot.innerHTML, /Submitted/);
  assert.doesNotMatch(slot.innerHTML, /Voted:/, 'no voterList entry yet, so no Voted time');
  assert.equal(untouched.innerHTML, '<h3>Current Vote</h3>');

  modal.content = null;
  assert.doesNotThrow(() => modal.refreshUserVote(proposalData));
  assert.doesNotThrow(() => modal.refreshUserVote(null));
});

test('the collapsed disclosure keeps focus through refreshes and a reopened modal starts expanded', async () => {
  const proposalId = 'proposal-12';
  const saved = [cast(TX_A)];
  const proposalData = proposal({ status: 'accepted' });
  const active = new Set();
  const modal = buildModal({
    proposalData,
    casts: saved,
    contextOverrides: {
      daoRepo: { ensureLoaded: async () => {}, getProposalById: () => proposalData },
      daoModal: { restoreListFocus() {} },
      openModal: () => active.add('active'),
      enterFullscreen() {},
      getTransactionTimestamp: () => 1_500,
      getDaoProposalReviewWindow: () => ({}),
      getDaoCommitteeReview: () => ({ committeeAddresses: [], committeeAddressSet: new Set(), votes: [] }),
      getDaoProposalResultSummary: () => null,
      getDaoProposalRewardSummary: () => null,
      getDaoProposalLifecycleActions: () => [],
      renderDaoProposalHeading: () => '',
      renderDaoProposalOptions: () => '',
      myData: { pending: [] },
    },
  });
  modal.modal = {
    classList: { contains: (name) => active.has(name), remove: (name) => active.delete(name) },
    querySelectorAll: () => [],
  };
  modal.content = createVoteContent();
  await modal._open(proposalId);
  const disclosure = () => modal.content.querySelector('.proposal-user-vote-section');
  assert.equal(disclosure()?.open, true);

  disclosure().open = false;
  disclosure().firstElementChild.focus();
  saved.push(cast(TX_B, { spend: 20n * LIB }));
  modal.refreshUserVote(proposalData);
  assert.equal(disclosure().open, false, 'saving another cast preserves the collapsed state');
  assert.match(disclosure().summary, /60 LIB/, 'the collapsed summary reflects the new spend');
  assert.equal(disclosure().firstElementChild.matches(':focus'), true);

  proposalData.voterList = votedBy(USER).voterList;
  modal.refreshIfOpen(proposalId);
  assert.equal(disclosure().open, false, 'a full proposal refresh preserves the collapsed state');
  assert.match(modal.content.innerHTML, /Voted: t1250/);
  assert.equal(disclosure().firstElementChild.matches(':focus'), true);

  modal.close();
  await modal._open(proposalId);
  assert.equal(disclosure().open, true, 'reopening starts expanded');
});
