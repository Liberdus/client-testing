import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Standalone because published client-testing main currently has no local-tests runner.
// WEB_CLIENT_ROOT=/absolute/client node --test local-tests/tests/issue-1836-economic-parameters.test.mjs
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && path.isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout');
const [dao, lib, appSource] = await Promise.all([
  import(pathToFileURL(path.join(clientRoot, 'dao.js'))),
  import(pathToFileURL(path.join(clientRoot, 'lib.js'))),
  readFile(path.join(clientRoot, 'app.js'), 'utf8'),
]);

const GOVERNANCE_KEYS = [
  'claimDuration', 'committeeAddresses', 'graceDuration', 'minimumSpendUsdStr', 'pctBurned',
  'proposalFeeUsdStr', 'reviewDuration', 'voteExponent', 'voteThresholdUsdStr', 'votingDuration',
];
const ECONOMIC_TYPES = {
  activeVersion: 'string:text', archiver: 'object:archiverVersions', certCycleDuration: 'number:integer',
  defaultTollUsdStr: 'string:decimalString', description: 'string:text', enableNodeSlashing: 'boolean:boolean',
  goldenTicketServerUrl: 'string:url', latestVersion: 'string:text', maintenanceFee: 'bigint:integer',
  maintenanceInterval: 'number:integer', messageMaxLength: 'number:integer', messageRetentionDays: 'number:integer',
  minTollUsdStr: 'string:decimalString', minVersion: 'string:text', nodePenaltyUsdStr: 'string:decimalString',
  nodeRewardAmountUsdStr: 'string:decimalString', nodeRewardInterval: 'number:integer', restakeCooldown: 'number:integer',
  enableLeftNetworkEarlySlashing: 'boolean:boolean', enableNodeRefutedSlashing: 'boolean:boolean',
  enableSyncTimeoutSlashing: 'boolean:boolean', leftNetworkEarlyPenaltyPercent: 'number:decimal',
  nodeRefutedPenaltyPercent: 'number:decimal', syncTimeoutPenaltyPercent: 'number:decimal',
  stabilityFactorStr: 'string:decimalString', stabilityScaleDiv: 'number:integer', stabilityScaleMul: 'number:integer',
  stakeLockTime: 'number:integer', stakeRequiredUsdStr: 'string:decimalString', title: 'string:text',
  tollNetworkTaxPercent: 'number:integer', tollTimeout: 'number:integer', transactionFeeUsdStr: 'string:decimalString',
  txPause: 'boolean:boolean',
};
const PROTOCOL_KEYS = [
  'minNodes', 'maxNodes', 'baselineNodes', 'cycleDuration', 'allowEndUserTxnInjections', 'amountToGrow',
  'amountToShrink', 'maxJoinedPerCycle', 'maxDesiredMultiplier', 'maxShrinkMultiplier', 'syncBoostEnabled',
  'limitRate', 'nodesPerConsensusGroup', 'voterPercentage',
];
const SLASHING_KEYS = [
  'enableLeftNetworkEarlySlashing', 'enableNodeRefutedSlashing', 'enableSyncTimeoutSlashing',
  'leftNetworkEarlyPenaltyPercent', 'nodeRefutedPenaltyPercent', 'syncTimeoutPenaltyPercent',
];
const NEW_VALUES = {
  activeVersion: '12345678901234567890.2.3-beta+build',
  archiver: { minVersion: '1.0.0', activeVersion: '2.0.0-rc.1+test', latestVersion: 'release-next' },
  defaultTollUsdStr: '0.000000000000000001',
  description: '12345678901234567890.123.456 <network> "description"',
  goldenTicketServerUrl: 'https://12345678901234567890.example.test/ticket?version=1.2.3',
  latestVersion: 'release-next', maintenanceFee: '123456789012345678901234567890123456789012345678901234567890',
  minTollUsdStr: '0', minVersion: '1.2.3', nodePenaltyUsdStr: '1.25', nodeRewardAmountUsdStr: '2.50',
  stabilityFactorStr: '0.0001', stakeRequiredUsdStr: '999999999999999.999999999999999999',
  title: '12345678901234567890.123.456',
};
const json = value => JSON.parse(JSON.stringify(value));

