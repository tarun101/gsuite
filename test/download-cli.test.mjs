import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadDriveFile } from '../dist/download-cli.js';

const content = new TextEncoder().encode('verified cloud bytes');
const sha256 = createHash('sha256').update(content).digest('hex');

function options(scope = `test-${randomUUID()}`) {
  return {
    url: 'https://gsuite-mcp.tarun-me.workers.dev/drive/download',
    ticket: '1'.repeat(64),
    fileId: '1Abcdefghijklmnopqrstuvwxyz',
    filename: '../../safe.pdf',
    mimeType: 'application/pdf',
    byteSize: content.length,
    headRevisionId: 'rev-123',
    sha256,
    taskScope: scope,
  };
}

function response(body = content, headerOverrides = {}) {
  const opts = options();
  return new Response(body, { headers: {
    'content-length': String(opts.byteSize),
    'content-type': opts.mimeType,
    'x-gsuite-file-id': opts.fileId,
    'x-gsuite-head-revision-id': opts.headRevisionId,
    'x-gsuite-sha256': opts.sha256,
    ...headerOverrides,
  } });
}

test('downloader verifies headers, size, and SHA-256 before atomically exposing a safe path', async () => {
  const opts = options();
  const result = await downloadDriveFile(opts, async (_url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${opts.ticket}`);
    assert.equal(init.redirect, 'error');
    return response();
  });
  try {
    assert.equal(result.filename, 'safe.pdf');
    assert.equal(result.sha256, sha256);
    assert.deepEqual(new Uint8Array(await fs.promises.readFile(result.path)), content);
    assert.equal((await fs.promises.stat(result.path)).mode & 0o777, 0o600);
  } finally {
    await fs.promises.rm(path.dirname(result.path), { recursive: true, force: true });
  }
});

test('integrity mismatch deletes the partial file and task-scoped directory', async () => {
  const scope = `mismatch-${randomUUID()}`;
  const opts = options(scope);
  const before = new Set((await fs.promises.readdir(os.tmpdir())).filter((name) => name.startsWith(`gsuite-drive-${scope}-`)));
  const wrong = new TextEncoder().encode('wrong bytes entirely!!');
  await assert.rejects(
    downloadDriveFile(opts, async () => response(wrong, { 'content-length': String(wrong.length) })),
    /content-length|SHA-256|byte size/,
  );
  const after = (await fs.promises.readdir(os.tmpdir())).filter((name) => name.startsWith(`gsuite-drive-${scope}-`) && !before.has(name));
  assert.deepEqual(after, []);
});

test('response metadata tampering is refused before a final file exists', async () => {
  const opts = options();
  await assert.rejects(
    downloadDriveFile(opts, async () => response(content, { 'x-gsuite-file-id': 'other-file' })),
    /x-gsuite-file-id did not match/,
  );
});

test('attacker-controlled download hosts are rejected before the ticket is sent', async () => {
  const opts = { ...options(), url: 'https://attacker.example/drive/download' };
  let fetched = false;
  await assert.rejects(
    downloadDriveFile(opts, async () => {
      fetched = true;
      return response();
    }),
    /pinned Routespring/,
  );
  assert.equal(fetched, false);
});
