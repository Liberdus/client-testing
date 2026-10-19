import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');

export class ReplyQuoteFixture {
  constructor() {
    const start = source.indexOf('\n  renderChatMessageHTML(');
    const end = source.indexOf('\n  buildChatMessageRangeHTML(', start);
    assert.ok(start >= 0 && end > start, 'production chat renderer is required');
    this.renderer = runInNewContext(`new (class {${source.slice(start, end)}})()`, {
      formatTime: () => '12:00',
      escapeHtml: (value) => this.escapeHtml(value),
      linkifyUrls: (value) => this.escapeHtml(value),
      isDeleted: () => false,
      getContactDisplayName: (contact) => contact.name,
    });
    this.contact = { name: 'Alice', messages: [] };

    const bindingStart = source.indexOf('    // Reply quote click delegation');
    const bindingEnd = source.indexOf('    // Voice message speed button event delegation', bindingStart);
    assert.ok(bindingStart >= 0 && bindingEnd > bindingStart, 'production quote click delegation is required');
    this.clickBindingSource = source.slice(bindingStart, bindingEnd);
  }

  escapeHtml(value) {
    // Model the renderer's HTML-text boundary without booting the browser-only helper.
    return String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
  }

  render(overrides = {}) {
    return this.renderer.renderChatMessageHTML({
      type: 'message',
      txid: 'reply',
      timestamp: 1_000,
      message: 'A reply',
      my: false,
      replyId: 'original',
      replyMessage: 'The original message',
      ...overrides,
    }, { contact: this.contact, lastReadTs: 0 });
  }
}
