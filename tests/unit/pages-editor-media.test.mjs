import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeURL } from '../../public/pages/document-v3.js';
import { mediaAccept, mediaKind } from '../../public/pages/editor-media.js';

test('YouTube input is parsed as an HTTPS identity, never stored as HTML or a raw URL', () => {
  for (const url of ['https://youtu.be/dQw4w9WgXcQ?si=tracking', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/embed/dQw4w9WgXcQ']) {
    assert.deepEqual(parseYouTubeURL(url), { provider: 'youtube', video_id: 'dQw4w9WgXcQ' });
  }
  for (const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', '<iframe src="https://www.youtube.com"></iframe>', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://user@youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com:444/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ/extra', 'https://youtube.com/redirect?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa', 'https://youtube.com/watch?v=short', 'https://youtube.com/watch?v=dQw4w9WgXcQ%0A']) assert.equal(parseYouTubeURL(url), null, url);
});

test('named pickers and client MIME checks agree; extensions never override MIME', () => {
  assert.equal(mediaAccept('audio'), 'audio/mpeg,.mp3');
  assert.equal(mediaAccept('video'), 'video/mp4,.mp4');
  assert.equal(mediaAccept('image'), 'image/jpeg,image/png,image/webp,image/gif');
  assert.equal(mediaKind({ type: 'audio/mpeg', size: 100 }, 'audio'), 'audio');
  assert.equal(mediaKind({ type: 'video/mp4', size: 100 }, 'audio'), null);
  assert.equal(mediaKind({ type: 'text/html', name: 'fake.mp3', size: 100 }, 'audio'), null);
  assert.equal(mediaKind({ type: 'image/gif', size: 100 }, 'image'), 'gif');
  assert.equal(mediaKind({ type: 'video/mp4', size: 26 * 1024 * 1024 }, 'video'), null);
});