function accountFixture() {
  return { current: {
    activeVersion: '1.1.0', archiver: { minVersion: '1.0.0', activeVersion: '1.1.0', latestVersion: '1.2.0' },
    certCycleDuration: 10, defaultTollUsdStr: '0.01', description: 'Synthetic network', enableNodeSlashing: true,
    goldenTicketServerUrl: 'http://tickets.example.test', latestVersion: '1.2.0', maintenanceFee: 90071992547409931234567890n,
    maintenanceInterval: 11, messageMaxLength: 1000, messageRetentionDays: 30, minTollUsdStr: '0.001', minVersion: '1.0.0',
    nodePenaltyUsdStr: '10', nodeRewardAmountUsdStr: '1', nodeRewardInterval: 12, restakeCooldown: 13,
    slashing: {
      enableLeftNetworkEarlySlashing: true, enableNodeRefutedSlashing: false, enableSyncTimeoutSlashing: true,
      leftNetworkEarlyPenaltyPercent: 0.1, nodeRefutedPenaltyPercent: 0.2, syncTimeoutPenaltyPercent: 0.3,
    },
    stabilityFactorStr: '1', stabilityScaleDiv: 100, stabilityScaleMul: 100, stakeLockTime: 14,
    stakeRequiredUsdStr: '100', title: 'Synthetic', tollNetworkTaxPercent: 5, tollTimeout: 15,
    transactionFeeUsdStr: '0.01', txPause: false,
    dao: {
      claimDuration: 60000, committeeAddresses: ['a', 'b', 'c', 'd'].map(char => char.repeat(40)), graceDuration: 60000,
      minimumSpendUsdStr: '1', pctBurned: 5, proposalFeeUsdStr: '5', reviewDuration: 60000,
      voteExponent: 0.5, voteThresholdUsdStr: '10', votingDuration: 60000,
    },
  } };
}

// Evaluate the production class and its neighboring helpers, without loading app startup,
// network services, accounts, browser storage, signing, or transaction submission.
const helpersStart = appSource.indexOf('function getPathValue(');
const classEnd = appSource.indexOf('const addProposalModal', helpersStart);
assert.ok(helpersStart >= 0 && classEnd > helpersStart, 'Production proposal editor must be extractable');
const confirmedDrafts = [];
const AddProposalModal = vm.runInNewContext(
  appSource.slice(helpersStart, classEnd) + '\nAddProposalModal',
  {
    ...dao, escapeHtml: lib.escapeHtml, longAddress: lib.longAddress, URL,
    PopupSelect: { hide() {}, enhanceAll() {}, focus() {} },
    myAccount: { keys: { address: 'a'.repeat(40) } },
    confirmProposalModal: { open: draft => confirmedDrafts.push(draft) },
    showToast: message => assert.fail(`Unexpected toast: ${message}`),
  },
  { filename: path.join(clientRoot, 'app.js') },
);

function inputFixture(value, changeIndex = 0, extraDataset = {}, optionIndex = 0) {
  const dataset = { daoOptionIndex: String(optionIndex), daoChangeIndex: String(changeIndex), ...extraDataset };
  return {
    value, dataset,
    matches(selector) {
      if (selector === '[data-dao-change-value]') return true;
      if (selector === '[data-dao-archiver-field]') return 'daoArchiverField' in dataset;
      return false;
    },
    closest() { return null; },
  };
}

function optionsListFixture() {
  const field = { dataset: {}, querySelector() { return field; }, closest() { return field; } };
  const option = { querySelector() { return field; } };
  return { innerHTML: '', querySelector() { return option; }, querySelectorAll() { return []; } };
}

async function modalFixture(keys = Object.keys(NEW_VALUES)) {
  const account = accountFixture();
  const modal = new AddProposalModal();
  modal.resetConfigCache();
  Object.assign(modal, {
    typeSelect: { value: 'economic' }, emergencySelect: { value: 'false' }, optionsList: optionsListFixture(),
    fetchConfigSource: async () => account,
  });
  modal.configOptionsByType.economic = await modal.fetchConfigOptions('economic');
  modal.options = [{ changes: keys.map(key => ({ key, value: structuredClone(NEW_VALUES[key]) })) }];
  return { modal, account };
}

function requireOption(modal, key) {
  const option = modal.getConfigOption(key);
  assert.ok(option, `Missing economic parameter: ${key}`);
  return option;
}

