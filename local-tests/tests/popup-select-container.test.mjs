import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const [appSource, evmAssetsSource, markup] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../evm-assets.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);

function classSource(className, nextMarker) {
  const classStart = appSource.indexOf(`class ${className}`);
  const classEnd = appSource.indexOf(nextMarker, classStart);
  return appSource.slice(classStart, classEnd);
}

const addProposalSource = classSource('AddProposalModal', 'const addProposalModal');
const popupSelectStart = appSource.lastIndexOf('\nclass PopupSelect');
const popupSelectEnd = appSource.indexOf('\nconst FULL_IMAGE_CACHE_MAX_SIZE', popupSelectStart);
const popupSelectSource = appSource.slice(popupSelectStart, popupSelectEnd);
const popupSelectContext = {};
runInNewContext(`${popupSelectSource}\nglobalThis.PopupSelect = PopupSelect;`, popupSelectContext);
const { PopupSelect } = popupSelectContext;

test('enhances every static select during shared loading', () => {
  assert.equal([...markup.matchAll(/<select\b/g)].length, 21);
  assert.match(popupSelectSource, /static load\(\) \{[\s\S]*PopupSelect\.enhanceAll\(document\);/);
  assert.match(
    appSource,
    /setupConnectivityDetection\(\);\s*PopupSelect\.load\(\);[\s\S]*reactNativeApp\.load\(\);/
  );
  assert.match(
    appSource,
    /removeAccountsModal\.load\(\);[\s\S]*PopupSelect\.syncAll\(document\);/
  );
  assert.doesNotMatch(addProposalSource, /PopupSelect\.enhanceAll\(this\.form\);/);
});

test('enhances dynamic proposal selects after rendering', () => {
  assert.match(
    addProposalSource,
    /PopupSelect\.hide\(\);[\s\S]*this\.optionsList\.innerHTML = [\s\S]*PopupSelect\.enhanceAll\(this\.optionsList\);/
  );
  assert.doesNotMatch(addProposalSource, /PopupSelect\.enhance\(this\.(?:typeSelect|emergencySelect)\)/);
});

test('delegates every select in the provided container', () => {
  const selects = [{ id: 'proposal-type' }, { id: 'proposal-emergency' }];
  const enhanced = [];
  PopupSelect.enhance = (select) => enhanced.push(select);

  PopupSelect.enhanceAll({
    querySelectorAll(selector) {
      assert.equal(selector, 'select');
      return selects;
    },
  });

  assert.deepEqual(enhanced, selects);
});

test('retains idempotent enhancement without DOM observation', () => {
  assert.match(
    popupSelectSource,
    /static enhance\(select\) \{[\s\S]*if \(PopupSelect\.getTrigger\(select\)\) return;/
  );
  assert.doesNotMatch(popupSelectSource, /MutationObserver/);
});

test('synchronizes EVM selectors after replacing their options', () => {
  assert.match(appSource, /syncSelect: \(select\) => PopupSelect\.sync\(select\)/);
  assert.match(evmAssetsSource, /populateNetworkSelect\(select, options\) \{[\s\S]*this\.syncSelect\(select\);/);
  assert.match(evmAssetsSource, /populateAssetSelect\(select, networkId\) \{[\s\S]*this\.syncSelect\(select\);/);
});
