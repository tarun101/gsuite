import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callGmail } from './gmail.js';
import { workspaceFor, type WorkspaceContext } from './workspace.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const MAX_RESULT_BYTES = 500_000;
const account = z
  .string()
  .describe('Required account alias or exact email address, for example "personal" or "work".');
const file = z
  .string()
  .describe('Google Drive file/folder URL or opaque file ID.');
const pageToken = z.string().optional();
const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }],
});
const fail = (error: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
});

function register(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: any) => Promise<unknown>,
  annotations?: ToolAnnotations
): void {
  server.registerTool(name, { description, inputSchema, annotations }, async (args: any) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      console.error(`gsuite ${name}:`, error instanceof Error ? error.message : error);
      return fail(error);
    }
  });
}

async function callDrive<T>(
  ctx: WorkspaceContext,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return callGmail(ctx, operation, fn);
}

function driveFileId(value: string): string {
  const patterns = [
    /\/(?:document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]+)/,
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) return value;
  throw new Error('file must be a Google Drive/Docs/Sheets/Slides URL or opaque file ID.');
}

function driveItemName(value: string): string {
  if (value === 'root' || value === 'items/root') return 'items/root';
  if (/^items\/[a-zA-Z0-9_-]+$/.test(value)) return value;
  return `items/${driveFileId(value)}`;
}

function rfc3339(value: string, field: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.valueOf())) {
    throw new Error(`${field} must be an RFC 3339 timestamp.`);
  }
  return time.toISOString();
}

function bounded<T>(value: T, label: string): T {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(
      `${label} exceeds ${Math.round(MAX_RESULT_BYTES / 1000)} KB; request a smaller page or narrower window.`
    );
  }
  return value;
}

function suggestionLedger(document: unknown): {
  suggestionIds: string[];
  occurrences: Array<{
    path: string;
    startIndex?: number;
    endIndex?: number;
    text?: string;
    suggestionFields: Record<string, unknown>;
  }>;
} {
  const suggestionIds = new Set<string>();
  const occurrences: Array<{
    path: string;
    startIndex?: number;
    endIndex?: number;
    text?: string;
    suggestionFields: Record<string, unknown>;
  }> = [];

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const node = value as Record<string, unknown>;
    const suggestionFields = Object.fromEntries(
      Object.entries(node).filter(([key, item]) => {
        if (!key.startsWith('suggested') || item == null) return false;
        if (Array.isArray(item)) return item.length > 0;
        if (typeof item === 'object') return Object.keys(item as Record<string, unknown>).length > 0;
        return true;
      })
    );
    if (Object.keys(suggestionFields).length > 0) {
      for (const item of Object.values(suggestionFields)) {
        if (Array.isArray(item)) {
          for (const id of item) if (typeof id === 'string') suggestionIds.add(id);
        } else if (item && typeof item === 'object') {
          for (const id of Object.keys(item as Record<string, unknown>)) suggestionIds.add(id);
        }
      }
      const textRun = node.textRun as Record<string, unknown> | undefined;
      occurrences.push({
        path,
        ...(typeof node.startIndex === 'number' ? { startIndex: node.startIndex } : {}),
        ...(typeof node.endIndex === 'number' ? { endIndex: node.endIndex } : {}),
        ...(typeof textRun?.content === 'string'
          ? { text: textRun.content }
          : typeof node.content === 'string'
            ? { text: node.content }
            : {}),
        suggestionFields,
      });
    }

    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('suggested')) walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(document, 'document');
  return { suggestionIds: [...suggestionIds].sort(), occurrences };
}

