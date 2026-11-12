import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Liberdus/web-client-v2#1895: on desktop the app frame is a fixed 800px tall, so a
// shorter window scrolls the page. Whatever part of the header is in view after
// scrolling must still belong to the header: the active screen may not paint over
// it and swallow clicks meant for its buttons. Modals, dialogs and toasts must
// keep covering the header.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
// Real markup and stylesheet without app scripts: this only depends on layout.
const fixture = index.replace(/<script\b[\s\S]*?<\/script>/g, '');
assert.ok(!/<script\b/.test(fixture) && fixture.includes('id="daoNotificationsBtn"'));

const mime = { '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const external = [];
const errors = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture);
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    assert.ok(path.startsWith(root + sep));
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const buttons = ['upcomingCallsBtn', 'daoNotificationsBtn', 'toggleSettings', 'toggleMenu'];
const screens = ['walletScreen', 'chatsScreen', 'contactsScreen'];

// Runs in the page: put the static markup into the signed-in layout.
function showSignedIn() {
  document.getElementById('bootSplash')?.remove();
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('header').classList.add('active');
  document.getElementById('footer').classList.add('active');
  document.getElementById('daoNotificationsBtn').hidden = false;
  document.getElementById('upcomingCallsBtn').style.display = '';
  window.headerClicks = {};
  for (const id of ['upcomingCallsBtn', 'daoNotificationsBtn', 'toggleSettings', 'toggleMenu']) {
    document.getElementById(id).addEventListener('click', () => { window.headerClicks[id] = (window.headerClicks[id] || 0) + 1; });
  }
  // Give the list screens rows, as a signed-in account with chats and contacts has.
  for (const id of ['chatList', 'contactsList']) {
    const list = document.getElementById(id);
    for (let i = 0; i < 12; i++) {
      const row = document.createElement('li');
      row.className = 'chat-item';
      row.innerHTML = '<div class="chat-avatar"></div><div class="chat-content"><div class="chat-header"><div class="chat-name">Synthetic row</div></div><div class="chat-message">Synthetic preview text</div></div>';
      list.append(row);
    }
  }
}

// Runs in the page: hit-test the part of a header button that is inside the window.
function probeButton(id) {
  const element = document.getElementById(id);
  const header = document.getElementById('header');
  const box = element.getBoundingClientRect();
  let visible = 0;
  let own = 0;
  const strangers = new Set();
  for (let x = box.left + 2; x < box.right - 1; x += 3) {
    for (let y = box.top + 2; y < box.bottom - 1; y += 3) {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      visible++;
      const target = document.elementFromPoint(x, y);
      if (target && element.contains(target)) own++;
      // The gap around a rounded button still belongs to the header; anything else is covering it.
      else if (!target || !header.contains(target)) strangers.add(target ? `${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}.${target.className}` : 'nothing');
    }
  }
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  return {
    width: box.width, height: box.height, visible, own, strangers: [...strangers], x, y,
    fullyVisible: box.top >= 0 && box.bottom <= window.innerHeight,
    centerVisible: y >= 1 && y < window.innerHeight - 1,
  };
}

// Runs in the page: which top-level layer owns each in-window sample point across the header box.
function headerOwners() {
  const box = document.getElementById('header').getBoundingClientRect();
  const owners = {};
  for (let x = box.left + 4; x < box.right - 3; x += 8) {
    for (let y = box.top + 4; y < box.bottom - 3; y += 6) {
      if (y < 0 || y >= window.innerHeight) continue;
      const target = document.elementFromPoint(x, y);
      const layer = target?.closest('.modal, #header, .toast, .app-screen');
      const name = layer ? (layer.id || layer.className) : 'other';
      owners[name] = (owners[name] || 0) + 1;
    }
  }
  return owners;
}

