import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const account = z
  .string()
  .describe('Required account alias or exact email address, for example "personal" or "work".');
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

async function callGoogle<T>(
  ctx: WorkspaceContext,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return callGmail(ctx, operation, fn);
}

function spreadsheetId(input: string): string {
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  throw new Error('spreadsheet must be a Google Sheets URL or spreadsheet ID.');
}

function documentId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  throw new Error('document must be a Google Docs URL or document ID.');
}

const DRIVE_AUDIT_FILE_FIELDS =
  'id,name,mimeType,modifiedTime,modifiedByMeTime,createdTime,viewedByMeTime,sharedWithMeTime,' +
  'size,trashed,parents,driveId,description,webViewLink,resourceKey,permissionIds,' +
  'hasAugmentedPermissions,inheritedPermissionsDisabled,' +
  'owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),' +
  'capabilities(canComment,canEdit,canShare)';

function documentText(content: any[] | undefined): string {
  const output: string[] = [];
  const walk = (elements: any[] | undefined) => {
    for (const element of elements ?? []) {
      if (element.paragraph?.elements) {
        for (const part of element.paragraph.elements) {
          if (part.textRun?.content) output.push(part.textRun.content);
        }
      }
      if (element.table?.tableRows) {
        for (const row of element.table.tableRows) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
          output.push('\n');
        }
      }
      if (element.tableOfContents?.content) walk(element.tableOfContents.content);
    }
  };
  walk(content);
  return output.join('').slice(0, 100_000);
}

const calendarId = z.string().optional().describe('Calendar ID; defaults to "primary".');
const eventDateTime = z
  .string()
  .describe('RFC 3339 date-time with explicit offset, or YYYY-MM-DD for an all-day event.');

function eventTime(value: string, timeZone?: string): { date?: string; dateTime?: string; timeZone?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('Timed events require an RFC 3339 offset, e.g. 2026-07-24T17:30:00-04:00.');
  }
  return { dateTime: new Date(value).toISOString(), ...(timeZone ? { timeZone } : {}) };
}

