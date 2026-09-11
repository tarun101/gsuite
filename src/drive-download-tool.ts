import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callGmail } from './gmail.js';
import { account, register } from './register.js';
import { workspaceFor } from './workspace.js';
import {
  DOWNLOAD_TICKET_TTL_MS,
  DRIVE_DOWNLOAD_METADATA_FIELDS,
  DRIVE_DOWNLOAD_OPERATION,
  normalizeDownloadMetadata,
  type DriveDownloadTicketRecord,
} from './drive-download-ticket.js';

export interface DriveDownloadToolDependencies {
  requester: string;
  downloadUrl: string;
  issue(record: DriveDownloadTicketRecord): Promise<string>;
  now?: () => number;
}

export function formatDriveDownloadTicketResult(
  record: DriveDownloadTicketRecord,
  ticket: string,
  downloadUrl: string,
): Record<string, unknown> {
  return {
    transferId: record.transferId,
    account: record.accountAlias,
    email: record.accountEmail,
    fileId: record.fileId,
    filename: record.filename,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    version: { headRevisionId: record.headRevisionId, modifiedTime: record.modifiedTime },
    sha256: record.sha256,
    downloadUrl,
    ticket,
    expiresAt: new Date(record.expiresAt).toISOString(),
    note: 'The ticket is visible in this MCP result. File bytes are not included.',
  };
}

export function registerDriveDownloadTool(
  server: McpServer,
  dependencies?: DriveDownloadToolDependencies,
): void {
  register(
    server,
    'drive_issue_download_ticket',
    'Authorize one short-lived, single-use cloud download for an ordinary Drive blob. Returns metadata and a bearer ticket in the MCP response, never file bytes. Google-native files are rejected.',
    {
      account,
      fileId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{10,200}$/, 'fileId must be an exact Drive identifier, not a URL.'),
      expectedSha256: z
        .string()
        .regex(/^[A-Fa-f0-9]{64}$/, 'expectedSha256 must be 64 hexadecimal characters.')
        .describe('Trusted SHA-256 for the exact ordinary uploaded file.'),
    },
    async (args) => {
      if (!dependencies) throw new Error('The remote download ticket broker is unavailable.');
      const ctx = workspaceFor(args.account);
      const result = await callGmail(ctx, 'authorize Drive cloud download', () =>
        ctx.drive.files.get({
          fileId: args.fileId,
          fields: DRIVE_DOWNLOAD_METADATA_FIELDS,
          supportsAllDrives: true,
        }),
      );
      const file = normalizeDownloadMetadata(result.data, args.expectedSha256);
      const issuedAt = (dependencies.now ?? Date.now)();
      const record: DriveDownloadTicketRecord = {
        ...file,
        transferId: crypto.randomUUID(),
        operation: DRIVE_DOWNLOAD_OPERATION,
        requester: dependencies.requester.toLowerCase(),
        accountAlias: ctx.alias,
        accountEmail: ctx.email.toLowerCase(),
        issuedAt,
        expiresAt: issuedAt + DOWNLOAD_TICKET_TTL_MS,
      };
      const ticket = await dependencies.issue(record);
      return formatDriveDownloadTicketResult(record, ticket, dependencies.downloadUrl);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );
}
