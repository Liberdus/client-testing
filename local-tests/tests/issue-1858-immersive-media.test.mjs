import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

// Published companion main has no offline runner yet; run this file directly.
// WEB_CLIENT_ROOT=/absolute/client/path node local-tests/tests/issue-1858-immersive-media.test.mjs
assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to an absolute client checkout.');
const appSource = readFileSync(join(process.env.WEB_CLIENT_ROOT, 'app.js'), 'utf8');
const htmlSource = readFileSync(join(process.env.WEB_CLIENT_ROOT, 'index.html'), 'utf8');

class FakeClock {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.now + delay });
    return id;
  }

  clearTimeout(id) { this.tasks.delete(id); }

  tick(duration) {
    const end = this.now + duration;
    while (true) {
      const next = [...this.tasks].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

class Element {
  constructor(markup = '') {
    this.hidden = /\bhidden(?:\s|>|$)/.test(markup);
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.children = [];
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.hovered = false;
    this.focusVisible = false;
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return force;
      },
    };
  }

  append(child) { child.parent = this; this.children.push(child); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector === ':hover') return this.hovered;
    if (selector.includes(':focus-visible')) return this.focusVisible;
    return selector.startsWith('.') && this.classes.has(selector.slice(1));
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  pause() {}
  load() {}

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name, details = {}) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      ...details,
    };
    this[`on${name}`]?.(event);
    let current = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(name) || []) listener(event);
      if (['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave'].includes(name)) break;
      current = current.parent;
    }
  }
}

class MediaHarness {
  constructor() {
    this.clock = new FakeClock();
    this.hoverCapable = true;
    this.document = new Element();
    this.document.activeElement = null;
    this.nodes = new Map();
    for (const match of htmlSource.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      this.nodes.set(match[1], new Element(match[0]));
    }
    this.document.getElementById = id => this.nodes.get(id) || null;
    this.container = this.nodes.get('fullImageModal');
    this.header = new Element();
    this.header.classList.add('modal-header');
    this.container.append(this.header);
    this.document.append(this.container);
    for (const id of ['closeFullImageModal', 'fullImageModalTitle']) this.header.append(this.nodes.get(id));
    const viewer = this.nodes.get('fullImageViewer');
    this.container.append(viewer);
    for (const id of ['fullImageLoading', 'fullImageError', 'fullImageViewerImage', 'fullImageViewerVideo', 'fullImageZoomControls']) {
      viewer.append(this.nodes.get(id));
    }
    const controls = this.nodes.get('fullImageZoomControls');
    controls.classList.add('full-image-zoom-controls');
    controls.append(this.nodes.get('fullImageZoomIn'));
    controls.append(this.nodes.get('fullImageZoomOut'));

    const start = appSource.indexOf('\nclass FullImageModal {');
    const end = appSource.indexOf('\nconst fullImageModal =', start);
    assert.ok(start >= 0 && end > start, 'FullImageModal must remain extractable for isolated behavior tests.');
    const environment = {
      assert,
      Blob,
      AbortController,
      document: this.document,
      setTimeout: this.clock.setTimeout.bind(this.clock),
      clearTimeout: this.clock.clearTimeout.bind(this.clock),
      matchMedia: () => ({ matches: this.hoverCapable }),
      URL: { createObjectURL: () => 'blob:synthetic-media', revokeObjectURL() {} },
      openModal: modal => { modal.classList.add('active'); return true; },
    };
    environment.window = environment;
    const Modal = new Function(...Object.keys(environment), `return (${appSource.slice(start, end)});`)(...Object.values(environment));
    this.modal = new Modal();
    this.modal.load();
  }

  open(kind = 'image', ready = true) {
    const request = this.modal.openLoading(`example.${kind === 'image' ? 'png' : 'mp4'}`, kind);
    const blob = new Blob(['synthetic-media'], { type: kind === 'image' ? 'image/png' : 'video/mp4' });
    if (ready && kind === 'image') {
      this.modal.showImage(blob, request);
      this.modal.image.dispatch('load');
    } else if (ready) {
      this.modal.showVideo(blob, request);
      this.modal.video.dispatch('loadedmetadata');
    }
    return request;
  }

  assertVisible(message = 'keep viewer chrome visible') {
    assert.equal(this.container.classList.contains('is-chrome-hidden'), false, message);
  }

  assertHidden(message = 'hide viewer chrome after three idle seconds') {
    assert.equal(this.container.classList.contains('is-chrome-hidden'), true, message);
  }
}

test('image and video chrome hide three seconds after media becomes ready', () => {
  for (const kind of ['image', 'video']) {
    const h = new MediaHarness();
    h.open(kind);
    h.clock.tick(2999);
    h.assertVisible();
    h.clock.tick(1);
    h.assertHidden(kind);
  }
});

