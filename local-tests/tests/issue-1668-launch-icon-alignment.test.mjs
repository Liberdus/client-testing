import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

function getRule(selector) {
  const start = styles.indexOf(selector);
  assert.notEqual(start, -1, `${selector} should exist`);

  const end = styles.indexOf('}', start);
  return styles.slice(start, end + 1);
}

test('settings and welcome Launch rows share the corrected icon', () => {
  assert.match(indexSource, /id="openLaunchUrl" data-icon="launch"/);
  assert.match(indexSource, /id="welcomeOpenLaunch" data-icon="launch"/);

  const launchRule = getRule('.menu-item[data-icon="launch"]::before');
  assert.match(launchRule, /M18 13v6a2 2 0 0 1-2 2H5/);
  assert.match(launchRule, /points='15,3 21,3 21,9'/);
  assert.doesNotMatch(launchRule, /points='7,7 17,7 17,17'/);
});

test('Launch retains the standard icon slot and label spacing', () => {
  const sharedIconRule = getRule('.menu-item::before');

  assert.match(sharedIconRule, /flex:\s*0 0 20px/);
  assert.match(sharedIconRule, /width:\s*20px/);
  assert.match(sharedIconRule, /height:\s*20px/);
  assert.match(sharedIconRule, /background-position:\s*center/);
  assert.match(sharedIconRule, /margin-right:\s*12px/);
});

test('Launch rows retain flex alignment when made visible', () => {
  assert.equal([...appSource.matchAll(/this\.launchButton\.style\.display = 'flex';/g)].length, 2);
  assert.doesNotMatch(appSource, /this\.launchButton\.style\.display = 'block';/);
});
