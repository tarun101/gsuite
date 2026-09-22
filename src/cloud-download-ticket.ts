export const CLOUD_DOWNLOAD_TICKET_TTL_MS = 5 * 60_000;
export const CLOUD_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export type CloudDownloadSource = 'drive.export' | 'gmail.attachment' | 'chat.attachment';

export interface CloudDownloadTicketRecord {
  transferId: string;
  operation: 'cloud.download';
  source: CloudDownloadSource;
  requester: string;
  accountAlias: string;
  accountEmail: string;
  filename: string;
  mimeType: string;
  maxBytes: number;
  fileId?: string;
  exportMimeType?: string;
  messageId?: string;
  attachmentId?: string;
  resourceName?: string;
  issuedAt: number;
  expiresAt: number;
}

export type CloudDownloadConsumeResult =
  | { ok: true; record: CloudDownloadTicketRecord }
  | { ok: false; reason: 'expired' | 'unknown_or_replayed'; transferId?: string };

export function validateCloudDownloadTicket(record: CloudDownloadTicketRecord): void {
  if (record.operation !== 'cloud.download' || !record.requester || !record.accountAlias || !record.accountEmail) {
    throw new Error('Download ticket is missing a required account binding.');
  }
  if (!record.filename || !record.mimeType || !Number.isSafeInteger(record.maxBytes) || record.maxBytes < 1 || record.maxBytes > CLOUD_DOWNLOAD_MAX_BYTES) {
    throw new Error('Download ticket has invalid output metadata.');
  }
  if (record.source === 'drive.export' && (!record.fileId || !record.exportMimeType)) throw new Error('Drive export ticket is incomplete.');
  if (record.source === 'gmail.attachment' && (!record.messageId || !record.attachmentId)) throw new Error('Gmail attachment ticket is incomplete.');
  if (record.source === 'chat.attachment' && !record.resourceName) throw new Error('Chat attachment ticket is incomplete.');
  if (record.expiresAt <= record.issuedAt) throw new Error('Download ticket has invalid timestamps.');
}
