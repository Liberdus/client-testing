import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, evmAssetsSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../evm-assets.js', import.meta.url), 'utf8'),
]);
function classSource(className, nextMarker) {
  const classStart = appSource.indexOf(`class ${className}`);
  const classEnd = appSource.indexOf(nextMarker, classStart);
  return appSource.slice(classStart, classEnd);
}

const sendSource = classSource('SendAssetFormModal', 'class SendAssetConfirmModal');
const receiveSource = classSource('ReceiveModal', '// initialize the receive modal');

test('sets contextual field visibility before opening or refreshing', () => {
  for (const [source, assetSelect] of [
    [sendSource, 'assetSelectDropdown'],
    [receiveSource, 'assetSelect'],
  ]) {
    const openStart = source.indexOf('async open(');
    const networkVisibility = source.indexOf('this.networkGroup.hidden', openStart);
    const assetVisibility = source.indexOf(`this.${assetSelect}.closest('.form-group').hidden`, openStart);
    const modalOpen = source.indexOf('openModal(this.modal)', openStart);
    const refresh = source.indexOf('await evmAssets.refresh()', openStart);

    assert.ok(networkVisibility > openStart && networkVisibility < modalOpen);
    assert.ok(assetVisibility > openStart && assetVisibility < modalOpen);
    assert.ok(modalOpen < refresh);
    assert.match(source, /const hasFixedNetwork = mode === 'evm' && Boolean\(networkId\)/);
    assert.match(source, /const hasFixedAsset = hasFixedNetwork && Boolean\(assetKey\)/);
  }
});

test('sets contextual strings before opening and hydrates only remote values', () => {
  for (const source of [sendSource, receiveSource]) {
    const prepareCall = source.indexOf('this.prepareEvmContext(networkId, assetKey)');
    const modalOpen = source.indexOf('openModal(this.modal)', prepareCall);
    const refresh = source.indexOf('await evmAssets.refresh()', modalOpen);

    assert.ok(prepareCall > 0 && prepareCall < modalOpen);
    assert.ok(modalOpen < refresh);
  }

  assert.match(sendSource, /this\.balanceSymbol\.textContent = asset\?\.tokenSymbol \|\| '';/);
  assert.match(sendSource, /this\.balanceAmount\.textContent = '';/);
  assert.match(sendSource, /this\.transactionFee\.textContent = 'Calculated at send';/);
  assert.match(receiveSource, /this\.receiveBalanceSymbol\.textContent = asset\?\.tokenSymbol \|\| '';/);
});

test('keeps contextual field visibility in the modal classes only', () => {
  const adapterStart = evmAssetsSource.indexOf('class EvmSendFormAdapter');
  const controllerStart = evmAssetsSource.indexOf('class EvmAssetsController');
  const adapterSource = evmAssetsSource.slice(adapterStart, controllerStart);
  const controllerSource = evmAssetsSource.slice(controllerStart);

  assert.doesNotMatch(adapterSource, /this\.networkGroup|this\.assetGroup/);
  assert.doesNotMatch(controllerSource, /applyContextualSelectors|prepareFormNetwork|applySelectedAsset/);
  assert.match(controllerSource, /const opening = this\.openSend\(options\);[\s\S]*this\.sendFormAdapter\.applyContext\(\);[\s\S]*return opening;/);
  assert.match(controllerSource, /openContextualReceive\(options\) \{ return this\.openReceive\(options\); \}/);
});
