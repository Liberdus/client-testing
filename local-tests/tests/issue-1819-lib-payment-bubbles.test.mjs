import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { big2str, escapeHtml, escapeHtmlAttribute, linkifyUrls, normalizeHttpsUrl, normalizeTransactionId } from '../lib.js';
import { formatDisplayAmount } from '../near-assets.js';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('class ChatModal {');
const end = source.indexOf('const chatModal = new ChatModal();', start);
assert.ok(start >= 0 && end > start, 'Load the actual ChatModal methods');
const network = {};
const chat = vm.runInNewContext(`${source.slice(start, end)}; Object.create(ChatModal.prototype)`, {
  big2str, escapeHtml, escapeHtmlAttribute, linkifyUrls, normalizeHttpsUrl, normalizeTransactionId, formatDisplayAmount, network, URL,
  formatTime: () => '12:34 PM', isDeleted: () => false,
  fetch: () => { throw Error('Rendering a LIB receipt must not request network data'); },
});
const TXID = 'abcdef12'.repeat(8);
const wei = 10n ** 18n;
const base = { my: true, amount: 25n * wei / 10n, timestamp: 1, txid: TXID, status: 'sent' };
const render = (overrides = {}, lastReadTs = 0) => {
  const item = { ...base, ...overrides };
  return chat.renderChatMessageHTML(item, { contact: { messages: [item] }, lastReadTs });
};
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('sent and received native receipts expose direction, asset, network and one timestamp', () => {
  for (const my of [true, false]) {
    const html = render({ my });
    assert.match(html, new RegExp(`class="message ${my ? 'sent' : 'received'}[^\"]*payment-info`));
    assert.match(html, /class="lib-payment-message"/);
    assert.match(html, /<img\b[^>]*src="\.\/media\/liberdus_logo_50\.png"/);
    assert.ok(text(html).includes(`Payment ${my ? 'sent' : 'received'}`));
    assert.ok(text(html).includes('Liberdus'));
    assert.match(html, new RegExp(`<span class="payment-direction">${my ? '-' : '\\+'}</span>`));
    assert.ok(text(html).includes('2.5 LIB'));
    assert.equal((html.match(/class="message-time"/g) || []).length, 1);
    assert.equal((text(html).match(/12:34 PM/g) || []).length, 1);
    assert.ok(!html.includes('data-verified'));
    assert.ok(!/Confirmed|Checking|Confirming/.test(text(html)), 'A native local record must not invent receipt verification');
  }
});

test('native amount display remains useful for one wei and never rounds large integers through Number', () => {
  for (const [amount, displayed, exact] of [
    [1n, '0.000000000000000001', '0.000000000000000001'],
    [10000000000000000000000000000000001n, '10000000000000000', '10000000000000000.000000000000000001'],
    [1234567890123456789n, '1.234567', '1.234567890123456789'],
  ]) {
    const html = render({ amount });
    assert.ok(text(html).includes(`${displayed} LIB`), text(html));
    assert.ok(html.includes(`title="${exact} LIB"`), 'Expose the exact amount on the amount header');
    assert.ok(text(html).includes(`${exact} LIB`), 'Expose the exact amount inside details');
  }
});

test('notes retain escaped linkified memo text without pulling the Note label into edit/reply/copy', () => {
  const memo = 'Lunch <img src=x onerror=alert(1)>\nhttps://liberdus.com/';
  const html = render({ message: memo, symbol: '<LIB>' });
  assert.ok(text(html).includes('Note'));
  assert.match(html, /class="payment-memo"/);
  assert.ok(html.includes(linkifyUrls(memo)), 'Use the existing safe memo linkifier');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;LIB&gt;'));
  assert.equal((html.match(/class="payment-memo"/g) || []).length, 1);
  assert.ok(!render().includes('class="payment-memo"'));
});

test('valid native txids appear exactly once in local details and unsafe ids add no disclosure/link', () => {
  const html = render({ txid: TXID.toUpperCase() });
  assert.match(html, /<details class="lib-payment-details">/);
  assert.ok(html.includes('<summary>Payment details</summary>'));
  assert.ok(html.includes(`<code>${TXID}</code>`));
  assert.equal(text(html).split(TXID).length - 1, 1);
  assert.ok(!html.includes('<a '), 'A native receipt must not fabricate an EVM explorer URL');
  for (const txid of [undefined, '', '0x' + TXID, 'not-a-txid', '" onclick="alert(1)']) {
    const invalid = render({ txid });
    assert.ok(!invalid.includes('class="lib-payment-details"'));
    assert.ok(!invalid.includes('<a '));
    if (txid) assert.ok(invalid.includes(`data-txid="${escapeHtmlAttribute(txid)}"`));
  }
});

test('native transaction links use the configured HTTPS explorer path and normalized full hash', () => {
  try {
    for (const [explorerUrl, expected] of [
      ['https://dev.liberdus.com:3035/', 'https://dev.liberdus.com:3035'],
      ['https://exp-test.liberdus.com', 'https://exp-test.liberdus.com'],
      ['https://explorer.example/base/path///', 'https://explorer.example/base/path'],
      [' https://EXPLORER.example:443/base/path/?old=1#section ', 'https://explorer.example/base/path'],
    ]) {
      network.explorerUrl = explorerUrl;
      for (const my of [true, false]) {
        const html = render({ my, txid: TXID.toUpperCase() });
        assert.ok(html.includes(`href="${expected}/transaction/${TXID}"`));
        assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));
        assert.ok(html.includes(`aria-label="View transaction ${TXID} in block explorer"`));
        assert.ok(html.includes(`<code>${TXID}</code>`));
        assert.equal(text(html).split(TXID).length - 1, 1);
        assert.ok(text(html).includes('↗'));
        assert.ok(!html.includes(`/transaction/0x${TXID}`));
      }
    }
  } finally { delete network.explorerUrl; }
});

test('missing or unsafe native explorer configuration retains plain full-hash details', () => {
  try {
    for (const explorerUrl of [undefined, null, '', {}, 'invalid', '/explorer/', 'http://explorer.example', 'javascript:alert(1)', 'https://user:secret@explorer.example', 'https://explorer.example/' + 'x'.repeat(2050)]) {
      network.explorerUrl = explorerUrl;
      const html = render();
      assert.ok(html.includes('<summary>Payment details</summary>'));
      assert.ok(html.includes(`<code>${TXID}</code>`));
      assert.ok(!html.includes('<a '));
    }
    network.explorerUrl = 'https://dev.liberdus.com:3035/';
    assert.ok(!render({ txid: '0x' + TXID }).includes('class="lib-payment-details"'));
    assert.ok(!render({ txid: '" onclick="alert(1)' }).includes('<a '));
  } finally { delete network.explorerUrl; }
});

test('existing pending/failed attributes and edited indicators remain attached to native receipts', () => {
  for (const status of ['sent', 'pending', 'failed']) {
    const html = render({ status, message: 'Edited memo', edited: true });
    assert.ok(html.includes(`data-status="${status}"`));
    assert.ok(html.includes(`data-txid="${TXID}"`));
    assert.ok(text(html).includes('edited'));
    assert.equal(text(html).includes('Payment failed'), status === 'failed');
  }
  assert.ok(render({ my: false, edited: true, edited_timestamp: 20 }, 10).includes('edited-new-dot'));
  assert.ok(!render({ my: false, edited: true, edited_timestamp: 20 }, 30).includes('edited-new-dot'));
  assert.ok(!render({ my: true, edited: true, edited_timestamp: 20 }, 10).includes('edited-new-dot'));
});