export function registerDriveAuditTools(server: McpServer): void {
  register(
    server,
    'drive_get_start_page_token',
    'Get a durable Drive change-log token for future incremental audits. Store the token before the next audit, then pass it to drive_list_changes.',
    {
      account,
      driveId: z.string().optional().describe('Optional shared-drive ID. Omit for the user change log.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callDrive(ctx, 'get Drive start page token', () =>
        ctx.drive.changes.getStartPageToken({
          driveId: args.driveId,
          supportsAllDrives: true,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        driveId: args.driveId,
        startPageToken: result.data.startPageToken,
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_list_changes',
    'Read the Drive change log from a durable page token, including removals/lost access and current file metadata. Follow nextPageToken until newStartPageToken is returned.',
    {
      account,
      pageToken: z.string().describe('Token from drive_get_start_page_token or a prior drive_list_changes response.'),
      pageSize: z.number().int().min(1).max(1000).optional(),
      driveId: z.string().optional().describe('Optional shared-drive ID matching the token.'),
      includeRemoved: z.boolean().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callDrive(ctx, 'list Drive changes', () =>
        ctx.drive.changes.list({
          pageToken: args.pageToken,
          pageSize: args.pageSize ?? 100,
          driveId: args.driveId,
          includeRemoved: args.includeRemoved ?? true,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          spaces: 'drive',
          fields:
            'nextPageToken,newStartPageToken,changes(changeType,time,removed,fileId,driveId,' +
            'file(id,name,mimeType,createdTime,modifiedTime,modifiedByMeTime,viewedByMeTime,' +
            'sharedWithMeTime,trashed,parents,driveId,description,webViewLink,permissionIds,' +
            'hasAugmentedPermissions,inheritedPermissionsDisabled,' +
            'owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),' +
            'capabilities(canComment,canEdit,canShare)))',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          driveId: args.driveId,
          nextPageToken: result.data.nextPageToken,
          newStartPageToken: result.data.newStartPageToken,
          changes: result.data.changes ?? [],
        },
        'Drive change page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_query_activity',
    'Query historical Drive activity for a time window or action type. Returns edits, comments, permission changes, moves, renames, creates, deletes, and other Drive action details exposed by Google.',
    {
      account,
      filter: z
        .string()
        .optional()
        .describe(
          'Drive Activity filter, e.g. time >= "2026-07-12T00:00:00-04:00" or detail.action_detail_case:PERMISSION_CHANGE.'
        ),
      item: z.string().optional().describe('Optional Drive file/folder URL, ID, or items/ID resource.'),
      ancestor: z
        .string()
        .optional()
        .describe('Optional Drive folder URL, ID, or items/ID resource; includes descendants.'),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken,
      consolidation: z.enum(['NONE', 'LEGACY']).optional(),
    },
    async (args) => {
      if (args.item && args.ancestor) throw new Error('Use item or ancestor, not both.');
      const ctx = workspaceFor(args.account);
      const result = await callDrive(ctx, 'query Drive activity', () =>
        ctx.driveActivity.activity.query({
          requestBody: {
            filter: args.filter,
            pageSize: args.pageSize ?? 100,
            pageToken: args.pageToken,
            ...(args.item
              ? { itemName: driveItemName(args.item) }
              : { ancestorName: driveItemName(args.ancestor ?? 'root') }),
            consolidationStrategy:
              args.consolidation === 'LEGACY' ? { legacy: {} } : { none: {} },
          },
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          nextPageToken: result.data.nextPageToken,
          activities: result.data.activities ?? [],
        },
        'Drive activity page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_list_comments',
    'List comments on one Drive file, including resolved/deleted state, assignments, mentions, quoted content, and embedded replies.',
    {
      account,
      file,
      startModifiedTime: z
        .string()
        .optional()
        .describe('Optional RFC 3339 lower bound on comment/reply modification time.'),
      includeDeleted: z.boolean().optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken,
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const fileId = driveFileId(args.file);
      const result = await callDrive(ctx, 'list Drive comments', () =>
        ctx.drive.comments.list({
          fileId,
          startModifiedTime: args.startModifiedTime
            ? rfc3339(args.startModifiedTime, 'startModifiedTime')
            : undefined,
          includeDeleted: args.includeDeleted ?? true,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          fields:
            'nextPageToken,comments(id,createdTime,modifiedTime,resolved,deleted,' +
            'author(displayName,photoLink,me),content,htmlContent,anchor,' +
            'quotedFileContent(mimeType,value),mentionedEmailAddresses,assigneeEmailAddress,' +
            'replies(id,createdTime,modifiedTime,deleted,action,author(displayName,photoLink,me),' +
            'content,htmlContent,mentionedEmailAddresses,assigneeEmailAddress))',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          fileId,
          nextPageToken: result.data.nextPageToken,
          comments: result.data.comments ?? [],
        },
        'Drive comment page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_list_comment_replies',
    'List every reply on one Drive comment with independent pagination, including resolve/reopen actions, mentions, assignments, and deleted replies.',
    {
      account,
      file,
      commentId: z.string(),
      includeDeleted: z.boolean().optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken,
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const fileId = driveFileId(args.file);
      const result = await callDrive(ctx, 'list Drive comment replies', () =>
        ctx.drive.replies.list({
          fileId,
          commentId: args.commentId,
          includeDeleted: args.includeDeleted ?? true,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          fields:
            'nextPageToken,replies(id,createdTime,modifiedTime,deleted,action,' +
            'author(displayName,photoLink,me),content,htmlContent,' +
            'mentionedEmailAddresses,assigneeEmailAddress)',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          fileId,
          commentId: args.commentId,
          nextPageToken: result.data.nextPageToken,
          replies: result.data.replies ?? [],
        },
        'Drive reply page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_list_permissions',
    'List current direct and inherited permissions for one Drive file/folder, including owners, pending ownership, link/domain access, roles, and expiration.',
    {
      account,
      file,
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken,
      includePublishedView: z.boolean().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const fileId = driveFileId(args.file);
      const result = await callDrive(ctx, 'list Drive permissions', () =>
        ctx.drive.permissions.list({
          fileId,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          supportsAllDrives: true,
          includePermissionsForView: args.includePublishedView ? 'published' : undefined,
          fields:
            'nextPageToken,permissions(id,displayName,type,emailAddress,role,' +
            'allowFileDiscovery,domain,expirationTime,deleted,view,pendingOwner,' +
            'inheritedPermissionsDisabled,permissionDetails(permissionType,inheritedFrom,role,inherited))',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          fileId,
          nextPageToken: result.data.nextPageToken,
          permissions: result.data.permissions ?? [],
        },
        'Drive permission page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_list_access_proposals',
    'List pending access requests for one Drive file. Google returns 403 when the selected account is not an approver; this tool never approves or denies a request.',
    {
      account,
      file,
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken,
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const fileId = driveFileId(args.file);
      const result = await callDrive(ctx, 'list Drive access proposals', () =>
        ctx.drive.accessproposals.list({
          fileId,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          fields:
            'nextPageToken,accessProposals(fileId,proposalId,requesterEmailAddress,' +
            'recipientEmailAddress,rolesAndViews(role,view),requestMessage,createTime)',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          fileId,
          nextPageToken: result.data.nextPageToken,
          accessProposals: result.data.accessProposals ?? [],
        },
        'Drive access-proposal page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'docs_list_suggestions',
    'Read a Google Doc with unresolved suggestions inline and return a compact ledger of every suggested insertion, deletion, and style/structure change across all tabs.',
    {
      account,
      document: z.string().describe('Google Docs URL or opaque document ID.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const documentId = driveFileId(args.document);
      const result = await callDrive(ctx, 'read Google Doc suggestions', () =>
        ctx.docs.documents.get({
          documentId,
          includeTabsContent: true,
          suggestionsViewMode: 'SUGGESTIONS_INLINE',
        })
      );
      const ledger = suggestionLedger(result.data);
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          documentId: result.data.documentId,
          title: result.data.title,
          revisionId: result.data.revisionId,
          suggestionsViewMode: result.data.suggestionsViewMode,
          suggestionCount: ledger.suggestionIds.length,
          ...ledger,
        },
        'Google Docs suggestion ledger'
      );
    },
    { readOnlyHint: true }
  );
}