test('loading and error feedback keep chrome visible without idle callbacks', () => {
  const h = new MediaHarness();
  const request = h.open('image', false);
  h.clock.tick(30_000);
  h.assertVisible('loading must retain the back button and filename');
  assert.equal(h.clock.tasks.size, 0);
  h.modal.showError('Synthetic load failure.', request);
  h.clock.tick(30_000);
  h.assertVisible('error feedback must retain the back button and filename');
  assert.equal(h.clock.tasks.size, 0);
});

test('pointer, touch and keyboard activity reveal chrome and restart its idle delay', () => {
  for (const type of ['pointermove', 'touchstart', 'keydown']) {
    const h = new MediaHarness();
    h.open('video');
    h.clock.tick(3000);
    h.assertHidden();
    const target = type === 'keydown' ? h.document : h.modal.video;
    target.dispatch(type, { key: 'ArrowRight', touches: [{ clientX: 10, clientY: 10 }] });
    h.assertVisible(type);
    h.clock.tick(2999);
    h.assertVisible();
    h.clock.tick(1);
    h.assertHidden(type);
  }
});

test('video timeupdate events do not postpone chrome hiding', () => {
  const h = new MediaHarness();
  h.open('video');
  for (let elapsed = 0; elapsed < 3000; elapsed += 500) {
    h.clock.tick(500);
    h.modal.video.dispatch('timeupdate');
  }
  h.assertHidden();
});

test('hovering the header or zoom controls holds chrome until the pointer leaves', () => {
  for (const area of ['header', 'zoomControls']) {
    const h = new MediaHarness();
    h.open();
    h.clock.tick(1000);
    const target = area === 'header' ? h.header : h.modal.zoomControls;
    target.hovered = true;
    target.dispatch('pointerenter');
    h.clock.tick(6000);
    h.assertVisible(area);
    target.hovered = false;
    target.dispatch('pointerleave');
    h.clock.tick(2999);
    h.assertVisible();
    h.clock.tick(1);
    h.assertHidden(area);
  }
});

test('sticky touch hover does not keep chrome visible on devices without hover capability', () => {
  for (const area of ['header', 'zoomControls']) {
    const h = new MediaHarness();
    h.hoverCapable = false;
    h.open();
    const target = area === 'header' ? h.header : h.modal.zoomControls;
    target.hovered = true;
    target.dispatch('pointerenter');
    h.clock.tick(2999);
    h.assertVisible();
    h.clock.tick(1);
    h.assertHidden(area);
  }
});

test('keyboard focus on a visible control holds chrome until focus leaves', async () => {
  const h = new MediaHarness();
  h.open();
  h.clock.tick(3000);
  h.assertHidden();
  h.document.activeElement = h.modal.closeButton;
  h.modal.closeButton.focusVisible = true;
  h.modal.closeButton.dispatch('focusin');
  h.assertVisible('keyboard focus must reveal the hidden controls');
  h.clock.tick(6000);
  h.assertVisible();
  h.document.activeElement = null;
  h.modal.closeButton.focusVisible = false;
  h.modal.closeButton.dispatch('focusout', { relatedTarget: null });
  await Promise.resolve();
  h.clock.tick(3000);
  h.assertHidden();
});

test('native media focus and blur without keyboard focus do not reveal idle chrome', async () => {
  const h = new MediaHarness();
  h.open('video');
  h.clock.tick(3000);
  h.assertHidden();
  h.document.activeElement = h.modal.video;
  h.modal.video.dispatch('focusin');
  h.assertHidden('native video focus must not wake chrome after it fades');
  h.document.activeElement = null;
  h.modal.video.dispatch('focusout');
  await Promise.resolve();
  h.assertHidden('native video blur must not wake chrome after it fades');
  h.clock.tick(6000);
  h.assertHidden();
});

test('image pan and pinch gestures keep chrome visible through the interaction', () => {
  for (const gesture of ['pan', 'pinch']) {
    const h = new MediaHarness();
    h.open();
    h.modal.zoomBy(1);
    if (gesture === 'pan') {
      h.modal.image.dispatch('pointerdown', { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 });
    } else {
      h.modal.image.dispatch('touchstart', { touches: [{ clientX: 5, clientY: 5 }, { clientX: 30, clientY: 30 }] });
    }
    h.clock.tick(6000);
    h.assertVisible(gesture);
    if (gesture === 'pan') h.modal.image.dispatch('pointerup', { pointerId: 7 });
    else h.modal.image.dispatch('touchend', { touches: [] });
    h.clock.tick(3000);
    h.assertHidden(gesture);
  }
});

test('close, error and attachment replacement cancel the old idle callback', () => {
  for (const action of ['close', 'error', 'replace']) {
    const h = new MediaHarness();
    const request = h.open();
    assert.equal(h.clock.tasks.size, 1, 'ready media schedules one hide callback');
    h.clock.tick(1000);
    if (action === 'close') h.modal.close();
    else if (action === 'error') h.modal.showError('Synthetic playback failure.', request);
    else h.open('video', false);
    assert.equal(h.clock.tasks.size, 0, action);
    h.clock.tick(6000);
    h.assertVisible(action);
  }
});