test('offers all governance/economic fields and keeps the existing protocol and slashing leaves', () => {
  assert.deepEqual(dao.DAO_CONFIG_CHANGE_OPTIONS.governance.map(option => option.key).sort(), [...GOVERNANCE_KEYS].sort());
  assert.deepEqual(dao.DAO_CONFIG_CHANGE_OPTIONS.economic.map(option => option.key).sort(), Object.keys(ECONOMIC_TYPES).sort());
  assert.deepEqual(dao.DAO_CONFIG_CHANGE_OPTIONS.protocol.map(option => option.key), PROTOCOL_KEYS);
  for (const option of dao.DAO_CONFIG_CHANGE_OPTIONS.economic) {
    assert.equal(`${option.valueType}:${option.validation}`, ECONOMIC_TYPES[option.key], option.key);
    assert.equal(option.path, `current.${SLASHING_KEYS.includes(option.key) ? 'slashing.' : ''}${option.key}`, option.key);
  }
  assert.ok(!dao.DAO_CONFIG_CHANGE_OPTIONS.economic.some(option => option.key === 'slashing'));
});

test('fetches every available current value from a synthetic network account without losing bigint precision', async () => {
  const { modal, account } = await modalFixture();
  const economic = modal.getConfigOptions();
  assert.equal(economic.length, Object.keys(ECONOMIC_TYPES).length);
  for (const option of economic) {
    const source = SLASHING_KEYS.includes(option.key) ? account.current.slashing : account.current;
    assert.deepEqual(option.current, source[option.key], option.key);
  }
  assert.equal(String(requireOption(modal, 'maintenanceFee').current), '90071992547409931234567890');
  const governance = await modal.fetchConfigOptions('governance');
  assert.equal(governance.length, GOVERNANCE_KEYS.length);
  assert.equal(governance.find(option => option.key === 'committeeAddresses').current.length, 4);
});

test('renders usable string, decimal, bigint and structured archiver controls with current values', async () => {
  const { modal } = await modalFixture();
  for (const [key, value] of Object.entries(NEW_VALUES)) {
    const option = requireOption(modal, key);
    const markup = modal.renderOptionChange(0, { key, value }, 0, 1, modal.getConfigOptions(), true);
    assert.ok(markup.includes(lib.escapeHtml(String(option.label))), key);
    assert.doesNotMatch(markup, /\[object Object\]/, key);
    const proposed = modal.renderProposedValueControl(option, value, 'testProposed', 'data-dao-change-value');
    if (key === 'archiver') {
      assert.match(proposed, /data-dao-archiver-versions/);
      for (const field of ['minVersion', 'activeVersion', 'latestVersion']) {
        assert.match(proposed, new RegExp(`data-dao-archiver-field="${field}"`));
        assert.ok(proposed.includes(value[field]));
      }
      const currentInputs = [...markup.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).filter(tag => /\breadonly\b/.test(tag));
      for (const field of ['minVersion', 'activeVersion', 'latestVersion']) {
        const input = currentInputs.find(tag => tag.includes(`data-dao-archiver-field="${field}"`));
        assert.ok(input?.includes(`value="${option.current[field]}"`), `Current archiver ${field}`);
      }
      assert.doesNotMatch(proposed, /<textarea/);
    } else {
      assert.match(proposed, /<(?:input|textarea)\b/);
      assert.match(proposed, /required/);
      if (key === 'maintenanceFee') {
        assert.match(proposed, /type="text"/);
        assert.match(proposed, /inputmode="numeric"/);
        assert.doesNotMatch(proposed, /maxlength=/);
      }
      if (option.validation === 'decimalString') assert.match(proposed, /inputmode="decimal"/);
    }
  }
});

test('input events preserve text, dotted versions, URLs and arbitrary-length maintenance integers', async () => {
  const keys = Object.keys(NEW_VALUES).filter(key => key !== 'archiver');
  const { modal } = await modalFixture(keys);
  keys.forEach((key, index) => {
    requireOption(modal, key);
    const input = inputFixture(NEW_VALUES[key], index);
    modal.handleOptionsInput({ target: input });
    assert.equal(input.value, NEW_VALUES[key], key);
    assert.equal(modal.options[0].changes[index].value, NEW_VALUES[key], key);
  });
  const decimalIndex = keys.indexOf('defaultTollUsdStr');
  const decimalInput = inputFixture('.25', decimalIndex);
  modal.handleOptionsInput({ target: decimalInput });
  assert.equal(decimalInput.value, '0.25', 'existing decimal normalization remains available');
});

