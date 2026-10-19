import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, markup, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('renders every DAO proposal filter without an expand control', () => {
  const filterKeys = [...markup.matchAll(/class="dao-filter-chip"[^>]*data-filter-key="([^"]+)"/g)]
    .map(([, key]) => key);

  assert.deepEqual(filterKeys, [
    'all', 'claimable', 'review', 'withheld', 'voting', 'rejected', 'accepted', 'applied',
    'executing', 'terminated', 'completed',
  ]);
  assert.deepEqual(
    [...markup.matchAll(/data-dao-context="([^"]+)"/g)].map(([, key]) => key),
    ['proposals', 'projects'],
  );
  assert.match(markup, /data-dao-filters="projects" inert aria-hidden="true"/);
  assert.match(appSource, /panel\.inert = inactive/);
  assert.match(appSource, /panel\.setAttribute\('aria-hidden', String\(inactive\)\)/);
  assert.doesNotMatch(markup, /data-filter-key="archived"/);
  assert.doesNotMatch(markup, /daoFilterExpandButton|daoFilterOverflow/);
  assert.doesNotMatch(appSource, /setFiltersExpanded|DAO_FILTER_OVERFLOW_KEYS|filterExpandButton|filterOverflow/);
  assert.doesNotMatch(appSource, /proposal-option-card-number/);
});

class DaoFilterLayout {
  static rule(selector) {
    const start = styles.indexOf(selector);
    assert.notEqual(start, -1, `Missing CSS selector: ${selector}`);
    const body = styles.indexOf('{', start);
    return styles.slice(body + 1, styles.indexOf('}', body));
  }
}

test('keeps mobile context rows readable with equal-width filters and wrapping labels', () => {
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-bar {'), /display: grid/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-row,'), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-row--outcomes {'), /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-row--projects {'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  const chip = DaoFilterLayout.rule('#daoModal .dao-filter-chip,');
  assert.match(chip, /min-height: 44px/);
  assert.match(chip, /min-width: 0/);
  assert.match(chip, /overflow-wrap: anywhere/);
  assert.match(chip, /font-size: var\(--font-size-sm\)/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-row--outcomes .dao-filter-chip,'), /flex-direction: column/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-slot > *'), /grid-area: 1 \/ 1/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-inactive'), /visibility: hidden/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-inactive'), /pointer-events: none/);
  assert.match(DaoFilterLayout.rule('#daoModal .dao-filter-chip-count {'), /max-width: 100%/);
});
