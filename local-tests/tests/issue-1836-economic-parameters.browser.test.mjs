import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// Offline, opt-in browser fixture. Uses the companion repository's installed Playwright.
// WEB_CLIENT_ROOT=/absolute/client node local-tests/tests/issue-1836-economic-parameters.browser.test.mjs
// PLAYWRIGHT_MODULE may point to another existing playwright/index.mjs installation.
const clientRoot = process.env.WEB_CLIENT_ROOT;
assert.ok(clientRoot && path.isAbsolute(clientRoot), 'Set WEB_CLIENT_ROOT to the absolute client checkout');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  || new URL('../../playwright-tests/node_modules/playwright/index.mjs', import.meta.url));
const [appSource, markup] = await Promise.all(['app.js', 'index.html'].map(name => readFile(path.join(clientRoot, name), 'utf8')));
const screenshotRoot = path.join(tmpdir(), 'issue-1836-economic-browser');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production source boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}

const modalMarkup = between(markup, '<div class="modal fixed-header" id="addProposalModal">', '<!-- Proposal Info Modal -->');
const fixtureMarkup = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div class="container">${modalMarkup}</div><script type="module" src="/fixture.js"></script></body></html>`;
const expectedValues = {
  archiver: { minVersion: 'old-release', activeVersion: '12345678901234567890.2.3-beta+build', latestVersion: 'release-next' },
  maintenanceFee: '123456789012345678901234567890123456789012345678901234567890',
  goldenTicketServerUrl: 'https://tickets.example.test/path?version=1.2.3',
  activeVersion: '12345678901234567890.2.3-beta+build',
};
const proposalTitle = 'Synthetic economic update';
const proposalDescription = 'Describe this proposal <without changing network metadata>.';
const fixtureScript = `
  import * as dao from '/dao.js';
  import * as lib from '/lib.js';
  Object.assign(globalThis, dao, lib);
  const PopupSelect = { hide() {}, enhanceAll() {} };
  const myAccount = { keys: { address: 'a'.repeat(40) } };
  const confirmed = [];
  const confirmProposalModal = { open: draft => confirmed.push(draft) };
  const showToast = message => { throw new Error('Unexpected toast: ' + message); };
  const getTransactionTimestamp = () => 1700000000000;
  globalThis.fetch = () => { throw new Error('Network services are forbidden in this fixture'); };
  ${between(appSource, 'function getPathValue(', 'const addProposalModal')}
  const account = { current: {
    archiver: { minVersion: '1.0.0', activeVersion: '1.1.0', latestVersion: '1.2.0' },
    maintenanceFee: 90071992547409931234567890n,
    title: 'Current network title', description: 'Current network description',
    goldenTicketServerUrl: 'http://tickets.example.test', activeVersion: '1.1.0',
  } };
  const modal = new AddProposalModal();
  modal.resetConfigCache();
  for (const [field, id] of Object.entries({
    modal: 'addProposalModal', form: 'addProposalForm', optionsList: 'addProposalOptionsList',
    typeSelect: 'addProposalType', emergencySelect: 'addProposalEmergency', titleInput: 'addProposalTitle',
    descriptionInput: 'addProposalDescription', proposalFeeInput: 'addProposalFee',
  })) modal[field] = document.getElementById(id);
  modal.typeSelect.value = 'economic';
  modal.emergencySelect.value = 'false';
  modal.fetchConfigSource = async () => account;
  modal.configOptionsByType.economic = await modal.fetchConfigOptions('economic');
  modal.options = [{ changes: ${JSON.stringify(Object.keys(expectedValues))}.map(key => modal.createChange(key)) }];
  modal.optionsList.addEventListener('input', event => modal.handleOptionsInput(event));
  modal.optionsList.addEventListener('change', event => modal.handleOptionsChange(event));
  modal.renderOptions();
  modal.modal.classList.add('active');
  modal.titleInput.value = 'Synthetic economic update';
  modal.descriptionInput.value = 'Exercise the new parameter controls.';
  modal.proposalFeeInput.value = '5 USD';
  modal.proposalFeeUsdStr = '5';
  modal.gracePeriodMs = 0;
  modal.maxGracePeriodMs = 60000;
  modal.reviewStartTimeMs = 0;
  modal.showValidationError = error => { throw error; };
  globalThis.fixture = { modal, account, confirmed };
