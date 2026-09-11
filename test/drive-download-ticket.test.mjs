import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DRIVE_DOWNLOAD_BYTES,
  assertMetadataStillMatches,
  hashTicket,
  normalizeDownloadMetadata,
  randomOpaqueTicket,
  ticketLooksValid,
  ticketShard,
} from '../dist/drive-download-ticket.js';
import { formatDriveDownloadTicketResult } from '../dist/drive-download-tool.js';

const SHA = 'a'.repeat(64);
const metadata = (overrides = {}) => ({
  id: '1Abcdefghijklmnopqrstuvwxyz',
  name: 'fixture.pdf',
  mimeType: 'application/pdf',
  size: '12',
  headRevisionId: 'rev-123',
  sha256Checksum: SHA,
  modifiedTime: '2026-09-11T00:00:00.000Z',
  trashed: false,
  capabilities: { canDownload: true, canReadRevisions: true },
  downloadRestrictions: {
    effectiveDownloadRestrictionWithContext: { restrictedForReaders: false, restrictedForWriters: false },
  },
  ...overrides,
});

const record = () => ({
  ...normalizeDownloadMetadata(metadata(), SHA),
  transferId: 'transfer-1',
  operation: 'drive.download',
  requester: 'i@tarun.me',
  accountAlias: 'work',
  accountEmail: 'tarun@routespring.com',
  issuedAt: 1,
  expiresAt: 91_001,
});

test('opaque tickets are 256 random bits, shard deterministically, and hash before storage', async () => {
  const first = randomOpaqueTicket();
  const second = randomOpaqueTicket();
  assert.equal(ticketLooksValid(first), true);
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  const firstHash = await hashTicket(first);
  assert.equal(ticketShard(firstHash), ticketShard(firstHash));
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.notEqual(firstHash, first);
});

test('ordinary blob metadata requires trusted SHA-256, download permission, allowlisted MIME, and bounded size', () => {
  assert.equal(normalizeDownloadMetadata(metadata(), SHA).byteSize, 12);
  assert.throws(() => normalizeDownloadMetadata(metadata(), 'b'.repeat(64)), /trusted expected SHA-256/);
  assert.throws(() => normalizeDownloadMetadata(metadata({ capabilities: { canDownload: false } }), SHA), /not currently permitted/);
  assert.throws(() => normalizeDownloadMetadata(metadata({ capabilities: { canDownload: true, canReadRevisions: false } }), SHA), /not currently permitted/);
  assert.throws(() => normalizeDownloadMetadata(metadata({ downloadRestrictions: { effectiveDownloadRestrictionWithContext: { restrictedForReaders: true } } }), SHA), /not currently permitted/);
  assert.throws(() => normalizeDownloadMetadata(metadata({ mimeType: 'application/x-unknown' }), SHA), /MIME type is not allowed/);
  assert.throws(() => normalizeDownloadMetadata(metadata({ size: String(MAX_DRIVE_DOWNLOAD_BYTES + 1) }), SHA), /cloud download limit/);
});

test('Google-native files are explicitly rejected', () => {
  for (const mimeType of [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
  ]) assert.throws(() => normalizeDownloadMetadata(metadata({ mimeType }), SHA), /Google-native/);
});

test('MCP ticket output contains metadata and ticket, never file content or base64', () => {
  const output = formatDriveDownloadTicketResult(record(), 'ticket-value', 'https://example.test/drive/download');
  assert.equal(output.ticket, 'ticket-value');
  assert.equal(output.sha256, SHA);
  assert.equal('content' in output, false);
  assert.equal('contentBase64' in output, false);
  assert.equal('bytes' in output, false);
});

test('redemption metadata recheck detects account-independent file and content tampering', () => {
  const expected = record();
  assert.doesNotThrow(() => assertMetadataStillMatches(metadata(), expected));
  assert.throws(() => assertMetadataStillMatches(metadata({ id: 'another-file-id' }), expected), /file ID mismatch/);
  assert.throws(() => assertMetadataStillMatches(metadata({ headRevisionId: 'rev-124' }), expected), /head revision mismatch/);
  assert.throws(() => assertMetadataStillMatches(metadata({ sha256Checksum: 'b'.repeat(64) }), expected), /trusted expected SHA-256/);
  assert.throws(() => assertMetadataStillMatches(metadata({ size: '13' }), expected), /byte size mismatch/);
});
