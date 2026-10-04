const { test } = require('@playwright/test');

/** Owns diagnostics for one test attempt, including test-created contexts and popups. */
class TestDiagnostics {
  static attempts = new WeakMap();
  static contextOwners = new WeakMap();
  static identities = new WeakMap();

  static current() {
    const info = test.info();
    if (!this.attempts.has(info)) this.attempts.set(info, new TestDiagnostics(info));
    return this.attempts.get(info);
  }

  constructor(info) {
    this.info = info;
    this.started = Date.now();
    this.pages = new Map();
    this.contextListeners = new Map();
    this.requests = new Map();
    this.bodyReads = new Set();
    this.errors = [];
    this.captures = new Map();
    this.details = [];
  }

  observeContext(context) {
    const previous = TestDiagnostics.contextOwners.get(context);
    if (previous === this) return;
    if (previous) previous.detachContext(context);
    TestDiagnostics.contextOwners.set(context, this);
    const onPage = page => this.observePage(page);
    context.on('page', onPage);
    this.contextListeners.set(context, onPage);
    for (const page of context.pages()) this.observePage(page);
  }

  observePage(page) {
    if (this.pages.has(page)) return this.pages.get(page).identity;
    const identity = { page: this.pages.size + 1, ...TestDiagnostics.identities.get(page.context()) };
    const listeners = {
      console: message => {
        if (message.type() === 'error') this.errors.push({ ...identity, kind: 'console', text: TestDiagnostics.cleanText(message.text()), at: Date.now() });
      },
      pageerror: error => this.errors.push({ ...identity, kind: 'pageerror', text: TestDiagnostics.cleanText(error.message), at: Date.now() }),
      request: request => this.recordRequest(request, identity),
      response: response => {
        const read = this.recordResponse(response).catch(error => {
          this.errors.push({ ...identity, kind: 'diagnostic-error', text: TestDiagnostics.cleanText(error.message) });
        });
        this.bodyReads.add(read);
        void read.then(() => this.bodyReads.delete(read));
      },
      requestfailed: request => {
        const entry = this.requests.get(request);
        if (entry) Object.assign(entry, { outcome: 'transport-error', error: request.failure()?.errorText, finishedAt: Date.now() });
        else this.errors.push({ ...identity, kind: 'requestfailed', url: new URL(request.url()).origin + new URL(request.url()).pathname, error: request.failure()?.errorText });
      },
    };
    for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
    this.pages.set(page, { identity, listeners });
    return identity;
  }

  identify(page, identity) {
    this.observeContext(page.context());
    Object.assign(this.observePage(page), identity);
    TestDiagnostics.identities.set(page.context(), { ...TestDiagnostics.identities.get(page.context()), ...identity });
  }

  recordRequest(request, identity) {
    const url = new URL(request.url());
    if (!/\/(address|inject|transaction)(\/|$)/.test(url.pathname)) return;
    const entry = {
      ...identity, url: url.origin + url.pathname + (url.searchParams.has('appReceiptId') ? `?appReceiptId=${url.searchParams.get('appReceiptId')}` : ''),
      method: request.method(), startedAt: Date.now(), outcome: 'pending',
    };
    if (url.pathname.endsWith('/inject')) {
      try {
        const payload = request.postDataJSON();
        const tx = typeof payload.tx === 'string' ? JSON.parse(payload.tx) : payload.tx;
        // Keep only public registration identity, never signed payloads or message contents.
        entry.transaction = { type: tx.type };
        if (tx.type === 'register') Object.assign(entry.transaction, { username: tx.alias, address: tx.from, timestamp: tx.timestamp });
      } catch (error) {
        entry.requestBodyError = TestDiagnostics.cleanText(error.message);
      }
    }
    this.requests.set(request, entry);
  }

  async recordResponse(response) {
    const entry = this.requests.get(response.request());
    if (!entry) return;
    Object.assign(entry, {
      status: response.status(), outcome: response.ok() ? 'response' : 'http-error', respondedAt: Date.now(), bodyState: 'pending',
      headers: { date: response.headers().date, server: response.headers().server, etag: response.headers().etag },
    });
    try {
      const body = await TestDiagnostics.bounded(response.text(), 2_000);
      try { entry.body = TestDiagnostics.cleanValue(JSON.parse(body)); }
      catch { entry.body = TestDiagnostics.cleanText(body); }
      entry.finishedAt = Date.now();
      entry.bodyState = 'complete';
    } catch (error) {
      entry.bodyError = TestDiagnostics.cleanText(error.message);
      entry.bodyState = 'unavailable';
    }
  }

