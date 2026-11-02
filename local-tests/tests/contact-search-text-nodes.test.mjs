import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { escapeHtml } from '../lib.js';

// web-client-v2 contact search: result names and "field: value" labels must be rendered as
// text nodes plus <mark> elements built from the raw contact values, never by interpolating
// contact or query text into HTML. The message search result name shares the same path.

const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout path');
const appSource = readFileSync(join(clientRoot, 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, `${startMarker.trim()} must exist in app.js`);
  return appSource.slice(start, end);
}

function topLevelFunction(name) {
  const source = appSource.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(source, `${name} must exist in app.js`);
  return source;
}

// Both search modals plus the real display-name, display-info and regex helpers, evaluated
// without launching the application or network services.
const createModalClasses = new Function(
  'deps',
  `const { myData, isDeleted, isFaucetAddress, getContactAvatarHtml, formatTime, debounce,
     openModal, footer, chatModal, contactInfoModal, escapeHtml, truncateMessage } = deps;
   ${topLevelFunction('escapeRegExp')}
   ${topLevelFunction('getContactDisplayName')}
   ${sourceBetween('\nclass SearchMessagesModal {', '\n/**\n * AvatarEditModal manages')}
   return { SearchMessagesModal, SearchContactsModal, messageSearchModal, contactSearchModal, createDisplayInfo };`
);

// The vCard importer's parser, so imported names are stored exactly as the client stores them.
const parseVcfContacts = new Function(
  `return function ${appSource.match(/^  parseVcfContacts\(vcfContent\) \{[\s\S]*?^  \}/m)?.[0]?.trim()}`
)();
assert.equal(typeof parseVcfContacts, 'function', 'ImportContactsModal.parseVcfContacts must exist in app.js');

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
    if (!this.queried.has(selector)) this.queried.set(selector, new FakeElement('span'));
    return this.queried.get(selector);
  }
  closest() { return null; }
  focus() {}
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
      ['messageSearchModal', 'messageSearch', 'closeSearchModal', 'searchResults',
        'contactSearchModal', 'contactSearch', 'closeContactSearchModal', 'contactSearchResults']
        .map((id) => [id, new FakeElement('div')])
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

const FAUCET = 'f'.repeat(64);

function createFixture(contactList) {
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.requestAnimationFrame = (callback) => callback();
  const calls = { contactInfoOpen: [], switchView: [], chatOpen: [] };
  const contacts = {};
  contactList.forEach((entry, index) => {
    const { address = String.fromCharCode(97 + index).repeat(64), ...contact } = entry;
    contacts[address] = { messages: [], ...contact };
  });
  const classes = createModalClasses({
    myData: { contacts },
    isDeleted: (message) => message.status === 'deleted',
    isFaucetAddress: (address) => address === FAUCET,
    getContactAvatarHtml: async () => '<div class="avatar"></div>',
    formatTime: () => 'now',
    debounce: (fn) => fn,
    openModal: (modal) => modal.classList.add('active'),
    footer: { switchView: (view) => calls.switchView.push(view) },
    chatModal: { open: async (...args) => calls.chatOpen.push(args), scrollToMessage() {} },
    contactInfoModal: { open: (displayInfo) => calls.contactInfoOpen.push(displayInfo) },
    escapeHtml,
    truncateMessage: (text) => text,
  });
  classes.messageSearchModal.load();
  classes.contactSearchModal.load();
  return { ...classes, document, calls, contacts };
}

// Types into the contact search box and returns the rendered result items.
async function searchContacts(fixture, searchText) {
  const input = fixture.document.getElementById('contactSearch');
  const container = fixture.document.getElementById('contactSearchResults');
  input.value = searchText;
  input.listeners.get('input')({ target: input });
  // Items are appended after each avatar resolves.
  await new Promise((resolve) => setImmediate(resolve));
  return container.childNodes;
}

function nodesOf(element) {
  return element.childNodes.map((node) => (node.nodeType === 1 ? `<${node.tagName.toLowerCase()}>${node.textContent}` : node.textContent));
}

function marksOf(element) {
  return element.childNodes.filter((node) => node.nodeType === 1 && node.tagName === 'MARK').map((node) => node.textContent);
}

function renderedContact(item) {
  const name = item.querySelector('.chat-name');
  const label = item.querySelector('.match-label');
  return {
    name: name.textContent,
    label: label.textContent,
    labelNodes: nodesOf(label),
    marks: marksOf(label),
    labelElement: label,
    nameElement: name,
  };
}

