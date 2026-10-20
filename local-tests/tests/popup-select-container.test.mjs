import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { evmAssets } from '../evm-assets.js';

const [appSource, markup] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);
// Only the DOM operations used by select enhancement and option replacement.
class ElementFixture {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.labels = [];
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => {
        for (const name of names) if (!this.classList.contains(name)) this.className += ` ${name}`;
      },
    };
  }
  get options() { return this.children; }
  get firstElementChild() { return this.children[0]; }
  get value() { return this.selectedValue ?? this.options[0]?.value ?? ''; }
  set value(value) { this.selectedValue = String(value); }
  get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text || ''; }
  set textContent(value) { this.children = []; this.text = value; }
  set innerHTML(html) {
    this.children = [...html.matchAll(/<span\b([^>]*)>/g)].map(([, attributes]) => {
      const span = new ElementFixture('span');
      span.readAttributes(attributes);
      return span;
    });
  }
  readAttributes(attributes) {
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) this.setAttribute(name, value);
    this.required = /\brequired\b/.test(attributes);
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else if (name === 'id') this.id = value;
    else this.attributes.set(name, value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) {
    this.children = children.flatMap(child => child.tagName === '#FRAGMENT' ? child.children : [child]);
    if (this.tagName === 'SELECT') this.selectedValue = undefined;
  }
  querySelector(selector) {
    return this.children.find(child => child.classList.contains(selector.slice(1))) || null;
  }
  insertAdjacentElement(position, element) {
    assert.equal(position, 'afterend');
    this.nextElementSibling = element;
    element.previousElementSibling = this;
  }
}

class PopupFixture {
  static source(start, end) {
    const first = appSource.indexOf(start);
    const last = appSource.indexOf(end, first);
    assert.ok(first >= 0 && last > first, start);
    return appSource.slice(first, last);
  }

  constructor() {
    this.selects = [...markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map(([, attributes, options]) => {
      const select = new ElementFixture('select');
      select.readAttributes(attributes);
      for (const [, optionAttributes, label] of options.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
        const option = new ElementFixture('option');
        option.value = /\bvalue="([^"]*)"/.exec(optionAttributes)?.[1] ?? label.trim();
        option.textContent = label.trim();
        select.append(option);
        if (/\bselected\b/.test(optionAttributes)) select.value = option.value;
      }
      return select;
    });
    assert.ok(this.selects.length > 0, 'Client markup must contain selects');
    this.elements = new Map(this.selects.map(select => [select.id, select]));
    for (const id of ['popupSelectListbox', 'popupSelectScrollIndicator']) {
      assert.ok(markup.includes(`id="${id}"`));
      this.elements.set(id, new ElementFixture());
    }
    this.getElementById('popupSelectScrollIndicator').append(new ElementFixture());
    this.myData = { wallet: { assets: [
      { id: 'liberdus', name: 'Liberdus', symbol: 'LIB' },
      { id: 'bsc:native', name: 'BNB', symbol: 'BNB' },
    ] } };
    const context = { document: this, window: { addEventListener() {} }, myData: this.myData };
    runInNewContext(`${popupSelectSource}\n${isLibAssetSource}\n${walletSource}\nglobalThis.PopupSelect = PopupSelect; globalThis.wallet = new WalletScreen();`, context);
    this.PopupSelect = context.PopupSelect;
    this.wallet = context.wallet;
    this.PopupSelect.load();
  }
  addEventListener() {}
  getElementById(id) {
    assert.ok(this.elements.has(id), `Missing fixture element ${id}`);
    return this.elements.get(id);
  }
  createElement(tagName) { return new ElementFixture(tagName); }
  createDocumentFragment() { return new ElementFixture('#fragment'); }
  createTextNode(text) {
    const node = new ElementFixture('#text');
    node.textContent = text;
    return node;
  }
  querySelectorAll(selector) {
    assert.equal(selector, 'select');
    return this.selects;
  }
}