export function registerWorkspaceTools(server: McpServer): void {
  // Sheets
  register(
    server,
    'sheets_get_metadata',
    'Get spreadsheet title and sheet/tab metadata.',
    { account, spreadsheet: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const id = spreadsheetId(args.spreadsheet);
      const result = await callGoogle(ctx, 'get spreadsheet metadata', () =>
        ctx.sheets.spreadsheets.get({
          spreadsheetId: id,
          fields:
            'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))',
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        spreadsheetId: result.data.spreadsheetId,
        title: result.data.properties?.title,
        sheets: (result.data.sheets ?? []).map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
          index: sheet.properties?.index,
          rows: sheet.properties?.gridProperties?.rowCount,
          columns: sheet.properties?.gridProperties?.columnCount,
        })),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'sheets_read_range',
    'Read a Google Sheets range in A1 notation.',
    {
      account,
      spreadsheet: z.string(),
      range: z.string(),
      valueRenderOption: z
        .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
        .optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'read spreadsheet range', () =>
        ctx.sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId(args.spreadsheet),
          range: args.range,
          valueRenderOption: args.valueRenderOption ?? 'FORMATTED_VALUE',
        })
      );
      const values = result.data.values ?? [];
      if (Buffer.byteLength(JSON.stringify(values)) > 400_000) {
        throw new Error('Range result exceeds 400 KB; read a narrower range.');
      }
      return {
        account: ctx.alias,
        email: ctx.email,
        range: result.data.range,
        rowCount: values.length,
        values,
      };
    },
    { readOnlyHint: true }
  );

  const grid = z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .min(1);
  register(
    server,
    'sheets_update_range',
    'Replace values in an exact Google Sheets range.',
    {
      account,
      spreadsheet: z.string(),
      range: z.string(),
      values: grid,
      valueInputOption: z.enum(['USER_ENTERED', 'RAW']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'update spreadsheet range', () =>
        ctx.sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId(args.spreadsheet),
          range: args.range,
          valueInputOption: args.valueInputOption ?? 'USER_ENTERED',
          requestBody: { values: args.values },
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  register(
    server,
    'sheets_append_rows',
    'Append rows after the table detected within a Google Sheets range.',
    {
      account,
      spreadsheet: z.string(),
      range: z.string(),
      rows: grid,
      valueInputOption: z.enum(['USER_ENTERED', 'RAW']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'append spreadsheet rows', () =>
        ctx.sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheetId(args.spreadsheet),
          range: args.range,
          valueInputOption: args.valueInputOption ?? 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: args.rows },
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data.updates };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  // Drive
  register(
    server,
    'drive_search_files',
    'Search Google Drive files using Drive query syntax.',
    {
      account,
      query: z.string().optional().describe('Drive q expression; defaults to "trashed = false".'),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'search Drive files', () =>
        ctx.drive.files.list({
          q: args.query ?? 'trashed = false',
          pageSize: args.pageSize ?? 25,
          pageToken: args.pageToken,
          orderBy: 'modifiedTime desc',
          fields: `nextPageToken,files(${DRIVE_AUDIT_FILE_FIELDS})`,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        nextPageToken: result.data.nextPageToken,
        files: result.data.files ?? [],
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_get_file',
    'Get metadata for one Google Drive file.',
    { account, fileId: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'get Drive file', () =>
        ctx.drive.files.get({
          fileId: args.fileId,
          fields: DRIVE_AUDIT_FILE_FIELDS,
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_download_file',
    'Download a binary Drive file or export a Google Workspace file to ~/Downloads.',
    {
      account,
      fileId: z.string(),
      filename: z.string(),
      exportMimeType: z
        .string()
        .optional()
        .describe('Required for Google Docs/Sheets/Slides, e.g. application/pdf.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const response = args.exportMimeType
        ? await callGoogle(ctx, 'export Drive file', () =>
            ctx.drive.files.export(
              { fileId: args.fileId, mimeType: args.exportMimeType },
              { responseType: 'arraybuffer' }
            )
          )
        : await callGoogle(ctx, 'download Drive file', () =>
            ctx.drive.files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'arraybuffer' })
          );
      const safe = path.basename(args.filename);
      let target = path.join(os.homedir(), 'Downloads', safe);
      const parsed = path.parse(target);
      for (let i = 1; fs.existsSync(target); i++) {
        target = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
      }
      fs.writeFileSync(target, Buffer.from(response.data as ArrayBuffer));
      return { account: ctx.alias, email: ctx.email, fileId: args.fileId, path: target };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_create_folder',
    'Create a Google Drive folder.',
    { account, name: z.string(), parentId: z.string().optional() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'create Drive folder', () =>
        ctx.drive.files.create({
          requestBody: {
            name: args.name,
            mimeType: 'application/vnd.google-apps.folder',
            ...(args.parentId ? { parents: [args.parentId] } : {}),
          },
          fields: 'id,name,mimeType,parents,webViewLink',
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'drive_rename_file',
    'Rename a Google Drive file or folder.',
    { account, fileId: z.string(), name: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'rename Drive file', () =>
        ctx.drive.files.update({
          fileId: args.fileId,
          requestBody: { name: args.name },
          fields: 'id,name,mimeType,parents,webViewLink',
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  register(
    server,
    'drive_move_file',
    'Move a Drive file into a new parent folder, removing existing parents by default.',
    {
      account,
      fileId: z.string(),
      newParentId: z.string(),
      keepExistingParents: z.boolean().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      let removeParents: string | undefined;
      if (!args.keepExistingParents) {
        const current = await callGoogle(ctx, 'read Drive parents', () =>
          ctx.drive.files.get({ fileId: args.fileId, fields: 'parents' })
        );
        removeParents = (current.data.parents ?? []).join(',') || undefined;
      }
      const result = await callGoogle(ctx, 'move Drive file', () =>
        ctx.drive.files.update({
          fileId: args.fileId,
          addParents: args.newParentId,
          removeParents,
          fields: 'id,name,mimeType,parents,webViewLink',
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  const trashDrive = (name: 'drive_trash_file' | 'drive_untrash_file', trashed: boolean) =>
    register(
      server,
      name,
      trashed ? 'Move a Drive file or folder to recoverable Trash.' : 'Restore a Drive file or folder from Trash.',
      { account, fileId: z.string() },
      async (args) => {
        const ctx = workspaceFor(args.account);
        const result = await callGoogle(ctx, name, () =>
          ctx.drive.files.update({
            fileId: args.fileId,
            requestBody: { trashed },
            fields: 'id,name,mimeType,trashed,parents,webViewLink',
          })
        );
        return { account: ctx.alias, email: ctx.email, ...result.data };
      },
      { readOnlyHint: false, destructiveHint: trashed, idempotentHint: true }
    );
  trashDrive('drive_trash_file', true);
  trashDrive('drive_untrash_file', false);

  // Calendar
  register(
    server,
    'calendar_list_calendars',
    'List calendars visible to the selected account.',
    { account },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'list calendars', () =>
        ctx.calendar.calendarList.list({ maxResults: 250 })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        calendars: (result.data.items ?? []).map((item) => ({
          id: item.id,
          summary: item.summary,
          primary: item.primary,
          accessRole: item.accessRole,
          timeZone: item.timeZone,
        })),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'calendar_list_events',
    'List events within an explicit time window.',
    {
      account,
      calendarId,
      timeMin: z.string().describe('RFC 3339 lower bound with timezone.'),
      timeMax: z.string().describe('RFC 3339 upper bound with timezone.'),
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'list calendar events', () =>
        ctx.calendar.events.list({
          calendarId: args.calendarId ?? 'primary',
          timeMin: new Date(args.timeMin).toISOString(),
          timeMax: new Date(args.timeMax).toISOString(),
          q: args.query,
          maxResults: args.maxResults ?? 100,
          pageToken: args.pageToken,
          singleEvents: true,
          orderBy: 'startTime',
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        nextPageToken: result.data.nextPageToken,
        timeZone: result.data.timeZone,
        events: (result.data.items ?? []).map((event) => ({
          id: event.id,
          status: event.status,
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: event.start,
          end: event.end,
          attendees: event.attendees,
          htmlLink: event.htmlLink,
          recurringEventId: event.recurringEventId,
        })),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'calendar_create_event',
    'Create a timed or all-day calendar event.',
    {
      account,
      calendarId,
      summary: z.string(),
      start: eventDateTime,
      end: eventDateTime,
      timeZone: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string().email()).optional(),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'create calendar event', () =>
        ctx.calendar.events.insert({
          calendarId: args.calendarId ?? 'primary',
          sendUpdates: args.sendUpdates ?? 'none',
          requestBody: {
            summary: args.summary,
            start: eventTime(args.start, args.timeZone),
            end: eventTime(args.end, args.timeZone),
            description: args.description,
            location: args.location,
            attendees: args.attendees?.map((email: string) => ({ email })),
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        eventId: result.data.id,
        summary: result.data.summary,
        start: result.data.start,
        end: result.data.end,
        htmlLink: result.data.htmlLink,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'calendar_update_event',
    'Patch selected fields on an existing calendar event.',
    {
      account,
      calendarId,
      eventId: z.string(),
      summary: z.string().optional(),
      start: eventDateTime.optional(),
      end: eventDateTime.optional(),
      timeZone: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string().email()).optional(),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      if ((args.start && !args.end) || (!args.start && args.end)) {
        throw new Error('start and end must be updated together.');
      }
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'update calendar event', () =>
        ctx.calendar.events.patch({
          calendarId: args.calendarId ?? 'primary',
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? 'none',
          requestBody: {
            summary: args.summary,
            ...(args.start
              ? { start: eventTime(args.start, args.timeZone), end: eventTime(args.end, args.timeZone) }
              : {}),
            description: args.description,
            location: args.location,
            attendees: args.attendees?.map((email: string) => ({ email })),
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        eventId: result.data.id,
        summary: result.data.summary,
        start: result.data.start,
        end: result.data.end,
        htmlLink: result.data.htmlLink,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'calendar_delete_event',
    'Delete one calendar event.',
    {
      account,
      calendarId,
      eventId: z.string(),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      await callGoogle(ctx, 'delete calendar event', () =>
        ctx.calendar.events.delete({
          calendarId: args.calendarId ?? 'primary',
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? 'none',
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        calendarId: args.calendarId ?? 'primary',
        eventId: args.eventId,
        deleted: true,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  );

  // Docs
  register(
    server,
    'docs_get_document',
    'Read a Google Doc title and plain text.',
    { account, document: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'get Google Doc', () =>
        ctx.docs.documents.get({ documentId: documentId(args.document) })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        documentId: result.data.documentId,
        title: result.data.title,
        text: documentText(result.data.body?.content),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'docs_create_document',
    'Create a blank Google Doc.',
    { account, title: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'create Google Doc', () =>
        ctx.docs.documents.create({ requestBody: { title: args.title } })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        documentId: result.data.documentId,
        title: result.data.title,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'docs_append_text',
    'Append plain text at the end of a Google Doc.',
    { account, document: z.string(), text: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const id = documentId(args.document);
      const current = await callGoogle(ctx, 'read Google Doc end index', () =>
        ctx.docs.documents.get({ documentId: id, fields: 'body.content.endIndex' })
      );
      const content = current.data.body?.content ?? [];
      const endIndex = Math.max(1, (content[content.length - 1]?.endIndex ?? 2) - 1);
      const result = await callGoogle(ctx, 'append to Google Doc', () =>
        ctx.docs.documents.batchUpdate({
          documentId: id,
          requestBody: {
            requests: [{ insertText: { location: { index: endIndex }, text: args.text } }],
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        documentId: id,
        updated: true,
        revisionId: result.data.writeControl?.requiredRevisionId,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'docs_replace_text',
    'Replace every matching text occurrence in a Google Doc.',
    {
      account,
      document: z.string(),
      find: z.string(),
      replace: z.string(),
      matchCase: z.boolean().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const id = documentId(args.document);
      const result = await callGoogle(ctx, 'replace text in Google Doc', () =>
        ctx.docs.documents.batchUpdate({
          documentId: id,
          requestBody: {
            requests: [
              {
                replaceAllText: {
                  containsText: { text: args.find, matchCase: args.matchCase ?? true },
                  replaceText: args.replace,
                },
              },
            ],
          },
        })
      );
      const replacements =
        result.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return { account: ctx.alias, email: ctx.email, documentId: id, replacements };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  );
}
