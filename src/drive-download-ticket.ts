/** Shared, serializable contract between the MCP issuer, ticket broker, and download endpoint. */

export const DOWNLOAD_TICKET_TTL_MS = 90_000;
export const MAX_DRIVE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const DRIVE_DOWNLOAD_OPERATION = 'drive.download' as const;
export const ROUTESPRING_DRIVE_DOWNLOAD_URL =
  'https://gsuite-mcp.tarun-me.workers.dev/drive/download';

export const ALLOWED_DRIVE_DOWNLOAD_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/zip',
  'image/jpeg',
  'image/png',
  'text/csv',
  'text/plain',
]);

export interface DriveDownloadTicketRecord {
  transferId: string;
  operation: typeof DRIVE_DOWNLOAD_OPERATION;
  requester: string;
  accountAlias: string;
  accountEmail: string;
  fileId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  headRevisionId: string;
  sha256: string;
  modifiedTime: string;
  issuedAt: number;
  expiresAt: number;
}

export type TicketConsumeResult =
  | { ok: true; record: DriveDownloadTicketRecord }
  | { ok: false; reason: 'expired' | 'unknown_or_replayed'; transferId?: string };

export interface DriveDownloadMetadata {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: string | null;
  headRevisionId?: string | null;
  sha256Checksum?: string | null;
  modifiedTime?: string | null;
  trashed?: boolean | null;
  capabilities?: {
    canDownload?: boolean | null;
    canReadRevisions?: boolean | null;
  } | null;
  downloadRestrictions?: {
    effectiveDownloadRestrictionWithContext?: {
      restrictedForReaders?: boolean | null;
      restrictedForWriters?: boolean | null;
    } | null;
  } | null;
}

export const DRIVE_DOWNLOAD_METADATA_FIELDS =
  'id,name,mimeType,size,headRevisionId,sha256Checksum,modifiedTime,trashed,' +
  'capabilities(canDownload,canReadRevisions),downloadRestrictions(effectiveDownloadRestrictionWithContext)';

export function randomOpaqueTicket(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ticketLooksValid(ticket: string): boolean {
  return /^[a-f0-9]{64}$/.test(ticket);
}

export function ticketShard(ticketHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(ticketHash)) throw new Error('Invalid ticket hash.');
  return `ticket-shard-${ticketHash.slice(0, 2)}`;
}

export async function hashTicket(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function restricted(metadata: DriveDownloadMetadata): boolean {
  const effective = metadata.downloadRestrictions?.effectiveDownloadRestrictionWithContext;
  return effective?.restrictedForReaders === true || effective?.restrictedForWriters === true;
}

/** Validate and normalize Drive's current metadata for the deliberately narrow blob-file prototype. */
export function normalizeDownloadMetadata(
  metadata: DriveDownloadMetadata,
  expectedSha256?: string,
): Omit<DriveDownloadTicketRecord, 'transferId' | 'operation' | 'requester' | 'accountAlias' | 'accountEmail' | 'issuedAt' | 'expiresAt'> {
  const sha256 = metadata.sha256Checksum?.toLowerCase();
  const byteSize = Number(metadata.size);
  if (!metadata.id || !metadata.name || !metadata.mimeType) throw new Error('Drive returned incomplete file metadata.');
  if (metadata.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error('Google-native Docs, Sheets, Slides, shortcuts, and folders are not supported by this prototype.');
  }
  if (!ALLOWED_DRIVE_DOWNLOAD_MIME_TYPES.has(metadata.mimeType)) {
    throw new Error(`MIME type is not allowed for cloud download: ${metadata.mimeType}`);
  }
  if (metadata.trashed === true) throw new Error('Trashed Drive files cannot be downloaded through this endpoint.');
  if (
    metadata.capabilities?.canDownload !== true ||
    metadata.capabilities?.canReadRevisions !== true ||
    restricted(metadata)
  ) {
    throw new Error('The selected account is not currently permitted to download this exact file revision.');
  }
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error('Drive did not return a valid positive byte size.');
  if (byteSize > MAX_DRIVE_DOWNLOAD_BYTES) {
    throw new Error(`File exceeds the ${MAX_DRIVE_DOWNLOAD_BYTES} byte cloud download limit.`);
  }
  if (!metadata.headRevisionId) throw new Error('Drive did not return an immutable head revision ID for this blob file.');
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Drive did not return a SHA-256 checksum for this blob file.');
  }
  if (!metadata.modifiedTime) throw new Error('Drive did not return modifiedTime metadata.');
  if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
    throw new Error('The trusted expected SHA-256 does not match Drive metadata.');
  }
  return {
    fileId: metadata.id,
    filename: metadata.name,
    mimeType: metadata.mimeType,
    byteSize,
    headRevisionId: metadata.headRevisionId,
    sha256,
    modifiedTime: metadata.modifiedTime,
  };
}

/** Recheck every security- and integrity-relevant binding immediately before fetching bytes. */
export function assertMetadataStillMatches(
  current: DriveDownloadMetadata,
  ticket: DriveDownloadTicketRecord,
): void {
  const normalized = normalizeDownloadMetadata(current, ticket.sha256);
  const exact: Array<[string, unknown, unknown]> = [
    ['file ID', normalized.fileId, ticket.fileId],
    ['filename', normalized.filename, ticket.filename],
    ['MIME type', normalized.mimeType, ticket.mimeType],
    ['byte size', normalized.byteSize, ticket.byteSize],
    ['head revision', normalized.headRevisionId, ticket.headRevisionId],
    ['modified time', normalized.modifiedTime, ticket.modifiedTime],
  ];
  const changed = exact.find(([, left, right]) => left !== right);
  if (changed) throw new Error(`Drive file changed since ticket issuance (${changed[0]} mismatch).`);
}
