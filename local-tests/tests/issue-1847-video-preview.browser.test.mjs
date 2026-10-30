// Standalone offline browser check; no local-tests runner or account is required.
// WEB_CLIENT_ROOT=/absolute/client PLAYWRIGHT_ROOT=/absolute/client-testing/playwright-tests \
//   MEDIA_PREVIEW_BROWSER=/opt/google/chrome/chrome \
//   node local-tests/tests/issue-1847-video-preview.browser.test.mjs
// Requires ffmpeg with libx264/aac and libvpx/libvorbis. Omit MEDIA_PREVIEW_BROWSER
// to use bundled Chromium; raw decoder failures explicitly skip that format's playback.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.WEB_CLIENT_ROOT && isAbsolute(process.env.WEB_CLIENT_ROOT), 'Set WEB_CLIENT_ROOT to the absolute implementation checkout');
const root = resolve(process.env.WEB_CLIENT_ROOT);
const companion = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(process.env.PLAYWRIGHT_ROOT || resolve(companion, 'playwright-tests'), 'package.json'));
const { chromium } = require('playwright');
const app = await readFile(resolve(root, 'app.js'), 'utf8');
const start = app.indexOf('\nclass FullImageModal {');
const end = app.indexOf('\nconst fullImageModal = new FullImageModal();', start);
assert.ok(start >= 0 && end > start, 'Find the production media modal class');
const classSource = app.slice(start, end);
const chatStart = app.indexOf('\nclass ChatModal {');
const chatEnd = app.indexOf('\nconst chatModal = new ChatModal();', chatStart);
assert.ok(chatStart >= 0 && chatEnd > chatStart, 'Find the production chat modal class');
const chatClassSource = app.slice(chatStart, chatEnd);
const index = (await readFile(resolve(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const temporary = await mkdtemp(resolve(tmpdir(), 'issue-1847-browser-'));
const captures = resolve(process.env.MEDIA_PREVIEW_CAPTURES || resolve(tmpdir(), 'issue-1847-browser-captures'));
await mkdir(captures, { recursive: true });
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const videoMime = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const fixtures = new Map();
let browser;
let server;

try {
  // Native decoders receive real, deterministic media, including an audio track.
  for (const [name, videoCodec, audioCodec] of [
    ['clip.mp4', 'libx264', 'aac'], ['clip.webm', 'libvpx', 'libvorbis'], ['clip.mov', 'libx264', 'aac'],
  ]) {
    const target = resolve(temporary, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', videoCodec,
      '-pix_fmt', 'yuv420p', '-c:a', audioCodec, '-y', target], { timeout: 30000 });
    fixtures.set(`/${name}`, await readFile(target));
  }
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(index);
      if (fixtures.has(path)) return response.writeHead(200, { 'Content-Type': videoMime[extname(path).slice(1)] }).end(fixtures.get(path));
      const file = resolve(root, '.' + decodeURIComponent(path));
      assert.ok(file.startsWith(root + sep));
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.MEDIA_PREVIEW_BROWSER ? { executablePath: process.env.MEDIA_PREVIEW_BROWSER } : {}) });

  for (const viewport of [{ name: 'desktop', width: 1100, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.name === 'mobile', hasTouch: viewport.name === 'mobile', serviceWorkers: 'block' });
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || route.request().url().startsWith('blob:')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(async () => { window.__normalizeMimeType = (await import('/lib.js')).normalizeMimeType; });
    await page.addScriptTag({ content: `
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const openModal = modal => { modal.classList.add('active'); return true; };
      const normalizeMimeType = window.__normalizeMimeType;
      ${chatClassSource}
      ${classSource}
      window.__modal = new FullImageModal();
      window.__modal.load();
      window.__mediaErrors = [];
      document.querySelector('#fullImageViewerVideo').addEventListener('error', event => {
        __mediaErrors.push({ code: event.target.error?.code, message: event.target.error?.message });
      });
      document.querySelector('#bootSplash').remove();
      window.__urls = new Set();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); __urls.add(url); return url; };
      URL.revokeObjectURL = url => { __urls.delete(url); return revoke(url); };
    ` });
    const video = page.locator('#fullImageViewerVideo');
    assert.equal(await video.count(), 1, `${viewport.name}: production HTML contains native video`);
    assert.equal(await video.getAttribute('controls'), '', 'Use native playback controls');
    assert.equal(await video.getAttribute('playsinline'), '', 'Keep mobile playback inline');

    // Exercise production menu rendering with a synthetic message, without account setup.
    await page.evaluate(() => {
      const menu = document.querySelector('#imageAttachmentContextMenu');
      const chat = Object.create(ChatModal.prototype);
      chat.imageAttachmentContextMenu = menu;
      chat.imageAttachmentContextMenuReactions = menu.querySelector('.message-context-reactions');
      chat.closeAllContextMenus = () => { menu.style.display = 'none'; };
      chat.canDeleteMessageForAll = () => false;
      chat.getMessageRecordFromElement = () => ({ xattach: [{ url: '/clip.mov', type: 'video/quicktime' }] });
      for (const method of ['syncContextReactionTrayDisplay', 'syncReactionPickerActiveState', 'syncDeleteContextMenuDisabledState']) {
        chat[method] = () => {};
      }
      const message = document.createElement('div');
      message.className = 'message received';
      message.innerHTML = '<div class="message-content">Synthetic QuickTime</div><div class="attachment-row attachment-row--media" data-type="video/quicktime" data-name="Synthetic%20QuickTime.mov" data-url="/clip.mov">Synthetic QuickTime.mov</div>';
      document.querySelector('#chatModal .messages-list').append(message);
      document.querySelector('#chatModal').classList.add('active');
      window.__menuRow = message.querySelector('.attachment-row');
      window.__chat = chat;
    });
    await page.locator('#chatModal').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.evaluate(() => __chat.showAttachmentContextMenu(new MouseEvent('contextmenu', { cancelable: true }), __menuRow));
    const openOption = page.locator('#imageAttachmentContextMenu [data-action="open"]');
    const saveOption = page.locator('#imageAttachmentContextMenu [data-action="save"]');
    assert.equal(await openOption.isVisible(), true, 'QuickTime attachment menu exposes Open');
    assert.equal(await saveOption.isVisible(), true, 'QuickTime attachment menu retains Save');
    await page.locator('#imageAttachmentContextMenu').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const menuBox = await page.locator('#imageAttachmentContextMenu').boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= viewport.width && menuBox.y >= 0 && menuBox.y + menuBox.height <= viewport.height,
      'QuickTime attachment menu stays in the viewport');
    if (viewport.name === 'mobile') await page.screenshot({ path: resolve(captures, 'mobile-quicktime-menu.png') });
    await page.evaluate(() => {
      __menuRow.dataset.type = 'application/octet-stream';
      __chat.showAttachmentContextMenu(new MouseEvent('contextmenu', { cancelable: true }), __menuRow);
    });
    assert.equal(await openOption.isVisible(), false, 'MOV filename alone does not expose Open for an unsupported MIME');
    assert.equal(await saveOption.isVisible(), true, 'Unsupported attachments retain Save');
    await page.evaluate(() => {
      __chat.imageAttachmentContextMenu.style.display = 'none';
      document.querySelector('#chatModal').classList.remove('active');
    });

    const played = [];
    for (const format of ['mp4', 'webm', 'mov']) {
      // A separate raw <video> distinguishes host codec availability from app behavior.
      const decoder = await page.evaluate(async format => {
        const raw = document.createElement('video');
        const blob = await (await fetch(`/clip.${format}`)).blob();
        const url = URL.createObjectURL(blob);
        let timeout;
        try {
          return await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`Raw ${format} decoder did not settle`)), 5000);
            raw.onloadeddata = () => resolve({ supported: true, canPlayType: raw.canPlayType(blob.type), mime: blob.type });
            raw.onerror = () => resolve({ supported: false, canPlayType: raw.canPlayType(blob.type), mime: blob.type,
              code: raw.error?.code, message: raw.error?.message });
            raw.src = url;
            raw.load();
          });
        } finally {
          clearTimeout(timeout);
          raw.removeAttribute('src'); raw.load(); URL.revokeObjectURL(url);
        }
      }, format);
      assert.equal(decoder.mime, videoMime[format], 'Use the original container MIME for native playback');
      await page.evaluate(format => { window.__request = __modal.openLoading(`Synthetic ${format}`, 'video'); }, format);
      assert.equal(await page.locator('#fullImageLoading').isVisible(), true, 'Show loading before media fetch');
      assert.equal(await page.locator('#fullImageViewer').getAttribute('aria-busy'), 'true');
      await page.locator('#fullImageModal').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-loading.png`) });
      await page.evaluate(async format => {
        const blob = await (await fetch(`/clip.${format}`)).blob();
        __modal.showVideo(blob, __request);
      }, format);
      if (format === 'mov') console.log(`MOV ${viewport.name}: ${JSON.stringify(decoder)}`);
      if (!decoder.supported) {
        await page.locator('#fullImageError').waitFor({ state: 'visible' });
        assert.match(await page.locator('#fullImageError').textContent(), /save/i);
        assert.equal(await page.evaluate(() => __urls.size), 0, 'Unsupported decoder releases media URL');
        await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-unsupported.png`) });
        console.log(`SKIP ${viewport.name} ${format} playback: raw decoder failed (${JSON.stringify(decoder)}); app fallback PASS`);
        await page.locator('#closeFullImageModal').click();
        continue;
      }
      await page.waitForFunction(() => {
        const video = document.querySelector('#fullImageViewerVideo');
        return video.readyState >= 2 && !video.hidden && video.duration >= 3.9;
      }, null, { timeout: 10000 }).catch(async error => {
        console.error(format, await video.evaluate(element => ({ state: element.readyState, duration: element.duration,
          error: element.error?.message, canPlay: element.canPlayType('video/mp4'), hidden: element.hidden,
          h264: element.canPlayType('video/mp4; codecs="avc1.42E01E"'), errors: __mediaErrors,
          fallback: document.querySelector('#fullImageError').textContent })));
        await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-failure.png`) });
        throw error;
      });
      assert.equal(await page.locator('#fullImageZoomControls').isVisible(), false, 'Video hides image zoom controls');
      assert.equal(await page.locator('#fullImageViewerImage').isVisible(), false, 'Video hides the image element');
      assert.equal(await video.evaluate(element => element.paused), true, 'Video waits for user playback');
      await page.locator('#fullImageModal').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const box = await video.boundingBox();
      assert.ok(box.width > 100 && box.height > 100 && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
        `${viewport.name}: native player fits inside viewport: ${JSON.stringify(box)}`);
      // Click Chromium's native play control, rather than replacing its UI.
      await video.hover();
      await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-ready.png`) });
      await video.click({ position: { x: 24, y: box.height - 48 } });
      await page.waitForFunction(() => document.querySelector('#fullImageViewerVideo').currentTime > 0.1, null, { timeout: 5000 }).catch(async error => {
        console.error('Native control click', await video.evaluate(element => ({ paused: element.paused, time: element.currentTime,
          state: element.readyState, error: element.error?.message, rect: element.getBoundingClientRect().toJSON() })));
        await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-control-failure.png`) });
        throw error;
      });
      assert.equal(await video.evaluate(element => element.paused), false, 'Native play control starts playback');
      await page.screenshot({ path: resolve(captures, `${viewport.name}-${format}-playing.png`) });
      await video.evaluate(element => { element.pause(); element.currentTime = 2; element.volume = 0.4; });
      await page.waitForFunction(() => {
        const video = document.querySelector('#fullImageViewerVideo');
        return !video.seeking && Math.abs(video.currentTime - 2) < 0.2;
      });
      assert.equal(await video.evaluate(element => element.volume), 0.4, 'Native player volume is usable');
      // Viewer touch handlers must not consume native control gestures.
      assert.equal(await video.evaluate(element => element.dispatchEvent(new TouchEvent('touchmove', {
        bubbles: true, cancelable: true, touches: [new Touch({ identifier: 1, target: element, clientX: 30, clientY: 30 })],
      }))), true, 'Video touch gestures are not canceled by image zoom');
      await page.locator('#closeFullImageModal').click();
      assert.deepEqual(await video.evaluate(element => ({ paused: element.paused, source: element.getAttribute('src') })), { paused: true, source: null }, 'Closing pauses video and clears the source');
      assert.equal(await page.evaluate(() => __urls.size), 0, 'Closing revokes the media object URL');
      assert.equal(await page.locator('#fullImageModal').evaluate(element => element.classList.contains('active')), false);
      played.push(format);
    }
    assert.ok(played.length, 'At least one real media decoder must pass native playback');

    // Browser decoder errors keep the modal open with an actionable Save hint.
    await page.evaluate(() => {
      const id = __modal.openLoading('Broken video.mp4', 'video');
      __modal.showVideo(new Blob(['not video bytes'], { type: 'video/mp4' }), id);
    });
    await page.locator('#fullImageError').waitFor({ state: 'visible' });
    await page.screenshot({ path: resolve(captures, `${viewport.name}-unsupported.png`) });
    assert.match(await page.locator('#fullImageError').textContent(), /save/i);
    assert.equal(await page.locator('#fullImageModal').evaluate(element => element.classList.contains('active')), true);
    assert.equal(await page.evaluate(() => __urls.size), 0, 'Decoder failure releases its object URL');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#fullImageModal').evaluate(element => element.classList.contains('active')), false);

    // Image behavior remains interactive after switching back from a failed video.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 900;
      const drawing = canvas.getContext('2d'); drawing.fillStyle = '#123abc'; drawing.fillRect(0, 0, 1200, 900);
      const blob = await new Promise(done => canvas.toBlob(done, 'image/png'));
      const id = __modal.openLoading('Synthetic image.png');
      __modal.showImage(blob, id);
    });
    const image = page.locator('#fullImageViewerImage');
    await image.waitFor({ state: 'visible' });
    await page.locator('#fullImageZoomIn').click();
    await page.screenshot({ path: resolve(captures, `${viewport.name}-image-zoom.png`) });
    assert.match(await image.evaluate(element => element.style.transform), /scale\(1\.5\)/, 'Image zoom remains available');
    assert.equal(await video.isVisible(), false, 'Images hide video');
    await page.locator('#fullImageZoomOut').click();
    assert.equal(await image.evaluate(element => element.style.transform), '', 'Image zoom resets to fit');
    await page.locator('#closeFullImageModal').click();
    assert.equal(await page.evaluate(() => __urls.size), 0, 'Image close revokes its object URL');
    assert.deepEqual(external, [], 'No external service is contacted');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    await context.close();
    console.log(`PASS ${viewport.name}: QuickTime Open/Save menu, ${played.join('/')} native playback, seeking, volume, touch, cleanup, error fallback, image zoom; no external requests`);
  }
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(done => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
