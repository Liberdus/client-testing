import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);
const styles = await readFile(new URL('styles.css', rootUrl), 'utf8');

const expectedHashes = new Map([
  ['fonts/inter-latin.woff2', 'c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4'],
  ['fonts/inter-latin-ext.woff2', 'a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2'],
  ['fonts/LICENSE.txt', '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a'],
]);

test('bundled Inter files match the reviewed assets', async () => {
  for (const [path, expectedHash] of expectedHashes) {
    const contents = await readFile(new URL(path, rootUrl));
    const actualHash = createHash('sha256').update(contents).digest('hex');
    assert.equal(actualHash, expectedHash, path);
  }
});

test('Inter is local and covers the application weight range', () => {
  const fontFaces = [...styles.matchAll(/@font-face\s*{[^}]+}/gs)].map(([rule]) => rule);
  assert.equal(fontFaces.length, 2);

  for (const rule of fontFaces) {
    assert.match(rule, /font-weight:\s*400 700/);
    assert.match(rule, /font-display:\s*swap/);
    assert.match(rule, /src:\s*url\('\.\/fonts\/inter-latin(?:-ext)?\.woff2'\)/);
    assert.doesNotMatch(rule, /https?:|\/\//);
  }
});

test('global and MenuModal typography safeguards are present', () => {
  assert.match(styles, /--font-primary:\s*'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,/);
  assert.match(styles, /body\s*{[^}]*font-variant-ligatures:\s*no-contextual/s);
  assert.match(styles, /\.menu-item\s*{[^}]*font-size:\s*var\(--font-size-base\)[^}]*font-weight:\s*var\(--font-weight-medium\)/s);
  assert.match(styles, /\.menu-item::before\s*{[^}]*width:\s*20px[^}]*height:\s*20px[^}]*opacity:\s*0\.75/s);
});
