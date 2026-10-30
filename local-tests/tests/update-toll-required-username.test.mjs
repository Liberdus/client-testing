import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getVerifiedUsername } from '../lib.js';

const ADDRESS = 'a'.repeat(40);
const OTHER_ADDRESS = 'b'.repeat(40);
const LONG_ADDRESS = `${ADDRESS}${'0'.repeat(24)}`;
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('normalizes and returns a username whose network address matches', async () => {
  const username = await getVerifiedUsername('Alice!', `0x${ADDRESS}`, async (normalizedUsername) => {
    assert.equal(normalizedUsername, 'alice');
    return LONG_ADDRESS;
  });

  assert.equal(username, 'alice');
});

test('rejects a username whose network address does not match', async () => {
  const username = await getVerifiedUsername('alice', ADDRESS, async () => OTHER_ADDRESS);

  assert.equal(username, null);
});

test('treats lookup failures as unverified', async () => {
  const username = await getVerifiedUsername('alice', ADDRESS, async () => {
    throw new Error('network unavailable');
  });

  assert.equal(username, null);
});

test('wires sender username and verified receipt handling into status transactions', () => {
  assert.match(appSource, /previousRequired: previousRequiredNum,\s+username: myAccount\.username,\s+type: 'update_toll_required'/);
  assert.match(appSource, /await getVerifiedUsername\(tx\.username, txFrom, getUsernameAddress\)/);
  assert.match(appSource, /if \(verifiedUsername\) \{\s+statusContact\.username = verifiedUsername;/);
});
