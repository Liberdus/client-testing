import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyQuoteFixture } from '../fixtures/reply-quotes.mjs';

test('reply quotes render as native non-submit buttons with the original message identity', () => {
  const html = new ReplyQuoteFixture().render();
  assert.match(html, /<button type="button" class="reply-quote reply-owner-contact" data-reply-txid="original">/);
  assert.match(html, /<span class="reply-quote-label reply-owner-contact">Alice<\/span>/);
  assert.match(html, /<span class="reply-quote-text">The original message<\/span>/);
  assert.doesNotMatch(html, /<div class="reply-quote(?: |")/);
});

test('quote labels interpret the original owner from the current viewer perspective', () => {
  const fixture = new ReplyQuoteFixture();
  for (const [my, replyOwnerIsMine, owner] of [
    [true, true, 'You'], [false, true, 'Alice'],
    [true, false, 'Alice'], [false, false, 'You'],
    [true, '1', 'You'], [false, '1', 'Alice'],
  ]) {
    const html = fixture.render({ my, replyOwnerIsMine });
    assert.match(html, new RegExp(`class="reply-quote-label [^"]+">${owner}</span>`));
  }
});

test('quotes without an owner hint use the loaded target and retain sensible fallbacks', () => {
  const fixture = new ReplyQuoteFixture();
  fixture.contact.messages = [{ txid: 'original', my: true }];
  assert.match(fixture.render(), /class="reply-quote-label reply-owner-me">You<\/span>/);
  fixture.contact.messages = [];
  fixture.contact.name = '';
  const html = fixture.render({ replyMessage: '' });
  assert.match(html, /class="reply-quote-label reply-owner-contact">Contact<\/span>/);
  assert.match(html, /class="reply-quote-text">View original message<\/span>/);
});

test('quote previews and owner labels render markup as text', () => {
  const fixture = new ReplyQuoteFixture();
  fixture.contact.name = '<b>Alice</b>';
  const html = fixture.render({ replyMessage: '<img src=x onerror=alert(1)>' });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;Alice&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img|<b>/);
});

test('ordinary messages without a reply do not acquire a quote button', () => {
  const html = new ReplyQuoteFixture().render({ replyId: '' });
  assert.doesNotMatch(html, /reply-quote|data-reply-txid/);
  assert.match(html, /A reply/);
});
