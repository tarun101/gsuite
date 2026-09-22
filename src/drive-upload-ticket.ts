import { hashTicket, randomOpaqueTicket, ticketLooksValid, ticketShard } from './drive-download-ticket.js';

export const DRIVE_UPLOAD_TICKET_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_DRIVE_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface DriveUploadTicketRecord {
  transferId: string;
  operation: 'drive.upload';
  requester: string;
  accountAlias: string;
  accountEmail: string;
  filename?: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  parentId?: string;
  fileId?: string;
  issuedAt: number;
  expiresAt: number;
}

export type UploadTicketConsumeResult =
  | { ok: true; record: DriveUploadTicketRecord }
  | { ok: false; reason: 'expired' | 'unknown_or_replayed'; transferId?: string };

export function validateDriveUploadTicket(record: DriveUploadTicketRecord, maxBytes = DEFAULT_MAX_DRIVE_UPLOAD_BYTES): void {
  if (record.operation !== 'drive.upload') throw new Error('Unsupported upload ticket operation.');
  if (!record.requester || !record.accountAlias || !record.accountEmail) throw new Error('Upload ticket is missing an account binding.');
  if (!record.filename && !record.fileId) throw new Error('Upload ticket must name a new file or an existing fileId.');
  if (record.fileId && record.parentId) throw new Error('An in-place upload cannot also move the file.');
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 1 || record.byteSize > maxBytes) {
    throw new Error(`Upload ticket size must be between 1 and ${maxBytes} bytes.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(record.sha256)) throw new Error('Upload ticket SHA-256 must be 64 hexadecimal characters.');
  if (!Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.issuedAt) {
    throw new Error('Upload ticket has invalid timestamps.');
  }
}

export async function issueOpaqueUploadTicket(
  issue: (hash: string, record: DriveUploadTicketRecord) => Promise<void>,
  record: DriveUploadTicketRecord,
): Promise<string> {
  validateDriveUploadTicket(record);
  const ticket = randomOpaqueTicket();
  const hash = await hashTicket(ticket);
  await issue(hash, record);
  return ticket;
}

export { hashTicket, ticketLooksValid, ticketShard };
