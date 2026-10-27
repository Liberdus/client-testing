import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Standalone while published client-testing main has no local-tests runner.
// WEB_CLIENT_ROOT=/absolute/client node local-tests/tests/issue-1839-dao-parameter-units.test.mjs
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && path.isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout');
const [dao, lib, appSource] = await Promise.all([
  import(pathToFileURL(path.join(clientRoot, 'dao.js'))),
  import(pathToFileURL(path.join(clientRoot, 'lib.js'))),
  readFile(path.join(clientRoot, 'app.js'), 'utf8'),
]);
const helpersStart = appSource.indexOf('function getPathValue(');
const classEnd = appSource.indexOf('const addProposalModal', helpersStart);
assert.ok(helpersStart >= 0 && classEnd > helpersStart, 'Production proposal editor must be extractable');
// Load only the production editor and neighboring helpers, without app startup or services.
const AddProposalModal = vm.runInNewContext(
  appSource.slice(helpersStart, classEnd) + '\nAddProposalModal',
  { ...dao, escapeHtml: lib.escapeHtml, URL },
  { filename: path.join(clientRoot, 'app.js') },
);
const json = value => JSON.parse(JSON.stringify(value));
const proposedValues = {
  activeVersion: 'release-2.3.4+build', goldenTicketServerUrl: 'https://tickets.example.test/v1.2.3',
  enableNodeSlashing: 'true', syncTimeoutPenaltyPercent: '0.375', transactionFeeUsdStr: '0.000000000000000001',
};
// Key order is the pre-feature catalog order; units reflect the server consumers.
const expectedUnits = {
  governance: {
    claimDuration: 'milliseconds', committeeAddresses: undefined, graceDuration: 'milliseconds',
    minimumSpendUsdStr: 'USD', pctBurned: 'percent', proposalFeeUsdStr: 'USD', reviewDuration: 'milliseconds',
    voteExponent: undefined, voteThresholdUsdStr: 'USD', votingDuration: 'milliseconds',
  },
  economic: {
    activeVersion: undefined, archiver: undefined, certCycleDuration: 'cycles', defaultTollUsdStr: 'USD',
    enableNodeSlashing: undefined, goldenTicketServerUrl: undefined, latestVersion: undefined,
    maintenanceFee: 'LIB base units', maintenanceInterval: 'milliseconds', messageMaxLength: 'messages',
    messageRetentionDays: 'days', minTollUsdStr: 'USD', minVersion: undefined, nodePenaltyUsdStr: 'USD',
    nodeRewardAmountUsdStr: 'USD', nodeRewardInterval: 'milliseconds', restakeCooldown: 'milliseconds',
    enableLeftNetworkEarlySlashing: undefined, enableNodeRefutedSlashing: undefined, enableSyncTimeoutSlashing: undefined,
    leftNetworkEarlyPenaltyPercent: 'percent', nodeRefutedPenaltyPercent: 'percent', syncTimeoutPenaltyPercent: 'percent',
    stabilityFactorStr: 'USD per LIB', stabilityScaleDiv: undefined, stabilityScaleMul: undefined,
    stakeLockTime: 'milliseconds', stakeRequiredUsdStr: 'USD', tollNetworkTaxPercent: 'percent',
    tollTimeout: 'milliseconds', transactionFeeUsdStr: 'USD', txPause: undefined,
  },
  protocol: {
    minNodes: 'nodes', maxNodes: 'nodes', baselineNodes: 'nodes', cycleDuration: 'seconds',
    allowEndUserTxnInjections: undefined, amountToGrow: 'nodes', amountToShrink: 'nodes', maxJoinedPerCycle: 'nodes per cycle',
    maxDesiredMultiplier: 'multiplier', maxShrinkMultiplier: 'fraction', syncBoostEnabled: undefined, limitRate: undefined,
    nodesPerConsensusGroup: 'nodes', voterPercentage: 'fraction',
  },
};

test('catalog units match server quantities while retaining catalog order and unitless controls', () => {
  for (const [proposalType, units] of Object.entries(expectedUnits)) {
    assert.deepEqual(dao.DAO_CONFIG_CHANGE_OPTIONS[proposalType].map(option => [option.key, option.unit]), Object.entries(units));
    for (const option of dao.DAO_CONFIG_CHANGE_OPTIONS[proposalType]) {
      const isSlashingPercent = ['leftNetworkEarlyPenaltyPercent', 'nodeRefutedPenaltyPercent', 'syncTimeoutPenaltyPercent'].includes(option.key);
      assert.equal(option.unitHint, isSlashingPercent ? '0.2 = 20%' : undefined, option.key);
      if (option.valueType === 'boolean') assert.equal(option.unit, undefined, option.key);
    }
  }
});

