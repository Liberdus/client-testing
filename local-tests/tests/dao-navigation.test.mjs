import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { DAO_PROJECT_FILTERS, DAO_STATES } from '../dao.js';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const lib = await readFile(new URL('../lib.js', import.meta.url), 'utf8');
const guard = lib.slice(lib.indexOf('const MODAL_TRANSITION_FALLBACK_MS'), lib.indexOf('/**\n * Wraps an async handler'));
const daoClass = app.slice(app.indexOf('class DaoModal {'), app.indexOf('const daoModal = new DaoModal();'));
assert.ok(guard.includes('export function openModal') && daoClass.includes('async _open('));

function modalElement() {
  const classes = new Set();
  return { classList: {
    add: (value) => classes.add(value), remove: (value) => classes.delete(value),
    contains: (value) => classes.has(value),
  } };
}

function setup() {
  const menu = modalElement();
  const calls = [];
  const context = {
    AbortController, assert, myData: {}, network: { netid: 'fixture' },
    DAO_FILTER_OPTIONS: [{ key: 'all' }, { key: 'claimable' }, ...DAO_STATES, ...DAO_PROJECT_FILTERS],
    DAO_PROJECT_FILTER_KEYS: new Set(DAO_PROJECT_FILTERS.map(({ key }) => key)),
    setTimeout: () => 1, clearTimeout() {},
    DAO_PROPOSAL_PAGE_SIZE: 10, createEmptyDaoNotificationSummary: () => ({}),
    getCorrectedTimestamp: () => 1000,
    showToast: () => 1, hideToast() {},
    menuModal: {
      isActive: () => menu.classList.contains('active'),
      close() { calls.push('close menu'); menu.classList.remove('active'); },
    },
    footer: { closeNewChatButton: () => calls.push('close new chat') },
    enterFullscreen: () => calls.push('fullscreen'),
    daoRepo: { reset() {}, refresh: async () => calls.push('refresh') },
  };
  const { DaoModal, openModal, finishModalTransition } = vm.runInNewContext(
    guard.replaceAll('export function', 'function') + daoClass
      + '\n({ DaoModal, openModal, finishModalTransition });', context,
  );
  const dao = new DaoModal();
  dao.modal = modalElement();
  dao.render = () => calls.push('render');
  dao.acknowledgeNotifications = () => {};
  dao.syncTrackedClaimWindows = async () => [];
  dao.loadSelectedFilter = async () => calls.push('load filter');
  return { dao, menu, calls, openModal, finishModalTransition };
}

test('rejected DAO opening preserves the menu and refresh state without starting reads', async () => {
  const h = setup();
  h.openModal(h.menu);
  const before = [h.dao.refreshSequence, h.dao.openRefreshId, h.dao.proposalOpenSequence];
  await h.dao._open('all');
  assert.equal(h.menu.classList.contains('active'), true);
  assert.equal(h.dao.isActive(), false);
  assert.deepEqual([h.dao.refreshSequence, h.dao.openRefreshId, h.dao.proposalOpenSequence], before);
  assert.deepEqual(h.calls, []);
});

test('DAO opens and refreshes after the menu transition completes', async () => {
  const h = setup();
  h.openModal(h.menu);
  await h.dao._open('all');
  h.finishModalTransition(h.menu);
  await h.dao._open('all');
  assert.equal(h.menu.classList.contains('active'), false);
  assert.equal(h.dao.isActive(), true);
  assert.equal(h.dao.refreshState, 'ready');
  assert.equal(h.dao.selectedFilterKey, 'all');
  assert.equal(h.calls.filter((call) => call === 'refresh').length, 1);
});

test('reopening an already active DAO still refreshes and applies the requested filter', async () => {
  const h = setup();
  h.openModal(h.dao.modal);
  h.finishModalTransition(h.dao.modal);
  await h.dao._open('all');
  await h.dao._open('completed');
  assert.equal(h.dao.selectedFilterKey, 'completed');
  assert.equal(h.calls.filter((call) => call === 'refresh').length, 2);
});
