import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { escapeHtml, truncateMessage } from '../lib.js';

// web-client-v2 #1753: message search previews must be built from raw message text and
// rendered as text nodes plus <mark> elements, never by interpolating message or query
// text into HTML.

const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');

const classStart = appSource.indexOf('\nclass SearchMessagesModal {');
const classEnd = appSource.indexOf('\nconst messageSearchModal = new SearchMessagesModal();', classStart);
assert.ok(classStart !== -1 && classEnd !== -1, 'SearchMessagesModal must exist in app.js');
const escapeRegExpSource = appSource.match(/^function escapeRegExp\([\s\S]*?^\}/m)?.[0];
assert.ok(escapeRegExpSource, 'escapeRegExp must exist in app.js');

// Evaluate only the search modal, without launching the application or network services.
const createModalClass = new Function(
  'deps',
  `const { myData, isDeleted, getContactDisplayName, getContactAvatarHtml, formatTime,
     debounce, openModal, footer, chatModal, escapeHtml, truncateMessage } = deps;
   ${escapeRegExpSource}
   ${appSource.slice(classStart, classEnd)}
   return SearchMessagesModal;`
);

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data = String(data);
  }
  get textContent() { return this.data; }
}

class FakeFragment {
  constructor() {
    this.nodeType = 11;
    this.childNodes = [];
  }
  appendChild(node) { this.childNodes.push(node); return node; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.childNodes = [];
    this.listeners = new Map();
    this.innerHtmlWrites = [];
    this.queried = new Map();
    this.value = '';
  }
  set innerHTML(markup) {
    this.innerHtmlWrites.push(markup);
    this.childNodes = [];
  }
  get innerHTML() { return this.innerHtmlWrites.at(-1) ?? ''; }
  set textContent(value) { this.childNodes = [new FakeText(value)]; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  appendChild(node) {
    if (node instanceof FakeFragment) {
      this.childNodes.push(...node.childNodes);
      node.childNodes = [];
    } else {
      this.childNodes.push(node);
    }
    return node;
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  // Children created from innerHTML are not parsed; hand out a stable element per selector.
  querySelector(selector) {
    if (!this.queried.has(selector)) this.queried.set(selector, new FakeElement('div'));
    return this.queried.get(selector);
  }
  closest() { return null; }
  get classList() {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      add: (name) => { classes.add(name); this.className = [...classes].join(' '); },
      remove: (name) => { classes.delete(name); this.className = [...classes].join(' '); },
      contains: (name) => classes.has(name),
    };
  }
}

class FakeDocument {
  constructor() {
    this.created = [];
    this.byId = new Map(
      ['messageSearchModal', 'messageSearch', 'closeSearchModal', 'searchResults'].map((id) => [id, new FakeElement('div')])
    );
  }
  getElementById(id) { return this.byId.get(id) ?? null; }
  createElement(tagName) {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element;
  }
  createTextNode(data) { return new FakeText(data); }
  createDocumentFragment() { return new FakeFragment(); }
}

function createFixture(messages) {
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.requestAnimationFrame = (callback) => callback();
  const calls = { switchView: [], open: [], scrollTo: [] };
  const contacts = {};
  messages.forEach((entry, index) => {
    const address = entry.address ?? `${index}`.padStart(64, 'a');
    contacts[address] ??= { username: entry.username ?? `user${index}`, messages: [] };
    contacts[address].messages.push({
      txid: entry.txid ?? `tx${index}`,
      message: entry.message,
      timestamp: entry.timestamp ?? 1_700_000_000_000 + index,
      my: entry.my ?? false,
      type: entry.type ?? 'message',
      status: entry.status,
    });
  });
  const SearchMessagesModal = createModalClass({
    myData: { contacts },
    isDeleted: (message) => message.status === 'deleted',
    getContactDisplayName: (contact) => contact.username,
    getContactAvatarHtml: async () => '<div class="avatar"></div>',
    formatTime: () => 'now',
    debounce: (fn) => fn,
    openModal: () => {},
    footer: { switchView: (view) => calls.switchView.push(view) },
    chatModal: {
      open: async (address, skipScroll) => calls.open.push([address, skipScroll]),
      scrollToMessage: (id) => calls.scrollTo.push(id),
    },
    escapeHtml,
    truncateMessage,
  });
  const modal = new SearchMessagesModal();
  modal.load();
  return { modal, document, calls };
}

async function renderedItems(fixture, searchText) {
  const results = fixture.modal.searchMessages(searchText);
  fixture.modal.displaySearchResults(results);
  // Items are appended after each avatar resolves.
  await new Promise((resolve) => setImmediate(resolve));
  const list = fixture.document.getElementById('searchResults').childNodes[0];
  assert.ok(list, 'results list must be appended');
  return list.childNodes.map((item) => ({ item, results }));
}

function previewOf(item) {
  const container = item.querySelector('.chat-message');
  return {
    container,
    text: container.textContent,
    marks: container.childNodes.filter((node) => node.nodeType === 1 && node.tagName === 'MARK').map((node) => node.textContent),
    nodes: container.childNodes.map((node) => (node.nodeType === 1 ? `<${node.tagName.toLowerCase()}>${node.textContent}` : node.textContent)),
  };
}

function assertTextNeverInterpolated(fixture, ...fragments) {
  const markup = fixture.document.created.flatMap((element) => element.innerHtmlWrites).join('\n');
  fragments.forEach((fragment) => {
    assert.ok(!markup.includes(fragment), `"${fragment}" must not be interpolated into HTML`);
    assert.ok(!markup.includes(escapeHtml(fragment)), `escaped "${fragment}" must not be interpolated into HTML`);
  });
}

test('apostrophes are matched and highlighted on the raw message text', async () => {
  const fixture = createFixture([{ message: "No, I don't think so" }]);
  const [{ item }] = await renderedItems(fixture, "don't");
  const preview = previewOf(item);
  assert.deepEqual(preview.nodes, ['> No, I ', "<mark>don't", ' think so']);
  assert.deepEqual(preview.marks, ["don't"]);
  assert.equal(preview.container.innerHTML, '', 'preview container must be filled with nodes, not markup');
  assertTextNeverInterpolated(fixture, "don't", 'think so');
});

test('quotes, ampersands and angle brackets stay literal and highlight the message casing', async () => {
  const fixture = createFixture([{ message: 'Tom & Jerry <3 "cheese" > milk', my: true }]);
  const [{ item }] = await renderedItems(fixture, '& jerry <3 "CHEESE"');
  const preview = previewOf(item);
  assert.deepEqual(preview.nodes, ['< Tom ', '<mark>& Jerry <3 "cheese"', ' > milk']);
  assertTextNeverInterpolated(fixture, 'Tom &', '<3');
});

test('Unicode text matches case-insensitively and emoji survive intact', async () => {
  const fixture = createFixture([{ message: 'Café ☕ then CAFÉ 😀 café' }]);
  const [{ item }] = await renderedItems(fixture, 'café');
  const preview = previewOf(item);
  assert.deepEqual(preview.marks, ['Café', 'CAFÉ', 'café']);
  assert.equal(preview.text, '> Café ☕ then CAFÉ 😀 café');
});

test('regex metacharacters in the query are literal and every occurrence is highlighted', async () => {
  const fixture = createFixture([{ message: 'a.b (x) a*b [y] 1+1 a.b' }]);
  const dots = previewOf((await renderedItems(fixture, '.'))[0].item);
  assert.deepEqual(dots.marks, ['.', '.']);
  assert.equal(dots.text, '> a.b (x) a*b [y] 1+1 a.b');
  assert.deepEqual(previewOf((await renderedItems(fixture, '(x)'))[0].item).marks, ['(x)']);
  assert.deepEqual(previewOf((await renderedItems(fixture, 'a*b'))[0].item).marks, ['a*b']);
  assert.deepEqual(previewOf((await renderedItems(fixture, '[y] 1+1'))[0].item).marks, ['[y] 1+1']);
});

test('long messages show context around the first match with ellipses on both sides', async () => {
  const before = 'before '.repeat(30).trim(); // 209 characters
  const after = ' after'.repeat(30);
  const fixture = createFixture([{ message: `${before} don't ${after}` }]);
  const [{ item }] = await renderedItems(fixture, "don't");
  const preview = previewOf(item);
  assert.deepEqual(preview.marks, ["don't"]);
  assert.match(preview.text, /^> \.\.\..*don't.*\.\.\.$/);
  const [leading] = preview.nodes;
  assert.ok(leading.length >= 30 && leading.length <= 36, `about 30 characters of context precede the match: ${JSON.stringify(leading)}`);
  const shown = preview.text.replace(/^> \.\.\./, '').replace(/\.\.\.$/, '');
  assert.ok(shown.length >= 100 && shown.length <= 101, `about 100 message characters are shown: ${shown.length}`);
});

test('a match near the end of the excerpt is highlighted without being cut short', async () => {
  const message = `needle ${'a'.repeat(90)}needle${'b'.repeat(50)}`;
  const fixture = createFixture([{ message }]);
  const [{ item }] = await renderedItems(fixture, 'needle');
  const preview = previewOf(item);
  assert.deepEqual(preview.marks, ['needle', 'needle']);
  assert.equal(preview.text, `> needle ${'a'.repeat(90)}needle...`);
});

test('a match at the end of a long message keeps a full window of context', async () => {
  const message = `${'x'.repeat(150)} the end`;
  const fixture = createFixture([{ message }]);
  const [{ item }] = await renderedItems(fixture, 'end');
  const preview = previewOf(item);
  assert.deepEqual(preview.marks, ['end']);
  assert.equal(preview.text, `> ...${'x'.repeat(92)} the end`);
});

test('a match at the start of a long message is shown from the beginning', async () => {
  const fixture = createFixture([{ message: 'z'.repeat(150) }]);
  const [{ item }] = await renderedItems(fixture, 'ZZ');
  const preview = previewOf(item);
  assert.equal(preview.marks.length, 50, 'adjacent non-overlapping matches are all highlighted');
  assert.equal(preview.text, `> ${'z'.repeat(100)}...`);
});

test('every returned result highlights the query, even for characters with uneven case rules', async () => {
  // These letters lower-case or upper-case to different code points than their ASCII lookalikes,
  // so finding a message one way and highlighting it another leaves results without a mark.
  const messages = ['İstanbul', 'Kelvin K', 'straße', 'ſmall long s', 'plain is kiss'];
  const fixture = createFixture(messages.map((message) => ({ message })));
  for (const query of ['i', 'k', 's', 'ss', 'IS']) {
    const items = await renderedItems(fixture, query);
    assert.ok(items.length >= 1, `"${query}" must still find the plain message`);
    items.forEach(({ item }) => {
      const preview = previewOf(item);
      assert.ok(preview.marks.length >= 1, `result "${preview.text}" for "${query}" must carry a highlight`);
      preview.marks.forEach((mark) => assert.equal(mark.length, query.length));
    });
  }
});

test('HTML-looking message and query text is displayed literally and stays inert', async () => {
  const payload = '<img src=x onerror="globalThis.executed = true">';
  const fixture = createFixture([{ message: `look ${payload} <mark>fake</mark> & done` }]);
  const [{ item }] = await renderedItems(fixture, '<img src=x');
  const preview = previewOf(item);
  assert.deepEqual(preview.nodes, ['> look ', '<mark><img src=x', ' onerror="globalThis.executed = true"> <mark>fake</mark> & done']);
  assert.ok(!fixture.document.created.some((element) => element.tagName === 'IMG'), 'no element may be created from message text');
  assert.equal(globalThis.executed, undefined);
  assertTextNeverInterpolated(fixture, payload, '<mark>fake</mark>');

  const [{ item: markItem }] = await renderedItems(fixture, '<mark>');
  assert.deepEqual(previewOf(markItem).marks, ['<mark>']);
  assertTextNeverInterpolated(fixture, '<mark>fake');
});

test('results keep newest-first ordering, direction prefixes and click-to-open navigation', async () => {
  const fixture = createFixture([
    { address: 'b'.repeat(64), username: 'Bea', txid: 'older', message: "Bea's note", timestamp: 100, my: false },
    { address: 'c'.repeat(64), username: 'Cy', txid: 'newest', message: "Cy's note", timestamp: 300, my: true },
    { address: 'b'.repeat(64), txid: 'deleted', message: "Bea's deleted note", timestamp: 400, status: 'deleted' },
    { address: 'b'.repeat(64), txid: 'call', message: "Bea's call", timestamp: 500, type: 'call' },
    { address: 'd'.repeat(64), username: 'Di', txid: 'middle', message: "Di's", timestamp: 200, my: false },
  ]);
  const items = await renderedItems(fixture, "'s");
  assert.deepEqual(items[0].results.map((result) => result.messageId), ['newest', 'middle', 'older']);
  assert.deepEqual(items.map(({ item }) => previewOf(item).text), ["< Cy's note", "> Di's", "> Bea's note"]);

  fixture.document.getElementById('messageSearch').value = "'s";
  await items[2].item.listeners.get('click')({ stopImmediatePropagation() {} });
  assert.deepEqual(fixture.calls.switchView, ['chats']);
  assert.deepEqual(fixture.calls.open, [['b'.repeat(64), true]]);
  assert.deepEqual(fixture.calls.scrollTo, ['older']);
  assert.equal(fixture.document.getElementById('messageSearch').value, '');
  assert.equal(fixture.document.getElementById('searchResults').innerHTML, '');
});
