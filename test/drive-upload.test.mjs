import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_MIME_TYPE,
  buildMultipartRelatedBody,
  driveUploadUrl,
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

test('buildMultipartRelatedBody terminates the body with a CRLF and the end boundary', () => {
  const { contentType, body } = buildMultipartRelatedBody(
    { name: 'zz-upload-probe.txt' },
    { mimeType: 'text/plain', data: new TextEncoder().encode('upload capability probe') },
    'TEST-BOUNDARY'
  );
  const text = Buffer.from(body).toString('utf8');

  assert.equal(contentType, 'multipart/related; boundary=TEST-BOUNDARY');
  // The regression: googleapis' stream assembly dropped this, and Drive replied
  // "Missing end boundary in multipart body".
  assert.ok(text.endsWith('\r\n--TEST-BOUNDARY--'), 'body must end with CRLF + end boundary');
  assert.equal(text.match(/--TEST-BOUNDARY--/g).length, 1);
});

test('buildMultipartRelatedBody lays out both parts in Drive\'s documented order', () => {
  const { body } = buildMultipartRelatedBody(
    { name: 'report.pdf', parents: ['folder-1'] },
    { mimeType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4') },
    'B'
  );
  assert.equal(
    Buffer.from(body).toString('utf8'),
    '--B\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      '{"name":"report.pdf","parents":["folder-1"]}\r\n' +
      '--B\r\n' +
      'Content-Type: application/pdf\r\n\r\n' +
      '%PDF-1.4\r\n' +
      '--B--'
  );
});

test('buildMultipartRelatedBody preserves binary bytes verbatim', () => {
  // Bytes that are not valid UTF-8; a string-concatenated body would mangle these.
  const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a]);
  const { body } = buildMultipartRelatedBody(
    { name: 'tiny.png' },
    { mimeType: 'image/png', data },
    'B'
  );
  const head = Buffer.from(
    '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"tiny.png"}\r\n--B\r\nContent-Type: image/png\r\n\r\n'
  );
  const roundTripped = Buffer.from(body).subarray(head.length, head.length + data.length);
  assert.deepEqual(new Uint8Array(roundTripped), data);
  assert.equal(body.length, head.length + data.length + Buffer.from('\r\n--B--').length);
});

test('buildMultipartRelatedBody generates a unique boundary when none is given', () => {
  const meta = { name: 'a.txt' };
  const media = { mimeType: 'text/plain', data: new TextEncoder().encode('a') };
  const first = buildMultipartRelatedBody(meta, media);
  const second = buildMultipartRelatedBody(meta, media);
  assert.notEqual(first.boundary, second.boundary);
  assert.match(first.contentType, /^multipart\/related; boundary=[0-9a-f-]{36}$/);
});

test('driveUploadUrl targets the upload endpoint with shared-drive support', () => {
  for (const uploadType of ['multipart', 'resumable']) {
    const url = new URL(driveUploadUrl(uploadType, 'id,name'));
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/upload/drive/v3/files');
    assert.equal(url.searchParams.get('uploadType'), uploadType);
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(url.searchParams.get('fields'), 'id,name');
  }
});
