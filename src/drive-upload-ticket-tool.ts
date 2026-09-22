import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { account, register } from './register.js';
import { mimeTypeForFilename } from './drive-upload.js';
import { workspaceFor } from './workspace.js';
import {
  DEFAULT_MAX_DRIVE_UPLOAD_BYTES,
  DRIVE_UPLOAD_TICKET_TTL_MS,
  type DriveUploadTicketRecord,
} from './drive-upload-ticket.js';

export interface DriveUploadTicketToolDependencies {
  requester: string;
  uploadUrl: string;
  issue(record: DriveUploadTicketRecord): Promise<string>;
  now?: () => number;
  maxBytes?: number;
}

export function registerDriveUploadTicketTool(server: McpServer, dependencies?: DriveUploadTicketToolDependencies): void {
  register(
    server,
    'drive_issue_upload_ticket',
    'For files over about 20 KB, issue a short-lived single-use URL for curl upload without putting bytes in MCP. Set fileId to replace that Drive file in place and retain its ID. The ticket is a bearer secret: use it only in the HTTPS Authorization header and never log it.',
    {
      account,
      filename: z.string().optional().describe('Name for a new file. Omit with fileId to retain the existing name.'),
      fileId: z.string().optional().describe('Existing Drive file ID to replace in place; cannot be combined with parentId.'),
      parentId: z.string().optional().describe('Destination folder ID for a new file.'),
      mimeType: z.string().optional().describe('MIME type; inferred from filename when omitted.'),
      byteSize: z.number().int().min(1).describe('Exact local file size from stat or wc -c.'),
      sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/, 'sha256 must be 64 hexadecimal characters.').describe('SHA-256 from sha256sum before upload.'),
    },
    async (args) => {
      if (!dependencies) throw new Error('Drive upload tickets are available only in the authenticated Worker.');
      if (!args.filename && !args.fileId) throw new Error('filename is required for a new Drive file.');
      if (args.fileId && args.parentId) throw new Error('parentId cannot be used while replacing an existing fileId.');
      const maxBytes = dependencies.maxBytes ?? DEFAULT_MAX_DRIVE_UPLOAD_BYTES;
      if (args.byteSize > maxBytes) throw new Error(`File exceeds this server's ${maxBytes}-byte upload-ticket limit.`);
      const issuedAt = (dependencies.now ?? Date.now)();
      const record: DriveUploadTicketRecord = {
        transferId: crypto.randomUUID(),
        operation: 'drive.upload',
        requester: dependencies.requester.toLowerCase(),
        accountAlias: args.account,
        // The endpoint resolves the alias again before upload; no account identity is accepted from curl.
        accountEmail: '',
        ...(args.filename ? { filename: args.filename } : {}),
        mimeType: args.mimeType ?? mimeTypeForFilename(args.filename ?? 'upload.bin'),
        byteSize: args.byteSize,
        sha256: args.sha256.toLowerCase(),
        ...(args.parentId ? { parentId: args.parentId } : {}),
        ...(args.fileId ? { fileId: args.fileId } : {}),
        issuedAt,
        expiresAt: issuedAt + DRIVE_UPLOAD_TICKET_TTL_MS,
      };
      // Bind the resolved Google email at issuance without exposing it in the tool response.
      const ctx = workspaceFor(args.account);
      record.accountAlias = ctx.alias;
      record.accountEmail = ctx.email.toLowerCase();
      const ticket = await dependencies.issue(record);
      return {
        transferId: record.transferId,
        account: record.accountAlias,
        operation: record.fileId ? 'replace' : 'create',
        fileId: record.fileId,
        filename: record.filename,
        mimeType: record.mimeType,
        byteSize: record.byteSize,
        sha256: record.sha256,
        uploadUrl: dependencies.uploadUrl,
        ticket,
        expiresAt: new Date(record.expiresAt).toISOString(),
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );
}