async function modalFixture() {
  const source = { current: {
    activeVersion: '1.2.3', goldenTicketServerUrl: 'http://tickets.example.test', enableNodeSlashing: false,
    slashing: { syncTimeoutPenaltyPercent: 0.3 }, transactionFeeUsdStr: '0.0100',
  } };
  const modal = new AddProposalModal();
  modal.resetConfigCache();
  const field = { dataset: {} };
  const option = { querySelector() { return field; } };
  Object.assign(modal, {
    typeSelect: { value: 'economic' }, emergencySelect: { value: 'false' },
    optionsList: { querySelector() { return option; } }, fetchConfigSource: async () => source,
  });
  modal.configOptionsByType.economic = await modal.fetchConfigOptions('economic');
  modal.options = [{ changes: modal.getConfigOptions().map(({ key }) => ({ key, value: proposedValues[key] })) }];
  return { modal, source };
}

for (const [key, expected] of [
  ['syncTimeoutPenaltyPercent', 'current.slashing.syncTimeoutPenaltyPercent · number in percent (0.2 = 20%)'],
  ['transactionFeeUsdStr', 'current.transactionFeeUsdStr · string in USD'],
  ['enableNodeSlashing', 'current.enableNodeSlashing · boolean'],
  ['activeVersion', 'current.activeVersion · string'],
  ['goldenTicketServerUrl', 'current.goldenTicketServerUrl · string'],
]) {
  test(`renders parameter metadata for ${key}`, async () => {
    const { modal } = await modalFixture();
    const changeIndex = modal.options[0].changes.findIndex(change => change.key === key);
    const markup = modal.renderOptionChange(0, modal.options[0].changes[changeIndex], changeIndex,
      modal.options[0].changes.length, modal.getConfigOptions(), true);
    assert.equal(markup.match(/<div class="dao-form-meta">([^<]*)<\/div>/)?.[1], expected);
  });
}

test('escapes optional unit text and hints and omits orphan hints on unitless controls', async () => {
  const { modal } = await modalFixture();
  const option = modal.getConfigOption('syncTimeoutPenaltyPercent');
  option.unit = '<USD & units>';
  option.unitHint = '<img src=x onerror=alert(1)>';
  const renderMetadata = () => modal.renderOptionChange(0, { key: option.key, value: '0.2' }, 0, 1,
    modal.getConfigOptions(), true).match(/<div class="dao-form-meta">(.*?)<\/div>/)?.[1];
  assert.equal(renderMetadata(), 'current.slashing.syncTimeoutPenaltyPercent · number in &lt;USD &amp; units&gt; (&lt;img src=x onerror=alert(1)&gt;)');
  for (const unit of [undefined, '']) {
    option.unit = unit;
    assert.equal(renderMetadata(), 'current.slashing.syncTimeoutPenaltyPercent · number');
  }
});

test('rendering units leaves current values, edits, order and serialized changes untouched', async () => {
  const { modal, source } = await modalFixture();
  const originalSource = structuredClone(source);
  const originalOptions = json(modal.options);
  const originalConfig = json(modal.getConfigOptions());
  const expectedChanges = modal.getConfigOptions().map(option => ({
    key: option.key, value: proposedValues[option.key], current: String(option.current),
  }));
  const before = json(modal.getValidatedOptions());
  modal.renderOptionChanges(0, modal.options[0].changes, modal.getConfigOptions(), true);
  const after = json(modal.getValidatedOptions());
  assert.deepEqual(after, before);
  assert.deepEqual(after.changes, [expectedChanges]);
  assert.deepEqual(source, originalSource);
  assert.deepEqual(json(modal.options), originalOptions);
  assert.deepEqual(json(modal.getConfigOptions()), originalConfig);
  const draft = dao.buildDaoProposalCreateDraft({
    from: 'a'.repeat(64), displayTitle: 'Synthetic units check', description: 'Display metadata only.',
    proposalType: 'economic', emergency: false, ...after, proposalFeeUsdStr: '5',
    reviewStartTimeMs: 0, gracePeriodMs: 0, maxGracePeriodMs: 60000,
  });
  const transaction = dao.buildDaoProposalCreateTransaction({
    draft, timestamp: 1700000000000, networkId: 'synthetic', proposalNumber: 1, maxGracePeriodMs: 60000,
    proposalDurations: { reviewDuration: 60000, votingDuration: 60000, claimDuration: 60000 },
  });
  assert.deepEqual(draft.transaction.economic.changes, [expectedChanges]);
  assert.deepEqual(transaction.economic.changes, [expectedChanges]);
});

test('unit labels do not make decorated amounts or invalid booleans valid inputs', async () => {
  for (const [key, value] of [
    ['syncTimeoutPenaltyPercent', '20%'], ['syncTimeoutPenaltyPercent', '-0.2'],
    ['transactionFeeUsdStr', '1 USD'], ['enableNodeSlashing', 'yes'],
  ]) {
    const { modal } = await modalFixture();
    modal.options[0].changes.find(change => change.key === key).value = value;
    assert.throws(() => modal.getValidatedOptions(), error => Boolean(error.validationTarget), `${key}: ${value}`);
  }
});
