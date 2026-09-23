import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isRemote } from './accounts.js';
import { callGmail } from './gmail.js';
import { workspaceFor, type WorkspaceContext } from './workspace.js';
import { buildRsvpPatchBody, findSelfAttendee } from './calendar-rsvp.js';
import { mimeTypeForFilename, resolveUploadSource } from './drive-upload.js';
import { uploadToDrive } from './drive-transfer.js';
import { aggregateAvailability, chunkCalendarIds, type CalendarFreeBusy } from './calendar-availability.js';
import { account, register } from './register.js';
import { needsRecurrenceTimeZone, normalizeRecurrence, shapeEvent } from './calendar-events.js';
import { registerDriveDownloadTool, type DriveDownloadToolDependencies } from './drive-download-tool.js';
import { registerDriveUploadTicketTool, type DriveUploadTicketToolDependencies } from './drive-upload-ticket-tool.js';
import { authorizedGoogleFetch, readDriveText } from './drive-read.js';
import {
  assertInlineUploadSize, buildDriveBatchBody, driveMetadataFields,
  driveSearchQuery, LEAN_DRIVE_FILE_FIELDS, MAX_INLINE_TEXT_BYTES,
  parseDriveBatchResponse, textExportMimeType,
} from './drive-operations.js';

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

function documentTabs(tabs: any[] | undefined): Array<{
  tabId?: string;
  title?: string;
  index?: number;
  nestingLevel?: number;
  parentTabId?: string;
  text: string;
}> {
  const output: Array<{
    tabId?: string;
    title?: string;
    index?: number;
    nestingLevel?: number;
    parentTabId?: string;
    text: string;
  }> = [];
  const walk = (items: any[] | undefined) => {
    for (const tab of items ?? []) {
      output.push({
        tabId: tab.tabProperties?.tabId,
        title: tab.tabProperties?.title,
        index: tab.tabProperties?.index,
        nestingLevel: tab.tabProperties?.nestingLevel,
        parentTabId: tab.tabProperties?.parentTabId,
        text: documentText(tab.documentTab?.body?.content),
      });
      walk(tab.childTabs);
    }
  };
  walk(tabs);
  return output;
}

const calendarId = z.string().optional().describe('Calendar ID; defaults to "primary".');
const eventDateTime = z
  .string()
  .describe('RFC 3339 date-time with explicit offset, or YYYY-MM-DD for an all-day event.');

const eventTransparency = z
  .enum(['opaque', 'transparent'])
  .optional()
  .describe(
    'Free/busy behavior: "opaque" blocks the time as Busy (the Google default when omitted); "transparent" shows the event as Free, so it never counts against availability.'
  );
const eventRecurrence = z
  .array(z.string())
  .optional()
  .describe(
    'RFC 5545 recurrence lines, one per array entry, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270630T035959Z", "EXDATE;TZID=America/New_York:20260912T090000"]. Accepts RRULE, EXRULE, RDATE, and EXDATE; DTSTART is rejected because start/end define it. Omit for a single event.'
  );

/**
 * Resolve the IANA time zone a timed recurring event needs. Falls back to the
 * target calendar's own zone — what the Calendar UI does — so a caller who
 * passed a correct RFC 3339 offset is not rejected for omitting a field the
 * single-event path never needed.
 */
async function resolveRecurrenceTimeZone(
  ctx: WorkspaceContext,
  calendarIdValue: string,
  explicit: string | undefined
): Promise<string> {
  if (explicit) return explicit;
  const result = await callGoogle(ctx, 'read calendar time zone', () =>
    ctx.calendar.calendars.get({ calendarId: calendarIdValue, fields: 'timeZone' })
  );
  const zone = result.data.timeZone;
  if (!zone) {
    throw new Error(
      'A timed recurring event needs an IANA timeZone and this calendar does not declare one; pass timeZone explicitly, for example "America/New_York".'
    );
  }
  return zone;
}

