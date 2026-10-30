// Standalone offline regression; main does not yet include the local-tests runner.
// WEB_CLIENT_ROOT=/absolute/client PLAYWRIGHT_ROOT=/absolute/client-testing/playwright-tests \
//   MEDIA_PREVIEW_BROWSER=/opt/google/chrome/chrome node local-tests/tests/issue-1858-immersive-media.browser.test.mjs
// Requires ffmpeg/libx264 and the repository's pinned Playwright dependencies.
// Use an H264-capable browser; bundled Chromium can omit that decoder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT || ''), 'Set WEB_CLIENT_ROOT to the absolute implementation checkout');
const root = resolve(process.env.WEB_CLIENT_ROOT);
const companion = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(process.env.PLAYWRIGHT_ROOT || resolve(companion, 'playwright-tests'), 'package.json'));
const { chromium } = require('playwright');
const app = await readFile(resolve(root, 'app.js'), 'utf8');
const start = app.indexOf('\nclass FullImageModal {');
const end = app.indexOf('\nconst fullImageModal = new FullImageModal();', start);
assert.ok(start >= 0 && end > start, 'Extract the production media modal class');
const source = app.slice(start, end);
const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const temporary = await mkdtemp(resolve(tmpdir(), 'issue-1858-browser-'));
const captures = resolve(process.env.MEDIA_PREVIEW_CAPTURES || resolve(tmpdir(), 'issue-1858-browser-captures'));
await mkdir(captures, { recursive: true });
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let browser, server;

class MediaChecks {
  constructor(page, scenario) {
    this.page = page;
    this.scenario = scenario;
    this.modal = page.locator('#fullImageModal');
    this.header = this.modal.locator('.modal-header');
    this.viewer = page.locator('#fullImageViewer');
    this.image = page.locator('#fullImageViewerImage');
    this.video = page.locator('#fullImageViewerVideo');
  }

  async openImage(shape = 'portrait') {
    await this.page.evaluate(async shape => {
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = shape === 'portrait' ? [720, 1280] : [1280, 720];
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#155a89'; drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = '#fff'; drawing.font = '36px sans-serif'; drawing.fillText(`Synthetic ${shape}`, 48, 100);
      const blob = await new Promise(done => canvas.toBlob(done, 'image/png'));
      const id = __modal.openLoading(`Synthetic ${shape}.png`);
      __modal.showImage(blob, id);
    }, shape);
    await this.image.waitFor({ state: 'visible' });
    await this.modal.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  }

