import assert from 'node:assert/strict';
import test from 'node:test';
import {
  driveRevisionDownloadUrl,
  handleDriveDownloadRequest,
} from '../dist/drive-download-endpoint.js';

const TICKET = '1'.repeat(64);
const SHA = 'a'.repeat(64);
const bytes = new TextEncoder().encode('hello world!');
const baseRecord = {
  transferId: 'transfer-1',
  operation: 'drive.download',
  requester: 'i@tarun.me',
  accountAlias: 'work',
  accountEmail: 'tarun@routespring.com',
  fileId: '1Abcdefghijklmnopqrstuvwxyz',
  filename: 'fixture.pdf',
  mimeType: 'application/pdf',
  byteSize: bytes.length,
  headRevisionId: 'rev-123',
  sha256: SHA,
  modifiedTime: '2026-09-11T00:00:00.000Z',
  issuedAt: 1_000,
  expiresAt: 91_000,
};
const metadata = (overrides = {}) => ({
  id: baseRecord.fileId,
  name: baseRecord.filename,
  mimeType: baseRecord.mimeType,
  size: String(baseRecord.byteSize),
  headRevisionId: baseRecord.headRevisionId,
  sha256Checksum: baseRecord.sha256,
  modifiedTime: baseRecord.modifiedTime,
  trashed: false,
  capabilities: { canDownload: true, canReadRevisions: true },
  downloadRestrictions: { effectiveDownloadRestrictionWithContext: {} },
  ...overrides,
});

function harness({ record = baseRecord, current = metadata(), upstream = new Response(bytes), expired = false } = {}) {
  let used = false;
  const audits = [];
  let fetchCount = 0;
  const dependencies = {
    now: () => 2_000,
    audit: (event) => audits.push(event),
    consume: async () => {
      if (used) return { ok: false, reason: 'unknown_or_replayed', transferId: record.transferId };
      used = true;
      return expired ? { ok: false, reason: 'expired', transferId: record.transferId } : { ok: true, record };
    },
    loadMetadata: async () => ({ accountEmail: record.accountEmail, metadata: current }),
    fetchBytes: async () => {
      fetchCount++;
      return upstream;
    },
  };
  const get = () => handleDriveDownloadRequest(new Request('https://example.test/drive/download', {
    headers: { authorization: `Bearer ${TICKET}` },
  }), {}, dependencies);
  return { audits, dependencies, get, fetchCount: () => fetchCount };
}

test('the upstream request is pinned to Google and the exact authorized revision', () => {
  const url = driveRevisionDownloadUrl(baseRecord.fileId, baseRecord.headRevisionId);
  assert.equal(url.origin, 'https://www.googleapis.com');
  assert.equal(
    url.pathname,
    `/drive/v3/files/${baseRecord.fileId}/revisions/${baseRecord.headRevisionId}`,
  );
  assert.equal(url.search, '?alt=media');
});

test('successful redemption streams raw bytes with metadata headers and no JSON payload', async () => {
  const h = harness();
  const response = await h.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gsuite-sha256'), SHA);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(h.fetchCount(), 1);
  assert.deepEqual(h.audits.map((event) => event.outcome), ['redeemed', 'complete']);
});

test('sequential and concurrent replay allow exactly one redemption', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.get(), h.get()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 401]);
  if (first.ok) await first.arrayBuffer();
  if (second.ok) await second.arrayBuffer();
  assert.equal((await h.get()).status, 401);
  assert.equal(h.fetchCount(), 1);
});

test('expiry and malformed tickets fail before Google access', async () => {
  const expired = harness({ expired: true });
  assert.equal((await expired.get()).status, 401);
  assert.equal(expired.fetchCount(), 0);
  const malformed = await handleDriveDownloadRequest(
    new Request('https://example.test/drive/download', { headers: { authorization: 'Bearer secret' } }),
    {},
    expired.dependencies,
  );
  assert.equal(malformed.status, 401);
  assert.equal(expired.fetchCount(), 0);
});

test('file, version, and account changes consume the ticket but refuse bytes', async () => {
  for (const change of [
    { current: metadata({ id: 'different-file-id' }) },
    { current: metadata({ headRevisionId: 'new-revision' }) },
    { record: { ...baseRecord, accountEmail: 'other@example.com' } },
  ]) {
    const h = harness(change);
    if (change.record) h.dependencies.loadMetadata = async () => ({ accountEmail: 'tarun@routespring.com', metadata: metadata() });
    assert.equal((await h.get()).status, 409);
    assert.equal((await h.get()).status, 401, 'failed redemption must still be single-use');
    assert.equal(h.fetchCount(), 0);
  }
});

test('interrupted upstream transfer is audited and cannot be retried', async () => {
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 4));
      controller.error(new Error('connection reset'));
    },
  });
  const h = harness({ upstream: new Response(interrupted) });
  const response = await h.get();
  await assert.rejects(response.arrayBuffer(), /Drive transfer was interrupted/);
  assert.equal((await h.get()).status, 401);
  assert.ok(h.audits.some((event) => event.outcome === 'interrupted'));
});

test('audit records never include the ticket or Authorization header', async () => {
  const h = harness();
  const response = await h.get();
  await response.arrayBuffer();
  const serialized = JSON.stringify(h.audits);
  assert.equal(serialized.includes(TICKET), false);
  assert.equal(serialized.toLowerCase().includes('authorization'), false);
});
