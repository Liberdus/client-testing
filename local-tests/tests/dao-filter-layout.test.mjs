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
    'review',
    'voting',
    'accepted',
    'claimable',
    'withheld',
    'rejected',
    'applied',
    'all',
    'executing',
    'terminated',
    'completed',
  ]);
  assert.match(markup, /class="dao-filter-row-label"[^>]*>Projects:<\/span>/);
  assert.doesNotMatch(markup, /data-filter-key="archived"/);
  assert.doesNotMatch(markup, /daoFilterExpandButton|daoFilterOverflow/);
  assert.doesNotMatch(appSource, /setFiltersExpanded|DAO_FILTER_OVERFLOW_KEYS|filterExpandButton|filterOverflow/);
  assert.doesNotMatch(appSource, /proposal-option-card-number/);
});

test('uses a wider project-filter row on desktop and equal columns on narrow screens', () => {
  assert.match(styles, /#daoModal \.dao-filter-bar \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(styles, /#daoModal \.dao-filter-bar \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /#daoModal \.dao-project-filter-row \{[^}]*grid-template-columns: max-content repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*#daoModal \.dao-project-filter-row \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /#daoModal \.dao-filter-chip \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(styles, /#daoModal \.dao-filter-chip-count \{[\s\S]*justify-self: end/);
  assert.match(styles, /#daoModal \.dao-filter-chip-label \{[^}]*text-overflow: clip/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*font-size: clamp\(9px, 2\.8vw, 12px\)/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*#daoModal \.dao-filter-chip \{[^}]*padding-right: 6px/);
});