function eventTime(value: string, timeZone?: string): { date?: string; dateTime?: string; timeZone?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('Timed events require an RFC 3339 offset, e.g. 2026-07-24T17:30:00-04:00.');
  }
  return { dateTime: new Date(value).toISOString(), ...(timeZone ? { timeZone } : {}) };
}

export function registerWorkspaceTools(
  server: McpServer,
  options: { driveDownload?: DriveDownloadToolDependencies; driveUploadTicket?: DriveUploadTicketToolDependencies } = {},
): void {
  // Sheets
  register(
    server,
    'sheets_create_spreadsheet',
    'Create a new blank Google Sheets spreadsheet with its default first tab.',
    {
      account,
      title: z.string().min(1).max(100).describe('Title for the new spreadsheet.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'create spreadsheet', () =>
        ctx.sheets.spreadsheets.create({
          requestBody: { properties: { title: args.title } },
          fields:
            'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))',
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        spreadsheetId: result.data.spreadsheetId,
        spreadsheetUrl: result.data.spreadsheetUrl,
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'sheets_add_tab',
    'Add a named tab to an existing Google Sheets spreadsheet.',
    {
      account,
      spreadsheet: z.string(),
      title: z.string().min(1).max(100).describe('Title for the new tab.'),
      index: z.number().int().nonnegative().optional().describe('Zero-based tab position; omit to append.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const id = spreadsheetId(args.spreadsheet);
      const result = await callGoogle(ctx, 'add spreadsheet tab', () =>
        ctx.sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: args.title,
                    ...(args.index === undefined ? {} : { index: args.index }),
                  },
                },
              },
            ],
          },
          fields: 'spreadsheetId,replies.addSheet.properties(sheetId,title,index,gridProperties(rowCount,columnCount))',
        })
      );
      const properties = result.data.replies?.[0]?.addSheet?.properties;
      return {
        account: ctx.alias,
        email: ctx.email,
        spreadsheetId: result.data.spreadsheetId ?? id,
        sheetId: properties?.sheetId,
        title: properties?.title,
        index: properties?.index,
        rows: properties?.gridProperties?.rowCount,
        columns: properties?.gridProperties?.columnCount,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

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

  register(
    server,
    'sheets_delete_rows',
    'Permanently delete one or more rows from a Google Sheets tab, shifting later rows upward.',
    {
      account,
      spreadsheet: z.string(),
      sheetId: z
        .number()
        .int()
        .nonnegative()
        .describe('Numeric tab ID returned by sheets_get_metadata.'),
      startRow: z.number().int().positive().describe('First row to delete, using 1-based row numbers.'),
      endRow: z
        .number()
        .int()
        .positive()
        .describe('Last row to delete, inclusive, using 1-based row numbers.'),
    },
    async (args) => {
      if (args.endRow < args.startRow) {
        throw new Error('endRow must be greater than or equal to startRow.');
      }
      const ctx = workspaceFor(args.account);
      const id = spreadsheetId(args.spreadsheet);
      await callGoogle(ctx, 'delete spreadsheet rows', () =>
        ctx.sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: args.sheetId,
                    dimension: 'ROWS',
                    startIndex: args.startRow - 1,
                    endIndex: args.endRow,
                  },
                },
              },
            ],
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        spreadsheetId: id,
        sheetId: args.sheetId,
        startRow: args.startRow,
        endRow: args.endRow,
        deletedRowCount: args.endRow - args.startRow + 1,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  );

  register(
    server,
    'sheets_hide_rows',
    'Hide one or more rows in a Google Sheets tab without deleting their contents.',
    {
      account,
      spreadsheet: z.string(),
      sheetId: z
        .number()
        .int()
        .nonnegative()
        .describe('Numeric tab ID returned by sheets_get_metadata.'),
      startRow: z.number().int().positive().describe('First row to hide, using 1-based row numbers.'),
      endRow: z
        .number()
        .int()
        .positive()
        .describe('Last row to hide, inclusive, using 1-based row numbers.'),
    },
    async (args) => {
      if (args.endRow < args.startRow) {
        throw new Error('endRow must be greater than or equal to startRow.');
      }
      const ctx = workspaceFor(args.account);
      const id = spreadsheetId(args.spreadsheet);
      await callGoogle(ctx, 'hide spreadsheet rows', () =>
        ctx.sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [
              {
                updateDimensionProperties: {
                  range: {
                    sheetId: args.sheetId,
                    dimension: 'ROWS',
                    startIndex: args.startRow - 1,
                    endIndex: args.endRow,
                  },
                  properties: { hiddenByUser: true },
                  fields: 'hiddenByUser',
                },
              },
            ],
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        spreadsheetId: id,
        sheetId: args.sheetId,
        startRow: args.startRow,
        endRow: args.endRow,
        hiddenRowCount: args.endRow - args.startRow + 1,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  );

  // Drive
  register(
    server,
    'drive_search_files',
    'Search Google Drive files, including shared drives, using Drive query syntax.',
    {
      account,
      query: z.string().optional().describe('Drive q expression; defaults to "trashed = false".'),
      driveId: z
        .string()
        .optional()
        .describe('Optional shared-drive ID to scope the search to a single shared drive. Omit to search across My Drive plus all shared drives you can access.'),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken: z.string().optional(),
      verbose: z.boolean().optional().describe('Return the full legacy metadata shape. Defaults to false.'),
      fields: z.string().optional().describe('Optional Drive files.list fields mask override.'),
      parentId: z.string().optional(),
      nameContains: z.string().optional(),
      modifiedAfter: z.string().optional().describe('RFC3339 timestamp.'),
      orderBy: z.string().optional().describe('Defaults to modifiedTime desc.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'search Drive files', () =>
        ctx.drive.files.list({
          q: driveSearchQuery(args),
          pageSize: args.pageSize ?? 10,
          pageToken: args.pageToken,
          orderBy: args.orderBy ?? 'modifiedTime desc',
          fields: driveMetadataFields(args.verbose, args.fields, true),
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          corpora: args.driveId ? 'drive' : 'allDrives',
          ...(args.driveId ? { driveId: args.driveId } : {}),
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
    {
      account, fileId: z.string(),
      verbose: z.boolean().optional().describe('Return the full legacy metadata shape. Defaults to false.'),
      fields: z.string().optional().describe('Optional Drive files.get fields mask override.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'get Drive file', () =>
        ctx.drive.files.get({
          fileId: args.fileId,
          fields: driveMetadataFields(args.verbose, args.fields),
          supportsAllDrives: true,
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_read_text',
    'Read a small UTF-8 Drive text file or export a Google Doc, Sheet, or Slide inline. Maximum 102400 bytes.',
    { account, fileId: z.string(), maxBytes: z.number().int().min(1).max(MAX_INLINE_TEXT_BYTES).optional() },
    async (args) => readDriveText(workspaceFor(args.account), args.fileId, args.maxBytes),
    { readOnlyHint: true }
  );

  register(
    server,
    'drive_get_files',
    'Get metadata for up to 50 Drive files in one batch, preserving a result or error for every ID.',
    { account, fileIds: z.array(z.string()).min(1).max(50) },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const { boundary, body } = buildDriveBatchBody(args.fileIds, LEAN_DRIVE_FILE_FIELDS);
      const response = await authorizedGoogleFetch(ctx, 'https://www.googleapis.com/batch/drive/v3', {
        method: 'POST',
        headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
        body,
      });
      if (!response.ok) throw new Error(`Drive batch metadata request failed with HTTP ${response.status}.`);
      const files = parseDriveBatchResponse(await response.text(), response.headers.get('content-type') ?? '', args.fileIds);
      return { account: ctx.alias, email: ctx.email, files };
    },
    { readOnlyHint: true }
  );

  if (isRemote()) {
    registerDriveDownloadTool(server, options.driveDownload);
    registerDriveUploadTicketTool(server, options.driveUploadTicket);
  }

  // Writes into the local CoWork inbox, so it only means anything when the server runs on
  // the caller's machine. The remote build does not advertise it at all rather
  // than advertising a tool that always throws.
  if (!isRemote()) register(
    server,
    'drive_download_file',
    'Download a binary Drive file or export a Google Workspace file to ~/Documents/CoWork OS/inbox/ on the machine running this server (local-only).',
    {
      account,
      fileId: z.string(),
      filename: z.string(),
      exportMimeType: z
        .string()
        .optional()
        .describe('Required for Google Docs/Sheets/Slides, e.g. application/pdf.'),
      returnContent: z.boolean().optional().describe('Also return UTF-8 text inline when the file is text and at most 102400 bytes.'),
    },
    async (args) => {
      if (isRemote()) throw new Error('drive_download_file is local-only; use Drive export/download from the MCP client.');
      const ctx = workspaceFor(args.account);
      const inline = args.returnContent ? await readDriveText(ctx, args.fileId) : undefined;
      if (inline && args.exportMimeType && args.exportMimeType !== textExportMimeType(inline.mimeType as string)) {
        throw new Error('returnContent requires the supported plain-text export MIME type for this file.');
      }
      const response = inline ? undefined : args.exportMimeType
        ? await callGoogle(ctx, 'export Drive file', () =>
            ctx.drive.files.export(
              { fileId: args.fileId, mimeType: args.exportMimeType },
              { responseType: 'arraybuffer' }
            )
          )
        : await callGoogle(ctx, 'download Drive file', () =>
            ctx.drive.files.get(
              { fileId: args.fileId, alt: 'media', supportsAllDrives: true },
              { responseType: 'arraybuffer' }
            )
          );
      const safe = path.basename(args.filename);
      const directory = path.join(os.homedir(), 'Documents', 'CoWork OS', 'inbox');
      fs.mkdirSync(directory, { recursive: true });
      let target = path.join(directory, safe);
      const parsed = path.parse(target);
      for (let i = 1; fs.existsSync(target); i++) {
        target = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
      }
      fs.writeFileSync(target, inline ? Buffer.from(inline.content as string, 'utf8') : Buffer.from(response!.data as ArrayBuffer));
      return { account: ctx.alias, email: ctx.email, fileId: args.fileId, path: target, ...(inline ?? {}) };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'drive_create_folder',
    'Create a Google Drive folder, including inside a shared drive.',
    {
      account,
      name: z.string(),
      parentId: z
        .string()
        .optional()
        .describe('Parent folder ID; may be a shared-drive folder or a shared-drive root ID. Defaults to My Drive root.'),
    },
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
          supportsAllDrives: true,
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'drive_upload_file',
    isRemote()
      ? 'Upload inline base64 content to Google Drive.'
      : 'Upload a local file (or inline base64 content) to Google Drive.',
    {
      account,
      filename: z.string().optional().describe('Name for a new file in Drive, e.g. "report.pdf". Omit with fileId to retain the existing name.'),
      fileId: z
        .string()
        .optional()
        .describe('Existing Drive file ID to replace in place. The file keeps this ID; omit to create a new file.'),
      // Reading from disk only means anything when the server runs on the same
      // machine as the caller. The deployed Worker has no filesystem, so the
      // remote build does not advertise `path` at all.
      ...(isRemote()
        ? {}
        : {
            path: z
              .string()
              .optional()
              .describe(
                'Absolute local file path to upload, read from disk on the machine running this server. ' +
                  'Only works for a locally-run server. Use this OR content.'
              ),
          }),
      content: z
        .string()
        .optional()
        .describe(
          isRemote()
            ? 'Base64-encoded file content.'
            : 'Base64-encoded file content. Use this OR path, not both.'
        ),
      sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe('Optional expected SHA-256 of the uploaded bytes.'),
      mimeType: z
        .string()
        .optional()
        .describe('MIME type, e.g. "application/pdf". Inferred from the filename when omitted.'),
      parentId: z
        .string()
        .optional()
        .describe('Destination folder ID; may be a shared-drive folder or shared-drive root ID. Defaults to the account\'s My Drive root.'),
    },
    async (args) => {
      if (isRemote() && args.path) throw new Error('Remote uploads require inline base64 content; local paths are not accessible.');
      if (!args.filename && !args.fileId) throw new Error('filename is required when creating a new Drive file.');
      const ctx = workspaceFor(args.account);
      const source = resolveUploadSource({ path: args.path, content: args.content });
      let data: Uint8Array;
      if (source === 'path') {
        const filePath = args.path as string;
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          throw new Error(`No readable file at path: ${filePath}`);
        }
        data = new Uint8Array(fs.readFileSync(filePath));
      } else {
        assertInlineUploadSize(args.content as string);
        data = new Uint8Array(Buffer.from(args.content as string, 'base64'));
        assertInlineUploadSize(args.content as string, data.byteLength);
      }
      if (args.sha256 && createHash('sha256').update(data).digest('hex') !== args.sha256.toLowerCase()) {
        throw new Error('Uploaded bytes do not match the supplied SHA-256.');
      }
      const mimeType = args.mimeType ?? mimeTypeForFilename(args.filename ?? 'upload.bin');
      const result = await callGoogle(ctx, 'upload Drive file', () =>
        uploadToDrive(ctx.auth, {
          metadata: {
            ...(args.filename ? { name: args.filename } : {}),
            ...(args.parentId ? { parents: [args.parentId] } : {}),
          },
          mimeType,
          data,
          ...(args.fileId ? { fileId: args.fileId } : {}),
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  );

  register(
    server,
    'drive_import_presentation',
    'Upload a PowerPoint or OpenDocument presentation and convert it to native Google Slides.',
    {
      account,
      path: z
        .string()
        .describe('Absolute local path to a .ppt, .pptx, or .odp presentation.'),
      title: z.string().describe('Title for the native Google Slides presentation.'),
      parentId: z
        .string()
        .optional()
        .describe('Destination folder ID; may be a shared-drive folder or shared-drive root ID. Defaults to the account\'s My Drive root.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const filePath = args.path as string;
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`No readable file at path: ${filePath}`);
      }
      const sourceMimeType = mimeTypeForFilename(filePath);
      const acceptedSourceMimeTypes = new Set([
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.oasis.opendocument.presentation',
      ]);
      if (!acceptedSourceMimeTypes.has(sourceMimeType)) {
        throw new Error('Presentation import requires a .ppt, .pptx, or .odp source file.');
      }
      const result = await callGoogle(ctx, 'import Google Slides presentation', () =>
        ctx.drive.files.create({
          requestBody: {
            name: args.title,
            mimeType: 'application/vnd.google-apps.presentation',
            ...(args.parentId ? { parents: [args.parentId] } : {}),
          },
          media: { mimeType: sourceMimeType, body: fs.createReadStream(filePath) },
          fields: 'id,name,mimeType,parents,webViewLink,createdTime,modifiedTime',
          supportsAllDrives: true,
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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
          supportsAllDrives: true,
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
          ctx.drive.files.get({ fileId: args.fileId, fields: 'parents', supportsAllDrives: true })
        );
        removeParents = (current.data.parents ?? []).join(',') || undefined;
      }
      const result = await callGoogle(ctx, 'move Drive file', () =>
        ctx.drive.files.update({
          fileId: args.fileId,
          addParents: args.newParentId,
          removeParents,
          fields: 'id,name,mimeType,parents,webViewLink',
          supportsAllDrives: true,
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
            supportsAllDrives: true,
          })
        );
        return { account: ctx.alias, email: ctx.email, ...result.data };
      },
      { readOnlyHint: false, destructiveHint: trashed, idempotentHint: true }
    );
  trashDrive('drive_trash_file', true);
  trashDrive('drive_untrash_file', false);

  register(
    server,
    'drive_list_shared_drives',
    'List the shared drives the account can access, returning each drive id and name (use the id as driveId in drive_search_files or as a parent for uploads/folders).',
    {
      account,
      query: z
        .string()
        .optional()
        .describe('Optional shared-drive query, e.g. "name contains \'Marketing\'".'),
      pageSize: z.number().int().min(1).max(100).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'list shared drives', () =>
        ctx.drive.drives.list({
          q: args.query,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          fields: 'nextPageToken,drives(id,name,createdTime,hidden)',
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        nextPageToken: result.data.nextPageToken,
        drives: result.data.drives ?? [],
      };
    },
    { readOnlyHint: true }
  );

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
    'List events within an explicit time window. Every event reports an explicit transparency ("opaque" = Busy, "transparent" = Free) plus a busy boolean. Recurring events are expanded into individual instances by default; set expandRecurring false to get the underlying series with its recurrence rules instead.',
    {
      account,
      calendarId,
      timeMin: z.string().describe('RFC 3339 lower bound with timezone.'),
      timeMax: z.string().describe('RFC 3339 upper bound with timezone.'),
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional(),
      expandRecurring: z
        .boolean()
        .optional()
        .describe(
          'Defaults to true: expand each recurring event into its individual instances, ordered by start time. Set false to return the recurring series itself, which is the only form that carries the recurrence rules (and the only id that can be patched to change the whole series).'
        ),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const expandRecurring = args.expandRecurring ?? true;
      const result = await callGoogle(ctx, 'list calendar events', () =>
        ctx.calendar.events.list({
          calendarId: args.calendarId ?? 'primary',
          timeMin: new Date(args.timeMin).toISOString(),
          timeMax: new Date(args.timeMax).toISOString(),
          q: args.query,
          maxResults: args.maxResults ?? 100,
          pageToken: args.pageToken,
          // orderBy 'startTime' is only valid alongside singleEvents; asking for
          // the unexpanded series must fall back to the API's default ordering.
          singleEvents: expandRecurring,
          orderBy: expandRecurring ? 'startTime' : undefined,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        nextPageToken: result.data.nextPageToken,
        timeZone: result.data.timeZone,
        expandRecurring,
        events: (result.data.items ?? []).map(shapeEvent),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'calendar_get_availability',
    'Aggregate free/busy across the account\'s calendars in a time window. By default EVERY calendar visible to the account is included, so a conflict on any secondary calendar (Personal, Family, etc.) is reported as busy; pass calendarIds only as an explicit opt-in to narrow the check. Reports which calendars were included and surfaces per-calendar access errors instead of silently omitting them. Events marked Free (transparency "transparent") never contribute to busy, so use calendar_list_events when you need those too. Read-only; never crosses account boundaries.',
    {
      account,
      timeMin: z.string().describe('RFC 3339 lower bound with timezone.'),
      timeMax: z.string().describe('RFC 3339 upper bound with timezone.'),
      calendarIds: z
        .array(z.string())
        .optional()
        .describe(
          'Explicit opt-in: only these calendar IDs are checked. Omit to aggregate every calendar visible to the account (the default complete-availability behavior).'
        ),
      timeZone: z
        .string()
        .optional()
        .describe('IANA timezone used to interpret the free/busy response; defaults to the account calendar timezone.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const timeMin = new Date(args.timeMin).toISOString();
      const timeMax = new Date(args.timeMax).toISOString();

      // Resolve the calendar set. A narrow scope is an explicit opt-in; the
      // default enumerates every calendar visible to THIS account only — the
      // account boundary is preserved because we only ever touch ctx.calendar,
      // never another account's client.
      let scope: 'explicit' | 'all';
      let included: Array<{ id: string; summary?: string | null; accessRole?: string | null }>;
      if (args.calendarIds && args.calendarIds.length > 0) {
        scope = 'explicit';
        included = (args.calendarIds as string[]).map((id) => ({ id }));
      } else {
        scope = 'all';
        const list = await callGoogle(ctx, 'list calendars for availability', () =>
          ctx.calendar.calendarList.list({ maxResults: 250 })
        );
        included = (list.data.items ?? [])
          .filter((item) => item.id)
          .map((item) => ({ id: item.id as string, summary: item.summary, accessRole: item.accessRole }));
      }

      if (included.length === 0) {
        return {
          account: ctx.alias,
          email: ctx.email,
          timeMin,
          timeMax,
          scope,
          calendarsIncluded: [],
          calendarErrors: [],
          overallBusy: false,
          busy: [],
          free: [{ start: timeMin, end: timeMax }],
          note: 'No calendars resolved for this account.',
        };
      }

      // freebusy.query accepts at most 50 calendars per request, so batch.
      const merged: Record<string, CalendarFreeBusy> = {};
      for (const batch of chunkCalendarIds(included.map((c) => c.id))) {
        const res = await callGoogle(ctx, 'query free/busy', () =>
          ctx.calendar.freebusy.query({
            requestBody: {
              timeMin,
              timeMax,
              timeZone: args.timeZone,
              items: batch.map((id) => ({ id })),
            },
          })
        );
        Object.assign(merged, (res.data.calendars ?? {}) as Record<string, CalendarFreeBusy>);
      }

      const result = aggregateAvailability(timeMin, timeMax, merged);
      return {
        account: ctx.alias,
        email: ctx.email,
        timeMin,
        timeMax,
        scope,
        calendarsIncluded: included,
        calendarErrors: result.calendarErrors,
        overallBusy: result.overallBusy,
        busy: result.busy,
        free: result.free,
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'calendar_create_event',
    'Create a timed or all-day calendar event, optionally recurring, optionally marked Free, and optionally with a Google Meet video conference.',
    {
      account,
      calendarId,
      summary: z.string(),
      start: eventDateTime,
      end: eventDateTime,
      timeZone: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      transparency: eventTransparency,
      recurrence: eventRecurrence,
      attendees: z.array(z.string().email()).optional(),
      addGoogleMeet: z
        .boolean()
        .optional()
        .describe('If true, attach a Google Meet video conference and return its join link.'),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      // Validate recurrence before the call so a bad rule fails with a specific
      // message instead of an opaque Google 400.
      const recurrence = normalizeRecurrence(args.recurrence);
      const timeZone = needsRecurrenceTimeZone(args.start, recurrence)
        ? await resolveRecurrenceTimeZone(ctx, args.calendarId ?? 'primary', args.timeZone)
        : args.timeZone;
      const result = await callGoogle(ctx, 'create calendar event', () =>
        ctx.calendar.events.insert({
          calendarId: args.calendarId ?? 'primary',
          sendUpdates: args.sendUpdates ?? 'none',
          // conferenceDataVersion must be 1 for the API to honor a Meet createRequest.
          conferenceDataVersion: args.addGoogleMeet ? 1 : undefined,
          requestBody: {
            summary: args.summary,
            start: eventTime(args.start, timeZone),
            end: eventTime(args.end, timeZone),
            description: args.description,
            location: args.location,
            ...(args.transparency ? { transparency: args.transparency } : {}),
            ...(recurrence ? { recurrence } : {}),
            attendees: args.attendees?.map((email: string) => ({ email })),
            ...(args.addGoogleMeet
              ? {
                  conferenceData: {
                    createRequest: {
                      // requestId must be unique per create call; Google dedupes retries by it.
                      requestId: randomUUID(),
                      conferenceSolutionKey: { type: 'hangoutsMeet' },
                    },
                  },
                }
              : {}),
          },
        })
      );
      const meetLink =
        result.data.hangoutLink ??
        result.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
        undefined;
      return {
        account: ctx.alias,
        email: ctx.email,
        eventId: result.data.id,
        summary: result.data.summary,
        start: result.data.start,
        end: result.data.end,
        transparency: result.data.transparency ?? 'opaque',
        recurrence: result.data.recurrence,
        ...(recurrence && recurrence.length > 0 ? { recurrenceTimeZone: timeZone } : {}),
        htmlLink: result.data.htmlLink,
        ...(args.addGoogleMeet
          ? {
              meetLink,
              // 'success' | 'pending' | 'failure' — pending means Meet is still provisioning.
              conferenceStatus:
                result.data.conferenceData?.createRequest?.status?.statusCode ??
                (meetLink ? 'success' : 'pending'),
            }
          : {}),
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'calendar_update_event',
    'Patch selected fields on an existing calendar event, including its free/busy transparency and recurrence rules. To change a whole series, pass the recurring series id (from calendar_list_events with expandRecurring false), not an instance id.',
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
      transparency: eventTransparency,
      recurrence: eventRecurrence.describe(
        'Replacement RFC 5545 recurrence lines (RRULE, EXRULE, RDATE, EXDATE); they replace the existing rules wholesale. Pass an empty array to strip recurrence and turn the series back into a single event. Omit to leave recurrence untouched.'
      ),
      attendees: z.array(z.string().email()).optional(),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      if ((args.start && !args.end) || (!args.start && args.end)) {
        throw new Error('start and end must be updated together.');
      }
      const ctx = workspaceFor(args.account);
      const recurrence = normalizeRecurrence(args.recurrence);
      const timeZone =
        args.start && needsRecurrenceTimeZone(args.start, recurrence)
          ? await resolveRecurrenceTimeZone(ctx, args.calendarId ?? 'primary', args.timeZone)
          : args.timeZone;
      const result = await callGoogle(ctx, 'update calendar event', () =>
        ctx.calendar.events.patch({
          calendarId: args.calendarId ?? 'primary',
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? 'none',
          requestBody: {
            summary: args.summary,
            ...(args.start
              ? { start: eventTime(args.start, timeZone), end: eventTime(args.end, timeZone) }
              : {}),
            description: args.description,
            location: args.location,
            ...(args.transparency ? { transparency: args.transparency } : {}),
            // An explicit empty array is meaningful here: it clears recurrence.
            ...(recurrence ? { recurrence } : {}),
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
        transparency: result.data.transparency ?? 'opaque',
        recurrence: result.data.recurrence,
        htmlLink: result.data.htmlLink,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'calendar_respond_to_event',
    'Accept, decline, or tentatively accept a calendar invitation for the selected account without changing other attendees or event details.',
    {
      account,
      calendarId,
      eventId: z.string(),
      responseStatus: z.enum(['accepted', 'declined', 'tentative']),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const selectedCalendarId = args.calendarId ?? 'primary';
      const current = await callGoogle(ctx, 'get calendar invitation', () =>
        ctx.calendar.events.get({
          calendarId: selectedCalendarId,
          eventId: args.eventId,
          fields: 'id,summary,start,end,htmlLink,organizer,attendees',
        })
      );
      const self = findSelfAttendee(current.data.attendees, ctx.email);
      if (!self?.email) {
        throw new Error(
          `The selected account ${ctx.email} is not an attendee on event ${args.eventId}; no RSVP was changed.`
        );
      }
      const selfEmail = self.email;

      const previousResponseStatus = self.responseStatus;
      const result = await callGoogle(ctx, 'respond to calendar invitation', () =>
        ctx.calendar.events.patch({
          calendarId: selectedCalendarId,
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? 'all',
          requestBody: buildRsvpPatchBody(selfEmail, args.responseStatus),
        })
      );
      const updatedSelf = findSelfAttendee(result.data.attendees, ctx.email);
      return {
        account: ctx.alias,
        email: ctx.email,
        calendarId: selectedCalendarId,
        eventId: result.data.id,
        summary: result.data.summary,
        start: result.data.start,
        end: result.data.end,
        organizer: result.data.organizer,
        previousResponseStatus,
        responseStatus: updatedSelf?.responseStatus ?? args.responseStatus,
        htmlLink: result.data.htmlLink,
      };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
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
        ctx.docs.documents.get({
          documentId: documentId(args.document),
          includeTabsContent: true,
        })
      );
      const tabs = documentTabs(result.data.tabs);
      return {
        account: ctx.alias,
        email: ctx.email,
        documentId: result.data.documentId,
        title: result.data.title,
        text: tabs.length
          ? tabs.map((tab) => tab.text).filter(Boolean).join('\n\n')
          : documentText(result.data.body?.content),
        tabs,
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
