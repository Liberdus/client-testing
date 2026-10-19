import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const releaseVersion = (await readFile(new URL('../version.html', import.meta.url), 'utf8')).trim();

function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);

  const bodyStart = appSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === '{') depth += 1;
    if (appSource[index] === '}') depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }

  throw new Error(`Could not find the end of ${name}`);
}

const comparableVersionSource = extractFunction('getComparableVersion');
const getComparableVersion = vm.runInNewContext(`${comparableVersionSource}; getComparableVersion`);

test('the web release uses the native app timestamp structure', () => {
  assert.match(releaseVersion, /^\d{4}\.\d{4}\.\d{4}$/);
});

test('legacy and canonical separators compare without a false update', async () => {
  assert.equal(getComparableVersion('2025.03.31.10.15'), getComparableVersion('2025.0331.1015'));

  const storedVersions = [];
  const context = {
    console: { error: () => {}, log: () => {} },
    fetch: async () => ({ ok: true, text: async () => '2025.0331.1015' }),
    localStorage: {
      getItem: () => '2025.03.31.10.15',
      setItem: (key, value) => storedVersions.push([key, value]),
    },
    logsModal: { log: () => {} },
    network: { netid: 'testnet' },
  };
  vm.createContext(context);
  vm.runInContext(`
    let myVersion = '0';
    ${comparableVersionSource}
    async ${extractFunction('checkVersion')}
    globalThis.runVersionCheck = checkVersion;
    globalThis.readVersion = () => myVersion;
  `, context);

  await context.runVersionCheck();

  assert.deepEqual(storedVersions, [['version_testnet', '2025.0331.1015']]);
  assert.equal(context.readVersion(), '2025.0331.1015');
});

test('welcome and About present explicit version labels', () => {
  assert.match(indexSource, /class="welcome-version"[^]*Web Version: <span id="versionDisplay"><\/span>/);
  assert.match(indexSource, /id="appVersionDisplay" class="hidden">App Version:/);
  assert.match(indexSource, /Web Version: <span id="versionDisplayAbout"><\/span>/);
  assert.match(appSource, /this\.versionDisplay\.textContent = getWebVersionDisplay\(\);/);
});

test('the welcome version block fills spare space without overlapping short screens', () => {
  assert.match(styles, /\.welcome-screen\s*{[^}]*padding-bottom:\s*calc\(2rem \+ env\(safe-area-inset-bottom, 0px\)\)[^}]*min-height:\s*0/s);
  assert.match(styles, /\.welcome-version\s*{[^}]*flex:\s*none[^}]*margin-top:\s*auto[^}]*color:\s*var\(--muted-text-color\)/s);
  assert.doesNotMatch(styles, /safe-area-inset-bottom,[^)]+\) \+ 100px/);
});