  async assertCanvas(shape) {
    const boxes = await this.page.evaluate(() => {
      const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
      const image = document.getElementById('fullImageViewerImage');
      return { modal: rect('fullImageModal'), viewer: rect('fullImageViewer'), image: rect('fullImageViewerImage'),
        ratio: image.naturalWidth / image.naturalHeight, documentWidth: document.documentElement.scrollWidth, width: innerWidth };
    });
    for (const dimension of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(boxes.modal[dimension] - boxes.viewer[dimension]) <= 1,
        `${this.scenario.name}: ${dimension} fills the modal behind the header: ${JSON.stringify(boxes)}`);
    }
    assert.ok(boxes.documentWidth <= boxes.width, 'No page horizontal overflow');
    assert.ok(Math.abs(boxes.image.width / boxes.image.height - boxes.ratio) < .01, `${shape}: preserve image aspect ratio`);
    assert.ok(boxes.image.left >= boxes.viewer.left - 1 && boxes.image.right <= boxes.viewer.right + 1
      && boxes.image.top >= boxes.viewer.top - 1 && boxes.image.bottom <= boxes.viewer.bottom + 1, `${shape}: contain the entire image`);
    assert.ok(Math.abs((boxes.image.left + boxes.image.right) - (boxes.viewer.left + boxes.viewer.right)) <= 2
      && Math.abs((boxes.image.top + boxes.image.bottom) - (boxes.viewer.top + boxes.viewer.bottom)) <= 2, 'Center media in the whole canvas');
  }

  async visible(reason) {
    assert.equal(await this.modal.evaluate(element => element.classList.contains('is-chrome-hidden')), false, reason);
  }

  async idle() {
    await this.page.mouse.move(1, 1);
    await this.page.waitForFunction(() => document.getElementById('fullImageModal').classList.contains('is-chrome-hidden'), null, { timeout: 4500 });
    await this.page.waitForTimeout(250);
    assert.equal(await this.header.evaluate(element => getComputedStyle(element).opacity), '0');
    assert.equal(await this.header.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  }

  async close() {
    // Chrome's native timeline owns its keyboard events; return focus to page chrome.
    await this.page.locator('#closeFullImageModal').focus();
    await this.page.keyboard.press('Escape');
    assert.equal(await this.modal.evaluate(element => element.classList.contains('active')), false);
    assert.deepEqual(await this.page.evaluate(() => ({ timer: __modal.chromeHideTimer, urls: __urls.size })), { timer: null, urls: 0 }, 'Closing clears idle timer and object URLs');
  }

  async thorough() {
    // Loading and failures keep an available close action beyond the idle deadline.
    await this.page.evaluate(() => { window.__request = __modal.openLoading('Still loading.png'); });
    await this.page.waitForTimeout(3250);
    await this.visible('Loading keeps chrome visible');
    await this.page.evaluate(() => __modal.showError('Synthetic unavailable media.', __request));
    await this.page.waitForTimeout(3250);
    await this.visible('Error keeps chrome visible');
    assert.match(await this.page.locator('#fullImageError').textContent(), /Save/);

    await this.openImage();
    await this.page.mouse.move(1, 1);
    await this.page.locator('#closeFullImageModal').focus();
    await this.page.keyboard.press('Tab');
    await this.page.waitForTimeout(3250);
    await this.visible('Keyboard focus keeps chrome visible');
    await this.page.evaluate(() => document.activeElement?.blur());
    await this.page.locator('#fullImageZoomIn').tap();
    assert.match(await this.image.evaluate(image => image.style.transform), /scale\(1\.5\)/);
    await this.page.waitForTimeout(3500);
    assert.equal(await this.modal.evaluate(element => element.classList.contains('is-chrome-hidden')), true, 'A coarse-device zoom tap must not leave sticky hover chrome');
    await this.viewer.tap();
    // Actual touch listeners must keep a held zoom gesture visible.
    await this.page.mouse.move(1, 1);
    await this.image.evaluate(image => {
      const touches = [new Touch({ identifier: 1, target: image, clientX: 100, clientY: 240 }),
        new Touch({ identifier: 2, target: image, clientX: 180, clientY: 240 })];
      image.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches }));
    });
    await this.page.waitForTimeout(3250);
    await this.visible('Held pinch gesture keeps chrome visible');
    await this.image.evaluate(image => image.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })));
    await this.idle();
    await this.viewer.tap();
    await this.visible('Tap restores chrome');
    await this.idle();
    await this.page.keyboard.press('ArrowRight');
    await this.visible('Keyboard restores chrome');

    for (const shape of ['portrait', 'landscape']) {
      await this.page.evaluate(async shape => {
        const id = __modal.openLoading(`Synthetic ${shape}.mp4`, 'video');
        __modal.showVideo(await (await fetch(`/${shape}.mp4`)).blob(), id);
      }, shape);
      await this.page.waitForFunction(() => document.getElementById('fullImageViewerVideo').readyState >= 2);
      assert.equal(await this.video.evaluate(video => getComputedStyle(video).objectFit), 'contain');
      assert.equal(await this.page.locator('#fullImageZoomControls').isVisible(), false);
      const box = await this.video.boundingBox();
      await this.video.click({ position: { x: 24, y: box.height - 48 } });
      await this.page.waitForFunction(() => document.getElementById('fullImageViewerVideo').currentTime > .1);
      await this.idle();
      assert.equal(await this.video.evaluate(video => !video.paused && video.currentTime > 2.5), true, 'Native timeupdate does not continually reveal chrome');
      const idleTime = await this.video.evaluate(video => video.currentTime);
      await this.page.waitForTimeout(1250);
      assert.equal(await this.header.evaluate(header => getComputedStyle(header).opacity), '0', 'Native controls auto-blur must not restore an idle header');
      assert.ok(await this.video.evaluate(video => video.currentTime) > idleTime + .5, 'Playback continues throughout the headerless hold');
      await this.video.click({ position: { x: box.width * .6, y: box.height - 22 } });
      await this.page.waitForFunction(() => document.getElementById('fullImageViewerVideo').currentTime > 8);
      await this.visible('Native seeking reveals chrome');
    }
    await this.close();
    assert.equal(await this.video.evaluate(video => video.paused && !video.getAttribute('src')), true);
  }
}

