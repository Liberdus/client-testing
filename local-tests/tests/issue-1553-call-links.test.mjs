import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');

class CallLinkHarness {
  constructor({ deleting = false, scheduled = false, anchor = true, row = true } = {}) {
    this.prevented = 0;
    this.stopped = 0;
    this.opened = [];
    this.toasts = [];
    this.gates = 0;
    const message = {};
    const phoneAnchor = { href: 'https://meet.example.test/room?call=synthetic', closest: selector => {
      assert.equal(selector, '.message');
      return row ? message : null;
    } };
    this.event = {
      target: { closest: selector => {
        assert.equal(selector, '.call-message-phone-button');
        return anchor ? phoneAnchor : null;
      } },
      preventDefault: () => this.prevented++,
      stopPropagation: () => this.stopped++,
    };
    const owner = {
      messagesList: { addEventListener: (name, handler) => {
        assert.equal(name, 'click');
        assert.equal(this.handler, undefined);
        this.handler = handler;
      } },
      isMessageInDeleteForAllGuard: element => {
        assert.equal(element, message);
        return deleting;
      },
      gateScheduledCall: element => {
        assert.equal(element, message);
        this.gates++;
        return scheduled;
      },
    };
    const comment = source.indexOf('// Intercept clicks on call icon to gate future calls');
    const start = source.indexOf("this.messagesList.addEventListener('click', (e) => {", comment);
    const end = source.indexOf('// Close all context menus when messages container scrolls', start);
    assert.ok(comment >= 0 && start > comment && end > start, 'Missing production call-link listener');
    vm.runInNewContext('(function () {\n' + source.slice(start, end) + '\n}).call(owner)', {
      owner,
      window: { open: (...args) => this.opened.push(args) },
      showToast: (...args) => this.toasts.push(args),
    });
  }

  click() {
    return this.handler(this.event);
  }
}

test('an eligible call link prevents default navigation and opens the full URL once in a new tab', () => {
  const h = new CallLinkHarness();
  h.click();
  assert.equal(h.prevented, 1);
  assert.deepEqual(h.opened, [['https://meet.example.test/room?call=synthetic', '_blank']]);
  assert.equal(h.gates, 1);
  assert.deepEqual(h.toasts, []);
});

test('a non-call click is ignored without opening or suppressing it', () => {
  const h = new CallLinkHarness({ anchor: false });
  h.click();
  assert.deepEqual(h.opened, []);
  assert.equal(h.prevented, 0);
  assert.equal(h.gates, 0);
});

test('a call anchor without a message row is ignored', () => {
  const h = new CallLinkHarness({ row: false });
  h.click();
  assert.deepEqual(h.opened, []);
  assert.equal(h.prevented, 0);
  assert.equal(h.gates, 0);
});

test('a call being deleted remains blocked before the scheduled-call gate', () => {
  const h = new CallLinkHarness({ deleting: true });
  h.click();
  assert.equal(h.prevented, 1);
  assert.equal(h.stopped, 1);
  assert.deepEqual(h.opened, []);
  assert.equal(h.gates, 0);
  assert.deepEqual(h.toasts, [['This call is being deleted.', 2000, 'warning']]);
});

test('a scheduled call refused by the existing gate remains blocked', () => {
  const h = new CallLinkHarness({ scheduled: true });
  h.click();
  assert.equal(h.prevented, 1);
  assert.equal(h.stopped, 1);
  assert.deepEqual(h.opened, []);
  assert.equal(h.gates, 1);
  assert.deepEqual(h.toasts, []);
});
