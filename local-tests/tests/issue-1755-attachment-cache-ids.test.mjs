import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const thumbnailSource = appSource.slice(
  appSource.indexOf('\nclass ThumbnailCache'),
  appSource.indexOf('\nconst thumbnailCache = new ThumbnailCache();'),
);
const ThumbnailCache = new Function(`${thumbnailSource}\nreturn ThumbnailCache;`)();

test('attachment identity ignores the storage origin, query and fragment', () => {
  for (const value of [
    'photo-id',
    'https://old.example/get/photo-id',
    'http://new.example:8080/get/photo-id/?download=1#preview',
    'https://user:password@files.example/get/photo-id?token=two',
  ]) {
    assert.equal(ThumbnailCache.getAttachmentId(value), 'photo-id', value);
  }
});

test('attachment IDs retain their exact spelling and cannot collide by filename', () => {
  for (const id of ['photo-a', 'photo-b', 'Photo-A', 'a%2Fb', '__proto__']) {
    assert.equal(ThumbnailCache.getAttachmentId(`https://files.example/get/${id}`), id);
    assert.equal(ThumbnailCache.getAttachmentId(id), id);
  }
});

test('unsupported URLs cannot become a broad cache alias', () => {
  for (const value of [
    undefined, null, 1, {}, '', ' ', 'photo id', '/get/photo-id',
    'https://files.example/get/', 'https://files.example/get',
    'https://files.example/get/a/b', 'https://files.example/avatar/photo-id',
    'ftp://files.example/get/photo-id', 'file:///get/photo-id',
    'data:image/png;base64,AAAA', 'blob:https://files.example/id',
  ]) {
    assert.throws(() => ThumbnailCache.getAttachmentId(value), String(value));
  }
});