function assertTextNeverInterpolated(fixture, ...fragments) {
  const markup = fixture.document.created.flatMap((element) => element.innerHtmlWrites).join('\n');
  fragments.forEach((fragment) => {
    assert.ok(!markup.includes(fragment), `"${fragment}" must not be interpolated into HTML`);
    assert.ok(!markup.includes(escapeHtml(fragment)), `escaped "${fragment}" must not be interpolated into HTML`);
  });
}

test('a locally entered name with markup renders literally in the name and the highlighted label', async () => {
  const payload = '<img src=x onerror="globalThis.executed = true">';
  const name = `Al ${payload} & <mark>co</mark>`;
  const fixture = createFixture([{ username: 'al', name }]);

  const [item] = await searchContacts(fixture, '<img src=x');
  const rendered = renderedContact(item);
  assert.equal(rendered.name, name);
  assert.deepEqual(rendered.labelNodes, ['name: Al ', '<mark><img src=x', ' onerror="globalThis.executed = true"> & <mark>co</mark>']);
  assert.equal(rendered.labelElement.innerHTML, '', 'label must be filled with nodes, not markup');
  assert.equal(rendered.nameElement.innerHTML, '', 'name must be assigned as text, not markup');
  assert.ok(!fixture.document.created.some((element) => element.tagName === 'IMG'), 'no element may be created from contact text');
  assert.equal(globalThis.executed, undefined);
  assertTextNeverInterpolated(fixture, payload, '<mark>co</mark>', 'Al ');

  const [markItem] = await searchContacts(fixture, '<mark>co');
  assert.deepEqual(renderedContact(markItem).marks, ['<mark>co']);
  assert.deepEqual(renderedContact(markItem).labelNodes, [`name: Al ${payload} & `, '<mark><mark>co', '</mark>']);
});

test('a name imported from a vCard FN line renders literally with its highlight', async () => {
  const payload = '<img src=x onerror="globalThis.imported = true">';
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'X-LIBERDUS-NETID:net', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', `FN:  Vee ${payload} <mark>x</mark>  `,
    `X-LIBERDUS-ADDRESS:${'1'.repeat(64)}`, 'X-LIBERDUS-USERNAME:vee', 'END:VCARD', '',
  ].join('\r\n');
  const [imported] = parseVcfContacts(vcf);
  assert.equal(imported.name, `Vee ${payload} <mark>x</mark>`);
  const fixture = createFixture([{ address: imported.address, username: imported.username, name: imported.name }]);

  const [item] = await searchContacts(fixture, 'onerror');
  const rendered = renderedContact(item);
  assert.equal(rendered.name, imported.name);
  assert.deepEqual(rendered.labelNodes, ['name: Vee <img src=x ', '<mark>onerror', '="globalThis.imported = true"> <mark>x</mark>']);
  assert.equal(globalThis.imported, undefined);
  assertTextNeverInterpolated(fixture, payload, '<mark>x</mark>');
});

test('apostrophes, ampersands, angle brackets and regex metacharacters in queries highlight the raw value', async () => {
  const fixture = createFixture([{
    username: 'obrien',
    name: "O'Brien & Sons <Ltd> (est. 1900)",
    senderInfo: { email: 'pat.o+brien@example.com', x: 'pat_x' },
  }]);
  const cases = [
    ["o'brien &", ['name: ', "<mark>O'Brien &", ' Sons <Ltd> (est. 1900)']],
    ['& sons <ltd>', ["name: O'Brien ", '<mark>& Sons <Ltd>', ' (est. 1900)']],
    ['(est. 1900)', ["name: O'Brien & Sons <Ltd> ", '<mark>(est. 1900)']],
    ['.o+brien@', ['email: pat', '<mark>.o+brien@', 'example.com']],
    ['_x', ['x: pat', '<mark>_x']],
    ['>', ["name: O'Brien & Sons <Ltd", '<mark>>', ' (est. 1900)']],
  ];
  for (const [query, nodes] of cases) {
    const items = await searchContacts(fixture, query);
    assert.equal(items.length, 1, `"${query}" must find the contact`);
    assert.deepEqual(renderedContact(items[0]).labelNodes, nodes, `label for "${query}"`);
  }
  assertTextNeverInterpolated(fixture, "O'Brien", '<Ltd>', 'pat.o+brien');
});

