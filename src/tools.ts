import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { loadConfig } from './accounts.js';
import { authorizeAccount } from './auth.js';
import { gmailFor, callGmail, type AccountContext } from './gmail.js';
import { shapeMessage, shapeThread, shapeThreadSummary, header, extractBody } from './shape.js';
import {
  cancelScheduledSend,
  listScheduledSends,
  scheduleDraftSend,
} from './scheduler.js';

const PREFIX = 'Multi-account Gmail (all connected accounts). ';
const account = z
  .string()
  .describe('Which Gmail account to use: an alias (e.g. "personal", "work") or the email address. See list_accounts.');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }],
});
const fail = (e: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
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
    } catch (e) {
      console.error(`gmail-multi ${name}:`, e instanceof Error ? e.message : e);
      return fail(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Compose helpers
// ---------------------------------------------------------------------------

interface ComposeAttachment {
  filename: string;
  path?: string;
  contentBase64?: string;
  contentType?: string;
  cid?: string;
}

interface ComposeArgs {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  html?: string;
  attachments?: ComposeAttachment[];
  replyToMessageId?: string;
}

interface ExistingDraft {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  html?: string;
  attachments?: ComposeAttachment[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

const composeShape = {
  to: z.array(z.string()).optional().describe('Recipient email addresses. Optional when replying — defaults to the original sender.'),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional().describe('Optional when replying — defaults to "Re: <original subject>".'),
  body: z.string().describe('Plain-text message body. Always required as a fallback, even when html is set.'),
  html: z
    .string()
    .optional()
    .describe(
      'Optional HTML message body (e.g. for real <table> layouts). When set, the message is sent as ' +
        'multipart/alternative with "body" as the plain-text fallback and this as the HTML part. ' +
        'Inline images: reference them as <img src="cid:some-id"> and give the matching attachment a "cid" of "some-id".'
    ),
  attachments: z
    .array(
      z.object({
        filename: z.string().describe('Attachment filename as it should appear to the recipient, e.g. "report.png".'),
        path: z
          .string()
          .optional()
          .describe('Absolute local file path to attach (read from disk on the machine running this server).'),
        contentBase64: z
          .string()
          .optional()
          .describe('Base64-encoded file content. Use this OR path, not both.'),
        contentType: z.string().optional().describe('MIME type, e.g. "image/png". Inferred from filename if omitted.'),
        cid: z
          .string()
          .optional()
          .describe('Content-ID for referencing this attachment inline from the html body as <img src="cid:...">.'),
      })
    )
    .optional()
    .describe('Optional file attachments (from a local path or inline base64 content).'),
  replyToMessageId: z
    .string()
    .optional()
    .describe('Gmail message ID being replied to. Sets correct threading headers (In-Reply-To/References) and threadId automatically.'),
};

async function buildMime(
  ctx: AccountContext,
  args: ComposeArgs,
  existing?: ExistingDraft
): Promise<{ raw: string; threadId?: string }> {
  let { to, cc, bcc, subject } = args;
  to ??= existing?.to;
  cc ??= existing?.cc;
  bcc ??= existing?.bcc;
  subject ??= existing?.subject;
  let inReplyTo: string | undefined = existing?.inReplyTo;
  let references: string | undefined = existing?.references;
  let threadId: string | undefined = existing?.threadId;

  if (args.replyToMessageId) {
    const orig = await callGmail(ctx, 'fetch reply target', () =>
      ctx.gmail.users.messages.get({
        userId: 'me',
        id: args.replyToMessageId!,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'],
      })
    );
    threadId = orig.data.threadId ?? undefined;
    const origMsgId = header(orig.data.payload, 'Message-ID');
    if (origMsgId) {
      inReplyTo = origMsgId;
      references = [header(orig.data.payload, 'References'), origMsgId].filter(Boolean).join(' ');
    }
    if (!subject) {
      const s = header(orig.data.payload, 'Subject');
      subject = /^re:/i.test(s) ? s : `Re: ${s}`;
    }
    if (!to || to.length === 0) {
      to = [header(orig.data.payload, 'Reply-To') || header(orig.data.payload, 'From')];
    }
  }
  if (!to || to.length === 0) throw new Error('"to" is required unless replyToMessageId is provided.');

  const attachments = (args.attachments ?? existing?.attachments ?? []).map((a) => {
    if (!a.path && !a.contentBase64) {
      throw new Error(`Attachment "${a.filename}" needs either "path" or "contentBase64".`);
    }
    return {
      filename: a.filename,
      path: a.path,
      content: a.contentBase64 ? Buffer.from(a.contentBase64, 'base64') : undefined,
      contentType: a.contentType,
      cid: a.cid,
    };
  });

  const mail = new MailComposer({
    to,
    cc,
    bcc,
    subject,
    text: args.body ?? existing?.body,
    html: args.html ?? existing?.html,
    attachments: attachments.length ? attachments : undefined,
    inReplyTo,
    references,
  });
  const buf = await new Promise<Buffer>((resolve, reject) =>
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)))
  );
  return { raw: buf.toString('base64url'), threadId };
}

function allHeaderValues(value: string): string[] | undefined {
  return value ? [value] : undefined;
}

function decodePartData(data?: string | null): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

async function existingDraftContent(ctx: AccountContext, draftId: string): Promise<{
  draft: any;
  existing: ExistingDraft;
}> {
  const draft = await callGmail(ctx, 'get draft', () =>
    ctx.gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' })
  );
  const message = draft.data.message;
  if (!message?.payload) throw new Error(`Draft ${draftId} has no message payload.`);
  const payload = message.payload;
  const extracted = extractBody(payload);
  const htmlParts: string[] = [];
  const attachments: ComposeAttachment[] = [];

  const walk = async (part: any): Promise<void> => {
    if (part.mimeType === 'text/html' && part.body?.data) htmlParts.push(decodePartData(part.body.data));
    const contentId = header(part, 'Content-ID').replace(/^<|>$/g, '') || undefined;
    if ((part.filename || contentId) && (part.body?.attachmentId || part.body?.data)) {
      let contentBase64: string;
      if (part.body.attachmentId) {
        const attachment = await callGmail(ctx, 'read draft attachment', () =>
          ctx.gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: message.id!,
            id: part.body.attachmentId,
          })
        );
        contentBase64 = Buffer.from(attachment.data.data ?? '', 'base64url').toString('base64');
      } else {
        contentBase64 = Buffer.from(part.body.data, 'base64url').toString('base64');
      }
      attachments.push({
        filename: part.filename || `inline-${attachments.length + 1}`,
        contentBase64,
        contentType: part.mimeType ?? undefined,
        cid: contentId,
      });
    }
    for (const child of part.parts ?? []) await walk(child);
  };
  await walk(payload);

  return {
    draft,
    existing: {
      to: allHeaderValues(header(payload, 'To')),
      cc: allHeaderValues(header(payload, 'Cc')),
      bcc: allHeaderValues(header(payload, 'Bcc')),
      subject: header(payload, 'Subject'),
      body: extracted.text,
      html: htmlParts.length ? htmlParts.join('\n') : undefined,
      attachments,
      threadId: message.threadId ?? undefined,
      inReplyTo: header(payload, 'In-Reply-To') || undefined,
      references: header(payload, 'References') || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Label name/ID resolution (per-account cache, refreshed on miss)
// ---------------------------------------------------------------------------

const labelCache = new Map<string, Map<string, string>>(); // alias -> lowercased name -> id

async function labelMap(ctx: AccountContext, refresh = false): Promise<Map<string, string>> {
  if (!refresh) {
    const cached = labelCache.get(ctx.alias);
    if (cached) return cached;
  }
  const res = await callGmail(ctx, 'list labels', () => ctx.gmail.users.labels.list({ userId: 'me' }));
  const map = new Map<string, string>();
  for (const l of res.data.labels ?? []) {
    if (l.name && l.id) map.set(l.name.toLowerCase(), l.id);
  }
  labelCache.set(ctx.alias, map);
  return map;
}

async function resolveLabelIds(ctx: AccountContext, labels: string[]): Promise<string[]> {
  let map = await labelMap(ctx);
  const ids: string[] = [];
  for (const label of labels) {
    if ([...map.values()].includes(label)) {
      ids.push(label); // already an ID
      continue;
    }
    let id = map.get(label.toLowerCase());
    if (!id) {
      map = await labelMap(ctx, true);
      id = map.get(label.toLowerCase());
    }
    if (!id) {
      throw new Error(`No label "${label}" in ${ctx.email}. Labels: ${[...map.keys()].sort().join(', ')}`);
    }
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  // --- Accounts ---

  register(
    server,
    'list_accounts',
    PREFIX + 'List the connected Gmail accounts (alias + email). Call this when unsure which accounts exist or what to pass as "account".',
    {},
    async () => {
      const config = loadConfig();
      return Object.entries(config.accounts).map(([alias, a]) => ({
        alias,
        email: a.email,
        isDefault: config.defaultAccount === alias,
      }));
    }
  );

  register(
    server,
    'add_account',
    PREFIX +
      'Connect a new Gmail account via OAuth: opens a browser for authorization and stores the token locally. ' +
      'If this times out before the user finishes, run instead in a terminal: npm run auth -- --alias <alias> (in the gmail-mcp project).',
    {
      alias: z.string().describe('Short friendly name for the account, e.g. "personal" or "work".'),
      email: z.string().optional().describe('Expected email address — aborts if a different account is authorized.'),
      credentialsPath: z
        .string()
        .optional()
        .describe(
          'Optional path to this account organization\'s Desktop OAuth client JSON. ' +
            'Use this when different Workspace organizations require different OAuth apps.'
        ),
    },
    async (args) => {
      const result = await authorizeAccount(args.alias, args.email, args.credentialsPath);
      return `Account "${result.alias}" (${result.email}) connected and ready.`;
    }
  );

  // --- Read / search ---

  register(
    server,
    'search_threads',
    PREFIX +
      'Search email threads in one account using full Gmail search syntax ' +
      '(e.g. "from:alice is:unread newer_than:7d has:attachment subject:invoice"). Returns compact thread summaries.',
    {
      account,
      query: z.string().describe('Gmail search query.'),
      maxResults: z.number().int().min(1).max(25).optional().describe('Default 10, max 25.'),
      pageToken: z.string().optional().describe('From a previous result, for pagination.'),
      labelIds: z.array(z.string()).optional().describe('Restrict to these label IDs (e.g. ["INBOX"]).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'search threads', () =>
        ctx.gmail.users.threads.list({
          userId: 'me',
          q: args.query,
          maxResults: args.maxResults ?? 10,
          pageToken: args.pageToken,
          labelIds: args.labelIds,
        })
      );
      const threads = res.data.threads ?? [];
      const detailed = await Promise.all(
        threads.map((t) =>
          callGmail(ctx, 'get thread summary', () =>
            ctx.gmail.users.threads.get({
              userId: 'me',
              id: t.id!,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date'],
            })
          )
        )
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        resultSizeEstimate: res.data.resultSizeEstimate,
        ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
        threads: detailed.map((d) =>
          shapeThreadSummary(d.data, threads.find((t) => t.id === d.data.id)?.snippet)
        ),
      };
    }
  );

  register(
    server,
    'get_thread',
    PREFIX + 'Read a full email thread (all messages, bodies, attachment metadata).',
    {
      account,
      threadId: z.string(),
      includeFullBodies: z.boolean().optional().describe('Default true. Set false for a quick skim (300-char bodies).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'get thread', () =>
        ctx.gmail.users.threads.get({ userId: 'me', id: args.threadId, format: 'full' })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        threadId: args.threadId,
        messages: shapeThread(res.data, args.includeFullBodies ?? true),
      };
    }
  );

  register(
    server,
    'get_message',
    PREFIX + 'Read a single email message in full (untruncated up to ~20k chars).',
    { account, messageId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'get message', () =>
        ctx.gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' })
      );
      return { account: ctx.alias, email: ctx.email, ...shapeMessage(res.data, 20000) };
    }
  );

  register(
    server,
    'download_attachment',
    PREFIX + 'Download an email attachment to ~/Downloads. Get attachmentId from get_thread/get_message.',
    {
      account,
      messageId: z.string(),
      attachmentId: z.string(),
      filename: z.string().optional().describe('Filename to save as (from the attachment metadata).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'download attachment', () =>
        ctx.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.messageId,
          id: args.attachmentId,
        })
      );
      if (!res.data.data) throw new Error('Attachment has no data.');
      const safe = (args.filename ?? `attachment-${args.attachmentId.slice(0, 12)}`).replace(/[/\\]/g, '_');
      let target = path.join(os.homedir(), 'Downloads', safe);
      const { name, ext } = path.parse(target);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(os.homedir(), 'Downloads', `${name}-${i}${ext}`);
      fs.writeFileSync(target, Buffer.from(res.data.data, 'base64url'));
      return `Saved to ${target} (${res.data.size ?? 'unknown'} bytes).`;
    }
  );

  // --- Compose / send ---

  register(
    server,
    'create_draft',
    PREFIX +
      'Create a draft email (does NOT send). Supports replies via replyToMessageId, an optional HTML body ' +
      '(for real tables/formatting, sent alongside the plain-text body as multipart/alternative), and optional ' +
      'file attachments (from a local path or base64 content, including inline images via cid).',
    { account, ...composeShape },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { raw, threadId } = await buildMime(ctx, args);
      const res = await callGmail(ctx, 'create draft', () =>
        ctx.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId } } })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        draftId: res.data.id,
        messageId: res.data.message?.id,
        note: 'Draft created — visible in Gmail. Use send_draft to send it.',
      };
    }
  );

  register(
    server,
    'list_drafts',
    PREFIX + 'List saved drafts with their subjects and recipients.',
    { account, maxResults: z.number().int().min(1).max(25).optional().describe('Default 10.') },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'list drafts', () =>
        ctx.gmail.users.drafts.list({ userId: 'me', maxResults: args.maxResults ?? 10 })
      );
      const drafts = res.data.drafts ?? [];
      const detailed = await Promise.all(
        drafts.map((d) =>
          callGmail(ctx, 'get draft', () =>
            ctx.gmail.users.drafts.get({ userId: 'me', id: d.id!, format: 'metadata' })
          )
        )
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        drafts: detailed.map((d) => ({
          draftId: d.data.id,
          messageId: d.data.message?.id,
          to: header(d.data.message?.payload, 'To'),
          subject: header(d.data.message?.payload, 'Subject'),
          threadId: d.data.message?.threadId,
        })),
      };
    }
  );

  register(
    server,
    'get_draft',
    PREFIX + 'Read an existing draft before reviewing or updating it.',
    { account, draftId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'get draft', () =>
        ctx.gmail.users.drafts.get({ userId: 'me', id: args.draftId, format: 'full' })
      );
      if (!res.data.message) throw new Error(`Draft ${args.draftId} has no message.`);
      return {
        account: ctx.alias,
        email: ctx.email,
        draftId: res.data.id,
        ...shapeMessage(res.data.message, 20000),
        bcc: header(res.data.message.payload, 'Bcc') || undefined,
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'update_draft',
    PREFIX +
      'Update an existing draft after reading it. Omitted recipients, subject, body, HTML, threading headers, ' +
      'and attachments are preserved. Pass attachments: [] or removeHtml: true to remove those parts.',
    {
      account,
      draftId: z.string(),
      to: composeShape.to,
      cc: composeShape.cc,
      bcc: composeShape.bcc,
      subject: composeShape.subject,
      body: z.string().optional().describe('Replacement plain-text body. Omit to preserve the current body.'),
      html: composeShape.html,
      removeHtml: z.boolean().optional().describe('Set true to remove the existing HTML alternative.'),
      attachments: composeShape.attachments,
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { existing } = await existingDraftContent(ctx, args.draftId);
      if (args.removeHtml) existing.html = undefined;
      const { raw, threadId } = await buildMime(
        ctx,
        {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          body: args.body ?? existing.body,
          html: args.html,
          attachments: args.attachments,
        },
        existing
      );
      const updated = await callGmail(ctx, 'update draft', () =>
        ctx.gmail.users.drafts.update({
          userId: 'me',
          id: args.draftId,
          requestBody: { id: args.draftId, message: { raw, threadId } },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        draftId: updated.data.id,
        messageId: updated.data.message?.id,
        threadId: updated.data.message?.threadId,
        updated: true,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  );

  register(
    server,
    'delete_draft',
    PREFIX + 'Delete a draft permanently (use this to discard a draft the user rejected). Does not affect sent mail.',
    { account, draftId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'delete draft', () => ctx.gmail.users.drafts.delete({ userId: 'me', id: args.draftId }));
      return `Draft ${args.draftId} deleted in ${ctx.email}.`;
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  register(
    server,
    'send_draft',
    PREFIX + 'Send an existing draft immediately as the selected account. Only call after explicit user approval.',
    { account, draftId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'send draft', () =>
        ctx.gmail.users.drafts.send({ userId: 'me', requestBody: { id: args.draftId } })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        sent: true,
        messageId: res.data.id,
        threadId: res.data.threadId,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'send_message',
    PREFIX +
      'Send an email immediately as the selected account. Prefer create_draft unless the user explicitly requested sending.',
    { account, ...composeShape },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { raw, threadId } = await buildMime(ctx, args);
      const res = await callGmail(ctx, 'send message', () =>
        ctx.gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        sent: true,
        messageId: res.data.id,
        threadId: res.data.threadId,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'schedule_draft_send',
    PREFIX +
      'Schedule an existing Gmail draft to send later. The local MCP process must run at or after sendAt; ' +
      'overdue jobs send on the next startup. Scheduling authorizes that future send.',
    {
      account,
      draftId: z.string(),
      sendAt: z
        .string()
        .describe('ISO 8601 timestamp with timezone, e.g. 2026-07-24T17:30:00-04:00.'),
    },
    async (args) => scheduleDraftSend(args.account, args.draftId, args.sendAt),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'schedule_send',
    PREFIX + 'Create a visible Gmail draft and schedule it to send later in one operation.',
    {
      account,
      sendAt: z
        .string()
        .describe('ISO 8601 timestamp with timezone, e.g. 2026-07-24T17:30:00-04:00.'),
      ...composeShape,
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { sendAt, account: _account, ...composeArgs } = args;
      const { raw, threadId } = await buildMime(ctx, composeArgs);
      const draft = await callGmail(ctx, 'create scheduled draft', () =>
        ctx.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId } } })
      );
      if (!draft.data.id) throw new Error('Gmail created a draft without returning its ID.');
      const scheduled = await scheduleDraftSend(ctx.alias, draft.data.id, sendAt);
      return { ...scheduled, messageId: draft.data.message?.id };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'list_scheduled_sends',
    PREFIX + 'List scheduled sends, optionally including completed, failed, or cancelled history.',
    {
      account: account.optional(),
      includeCompleted: z.boolean().optional().describe('Default false.'),
    },
    async (args) => listScheduledSends(args.account, args.includeCompleted ?? false),
    { readOnlyHint: true }
  );

  register(
    server,
    'cancel_scheduled_send',
    PREFIX + 'Cancel a future scheduled send. The Gmail draft remains available.',
    { scheduleId: z.string() },
    async (args) => cancelScheduledSend(args.scheduleId),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  );

      // --- Labels ---

  register(
    server,
    'list_labels',
    PREFIX + 'List all labels in one account (system + user labels).',
    { account },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'list labels', () => ctx.gmail.users.labels.list({ userId: 'me' }));
      labelCache.delete(ctx.alias); // listing is the freshest source; let the cache rebuild
      return {
        account: ctx.alias,
        email: ctx.email,
        labels: (res.data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      };
    }
  );

  register(server, 'create_label', PREFIX + 'Create a new label.', { account, name: z.string() }, async (args) => {
    const ctx = gmailFor(args.account);
    const res = await callGmail(ctx, 'create label', () =>
      ctx.gmail.users.labels.create({ userId: 'me', requestBody: { name: args.name } })
    );
    labelCache.delete(ctx.alias);
    return { account: ctx.alias, labelId: res.data.id, name: res.data.name };
  });

  register(
    server,
    'update_label',
    PREFIX + 'Rename a label.',
    { account, labelId: z.string(), name: z.string().describe('New name.') },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'update label', () =>
        ctx.gmail.users.labels.patch({ userId: 'me', id: args.labelId, requestBody: { name: args.name } })
      );
      labelCache.delete(ctx.alias);
      return { account: ctx.alias, labelId: res.data.id, name: res.data.name };
    }
  );

  register(
    server,
    'delete_label',
    PREFIX + 'Delete a label (does not delete the emails carrying it).',
    { account, labelId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'delete label', () => ctx.gmail.users.labels.delete({ userId: 'me', id: args.labelId }));
      labelCache.delete(ctx.alias);
      return `Label ${args.labelId} deleted in ${ctx.email}.`;
    }
  );

  const labelsParam = z.array(z.string()).describe('Label names or IDs.');

  const modifyTool = (
    name: string,
    description: string,
    idField: 'threadId' | 'messageId',
    apply: (ctx: AccountContext, id: string, labelIds: string[]) => Promise<unknown>
  ) => {
    register(
      server,
      name,
      PREFIX + description,
      { account, [idField]: z.string(), labels: labelsParam },
      async (args) => {
        const ctx = gmailFor(args.account);
        const labelIds = await resolveLabelIds(ctx, args.labels);
        await apply(ctx, args[idField], labelIds);
        return `Done: ${name} [${args.labels.join(', ')}] on ${idField} ${args[idField]} in ${ctx.email}.`;
      }
    );
  };

  modifyTool('label_thread', 'Add labels to a thread.', 'threadId', (ctx, id, addLabelIds) =>
    callGmail(ctx, 'label thread', () =>
      ctx.gmail.users.threads.modify({ userId: 'me', id, requestBody: { addLabelIds } })
    )
  );
  modifyTool('unlabel_thread', 'Remove labels from a thread.', 'threadId', (ctx, id, removeLabelIds) =>
    callGmail(ctx, 'unlabel thread', () =>
      ctx.gmail.users.threads.modify({ userId: 'me', id, requestBody: { removeLabelIds } })
    )
  );
  modifyTool('label_message', 'Add labels to a single message.', 'messageId', (ctx, id, addLabelIds) =>
    callGmail(ctx, 'label message', () =>
      ctx.gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds } })
    )
  );
  modifyTool('unlabel_message', 'Remove labels from a single message.', 'messageId', (ctx, id, removeLabelIds) =>
    callGmail(ctx, 'unlabel message', () =>
      ctx.gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds } })
    )
  );

  // --- Archive / Trash ---

  register(
    server,
    'archive_thread',
    PREFIX + 'Archive a thread (remove it from the inbox; it stays searchable in All Mail).',
    { account, threadId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'archive thread', () =>
        ctx.gmail.users.threads.modify({ userId: 'me', id: args.threadId, requestBody: { removeLabelIds: ['INBOX'] } })
      );
      return `Thread ${args.threadId} archived in ${ctx.email}.`;
    }
  );

  register(
    server,
    'trash_thread',
    PREFIX + 'Move a whole thread to Trash (recoverable through Gmail for 30 days).',
    { account, threadId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'trash thread', () =>
        ctx.gmail.users.threads.trash({ userId: 'me', id: args.threadId })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        threadId: args.threadId,
        trashed: true,
        recoverable: true,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  register(
    server,
    'trash_message',
    PREFIX + 'Move one message to Trash (recoverable through Gmail for 30 days).',
    { account, messageId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'trash message', () =>
        ctx.gmail.users.messages.trash({ userId: 'me', id: args.messageId })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        messageId: args.messageId,
        trashed: true,
        recoverable: true,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );

  register(
    server,
    'untrash_thread',
    PREFIX + 'Restore a whole thread from Trash.',
    { account, threadId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'untrash thread', () =>
        ctx.gmail.users.threads.untrash({ userId: 'me', id: args.threadId })
      );
      return { account: ctx.alias, email: ctx.email, threadId: args.threadId, restored: true };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  );

  register(
    server,
    'untrash_message',
    PREFIX + 'Restore one message from Trash.',
    { account, messageId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'untrash message', () =>
        ctx.gmail.users.messages.untrash({ userId: 'me', id: args.messageId })
      );
      return { account: ctx.alias, email: ctx.email, messageId: args.messageId, restored: true };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  );

    }
