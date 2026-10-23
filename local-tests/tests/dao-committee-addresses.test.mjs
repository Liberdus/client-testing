import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAO_CONFIG_CHANGE_OPTIONS,
  DaoCommitteeAddresses,
  buildDaoProposalCreateDraft,
  buildDaoProposalCreateTransaction,
} from '../dao.js';

class CommitteeFixture {
  static addresses(count = 4) {
    return Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(40, 'a'));
  }

  static draft(change = {}) {
    return buildDaoProposalCreateDraft({
      from: 'f'.repeat(64), displayTitle: 'Update committee', emergency: false,
      proposalType: 'governance', description: 'Replace committee members.',
      options: ['no', 'Option 1'], proposalFeeUsdStr: '5', reviewStartTimeMs: 0,
      gracePeriodMs: 0, maxGracePeriodMs: 60000,
      changes: [[{
        key: 'committeeAddresses',
        value: JSON.stringify(this.addresses()),
        current: JSON.stringify(this.addresses().map(address => address.padEnd(64, '0'))),
        ...change,
      }]],
    });
  }
}

test('offers the committee array under Governance', () => {
  const option = DAO_CONFIG_CHANGE_OPTIONS.governance.find(option => option.key === 'committeeAddresses');
  assert.equal(option.path, 'current.dao.committeeAddresses');
  assert.equal(option.valueType, 'array');
  assert.equal(option.validation, 'committeeAddresses');
});

test('normalizes optional prefixes and case without changing the input list or address order', () => {
  const input = [' 0x' + 'A'.repeat(40) + ' ', '0X' + 'B'.repeat(40), 'C'.repeat(64), 'd'.repeat(64)];
  const original = [...input];
  assert.deepEqual(DaoCommitteeAddresses.normalize(input), [
    'a'.repeat(40) + '0'.repeat(24), 'b'.repeat(40) + '0'.repeat(24), 'c'.repeat(64), 'd'.repeat(64),
  ]);
  assert.deepEqual(input, original);
});

test('accepts both membership limits and rejects lists below four or above ten', () => {
  for (const count of [4, 10]) assert.equal(DaoCommitteeAddresses.normalize(CommitteeFixture.addresses(count)).length, count);
  for (const count of [0, 3, 11]) assert.throws(() => DaoCommitteeAddresses.normalize(CommitteeFixture.addresses(count)), /4.*10/);
});

test('rejects blank, non-string, non-hex and wrong-length entries with their row index', () => {
  for (const value of ['', ' ', null, 42, 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), '0x0x' + 'a'.repeat(40)]) {
    const input = CommitteeFixture.addresses();
    input[2] = value;
    assert.throws(() => DaoCommitteeAddresses.normalize(input), error => error.addressIndex === 2);
  }
});

test('detects duplicates after padding, prefix removal and lowercasing', () => {
  const input = CommitteeFixture.addresses();
  input[1] = ' 0X' + input[0].toUpperCase().padEnd(64, '0') + ' ';
  assert.throws(() => DaoCommitteeAddresses.normalize(input), error => /duplicate/.test(error.message) && error.addressIndex === 1);
});

test('requires serialized JSON arrays and rejects malformed or non-array JSON', () => {
  for (const value of [CommitteeFixture.addresses(), undefined, '', 'bad json', '{}', 'null', '"text"']) {
    assert.throws(() => DaoCommitteeAddresses.parse(value));
  }
  assert.deepEqual(DaoCommitteeAddresses.parse(JSON.stringify(CommitteeFixture.addresses())), DaoCommitteeAddresses.normalize(CommitteeFixture.addresses()));
});

test('builds draft and transaction changes as canonical JSON strings', () => {
  const input = [' 0x' + 'A'.repeat(40), '0X' + 'B'.repeat(64), 'c'.repeat(40), 'd'.repeat(64)];
  const draft = CommitteeFixture.draft({ value: JSON.stringify(input), current: JSON.stringify(input) });
  const transaction = buildDaoProposalCreateTransaction({
    draft, timestamp: 1700000000000, networkId: 'synthetic', proposalNumber: 7,
    maxGracePeriodMs: 60000,
    proposalDurations: { reviewDuration: 60000, votingDuration: 60000, claimDuration: 60000 },
  });
  for (const change of [draft.transaction.governance.changes[0][0], transaction.governance.changes[0][0]]) {
    for (const property of ['current', 'value']) {
      assert.equal(typeof change[property], 'string');
      assert.deepEqual(JSON.parse(change[property]), DaoCommitteeAddresses.normalize(input));
      assert.doesNotMatch(change[property], /0x|[A-F]/);
    }
  }
});

test('transaction builders reject invalid committee payloads in either current or proposed values', () => {
  for (const property of ['current', 'value']) {
    for (const invalid of ['not json', JSON.stringify(CommitteeFixture.addresses(3)), JSON.stringify(['a'.repeat(40), ...CommitteeFixture.addresses(3)].fill('a'.repeat(40)))]) {
      assert.throws(() => CommitteeFixture.draft({ [property]: invalid }));
      const draft = CommitteeFixture.draft();
      draft.transaction.governance.changes[0][0][property] = invalid;
      assert.throws(() => buildDaoProposalCreateTransaction({
        draft, timestamp: 1700000000000, networkId: 'synthetic', proposalNumber: 7,
        maxGracePeriodMs: 60000,
        proposalDurations: { reviewDuration: 60000, votingDuration: 60000, claimDuration: 60000 },
      }));
    }
  }
});