try {
  for (const [shape, size] of [['portrait', '360x640'], ['landscape', '640x360']]) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`, '-t', '18',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-y', resolve(temporary, `${shape}.mp4`)], { timeout: 30000 });
  }
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
      if (['/portrait.mp4', '/landscape.mp4'].includes(path)) return response.writeHead(200, { 'Content-Type': 'video/mp4' }).end(await readFile(resolve(temporary, path.slice(1))));
      const file = resolve(root, '.' + decodeURIComponent(path));
      assert.ok(file.startsWith(root + sep));
      const data = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.MEDIA_PREVIEW_BROWSER ? { executablePath: process.env.MEDIA_PREVIEW_BROWSER } : {}) });
  const scenarios = [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'tablet', width: 736, height: 1000 },
    { name: 'mobile', width: 390, height: 844, thorough: true }, { name: 'narrow-reduced', width: 320, height: 720, reducedMotion: 'reduce' }];
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.width < 500, hasTouch: scenario.width < 500, reducedMotion: scenario.reducedMotion || 'no-preference', serviceWorkers: 'block' });
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || route.request().url().startsWith('blob:')) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.addScriptTag({ content: `
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const openModal = modal => { modal.classList.add('active'); return true; };
      ${source}
      window.__modal = new FullImageModal(); __modal.load();
      document.getElementById('bootSplash').remove();
      window.__urls = new Set();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); __urls.add(url); return url; };
      URL.revokeObjectURL = url => { __urls.delete(url); revoke(url); };
    ` });
    const checks = new MediaChecks(page, scenario);
    for (const shape of ['portrait', 'landscape']) {
      await checks.openImage(shape);
      await checks.assertCanvas(shape);
    }
    await page.screenshot({ path: resolve(captures, `${scenario.name}-visible.png`) });
    if (scenario.name === 'desktop') {
      await page.locator('#closeFullImageModal').hover();
      await page.waitForTimeout(3250);
      await checks.visible('Header hover keeps the close action visible');
      await page.locator('#fullImageZoomControls').hover();
      await page.waitForTimeout(3250);
      await checks.visible('Zoom hover keeps chrome visible');
    }
    const before = await checks.image.boundingBox();
    await checks.idle();
    assert.deepEqual(await checks.image.boundingBox(), before, 'Auto-hide does not shift media geometry');
    await checks.viewer.hover();
    await checks.visible('Pointer movement reveals chrome');
    if (scenario.reducedMotion) assert.equal(await checks.header.evaluate(header => getComputedStyle(header).transitionDuration), '0s', 'Respect reduced motion');
    if (scenario.thorough) await checks.thorough();
    else await checks.close();
    assert.deepEqual(external, [], 'No external service requests');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    await context.close();
    console.log(`PASS ${scenario.name}: full canvas, portrait/landscape contain, idle/reveal and cleanup${scenario.thorough ? ', loading/error/hover/focus/zoom/tap/keyboard/native video' : ''}`);
  }
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(done => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