`;

let browser;
const origin = 'http://economic-parameters.fixture';
before(async () => {
  await mkdir(screenshotRoot, { recursive: true });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

for (const width of [390, 1280]) {
  test(`economic controls are usable and serialize DOM edits at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const pageErrors = [];
    const blockedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        blockedRequests.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/' || url.pathname === '/fixture.js') {
        return route.fulfill({
          contentType: url.pathname === '/' ? 'text/html' : 'text/javascript',
          body: url.pathname === '/' ? fixtureMarkup : fixtureScript,
        });
      }
      const file = path.resolve(clientRoot, '.' + url.pathname);
      assert.ok(file.startsWith(clientRoot + path.sep), 'Read only client fixture dependencies');
      try {
        return route.fulfill({
          contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream',
          body: await readFile(file),
        });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
    try {
      await page.goto(origin);
      await page.waitForFunction(() => Boolean(globalThis.fixture));
      await page.waitForFunction(() => Math.abs(
        fixture.modal.modal.getBoundingClientRect().left - document.querySelector('.container').getBoundingClientRect().left,
      ) < 0.5);
      const selectableKeys = await page.locator('[data-dao-change-key] option').evaluateAll(options => options.map(option => option.value));
      for (const key of ['title', 'description']) {
        assert.ok(!selectableKeys.includes(key), `Network ${key} must not be a parameter choice`);
      }
      await page.locator('#addProposalTitle').fill(proposalTitle);
      await page.locator('#addProposalDescription').fill(proposalDescription);
      const proposed = index => page.locator(`#addProposalOption1Proposed${index + 1}`);
      const currentArchiver = page.locator('#addProposalOption1Current1 input');
      assert.equal(await currentArchiver.count(), 3);
      for (const input of await currentArchiver.all()) assert.equal(await input.getAttribute('readonly'), '');
      for (const [field, value] of Object.entries(expectedValues.archiver)) {
        await proposed(0).locator(`[data-dao-archiver-field="${field}"]`).fill(value);
      }
      for (const [index, key] of Object.keys(expectedValues).entries()) {
        if (key !== 'archiver') await proposed(index).fill(expectedValues[key]);
      }
      assert.equal(await proposed(1).getAttribute('type'), 'text');
      assert.equal(await proposed(2).getAttribute('type'), 'url');
      assert.equal(await proposed(3).getAttribute('type'), 'text');

      const geometry = await page.evaluate(() => {
        const modal = fixture.modal.modal;
        return {
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          modalWidth: modal.clientWidth, modalScrollWidth: modal.scrollWidth,
          controls: [...fixture.modal.optionsList.querySelectorAll('input, select, textarea')].map(element => {
            const rect = element.getBoundingClientRect();
            return { id: element.id, left: rect.left, right: rect.right, width: rect.width };
          }),
        };
      });
      assert.ok(geometry.documentWidth <= width + 1, JSON.stringify(geometry));
      assert.ok(geometry.modalScrollWidth <= geometry.modalWidth + 1, JSON.stringify(geometry));
      for (const control of geometry.controls) {
        assert.ok(control.width >= 80, `Control too narrow: ${JSON.stringify(control)}`);
        assert.ok(control.left >= -1 && control.right <= width + 1, `Control overflows: ${JSON.stringify(control)}`);
      }
      await proposed(0).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshotRoot, `economic-${width}-archiver.png`) });
      await proposed(1).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshotRoot, `economic-${width}-maintenance.png`) });

      const result = await page.evaluate(async () => {
        const { modal, account, confirmed } = fixture;
        const validated = modal.getValidatedOptions();
        await modal.handleCreate();
        const transaction = buildDaoProposalCreateTransaction({
          draft: confirmed.at(-1), timestamp: 1700000000000, networkId: 'synthetic', proposalNumber: 1,
          maxGracePeriodMs: 60000,
          proposalDurations: { reviewDuration: 60000, votingDuration: 60000, claimDuration: 60000 },
        });
        return {
          draftChanges: confirmed.at(-1).transaction.economic.changes,
          transactionChanges: transaction.economic.changes, changes: validated.changes[0],
          draftTitle: confirmed.at(-1).transaction.title, draftDescription: confirmed.at(-1).transaction.description,
          transactionTitle: transaction.title, transactionDescription: transaction.description,
          currentArchiver: account.current.archiver,
        };
      });
      assert.equal(result.changes.length, Object.keys(expectedValues).length);
      for (const change of result.changes) {
        assert.equal(typeof change.value, 'string');
        assert.equal(typeof change.current, 'string');
        if (change.key === 'archiver') {
          assert.deepEqual(JSON.parse(change.value), expectedValues.archiver);
          assert.deepEqual(JSON.parse(change.current), result.currentArchiver);
        } else assert.equal(change.value, expectedValues[change.key]);
      }
      assert.deepEqual(result.draftChanges, [result.changes]);
      assert.deepEqual(result.transactionChanges, [result.changes]);
      assert.equal(result.draftTitle, proposalTitle);
      assert.equal(result.transactionTitle, proposalTitle);
      assert.equal(result.draftDescription, proposalDescription);
      assert.equal(result.transactionDescription, proposalDescription);
      assert.deepEqual(result.currentArchiver, { minVersion: '1.0.0', activeVersion: '1.1.0', latestVersion: '1.2.0' });
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(blockedRequests, []);
    } finally {
      await page.close();
    }
  });
}
