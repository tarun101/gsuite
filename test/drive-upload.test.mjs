import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MIME_TYPE,
  mimeTypeForFilename,
  resolveUploadSource,
} from '../dist/drive-upload.js';

test('mimeTypeForFilename maps common extensions, case-insensitively', () => {
  assert.equal(mimeTypeForFilename('report.pdf'), 'application/pdf');
  assert.equal(mimeTypeForFilename('IMAGE.JPG'), 'image/jpeg');
  assert.equal(
    mimeTypeForFilename('data.xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.equal(mimeTypeForFilename('notes.md'), 'text/markdown');
});

test('mimeTypeForFilename falls back to octet-stream for unknown/extensionless names', () => {
  assert.equal(mimeTypeForFilename('mystery.qwerty'), DEFAULT_MIME_TYPE);
  assert.equal(mimeTypeForFilename('LICENSE'), DEFAULT_MIME_TYPE);
});

test('resolveUploadSource picks the provided source', () => {
  assert.equal(resolveUploadSource({ path: '/tmp/a.txt' }), 'path');
  assert.equal(resolveUploadSource({ content: 'aGk=' }), 'content');
});

test('resolveUploadSource rejects neither-or-both', () => {
  assert.throws(() => resolveUploadSource({}), /either "path".*or "content"/);
  assert.throws(
    () => resolveUploadSource({ path: '/tmp/a.txt', content: 'aGk=' }),
    /not both/
  );
});
