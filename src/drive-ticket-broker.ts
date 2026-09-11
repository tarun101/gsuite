import { DurableObject } from 'cloudflare:workers';
import type { DriveDownloadTicketRecord, TicketConsumeResult } from './drive-download-ticket.js';

type TicketRow = {
  transfer_id: string;
  operation: string;
  requester: string;
  account_alias: string;
  account_email: string;
  file_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  head_revision_id: string;
  sha256: string;
  modified_time: string;
  issued_at: number;
  expires_at: number;
};

function rowToRecord(row: TicketRow): DriveDownloadTicketRecord {
  if (row.operation !== 'drive.download') throw new Error('Unsupported ticket operation.');
  return {
    transferId: row.transfer_id,
    operation: row.operation,
    requester: row.requester,
    accountAlias: row.account_alias,
    accountEmail: row.account_email,
    fileId: row.file_id,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    headRevisionId: row.head_revision_id,
    sha256: row.sha256,
    modifiedTime: row.modified_time,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

/** Strongly consistent, sharded single-use ticket ledger. Only SHA-256 ticket hashes are persisted. */
export class DriveTicketBroker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS download_tickets (
          ticket_hash TEXT PRIMARY KEY,
          transfer_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          requester TEXT NOT NULL,
          account_alias TEXT NOT NULL,
          account_email TEXT NOT NULL,
          file_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          head_revision_id TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          modified_time TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'expired')),
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS download_tickets_expiry ON download_tickets(expires_at);
      `);
    });
  }

  async issue(ticketHash: string, record: DriveDownloadTicketRecord): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(ticketHash)) throw new Error('Invalid ticket hash.');
    this.ctx.storage.sql.exec(
      `INSERT INTO download_tickets (
        ticket_hash, transfer_id, operation, requester, account_alias, account_email,
        file_id, filename, mime_type, byte_size, head_revision_id, sha256,
        modified_time, issued_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
      ticketHash,
      record.transferId,
      record.operation,
      record.requester,
      record.accountAlias,
      record.accountEmail,
      record.fileId,
      record.filename,
      record.mimeType,
      record.byteSize,
      record.headRevisionId,
      record.sha256,
      record.modifiedTime,
      record.issuedAt,
      record.expiresAt,
    );
    console.info(JSON.stringify({ event: 'drive_download_ticket', outcome: 'issued', transferId: record.transferId, requester: record.requester, account: record.accountAlias, fileId: record.fileId, expiresAt: record.expiresAt }));
  }

  async consume(ticketHash: string, now: number): Promise<TicketConsumeResult> {
    if (!/^[a-f0-9]{64}$/.test(ticketHash)) return { ok: false, reason: 'unknown_or_replayed' };
    const claimed = this.ctx.storage.sql.exec<TicketRow>(
      `UPDATE download_tickets
       SET status = 'consumed', consumed_at = ?
       WHERE ticket_hash = ? AND status = 'issued' AND expires_at >= ?
       RETURNING transfer_id, operation, requester, account_alias, account_email,
         file_id, filename, mime_type, byte_size, head_revision_id, sha256,
         modified_time, issued_at, expires_at`,
      now,
      ticketHash,
      now,
    ).toArray()[0];
    if (claimed) return { ok: true, record: rowToRecord(claimed) };

    const existing = this.ctx.storage.sql.exec<{ transfer_id: string; status: string; expires_at: number }>(
      'SELECT transfer_id, status, expires_at FROM download_tickets WHERE ticket_hash = ?',
      ticketHash,
    ).toArray()[0];
    if (existing?.status === 'issued' && existing.expires_at < now) {
      this.ctx.storage.sql.exec(
        "UPDATE download_tickets SET status = 'expired' WHERE ticket_hash = ? AND status = 'issued'",
        ticketHash,
      );
      return { ok: false, reason: 'expired', transferId: existing.transfer_id };
    }
    return { ok: false, reason: 'unknown_or_replayed', transferId: existing?.transfer_id };
  }
}
