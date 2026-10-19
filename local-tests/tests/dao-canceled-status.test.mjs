import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DAO_STATES, getDaoStateLabel } from '../dao.js';

const [appSource, markup] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);

test('displays canceled proposals without adding a canceled filter', () => {
  assert.equal(getDaoStateLabel('canceled'), 'Canceled');
  assert.equal(DAO_STATES.some(({ key }) => key === 'canceled'), false);
  assert.doesNotMatch(markup, /data-filter-key="canceled"/);
  assert.match(
    appSource,
    /else if \(state === 'canceled'\) \{\s*chips\.push\(\{\s*value: getDaoStateLabel\(state\),\s*tone: 'rejected',/,
  );
});
