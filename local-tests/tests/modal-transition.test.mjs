import assert from 'node:assert/strict';
import test from 'node:test';

class FakeDocument {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function createModal() {
  const classes = new Set();
  return {
    classList: {
      add: (className) => classes.add(className),
      contains: (className) => classes.has(className),
      remove: (className) => classes.delete(className),
    },
  };
}

const fakeDocument = new FakeDocument();
globalThis.document = fakeDocument;

const {
  installModalTransitionListeners,
  openModal,
} = await import('../lib.js');

installModalTransitionListeners();
installModalTransitionListeners();

test('installs one shared modal transition listener', () => {
  assert.equal(fakeDocument.listeners.get('transitionend').length, 1);
  assert.equal(fakeDocument.listeners.get('transitioncancel').length, 1);
});

test('ignores overlapping modal requests', () => {
  const openingModal = createModal();
  const blockedModal = createModal();

  assert.equal(openModal(openingModal), true);
  assert.equal(openModal(blockedModal), false);
  assert.equal(openingModal.classList.contains('active'), true);
  assert.equal(openingModal.classList.contains('is-transition-complete'), false);
  assert.equal(blockedModal.classList.contains('active'), false);

  fakeDocument.emit('transitionend', { target: openingModal, propertyName: 'transform' });
  assert.equal(blockedModal.classList.contains('active'), false);

  fakeDocument.emit('transitionend', { target: openingModal, propertyName: 'opacity' });
  assert.equal(openingModal.classList.contains('is-transition-complete'), true);
  assert.equal(blockedModal.classList.contains('active'), false);

  openModal(blockedModal);
  assert.equal(blockedModal.classList.contains('active'), true);
  fakeDocument.emit('transitionend', { target: blockedModal, propertyName: 'opacity' });
});

test('releases a cancelled transition for the next request', () => {
  const openingModal = createModal();
  const nextModal = createModal();

  openModal(openingModal);
  fakeDocument.emit('transitioncancel', { target: openingModal, propertyName: 'opacity' });

  openModal(nextModal);
  assert.equal(nextModal.classList.contains('active'), true);
  fakeDocument.emit('transitionend', { target: nextModal, propertyName: 'opacity' });
});

test('releases the guard when no transition event is emitted', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let runFallback;

  globalThis.setTimeout = (callback) => {
    runFallback = callback;
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    const openingModal = createModal();
    const nextModal = createModal();
    openModal(openingModal);

    runFallback();

    assert.equal(openingModal.classList.contains('is-transition-complete'), true);
    openModal(nextModal);
    assert.equal(nextModal.classList.contains('active'), true);
    fakeDocument.emit('transitionend', { target: nextModal, propertyName: 'opacity' });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
