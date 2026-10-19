import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('media and file attachments render with distinct presentation hooks', () => {
  assert.match(appSource, /class="attachment-row \$\{isMedia \? 'attachment-row--media' : 'attachment-row--file'\}"/);
  assert.match(appSource, /message \$\{messageClass}\$\{hasMediaAttachment \? ' has-media-attachment' : ''}/);
  assert.match(appSource, /isMedia \? '<div class="attachment-preview-hint">Click for options<\/div>' : ''/);
  assert.match(appSource, /isMedia \? '' : `\s*<div class="attachment-details">/);
  assert.doesNotMatch(appSource, /<div class="attachment-row" style=/);
  assert.doesNotMatch(appSource, /<div class="attachment-icon-container" style=/);
});

test('media placeholders and decoded thumbnails occupy the bubble width', () => {
  assert.match(styles, /\.message\.has-media-attachment\s*{[^}]*width:\s*300px/s);
  assert.match(styles, /\.attachment-row--media\s*{[^}]*margin:\s*0 -1rem 8px[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.attachment-row--media \.attachment-icon\s*{[^}]*width:\s*100%[^}]*height:\s*96px[^}]*background-size:\s*48px/s);
  assert.match(styles, /\.message\.sent \.attachment-row--media \.attachment-icon\s*{[^}]*filter:\s*brightness\(0\) invert\(1\)/s);
  assert.doesNotMatch(styles.match(/\.attachment-row--media \.attachment-icon-container\s*{[^}]*}/s)?.[0] || '', /background/);
  assert.match(styles, /\.attachment-row--media \.attachment-thumbnail\s*{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*height:\s*auto/s);
});

test('ordinary files retain readable metadata', () => {
  assert.match(styles, /\.attachment-row--file\s*{[^}]*align-items:\s*center[^}]*padding:\s*9px 11px/s);
  assert.match(styles, /\.attachment-details\s*{[^}]*min-width:\s*0[^}]*flex:\s*1/s);
  assert.match(styles, /\.attachment-label\s*{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
});

test('thumbnail replacement provides useful alt text and releases stale URLs', async () => {
  const methodStart = appSource.indexOf('\n  async updateThumbnailInPlace(');
  const methodEnd = appSource.indexOf('\n  /**', methodStart + 1);
  const methodSource = appSource.slice(methodStart, methodEnd);
  const revokedUrls = [];
  const urlApi = {
    createObjectURL: () => 'blob:new-thumbnail',
    revokeObjectURL: url => revokedUrls.push(url),
  };
  class MockImage {
    async decode() {}
  }
  const Harness = new Function('URL', 'Image', `return class Harness {${methodSource}\n}`)(urlApi, MockImage);
  let replacement;
  const iconContainer = {
    isConnected: true,
    parentNode: {},
    replaceChildren: child => { replacement = child; },
  };
  const attachmentRow = {
    dataset: {
      name: encodeURIComponent('summer photo.jpg'),
      thumbnailUrl: 'blob:old-thumbnail',
    },
    isConnected: true,
    parentNode: {},
    querySelector: () => iconContainer,
  };

  const didUpdate = await new Harness().updateThumbnailInPlace(attachmentRow, new Blob(['image']));

  assert.equal(didUpdate, true);
  assert.equal(replacement.alt, 'Preview of summer photo.jpg');
  assert.equal(replacement.src, 'blob:new-thumbnail');
  assert.equal(attachmentRow.dataset.thumbnailUrl, 'blob:new-thumbnail');
  assert.deepEqual(revokedUrls, ['blob:old-thumbnail']);
});

test('delayed thumbnail work cannot update a removed row', async () => {
  const methodStart = appSource.indexOf('\n  async updateThumbnailInPlace(');
  const methodEnd = appSource.indexOf('\n  /**', methodStart + 1);
  const methodSource = appSource.slice(methodStart, methodEnd);
  const revokedUrls = [];
  let attachmentRow;
  const urlApi = {
    createObjectURL: () => 'blob:removed-thumbnail',
    revokeObjectURL: url => revokedUrls.push(url),
  };
  class MockImage {
    async decode() {
      attachmentRow.isConnected = false;
    }
  }
  const Harness = new Function('URL', 'Image', `return class Harness {${methodSource}\n}`)(urlApi, MockImage);
  const iconContainer = {
    isConnected: true,
    parentNode: {},
    replaceChildren: () => assert.fail('removed row must not be updated'),
  };
  attachmentRow = {
    dataset: { name: encodeURIComponent('removed.jpg') },
    isConnected: true,
    parentNode: {},
    querySelector: () => iconContainer,
  };

  const didUpdate = await new Harness().updateThumbnailInPlace(attachmentRow, new Blob(['image']));

  assert.equal(didUpdate, false);
  assert.deepEqual(revokedUrls, ['blob:removed-thumbnail']);
});