test('archiver drafts and field edits preserve other fields, options and current network config', async () => {
  const { modal, account } = await modalFixture(['archiver']);
  requireOption(modal, 'archiver');
  const first = modal.createChange('archiver');
  const second = modal.createChange('archiver');
  assert.deepEqual(json(first.value), account.current.archiver);
  assert.notEqual(first.value, second.value);
  assert.notEqual(first.value, account.current.archiver);
  modal.options = [{ changes: [first] }, { changes: [second] }];
  const version = '12345678901234567890.2.3-rc+build';
  const input = inputFixture(version, 0, { daoArchiverField: 'activeVersion' });
  modal.handleOptionsInput({ target: input });
  assert.equal(input.value, version);
  assert.equal(first.value.activeVersion, version);
  assert.equal(second.value.activeVersion, '1.1.0');
  assert.deepEqual(account.current.archiver, { minVersion: '1.0.0', activeVersion: '1.1.0', latestVersion: '1.2.0' });
  assert.equal(first.value.minVersion, '1.0.0');
  assert.equal(first.value.latestVersion, '1.2.0');
  assert.equal(JSON.parse(modal.getValidatedOptions().changes[0][0].value).activeVersion, version);
});

test('validates and serializes every added parameter through the real form, draft and transaction builders', async () => {
  const { modal } = await modalFixture();
  const validated = modal.getValidatedOptions();
  assert.deepEqual(json(validated.options), ['no', 'Option 1']);
  assert.equal(validated.changes[0].length, Object.keys(NEW_VALUES).length);
  for (const change of validated.changes[0]) {
    const option = requireOption(modal, change.key);
    assert.equal(typeof change.value, 'string', change.key);
    assert.equal(typeof change.current, 'string', change.key);
    if (change.key === 'archiver') {
      assert.deepEqual(JSON.parse(change.value), NEW_VALUES.archiver);
      assert.deepEqual(JSON.parse(change.current), option.current);
    } else {
      assert.equal(change.value, NEW_VALUES[change.key], change.key);
      assert.equal(change.current, String(option.current), change.key);
    }
  }
  Object.assign(modal, {
    titleInput: { value: 'Update economic configuration' }, descriptionInput: { value: 'Synthetic proposal.' },
    proposalFeeUsdStr: '5', gracePeriodMs: 0, maxGracePeriodMs: 60000,
    clearValidationErrors() {}, getReviewStartTimeMs: () => 0,
    showValidationError: error => assert.fail(error.message),
  });
  const previousConfirmations = confirmedDrafts.length;
  await modal.handleCreate();
  assert.equal(confirmedDrafts.length, previousConfirmations + 1);
  const draft = confirmedDrafts.at(-1);
  const transaction = dao.buildDaoProposalCreateTransaction({
    draft, timestamp: 1700000000000, networkId: 'synthetic', proposalNumber: 1, maxGracePeriodMs: 60000,
    proposalDurations: { reviewDuration: 60000, votingDuration: 60000, claimDuration: 60000 },
  });
  for (const payload of [draft.transaction, transaction]) {
    assert.equal(payload.proposalType, 'economic');
    assert.deepEqual(json(payload.economic.changes), json(validated.changes));
  }
});

test('retains existing decimal-string bounds for new USD values and stability factor', async () => {
  const keys = Object.keys(NEW_VALUES).filter(key => ECONOMIC_TYPES[key] === 'string:decimalString');
  for (const key of keys) {
    const { modal } = await modalFixture([key]);
    requireOption(modal, key);
    for (const value of ['', '-1', '1e2', 'NaN', '1000000000000000', '0.0000000000000000001']) {
      modal.options[0].changes[0].value = value;
      assert.throws(() => modal.getValidatedOptions(), undefined, `${key}: ${value}`);
    }
  }
});

const ZERO_STABILITY_VALUES = ['0', '0.0', '0.000000000000000000', ' 0 ', '\t0.000000000000000000\n'];

test('rejects every zero stability-factor representation with a meaningful field error', async () => {
  const { modal } = await modalFixture(['stabilityFactorStr']);
  const valueInput = modal.optionsList.querySelector().querySelector();
  for (const value of ZERO_STABILITY_VALUES) {
    modal.options[0].changes[0].value = value;
    assert.throws(() => modal.getValidatedOptions(), error => {
      assert.equal(error.validationTarget, valueInput);
      assert.match(error.message, /stability factor/i);
      assert.match(error.message, /greater than (?:zero|0)|positive/i);
      return true;
    }, `Zero stability factor must be rejected: ${JSON.stringify(value)}`);
  }
});

