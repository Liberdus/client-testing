import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Render the actual proposal modal, popup controls, validation and review classes.
// Only surrounding account/network/submission services are synthetic; no app startup,
// live signing, broadcast or Menu/DAO account navigation is claimed by this fixture.
class CommitteeBrowserFixture {
  static wallets = [
    '88888888abcdef012345678988888888abcdef01',
    'deadbeef0123456789abcdef0123456789abcdef',
    'fedcba98888888880123456789abcdef01234567',
    '0123456789abcdefabcdef0198765432abcd0000',
  ];

  static between(source, start, end) {
    const offset = source.indexOf(start);
    assert.notEqual(offset, -1, `Missing source entry point: ${start}`);
    const endOffset = source.indexOf(end, offset + start.length);
    assert.notEqual(endOffset, -1, `Missing source boundary: ${end}`);
    return source.slice(offset, endOffset);
  }

  async start() {
    this.root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const [app, markup] = await Promise.all(['app.js', 'index.html'].map(name => readFile(resolve(this.root, name), 'utf8')));
    const modalMarkup = CommitteeBrowserFixture.between(markup, '<div class="modal fixed-header" id="addProposalModal">', '<!-- Proposal Info Modal -->');
    const popupMarkup = CommitteeBrowserFixture.between(markup, '<div id="popupSelectListbox"', '<!-- Audio element');
    this.html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div class="container"><button id="openFixture" class="btn">Open proposal editor</button>${modalMarkup}</div>${popupMarkup}<div id="fixtureToast" class="sr-only" role="status"></div><script type="module" src="/fixture.js"></script></body></html>`;
    this.script = `
      import * as dao from '/dao.js';
      import * as lib from '/lib.js';
      Object.assign(globalThis, dao, lib);
      ${CommitteeBrowserFixture.between(app, 'function getPathValue(', 'const addProposalModal =')}
      ${CommitteeBrowserFixture.between(app, 'function formatDaoDurationSummary(', 'function renderDaoProjectMilestones(')}
      ${CommitteeBrowserFixture.between(app, 'function formatDaoDetailValue(', 'function parseDaoVoteSpendMultiple(')}
      ${CommitteeBrowserFixture.between(app, 'function formatDaoProposalTitle(', 'class DaoModal')}
      ${CommitteeBrowserFixture.between(app, 'class ConfirmProposalModal', 'const confirmProposalModal =')}
      ${CommitteeBrowserFixture.between(app, 'class PopupSelect', 'const FULL_IMAGE_CACHE_MAX_SIZE')}
      const NETWORK_ACCOUNT_ID = '0'.repeat(64);
      const myAccount = { keys: { address: 'f'.repeat(40) } };
      const network = { netid: 'synthetic' };
      const myData = { pending: [] };
      const daoModal = { isActive: () => false };
      const account = { current: { dao: {
        committeeAddresses: ${JSON.stringify(CommitteeBrowserFixture.wallets)}.map(address => address.padEnd(64, '0')),
        claimDuration: 60000, graceDuration: 60000, reviewDuration: 60000, votingDuration: 60000,
        proposalFeeUsdStr: '5', voteExponent: 1,
      } } };
      let configUnavailable = false;
      const queryNetwork = async () => configUnavailable ? null : { account: structuredClone(account) };
      const getTransactionTimestamp = () => 1700000000000;
      const enterFullscreen = () => {};
      const showToast = message => { document.getElementById('fixtureToast').textContent = message; };
      const hideToast = () => {};
      const hasPendingDaoProposalCreation = () => false;
      const captured = [];
      const daoRepo = { createProposal: async options => {
        captured.push(buildDaoProposalCreateTransaction({ ...options, proposalNumber: 7 }));
        return { ok: false, error: 'Synthetic submission failure' };
      } };
      const addProposalModal = new AddProposalModal();
      const confirmProposalModal = new ConfirmProposalModal();
      installModalTransitionListeners();
      PopupSelect.load();
      addProposalModal.load();
      confirmProposalModal.load();
      document.getElementById('openFixture').addEventListener('click', () => addProposalModal.open());
      globalThis.fixture = { addProposalModal, confirmProposalModal, account, captured,
        setUnavailable: value => { configUnavailable = value; } };
    `;
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((accept, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', accept);
    });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
  }

  async serve(request, response) {
    try {
      const pathname = new URL(request.url, 'http://fixture').pathname;
      if (pathname === '/' || pathname === '/fixture.js') {
        response.setHeader('Content-Type', pathname === '/' ? 'text/html' : 'text/javascript');
        response.end(pathname === '/' ? this.html : this.script);
        return;
      }
      const file = resolve(this.root, '.' + pathname);
      assert.ok(file.startsWith(this.root + sep));
      const content = await readFile(file);
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  }

  static async select(page, key) {
    const trigger = page.locator('[data-dao-change-key] + .popup-select__trigger').first();
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept))));
    await trigger.click();
    await page.getByRole('option', { name: key, exact: true }).click();
  }

  static async expectNoOverflow(page, selector) {
    assert.equal(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${selector} overflowed`);
  }

  static async expectWalletTextFits(group) {
    const widths = await group.locator('input').evaluateAll(inputs => inputs.map(input => {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      return {
        address: input.value,
        text: context.measureText(input.value).width + Math.max(0, input.value.length - 1) * spacing,
        available: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    }));
    for (const { address, text, available } of widths) {
      assert.equal(address.length, 40);
      assert.ok(text <= available + 1, `Wallet text needs ${text.toFixed(1)}px, but input has ${available.toFixed(1)}px`);
    }
    const lines = await group.locator('xpath=ancestor::*[@data-dao-change-row][1]').locator('.dao-committee-address-list [role="listitem"]').evaluateAll(items => items.map(item => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getClientRects().length;
    }));
    assert.deepEqual(lines, [1, 1, 1, 1], 'Current wallet addresses must each use one line');
  }

  static async expectRemoveIcons(page) {
    for (const button of await page.locator('#addProposalModal button.dao-form-remove-button:visible').all()) {
      const label = await button.getAttribute('aria-label');
      assert.match(label, /^Remove /);
      assert.equal(await button.getAttribute('title'), label);
      assert.equal((await button.textContent()).trim(), '');
      assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1);
      assert.equal(await button.getByRole('img').count(), 0);
    }
  }

  async verify(browser, viewport) {
    const { width } = viewport;
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10000);
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(this.origin)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      await page.goto(this.origin);
      await page.waitForFunction(() => Boolean(window.fixture));
      await page.getByRole('button', { name: 'Open proposal editor' }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'addProposalTitle');
      await page.waitForFunction(() => document.getElementById('addProposalModal').classList.contains('is-transition-complete'));
      await page.locator('#addProposalTitle').fill('Update committee members');
      await page.locator('#addProposalDescription').fill('A synthetic committee proposal.');
      await CommitteeBrowserFixture.select(page, 'Committee Addresses');
      const first = page.locator('[data-dao-committee-addresses]').first();
      const addresses = first.locator('input');
      const displayedCurrent = CommitteeBrowserFixture.wallets;
      assert.deepEqual(await addresses.evaluateAll(inputs => inputs.map(input => input.value)), displayedCurrent);
      assert.deepEqual(await page.locator('[data-dao-change-row]').first().locator('.dao-committee-address-list [role="listitem"]').allTextContents(), displayedCurrent);
      await page.evaluate(() => document.fonts.ready);
      await CommitteeBrowserFixture.expectWalletTextFits(first);
      await CommitteeBrowserFixture.expectRemoveIcons(page);
      assert.equal(await page.locator('[data-dao-remove-option]').isDisabled(), true);
      assert.equal(await page.locator('[data-dao-remove-change]').isDisabled(), true);
      await first.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.locator('[data-dao-change-row]').first().screenshot({ path: `/tmp/committee-addresses-${width}-prefilled-row.png` });
      await page.screenshot({ path: `/tmp/committee-addresses-${width}-prefilled-viewport.png` });
      await addresses.nth(0).fill(' 0X' + 'E'.repeat(40) + ' ');
      await page.locator('#addProposalOptionButton').click();
      assert.equal(await page.locator('[data-dao-committee-addresses]').nth(1).locator('input').first().inputValue(), displayedCurrent[0]);
      assert.equal(await addresses.first().inputValue(), ' 0X' + 'E'.repeat(40) + ' ');
      assert.equal(await page.evaluate(() => fixture.account.current.dao.committeeAddresses[0]), displayedCurrent[0].padEnd(64, '0'));

      await CommitteeBrowserFixture.expectRemoveIcons(page);
      const removeOptionLabel = await page.locator('[data-dao-remove-option="1"]').getAttribute('aria-label');
      await page.getByRole('button', { name: removeOptionLabel, exact: true }).click();
      assert.equal(await page.locator('[data-dao-option]').count(), 1);
      assert.equal(await page.locator('[data-dao-remove-option]').isDisabled(), true);
      assert.equal(await addresses.first().inputValue(), ' 0X' + 'E'.repeat(40) + ' ');
      await page.locator('#addProposalOptionButton').click();

      await first.getByRole('button', { name: 'Remove committee address 4', exact: true }).click();
      assert.equal(await addresses.count(), 3);
      assert.match(await first.locator('[data-dao-committee-error]').textContent(), /4.*10/);
      await page.locator('#addProposalSubmitButton').click();
      assert.equal(await page.locator('#confirmProposalModal').evaluate(element => element.classList.contains('active')), false);
      await first.getByRole('button', { name: 'Add address', exact: true }).click();
      assert.equal(await addresses.nth(3).evaluate(element => document.activeElement === element), true);
      await addresses.nth(3).fill('0x' + 'E'.repeat(40));
      assert.match(await first.locator('[data-dao-committee-error]').textContent(), /duplicate/);
      await addresses.nth(3).fill('z'.repeat(40));
      assert.match(await first.locator('[data-dao-committee-error]').textContent(), /hexadecimal/);
      await addresses.nth(3).fill('f'.repeat(64));
      assert.equal(await first.locator('[data-dao-committee-error]').isVisible(), false);

      for (let index = 4; index < 10; index++) {
        await first.getByRole('button', { name: 'Add address', exact: true }).click();
        await addresses.nth(index).fill(index.toString(16).repeat(64));
      }
      assert.equal(await addresses.count(), 10);
      assert.equal(await first.getByRole('button', { name: 'Add address', exact: true }).isDisabled(), true);
      for (let index = 9; index >= 0; index--) await first.getByRole('button', { name: `Remove committee address ${index + 1}`, exact: true }).click();
      assert.equal(await addresses.count(), 0);
      assert.equal(await first.getByRole('button', { name: 'Add address', exact: true }).evaluate(element => document.activeElement === element), true);
      assert.match(await first.locator('[data-dao-committee-error]').textContent(), /4.*10/);
      const proposed = [' 0x' + 'A'.repeat(40) + ' ', '0X' + 'B'.repeat(40), 'c'.repeat(64), 'd'.repeat(36) + '0000'];
      for (let index = 0; index < proposed.length; index++) {
        await first.getByRole('button', { name: 'Add address', exact: true }).click();
        await addresses.nth(index).fill(proposed[index]);
      }
      await page.locator('[data-dao-add-parameter-change]').click();
      await CommitteeBrowserFixture.expectRemoveIcons(page);
      const removeChangeLabel = await page.locator('[data-dao-remove-change="0:1"]').getAttribute('aria-label');
      await page.getByRole('button', { name: removeChangeLabel, exact: true }).click();
      assert.equal(await page.locator('[data-dao-option="0"] [data-dao-change-row]').count(), 1);
      assert.equal(await page.locator('[data-dao-option="1"] [data-dao-change-row]').count(), 1);
      assert.equal(await page.locator('[data-dao-remove-change]').isDisabled(), true);
      assert.deepEqual(await addresses.evaluateAll(inputs => inputs.map(input => input.value)), proposed);
      await page.locator('[data-dao-add-parameter-change]').click();
      await page.locator('[data-dao-option="0"] input[data-dao-change-index="1"]').fill('120000');
      await page.locator('[data-dao-option="1"] input[data-dao-change-index="1"]').fill('180000');
      await first.scrollIntoViewIfNeeded();
      await CommitteeBrowserFixture.expectNoOverflow(page, '#addProposalModal .modal-content');
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.screenshot({ path: `/tmp/committee-addresses-${width}-editor.png` });
      await page.locator('#addProposalSubmitButton').click();
      await page.locator('#confirmProposalModal.active.is-transition-complete').waitFor();
      const lists = page.locator('#confirmProposalContent .dao-committee-address-list');
      assert.equal(await lists.count(), 4);
      const canonical = proposed.map(value => value.trim().replace(/^0x/i, '').toLowerCase().padEnd(64, '0'));
      assert.deepEqual(await lists.nth(0).locator('[role="listitem"]').allTextContents(), displayedCurrent);
      assert.deepEqual(await lists.nth(1).locator('[role="listitem"]').allTextContents(), [
        'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64), 'd'.repeat(36) + '0000',
      ]);
      assert.doesNotMatch(await lists.allTextContents().then(values => values.join('')), /0x|[A-F]|\[|\]/);
      await CommitteeBrowserFixture.expectNoOverflow(page, '#confirmProposalModal .modal-content');
      const noChange = await page.locator('#confirmProposalContent .proposal-option-section--no-change').boundingBox();
      assert.ok(noChange.height < 200, 'No change must not stretch to the committee list height');
      await page.locator('#confirmProposalContent .proposal-change-row').first().scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.screenshot({ path: `/tmp/committee-addresses-${width}-review.png` });
      await page.locator('#backConfirmProposal').click();
      assert.deepEqual(await addresses.evaluateAll(inputs => inputs.map(input => input.value)), proposed);
      await page.locator('#addProposalSubmitButton').click();
      await page.locator('#confirmProposalModal.active.is-transition-complete').waitFor();
      await page.locator('#signConfirmProposal').click();
      await page.waitForFunction(() => fixture.captured.length === 1);
      assert.deepEqual(await page.evaluate(() => JSON.parse(fixture.captured[0].governance.changes[0][0].value)), canonical);
      assert.deepEqual(await page.evaluate(() => JSON.parse(fixture.captured[0].governance.changes[0][0].current)), displayedCurrent.map(address => address.padEnd(64, '0')));
      assert.deepEqual(await page.evaluate(() => fixture.captured[0].governance.changes.map(changes => changes[1])), [
        { key: 'claimDuration', current: '60000', value: '120000' },
        { key: 'claimDuration', current: '60000', value: '180000' },
      ]);
      assert.equal(await page.locator('#confirmProposalModal').evaluate(element => element.classList.contains('active')), true);
      await page.locator('#signConfirmProposal').click();
      await page.waitForFunction(() => fixture.captured.length === 2);
      assert.deepEqual(await page.evaluate(() => fixture.captured[0]), await page.evaluate(() => fixture.captured[1]));
      await page.locator('#backConfirmProposal').click();
      assert.deepEqual(await addresses.evaluateAll(inputs => inputs.map(input => input.value)), proposed);
      await page.locator('#cancelAddProposal').click();

      // Reopen with no network config: the supported form must remain recoverable.
      await page.evaluate(() => fixture.setUnavailable(true));
      await page.getByRole('button', { name: 'Open proposal editor' }).click();
      await page.locator('#addProposalModal.active.is-transition-complete').waitFor();
      await page.getByText('Current DAO config values are unavailable. Try again when the network responds.', { exact: true }).waitFor();
      assert.equal(await page.locator('#addProposalOptionButton').isDisabled(), true);
      await page.locator('#cancelAddProposal').click();
      await page.evaluate(() => fixture.setUnavailable(false));
      await page.getByRole('button', { name: 'Open proposal editor' }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'addProposalTitle');
      await page.waitForFunction(() => document.getElementById('addProposalModal').classList.contains('is-transition-complete'));
      await page.locator('#addProposalTitle').fill('Numeric regression');
      await page.locator('#addProposalDescription').fill('Claim duration remains editable.');
      await page.locator('[data-dao-change-value]').fill('120000');
      await page.locator('#addProposalSubmitButton').click();
      await page.locator('#confirmProposalModal.active.is-transition-complete').waitFor();
      assert.equal(await page.evaluate(() => fixture.confirmProposalModal.currentDraft.transaction.governance.changes[0][0].value), '120000');
      await page.locator('#backConfirmProposal').click();
      const typeTrigger = page.locator('#addProposalType + .popup-select__trigger');
      await typeTrigger.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept))));
      await typeTrigger.click();
      await page.getByRole('option', { name: 'Project', exact: true }).click();
      await CommitteeBrowserFixture.expectRemoveIcons(page);
      assert.equal(await page.getByRole('button', { name: 'Remove milestone 1', exact: true }).isDisabled(), true);
      await page.locator('#addProposalProjectAddMilestone').click();
      await CommitteeBrowserFixture.expectRemoveIcons(page);
      await page.getByRole('button', { name: 'Remove milestone 2', exact: true }).click();
      assert.equal(await page.locator('[data-dao-remove-milestone]').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Remove milestone 1', exact: true }).isDisabled(), true);
      await CommitteeBrowserFixture.expectNoOverflow(page, '#addProposalModal .modal-content');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`PASS committee editor/review controls at ${width}px`);
    } finally {
      if (errors.length) console.error('Page errors:', errors);
      await page.screenshot({ path: `/tmp/committee-addresses-${width}-last.png` });
      await page.close();
    }
  }
}

const fixture = new CommitteeBrowserFixture();
await fixture.start();
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 391, height: 751 }, { width: 1100, height: 900 }, { width: 390, height: 900 }, { width: 320, height: 900 }]) await fixture.verify(browser, viewport);
} finally {
  await browser.close();
  await new Promise(accept => fixture.server.close(accept));
}