  static cleanText(text) {
    return String(text).replace(/\b(?:0x)?[a-f\d]{64,}\b/gi, '[redacted hex]').slice(0, 4_000);
  }

  static cleanValue(value) {
    if (Array.isArray(value)) return value.slice(0, 30).map(item => this.cleanValue(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        /secret|private.?key|seed|password|signature|pqpublic|encrypted|message|localstorage/i.test(key)
          ? '[redacted]' : this.cleanValue(item)]));
    }
    return typeof value === 'string' ? value.slice(0, 4_000) : value;
  }

  static async bounded(promise, timeout) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Diagnostic operation exceeded ${timeout}ms`)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  async capturePage(page, stage) {
    if (page.isClosed()) return;
    const identity = this.observePage(page);
    try {
      const state = await TestDiagnostics.bounded(page.evaluate(() => {
        const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
        const create = document.querySelector('#createAccountForm button[type="submit"]');
        const next = document.querySelector('#newChatForm button[type="submit"]');
        return {
          title: document.title,
          username: document.querySelector('.app-name')?.textContent,
          createModalVisible: visible(document.querySelector('#createAccountModal.active')),
          createDisabled: create?.disabled,
          toasts: [...document.querySelectorAll('.toast.show')].map(el => el.textContent),
          recipient: document.querySelector('#chatRecipient')?.value,
          recipientStatus: document.querySelector('#chatRecipientError')?.textContent,
          continueDisabled: next?.disabled,
        };
      }), 2_000);
      const screenshot = await page.screenshot({ timeout: 2_000 });
      this.captures.set(page, { identity, stage, url: page.url(), state: TestDiagnostics.cleanValue(state), screenshot });
    } catch (error) {
      this.errors.push({ ...identity, kind: 'diagnostic-error', stage, text: TestDiagnostics.cleanText(error.message) });
    }
  }

  async attach(name) {
    try {
      const { info } = this;
      // Each body read has a two-second deadline. Preserve headers-only responses
      // as explicitly unavailable instead of racing report serialization.
      await Promise.allSettled([...this.bodyReads]);
      await info.attach(name, {
        body: JSON.stringify({
          test: info.title, retry: info.retry, worker: info.workerIndex, browser: info.project.name,
          target: info.project.use.baseURL, startedAt: this.started,
          pages: [...this.pages.values()].map(value => value.identity), details: this.details,
          requests: [...this.requests.values()], errors: this.errors,
          captures: [...this.captures.values()].map(({ screenshot, ...capture }) => capture),
        }, null, 2), contentType: 'application/json',
      });
      for (const { identity, stage, screenshot } of this.captures.values()) {
        await info.attach(`${name}-page-${identity.page}-${stage}`, { body: screenshot, contentType: 'image/png' });
      }
    } catch (error) {
      // Evidence must never replace the application's/assertion's original error.
      console.error(`Could not attach diagnostics: ${TestDiagnostics.cleanText(error.message)}`);
    }
  }

  detachContext(context) {
    const listener = this.contextListeners.get(context);
    if (listener) context.off('page', listener);
    this.contextListeners.delete(context);
    for (const [page, { listeners }] of this.pages) {
      if (page.context() !== context) continue;
      for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
    }
  }

  async finish() {
    if (this.info.status !== this.info.expectedStatus) {
      await Promise.all([...this.pages.keys()].map(page => this.capturePage(page, 'failure')));
      await this.attach('failure-diagnostics');
    }
    for (const context of this.contextListeners.keys()) this.detachContext(context);
  }

  // Teardown errors are reported separately; an assertion/setup error stays primary.
  async close(resources, primaryError) {
    const results = await Promise.allSettled(resources.map(resource => TestDiagnostics.bounded(resource.close(), 5_000)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (!errors.length) return;
    this.errors.push(...errors.map(error => ({ kind: 'cleanup-error', text: TestDiagnostics.cleanText(error.message) })));
    await this.attach('cleanup-diagnostics');
    if (!primaryError && this.info.status === this.info.expectedStatus) throw errors[0];
  }
}

module.exports = { TestDiagnostics };