test('does not open proposal confirmation for a zero stability factor', async () => {
  const { modal } = await modalFixture(['stabilityFactorStr']);
  const errors = [];
  Object.assign(modal, {
    titleInput: { value: 'Update stability factor' }, descriptionInput: { value: 'Synthetic proposal.' },
    proposalFeeUsdStr: '5', gracePeriodMs: 0, maxGracePeriodMs: 60000,
    clearValidationErrors() {}, getReviewStartTimeMs: () => 0,
    showValidationError: error => errors.push(error),
  });
  for (const value of ZERO_STABILITY_VALUES) {
    modal.options[0].changes[0].value = value;
    const previousConfirmations = confirmedDrafts.length;
    const previousErrors = errors.length;
    await modal.handleCreate();
    assert.equal(confirmedDrafts.length, previousConfirmations, `Rejected zero opened confirmation: ${JSON.stringify(value)}`);
    assert.equal(errors.length, previousErrors + 1);
    assert.ok(errors.at(-1).validationTarget);
    assert.match(errors.at(-1).message, /stability factor/i);
  }
});

test('preserves exact positive stability-factor strings including the smallest supported fraction', async () => {
  const { modal } = await modalFixture(['stabilityFactorStr']);
  for (const value of ['0.000000000000000001', '0.25', '1', '1.500', '999999999999999.999999999999999999']) {
    const input = inputFixture(value);
    modal.handleOptionsInput({ target: input });
    assert.equal(input.value, value);
    assert.equal(modal.getValidatedOptions().changes[0][0].value, value);
  }
});

test('continues to allow zero transaction fees and minimum tolls', async () => {
  for (const key of ['transactionFeeUsdStr', 'minTollUsdStr']) {
    const { modal } = await modalFixture([key]);
    for (const value of ZERO_STABILITY_VALUES) {
      modal.options[0].changes[0].value = value;
      assert.equal(modal.getValidatedOptions().changes[0][0].value, value.trim(), key);
    }
  }
});

test('requires nonempty text while allowing server version labels beyond semver', async () => {
  for (const key of ['activeVersion', 'minVersion', 'latestVersion', 'title', 'description']) {
    const { modal } = await modalFixture([key]);
    requireOption(modal, key);
    for (const value of ['', '   ']) {
      modal.options[0].changes[0].value = value;
      assert.throws(() => modal.getValidatedOptions(), undefined, key);
    }
    modal.options[0].changes[0].value = 'release-next';
    assert.equal(modal.getValidatedOptions().changes[0][0].value, 'release-next', key);
  }
});

test('requires an absolute HTTP or HTTPS golden-ticket endpoint', async () => {
  const { modal } = await modalFixture(['goldenTicketServerUrl']);
  requireOption(modal, 'goldenTicketServerUrl');
  for (const value of ['', 'ticket-service', '//tickets.example.test', 'ftp://tickets.example.test', 'javascript:alert(1)', 'https://']) {
    modal.options[0].changes[0].value = value;
    assert.throws(() => modal.getValidatedOptions(), undefined, value);
  }
  for (const value of ['http://localhost:8080/ticket', NEW_VALUES.goldenTicketServerUrl]) {
    modal.options[0].changes[0].value = value;
    assert.equal(modal.getValidatedOptions().changes[0][0].value, value);
  }
});

test('validates maintenance fees as nonnegative integer strings without number coercion', async () => {
  const { modal } = await modalFixture(['maintenanceFee']);
  requireOption(modal, 'maintenanceFee');
  for (const value of ['', '-1', '+1', '1.0', '1e3', '0x10', 'NaN', 'Infinity', '1_000']) {
    modal.options[0].changes[0].value = value;
    assert.throws(() => modal.getValidatedOptions(), undefined, value);
  }
  for (const value of ['0', '9'.repeat(100), NEW_VALUES.maintenanceFee]) {
    const input = inputFixture(value);
    modal.handleOptionsInput({ target: input });
    assert.equal(input.value, value);
    assert.equal(modal.getValidatedOptions().changes[0][0].value, value);
  }
});

test('rejects incomplete or malformed archiver values and requires all three version strings', async () => {
  const { modal } = await modalFixture(['archiver']);
  requireOption(modal, 'archiver');
  const invalid = [null, [], '{}', {}, { ...NEW_VALUES.archiver, minVersion: '' },
    { ...NEW_VALUES.archiver, activeVersion: ' ' }, { ...NEW_VALUES.archiver, latestVersion: 2 }];
  for (const value of invalid) {
    modal.options[0].changes[0].value = value;
    assert.throws(() => modal.getValidatedOptions(), error => Boolean(error.validationTarget), JSON.stringify(value));
  }
  modal.options[0].changes[0].value = { minVersion: 'old-release', activeVersion: 'current', latestVersion: 'next' };
  assert.deepEqual(JSON.parse(modal.getValidatedOptions().changes[0][0].value), modal.options[0].changes[0].value);
});
