import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('keeps every shared proposal option card as tall as its tallest sibling', () => {
  assert.match(
    styles,
    /#addProposalModal \.proposal-option-cards,\s*#confirmProposalModal \.proposal-option-cards,\s*#proposalInfoModal \.proposal-option-cards \{[^}]*grid-auto-rows: 1fr/,
  );
});