const scrollTo = async (page, y) => {
  await page.evaluate(top => window.scrollTo(0, top), y);
  await page.waitForFunction(top => Math.abs(window.scrollY - top) < 1, y);
};
const openModal = async (page, id) => {
  await page.evaluate(name => document.getElementById(name).classList.add('active'), id);
  await page.waitForFunction(name => {
    const modal = document.getElementById(name);
    return getComputedStyle(modal).opacity === '1' && Math.abs(modal.getBoundingClientRect().left - document.querySelector('.container').getBoundingClientRect().left) < 1;
  }, id);
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
  // A short desktop window (the page scrolls) and a phone (the frame fills the screen).
  for (const viewport of [{ width: 900, height: 520 }, { width: 390, height: 844 }]) {
    const label = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(showSignedIn);
    const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (viewport.width > 768) assert.ok(maxScroll > 100, `${label}: the short desktop window is expected to scroll (${maxScroll}px)`);
    // Small offsets keep the header at least partly in view however it is positioned.
    const offsets = [...new Set([0, 20, 40, 70, maxScroll].map(offset => Math.min(offset, maxScroll)))];
    let clicks = 0;

    for (const screen of screens) {
      await page.evaluate(active => {
        for (const element of document.querySelectorAll('.app-screen')) element.classList.toggle('active', element.id === active);
      }, screen);
      for (const offset of offsets) {
        await scrollTo(page, offset);
        const where = `${label} ${screen} scrolled ${offset}px`;
        const owners = await page.evaluate(headerOwners);
        assert.deepEqual(Object.keys(owners).filter(name => name !== 'header'), [], `${where}: the header in view is covered (${JSON.stringify(owners)})`);
        for (const id of buttons) {
          const probe = await page.evaluate(probeButton, id);
          assert.ok(probe.width > 0 && probe.height > 0, `${where} #${id} is laid out`);
          if (offset === 0) assert.ok(probe.fullyVisible, `${where} #${id} is fully in view before scrolling`);
          assert.deepEqual(probe.strangers, [], `${where} #${id} is covered by ${probe.strangers.join(', ')}`);
          if (probe.fullyVisible) assert.ok(probe.own >= probe.visible * 0.9, `${where} #${id} receives only ${probe.own} of ${probe.visible} sample clicks`);
          if (probe.centerVisible) {
            const before = await page.evaluate(name => window.headerClicks[name] || 0, id);
            await page.mouse.click(probe.x, probe.y);
            assert.equal(await page.evaluate(name => window.headerClicks[name] || 0, id), before + 1, `${where} #${id} receives a real click`);
            clicks++;
          }
        }
      }
    }
    // Every button is clicked on every screen at least before scrolling.
    assert.ok(clicks >= screens.length * buttons.length, `${label}: only ${clicks} real clicks were made`);

    // Full-screen modals come after the header in the DOM and must keep covering it.
    await scrollTo(page, 0);
    await openModal(page, 'menuModal');
    for (const offset of offsets) {
      await scrollTo(page, offset);
      const owners = await page.evaluate(headerOwners);
      assert.deepEqual(Object.keys(owners).filter(name => name !== 'menuModal'), [], `${label} scrolled ${offset}px: the open menu covers the header (${JSON.stringify(owners)})`);
    }
    // A second modal opened over the menu still stacks above it in DOM order.
    await scrollTo(page, 0);
    await openModal(page, 'daoModal');
    assert.deepEqual(Object.keys(await page.evaluate(headerOwners)), ['daoModal'], `${label}: a later modal covers both the menu and the header`);
    await page.evaluate(() => {
      for (const id of ['menuModal', 'daoModal']) document.getElementById(id).classList.remove('active');
    });

    // Centered dialogs dim the whole frame, header included.
    await page.evaluate(() => document.getElementById('failedTransactionModal').classList.add('active'));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('failedTransactionModal')).opacity === '1');
    assert.deepEqual(Object.keys(await page.evaluate(headerOwners)), ['failedTransactionModal'], `${label}: the dialog backdrop covers the header`);
    await page.evaluate(() => document.getElementById('failedTransactionModal').classList.remove('active'));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('failedTransactionModal')).visibility === 'hidden');

    // A sticky toast that overlaps the header stays on top of it.
    const overlap = await page.evaluate(() => {
      const toast = document.createElement('div');
      toast.className = 'toast error sticky show';
      toast.id = 'syntheticToast';
      toast.textContent = 'Synthetic sticky toast';
      const container = document.getElementById('toastContainer');
      container.append(toast);
      // Slide the toast container up over the header so the two really overlap.
      const header = document.getElementById('header').getBoundingClientRect();
      container.style.top = `${container.offsetTop + header.top - container.getBoundingClientRect().top}px`;
      const box = toast.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = Math.max(box.top, header.top) + 6;
      return { overlaps: box.top < header.bottom && box.bottom > header.top, owner: document.elementFromPoint(x, y)?.closest('.toast, #header')?.id };
    });
    assert.ok(overlap.overlaps, `${label}: the synthetic toast overlaps the header`);
    assert.equal(overlap.owner, 'syntheticToast', `${label}: the toast stays above the header`);

    await context.close();
    console.log(`PASS header never covered by a screen at scroll ${offsets.join('/')}px on ${screens.length} screens (${clicks} real clicks); modals, dialog and toast cover it at ${label}`);
  }
  assert.deepEqual(external, [], 'header overlap regression stays offline');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
