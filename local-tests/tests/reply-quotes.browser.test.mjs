import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { ReplyQuoteFixture } from '../fixtures/reply-quotes.mjs';

class ReplyQuoteBrowserFixture {
  constructor() {
    this.quote = new ReplyQuoteFixture();
    this.externalRequests = [];
  }

  async start() {
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();
    await this.page.route('**/*', (route) => {
      if (route.request().url().startsWith(this.origin + '/')) return route.continue();
      this.externalRequests.push(route.request().url());
      return route.abort();
    });
  }

  async serve(request, response) {
    const pathname = new URL(request.url, this.origin).pathname;
    try {
      if (pathname === '/styles.css' || /^\/fonts\/[\w.-]+$/.test(pathname)) {
        const content = await readFile(new URL(`..${pathname}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return response.end(content);
      }
      const longPreview = 'A long original message '.repeat(20);
      const messages = [false, true].map(my => this.quote.render({ my, replyMessage: longPreview })).join('');
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="messages" style="width:100%;padding:16px;display:flex;flex-direction:column">${messages}</main></body></html>`);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  }

  async open(width) {
    await this.page.setViewportSize({ width, height: 900 });
    await this.page.goto(this.origin);
    await this.page.evaluate(({ binding }) => {
      window.jumpTargets = [];
      window.propagatedClicks = 0;
      document.addEventListener('click', () => { window.propagatedClicks++; });
      new Function(binding).call({
        messagesList: document.querySelector('#messages'),
        scrollToMessage: (txid) => window.jumpTargets.push(txid),
      });
    }, { binding: this.quote.clickBindingSource });
  }

  async close() {
    await this.browser?.close();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}

const fixture = new ReplyQuoteBrowserFixture();
before(() => fixture.start());
after(async () => {
  await fixture.close();
  assert.deepEqual(fixture.externalRequests, []);
});

for (const width of [320, 390, 1100]) {
  test(`reply quotes retain keyboard activation, visible focus and single-line previews at ${width}px`, async () => {
    await fixture.open(width);
    const quotes = fixture.page.locator('.reply-quote');
    assert.equal(await quotes.count(), 2);
    await fixture.page.keyboard.press('Tab');
    assert.equal(await quotes.first().evaluate(element => element === document.activeElement), true);
    assert.equal(await quotes.first().evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.press('Space');
    assert.deepEqual(await fixture.page.evaluate(() => window.jumpTargets), ['original', 'original']);
    assert.equal(await fixture.page.evaluate(() => window.propagatedClicks), 0);
    const geometry = await quotes.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      const preview = element.querySelector('.reply-quote-text');
      const style = getComputedStyle(preview);
      return {
        left: rect.left, right: rect.right,
        nowrap: style.whiteSpace, ellipsis: style.textOverflow,
        clipped: preview.scrollWidth > preview.clientWidth,
        background: getComputedStyle(element).backgroundColor,
      };
    }));
    assert.ok(geometry.every(box => box.left >= 0 && box.right <= width), JSON.stringify(geometry));
    assert.ok(geometry.every(box => box.nowrap === 'nowrap' && box.ellipsis === 'ellipsis' && box.clipped));
    assert.ok(geometry.every(box => box.background === 'rgba(0, 0, 0, 0)'));
  });
}