test('the label shows the best matching field: exact beats prefix beats substring, every occurrence marked', async () => {
  const fixture = createFixture([{
    username: 'ana',
    name: 'Ana Banana',
    senderInfo: { name: 'Ana B.', email: 'ana@example.com', phone: '+1 555 0100' },
  }]);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'ana'))[0]).labelNodes, ['username: ', '<mark>ana']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'ANA B'))[0]).labelNodes, ['name: ', '<mark>Ana B', 'anana']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'ana b.'))[0]).labelNodes, ['name: ', '<mark>Ana B.']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'example'))[0]).labelNodes, ['email: ana@', '<mark>example', '.com']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, '555'))[0]).labelNodes, ['phone: +1 ', '<mark>555', ' 0100']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'an'))[0]).labelNodes, ['username: ', '<mark>an', 'a']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'nan'))[0]).labelNodes, ['name: Ana Ba', '<mark>nan', 'a']);
  assert.deepEqual(renderedContact((await searchContacts(fixture, 'a'))[0]).marks, ['a', 'a']);
});

test('avatar identifiers, avatar keys and time zones are not searchable', async () => {
  const fixture = createFixture([{
    username: 'zed',
    senderInfo: { avatarId: 'avatar-object-id', avatarKey: 'c2VjcmV0LWtleQ==', timezone: 'America/New_York' },
  }]);
  for (const query of ['avatar-object', 'c2VjcmV0', 'america', 'new_york']) {
    const items = await searchContacts(fixture, query);
    assert.deepEqual(items, [], `"${query}" must not match hidden sender fields`);
    assert.match(fixture.document.getElementById('contactSearchResults').innerHTML, /No contacts found/);
  }
  assert.equal((await searchContacts(fixture, 'zed')).length, 1);
});

test('results are ordered exact, then prefix, then substring, then by username, skipping the faucet', async () => {
  const fixture = createFixture([
    { username: 'dan', name: 'Daniel' },
    { username: 'bob', name: 'Rob Danton' },
    { username: 'ann', name: 'Dan' },
    { username: 'cat', name: 'Danny' },
    { address: FAUCET, username: 'dan-faucet' },
  ]);
  const items = await searchContacts(fixture, 'dan');
  // "Daniel" is found by its exact username, so it ranks with "Dan" and before the prefix match
  assert.deepEqual(items.map((item) => renderedContact(item).name), ['Dan', 'Daniel', 'Danny', 'Rob Danton']);
  assert.deepEqual(items.map((item) => renderedContact(item).label), ['name: Dan', 'username: dan', 'name: Danny', 'name: Rob Danton']);
  assert.deepEqual(items.map((item) => renderedContact(item).marks), [['Dan'], ['dan'], ['Dan'], ['Dan']]);
});

test('clicking a result opens the contact info modal for that contact and closes the search', async () => {
  const fixture = createFixture([
    { username: 'alice', name: "Alice <O'Neil>" },
    { username: 'bob', name: "Bob O'Neil" },
  ]);
  fixture.contactSearchModal.open();
  assert.ok(fixture.contactSearchModal.isActive());
  const items = await searchContacts(fixture, "o'neil");
  assert.equal(items.length, 2);

  items[1].listeners.get('click')();
  assert.equal(fixture.calls.contactInfoOpen.length, 1);
  const [displayInfo] = fixture.calls.contactInfoOpen;
  assert.equal(displayInfo.address, 'b'.repeat(64));
  assert.equal(displayInfo.username, 'bob');
  assert.equal(displayInfo.name, "Bob O'Neil");
  assert.deepEqual(displayInfo, fixture.createDisplayInfo({ ...fixture.contacts['b'.repeat(64)], address: 'b'.repeat(64) }));
  assert.equal(fixture.document.getElementById('contactSearch').value, '');
  assert.equal(fixture.document.getElementById('contactSearchResults').innerHTML, '');
  assert.ok(!fixture.contactSearchModal.isActive());
});

test('message search results show the contact display name literally', async () => {
  const name = '<b onmouseover="globalThis.named = true">Bea</b>';
  const fixture = createFixture([{ username: 'bea', name, messages: [{ txid: 't1', message: 'hello there', timestamp: 1, my: false }] }]);
  const results = fixture.messageSearchModal.searchMessages('hello');
  fixture.messageSearchModal.displaySearchResults(results);
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = fixture.document.getElementById('searchResults').childNodes[0].childNodes;
  assert.equal(item.querySelector('.chat-name').textContent, name);
  assert.equal(item.querySelector('.chat-name').innerHTML, '');
  assert.deepEqual(nodesOf(item.querySelector('.chat-message')), ['> ', '<mark>hello', ' there']);
  assert.equal(globalThis.named, undefined);
  assertTextNeverInterpolated(fixture, name, 'Bea');
});
