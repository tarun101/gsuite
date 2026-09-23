import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertInlineUploadSize, buildDriveBatchBody, driveMetadataFields,
  driveSearchQuery, MAX_INLINE_TEXT_BYTES, parseDriveBatchResponse,
  readBoundedText, textExportMimeType,
} from '../dist/drive-operations.js';
import { authorizedGoogleFetch, readDriveText } from '../dist/drive-read.js';

test('authenticated Drive fetch refuses redirects without forwarding the token', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token');
    return new Response(null, { status: 302, headers: { location: 'https://example.test/' } });
  };
  try {
    const ctx = { auth: { getAccessToken: async () => ({ token: 'test-token' }) } };
    await assert.rejects(authorizedGoogleFetch(ctx, 'https://www.googleapis.com/drive/v3/files/id'), /Google redirect refused/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('lean metadata is default and verbose preserves the prior field shape', () => {
  assert.equal(driveMetadataFields(), 'id,name,mimeType,modifiedTime,size,parents');
  assert.match(driveMetadataFields(true), /owners\(displayName,emailAddress,me\)/);
  assert.match(driveMetadataFields(true, undefined, true), /^nextPageToken,files\(/);
  assert.equal(driveMetadataFields(false, 'id,name', false), 'id,name');
  assert.equal(driveMetadataFields(false, 'files(id,name)', true), 'nextPageToken,files(id,name)');
});

test('search options escape quotes and retain a caller query', () => {
  assert.equal(
    driveSearchQuery({ query: "fullText contains 'Tarun'", nameContains: "O'Brien", parentId: 'folder-1' }),
    "(fullText contains 'Tarun') and 'folder-1' in parents and name contains 'O\\'Brien'",
  );
  assert.throws(() => driveSearchQuery({ modifiedAfter: 'yesterday' }), /RFC3339/);
});

test('inline text cap accepts 102400 bytes and rejects 102401 bytes', async () => {
  const body = (length) => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(length).fill(65)); controller.close(); } });
  assert.equal((await readBoundedText(body(MAX_INLINE_TEXT_BYTES), MAX_INLINE_TEXT_BYTES)).byteSize, MAX_INLINE_TEXT_BYTES);
  await assert.rejects(readBoundedText(body(MAX_INLINE_TEXT_BYTES + 1), MAX_INLINE_TEXT_BYTES), /102401 bytes.*drive_issue_download_ticket/);
  assert.doesNotThrow(() => assertInlineUploadSize(Buffer.alloc(MAX_INLINE_TEXT_BYTES).toString('base64'), MAX_INLINE_TEXT_BYTES));
  assert.throws(() => assertInlineUploadSize(Buffer.alloc(MAX_INLINE_TEXT_BYTES + 1).toString('base64'), MAX_INLINE_TEXT_BYTES + 1), /drive_issue_upload_ticket/);
});

test('Docs, Sheets and Slides select their supported text exports', () => {
  assert.equal(textExportMimeType('application/vnd.google-apps.document'), 'text/plain');
  assert.equal(textExportMimeType('application/vnd.google-apps.spreadsheet'), 'text/csv');
  assert.equal(textExportMimeType('application/vnd.google-apps.presentation'), 'text/plain');
});

test('drive_read_text exports a Google Doc as UTF-8 plain text', async () => {
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => { requested = String(url); return new Response('hello document'); };
  try {
    const ctx = {
      alias: 'personal', email: 'i@example.test',
      auth: { getAccessToken: async () => ({ token: 'test-token' }) },
      drive: { files: { get: async () => ({ data: { id: 'file-123', name: 'doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-23T00:00:00Z' } }) } },
    };
    const result = await readDriveText(ctx, 'file-123');
    assert.match(requested, /\/files\/file-123\/export\?mimeType=text%2Fplain/);
    assert.equal(result.content, 'hello document');
    assert.equal(result.mimeType, 'application/vnd.google-apps.document');
  } finally { globalThis.fetch = original; }
});

test('drive_read_text rejects blob content that disagrees with Drive SHA-256', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('wrong content');
  try {
    const ctx = {
      alias: 'personal', email: 'i@example.test',
      auth: { getAccessToken: async () => ({ token: 'test-token' }) },
      drive: { files: { get: async () => ({ data: { id: 'file-123', name: 'note.md', mimeType: 'text/markdown', size: '13', sha256Checksum: 'a'.repeat(64) } }) } },
    };
    await assert.rejects(readDriveText(ctx, 'file-123'), /SHA-256 mismatch/);
  } finally { globalThis.fetch = original; }
});

test('batch response preserves every ID including partial failure', () => {
  const ids = ['file-a', 'file-b'];
  const request = buildDriveBatchBody(ids, 'id,name');
  assert.match(request.body, /Content-ID: <file-0>/);
  const response = '--reply\r\nContent-Type: application/http\r\nContent-ID: <response-file-0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"file-a","name":"A"}\r\n' +
    '--reply\r\nContent-Type: application/http\r\nContent-ID: <response-file-1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"message":"missing"}}\r\n--reply--\r\n';
  assert.deepEqual(parseDriveBatchResponse(response, 'multipart/mixed; boundary=reply', ids), [
    { id: 'file-a', name: 'A' }, { id: 'file-b', error: 'missing' },
  ]);
});