const popupSelectSource = PopupFixture.source('\nclass PopupSelect', '\nconst FULL_IMAGE_CACHE_MAX_SIZE');
const addProposalSource = PopupFixture.source('class AddProposalModal', 'const addProposalModal');
const walletSource = PopupFixture.source('class WalletScreen', 'const walletScreen');
const isLibAssetSource = PopupFixture.source('function isLibAsset(', 'function getLibUsdPriceFromParameters(');

test('shared loading enhances every select present in the client markup', () => {
  const fixture = new PopupFixture();
  for (const select of fixture.selects) {
    const trigger = fixture.PopupSelect.getTrigger(select);
    assert.ok(trigger, select.id);
    assert.equal(trigger.getAttribute('role'), 'combobox');
    assert.equal(select.getAttribute('aria-hidden'), 'true');
    assert.equal(select.tabIndex, -1);
    if (select.required) assert.equal(trigger.getAttribute('aria-required'), 'true');
    assert.equal(trigger.querySelector('.popup-select__value').textContent, select.options[select.selectedIndex]?.textContent || '');
  }
  assert.match(appSource, /setupConnectivityDetection\(\);\s*PopupSelect\.load\(\);[\s\S]*reactNativeApp\.load\(\);/);
  assert.match(appSource, /removeAccountsModal\.load\(\);[\s\S]*PopupSelect\.syncAll\(document\);/);
});

test('dynamic proposal selects use the same enhancement path', () => {
  const fixture = new PopupFixture();
  const selects = [new ElementFixture('select'), new ElementFixture('select')];
  fixture.PopupSelect.enhanceAll({ querySelectorAll: () => selects });
  assert.ok(selects.every(select => fixture.PopupSelect.getTrigger(select)));
  assert.notEqual(selects[0].id, selects[1].id);
  assert.match(addProposalSource, /PopupSelect\.hide\(\);[\s\S]*this\.optionsList\.innerHTML = [\s\S]*PopupSelect\.enhanceAll\(this\.optionsList\);/);
  assert.doesNotMatch(addProposalSource, /PopupSelect\.enhanceAll\(this\.form\);|PopupSelect\.enhance\(this\.(?:typeSelect|emergencySelect)\)/);
});

test('repeated loading and enhancement retain the existing controls', () => {
  const fixture = new PopupFixture();
  const triggers = fixture.selects.map(select => fixture.PopupSelect.getTrigger(select));
  fixture.PopupSelect.load();
  fixture.PopupSelect.enhanceAll(fixture);
  assert.deepEqual(fixture.selects.map(select => fixture.PopupSelect.getTrigger(select)), triggers);
  assert.doesNotMatch(popupSelectSource, /MutationObserver/);
});

test('EVM network option replacement preserves selection and updates the visible control', () => {
  const fixture = new PopupFixture();
  globalThis.document = fixture;
  const controller = new evmAssets.constructor();
  controller.configure({ syncSelect: select => fixture.PopupSelect.sync(select) });
  const select = fixture.getElementById('assetsNetwork');
  select.value = 'bsc';
  controller.populateNetworkSelect(select, { includeAll: true });
  assert.deepEqual(select.options.map(option => option.value), ['all', ...controller.getEvmCatalog().map(network => network.id)]);
  assert.equal(select.value, 'bsc');
  assert.equal(fixture.PopupSelect.getTrigger(select).querySelector('.popup-select__value').textContent, 'BNB Smart Chain (BSC)');
  controller.populateNetworkSelect(select, { selectedId: 'polygon' });
  assert.equal(select.value, 'polygon');
  assert.equal(fixture.PopupSelect.getTrigger(select).querySelector('.popup-select__value').textContent, 'Polygon (POL)');
});

test('LIB asset option replacement excludes EVM assets and synchronizes all LIB selectors', () => {
  const fixture = new PopupFixture();
  for (const id of ['sendAsset', 'receiveAsset', 'historyAsset']) {
    const select = fixture.getElementById(id);
    fixture.wallet.populateAssetSelect(select);
    assert.deepEqual(select.options.map(option => option.value), ['liberdus']);
    assert.equal(fixture.PopupSelect.getTrigger(select).querySelector('.popup-select__value').textContent, 'Liberdus (LIB)');
  }
});
