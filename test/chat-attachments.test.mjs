import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  cachedUploadsMatch,
  downloadFilename,
  loadChatUploadState,
  MAX_CHAT_UPLOAD_BYTES,
  messageFingerprint,
  prepareChatUpload,
  resolveAttachmentDownloadSource,
  resolveDriveExport,
  saveChatUploadState,
  saveDownloadStream,
} from '../dist/chat-attachments.js';

async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('prepareChatUpload validates and fingerprints path and base64 sources', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-chat-upload-'));
  const file = path.join(directory, 'hello.txt');
  fs.writeFileSync(file, 'hello');
  try {
    const fromPath = await prepareChatUpload({ filename: '../hello.txt', path: file });
    assert.equal(fromPath.filename, 'hello.txt');
    assert.equal(fromPath.mimeType, 'text/plain');
    assert.equal(fromPath.size, 5);
    assert.equal(fromPath.sha256, createHash('sha256').update('hello').digest('hex'));
    assert.equal((await collect(fromPath.openBody())).toString(), 'hello');

    const fromBase64 = await prepareChatUpload({
      filename: 'hello.bin',
      contentBase64: Buffer.from('hello').toString('base64'),
      mimeType: 'application/x-test',
    });
    assert.equal(fromBase64.mimeType, 'application/x-test');
    assert.equal(fromBase64.sha256, fromPath.sha256);
    assert.equal((await collect(fromBase64.openBody())).toString(), 'hello');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepareChatUpload rejects invalid sources and files over the Chat limit', async () => {
  await assert.rejects(
    prepareChatUpload({ filename: 'x.txt', contentBase64: 'not base64!' }),
    /valid.*base64/i
  );
  await assert.rejects(
    prepareChatUpload({ filename: 'x.txt' }),
    /exactly one of path or contentBase64/
  );
  await assert.rejects(
    prepareChatUpload({ filename: 'x.txt', path: '/tmp/a', contentBase64: 'eA==' }),
    /exactly one of path or contentBase64/
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-chat-large-'));
  const file = path.join(directory, 'large.bin');
  try {
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_CHAT_UPLOAD_BYTES + 1);
    await assert.rejects(
      prepareChatUpload({ filename: 'large.bin', path: file }),
      /cannot exceed/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('attachment source and Drive export routing are explicit', () => {
  assert.equal(
    resolveAttachmentDownloadSource({
      resourceName: 'spaces/AAA/messages/BBB.BBB/attachments/CCC',
    }),
    'chat'
  );
  assert.equal(resolveAttachmentDownloadSource({ driveFileId: 'drive_file-123' }), 'drive');
  assert.throws(() => resolveAttachmentDownloadSource({}), /exactly one/);
  assert.throws(
    () => resolveAttachmentDownloadSource({ resourceName: 'wrong', driveFileId: 'drive' }),
    /exactly one/
  );

  assert.equal(resolveDriveExport('application/pdf'), undefined);
  assert.deepEqual(resolveDriveExport('application/vnd.google-apps.document'), {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  });
  assert.equal(
    downloadFilename(undefined, 'Proposal', resolveDriveExport('application/vnd.google-apps.document')),
    'Proposal.docx'
  );
  assert.throws(
    () => resolveDriveExport('application/pdf', 'application/pdf'),
    /only valid for Google Workspace/
  );
});

test('saveDownloadStream avoids overwrites, hashes bytes, and removes failed partials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-chat-download-'));
  try {
    fs.writeFileSync(path.join(directory, 'report.txt'), 'existing');
    const saved = await saveDownloadStream(Readable.from(Buffer.from('hello')), 'report.txt', {
      directory,
      maxBytes: 10,
    });
    assert.equal(path.basename(saved.path), 'report-1.txt');
    assert.equal(saved.bytes, 5);
    assert.equal(saved.sha256, createHash('sha256').update('hello').digest('hex'));
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(directory, 'report.txt'), 'utf8'), 'existing');

    await assert.rejects(
      saveDownloadStream(Readable.from(Buffer.from('too long')), 'oversize.txt', {
        directory,
        maxBytes: 3,
      }),
      /download limit/
    );
    assert.ok(!fs.readdirSync(directory).some((name) => name.endsWith('.part')));
    assert.ok(!fs.existsSync(path.join(directory, 'oversize.txt')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat upload retry state is payload-bound and survives process restarts', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-chat-state-'));
  const requestId = randomUUID();
  try {
    const upload = await prepareChatUpload({
      filename: 'note.txt',
      contentBase64: Buffer.from('note').toString('base64'),
    });
    const fingerprint = messageFingerprint({
      space: 'spaces/AAA',
      text: 'Attached',
      attachments: [upload],
    });
    const state = {
      version: 1,
      account: 'work',
      space: 'spaces/AAA',
      requestId,
      messageFingerprint: fingerprint,
      attachments: [
        {
          filename: upload.filename,
          mimeType: upload.mimeType,
          size: upload.size,
          sha256: upload.sha256,
          attachmentDataRef: { attachmentUploadToken: 'opaque-token' },
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    saveChatUploadState(baseDir, state);
    const reloaded = loadChatUploadState(baseDir, 'work', requestId);
    assert.deepEqual(reloaded, state);
    assert.equal(cachedUploadsMatch(reloaded, fingerprint, [upload]), true);
    assert.equal(cachedUploadsMatch(reloaded, `${fingerprint}changed`, [upload]), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
