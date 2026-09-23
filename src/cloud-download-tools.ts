import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { account, register } from './register.js';
import { CLOUD_DOWNLOAD_MAX_BYTES, CLOUD_DOWNLOAD_TICKET_TTL_MS, type CloudDownloadTicketRecord } from './cloud-download-ticket.js';
import { workspaceFor } from './workspace.js';

export interface CloudDownloadToolDependencies { requester: string; downloadUrl: string; issue(record: CloudDownloadTicketRecord): Promise<string>; now?: () => number; maxBytes?: number; }
const source = z.enum(['drive.export', 'gmail.attachment', 'chat.attachment']);
const maxBytes = z.number().int().min(1).max(CLOUD_DOWNLOAD_MAX_BYTES).optional();

function issue(
  dependencies: CloudDownloadToolDependencies,
  args: any,
  kind: CloudDownloadTicketRecord['source'],
) {
  const ctx = workspaceFor(args.account); const issuedAt = (dependencies.now ?? Date.now)();
  const record: CloudDownloadTicketRecord = {
    transferId: crypto.randomUUID(), operation: 'cloud.download', source: kind,
    requester: dependencies.requester.toLowerCase(), accountAlias: ctx.alias, accountEmail: ctx.email.toLowerCase(),
    filename: args.filename, mimeType: args.mimeType, maxBytes: args.maxBytes ?? dependencies.maxBytes ?? CLOUD_DOWNLOAD_MAX_BYTES,
    ...(kind === 'drive.export' ? { fileId: args.fileId, exportMimeType: args.mimeType } : {}),
    ...(kind === 'gmail.attachment' ? { messageId: args.messageId, attachmentId: args.attachmentId } : {}),
    ...(kind === 'chat.attachment' ? { resourceName: args.resourceName } : {}),
    issuedAt, expiresAt: issuedAt + CLOUD_DOWNLOAD_TICKET_TTL_MS,
  };
  return dependencies.issue(record).then((ticket) => ({ account: ctx.alias, source: kind, filename: record.filename, mimeType: record.mimeType, maxBytes: record.maxBytes, downloadUrl: dependencies.downloadUrl, ticket, expiresAt: new Date(record.expiresAt).toISOString() }));
}

export function registerCloudDownloadTools(server: McpServer, dependencies?: CloudDownloadToolDependencies): void {
  const unavailable = () => { if (!dependencies) throw new Error('Cloud download tickets are available only in the authenticated Worker.'); return dependencies; };
  register(server, 'drive_issue_export_download_ticket', 'Issue a single-use cloud download ticket for a Google Docs, Sheets, or Slides export. File bytes never enter MCP.', {
    account, fileId: z.string(), filename: z.string(), mimeType: z.string().describe('Requested Drive export MIME type, for example text/markdown or text/plain.'), maxBytes,
  }, (args) => issue(unavailable(), args, 'drive.export'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  register(server, 'gmail_issue_attachment_download_ticket', 'Issue a single-use cloud download ticket for one Gmail attachment. File bytes never enter MCP.', {
    account, messageId: z.string(), attachmentId: z.string(), filename: z.string(), mimeType: z.string(), maxBytes,
  }, (args) => issue(unavailable(), args, 'gmail.attachment'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  register(server, 'chat_issue_attachment_download_ticket', 'Issue a single-use cloud download ticket for one Google Chat uploaded attachment. File bytes never enter MCP.', {
    account, resourceName: z.string(), filename: z.string(), mimeType: z.string(), maxBytes,
  }, (args) => issue(unavailable(), args, 'chat.attachment'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
}
