import assert from 'node:assert/strict';
import test from 'node:test';

import { evmAssets } from '../evm-assets.js';
import { installModalTransitionListeners, openModal } from '../lib.js';

const transitionListeners = new Map();
globalThis.document = {
  addEventListener: (type, listener) => transitionListeners.set(type, listener),
};
installModalTransitionListeners();

function finishOpening(modal) {
  transitionListeners.get('transitionend')({ target: modal, propertyName: 'opacity' });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(t) {
  const controller = new evmAssets.constructor();
  const modal = controller.assetsModal;
  const classes = new Set();
  modal.modal = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
  const shown = [];
  const hidden = [];
  controller.configure({
    showToast: (...args) => {
      shown.push(args);
      return `toast-${shown.length}`;
    },
    hideToast: (id) => hidden.push(id),
  });
  const loading = deferred();
  const update = t.mock.method(modal, 'update', () => loading.promise);
  t.after(() => {
    modal.close();
    finishOpening(modal.modal);
  });
  return { modal, loading, update, shown, hidden };
}

test('keeps a loading toast visible until the modal data finishes loading', async (t) => {
  const { modal, loading, shown, hidden } = setup(t);
  const opening = modal.open();
  assert.equal(modal.isActive(), true);
  assert.deepEqual(shown, [['Loading EVM assets...', 0, 'loading', false, { dedupe: false }]]);
  await Promise.resolve();
  assert.deepEqual(hidden, []);

  loading.resolve();
  await opening;
  assert.deepEqual(hidden, ['toast-1']);
});

test('cleans up the loading toast if loading fails', async (t) => {
  const { modal, loading, hidden } = setup(t);
  const opening = modal.open();
  loading.reject(new Error('Loading failed'));
  await assert.rejects(opening, /Loading failed/);
  assert.deepEqual(hidden, ['toast-1']);
});

test('closing while loading dismisses the toast immediately', async (t) => {
  const { modal, loading, hidden } = setup(t);
  const opening = modal.open();
  modal.close();
  assert.equal(modal.isActive(), false);
  assert.deepEqual(hidden, ['toast-1']);
  loading.resolve();
  await opening;
  assert.deepEqual(hidden, ['toast-1']);
});

test('an earlier load cannot dismiss the toast after closing and reopening', async (t) => {
  const { modal, loading, update, shown, hidden } = setup(t);
  const firstOpening = modal.open();
  finishOpening(modal.modal);
  modal.close();

  const nextLoading = deferred();
  update.mock.mockImplementation(() => nextLoading.promise);
  const nextOpening = modal.open();
  assert.equal(shown.length, 2);
  loading.resolve();
  await firstOpening;
  assert.deepEqual(hidden, ['toast-1']);

  nextLoading.resolve();
  await nextOpening;
  assert.deepEqual(hidden, ['toast-1', 'toast-2']);
});

test('repeated open requests do not duplicate loading toasts or updates', async (t) => {
  const { modal, loading, update, shown } = setup(t);
  const opening = modal.open();
  finishOpening(modal.modal);
  await modal.open();
  assert.equal(shown.length, 1);
  assert.equal(update.mock.callCount(), 1);
  loading.resolve();
  await opening;
});

test('a blocked modal opening does not start a loading toast', async (t) => {
  const { modal, update, shown } = setup(t);
  const otherModal = { classList: { add() {}, remove() {}, contains: () => false } };
  openModal(otherModal);
  try {
    await modal.open();
    assert.deepEqual(shown, []);
    assert.equal(update.mock.callCount(), 0);
  } finally {
    finishOpening(otherModal);
  }
});
