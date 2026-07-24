import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { chat_v1 } from 'googleapis';
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
const space = z
  .string()
  .describe('Google Chat space resource name from chat_list_spaces, for example "spaces/AAAA".');
const message = z
  .string()
  .describe('Google Chat message resource name, for example "spaces/AAAA/messages/BBBB.BBBB".');
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

async function callChat<T>(
  ctx: WorkspaceContext,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return callGmail(ctx, operation, fn);
}

function requireSpaceName(value: string): string {
  if (/^spaces\/[A-Za-z0-9_-]+$/.test(value)) return value;
  throw new Error('space must be a resource name returned by chat_list_spaces, e.g. "spaces/AAAA".');
}

function requireMessageName(value: string): string {
  if (/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/.test(value)) return value;
  throw new Error(
    'message must be a resource name returned by a Chat message tool, e.g. "spaces/AAAA/messages/BBBB.BBBB".'
  );
}

function requireReactionName(value: string): string {
  if (
    /^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+\/reactions\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    return value;
  }
  throw new Error('reaction must be a resource name returned by chat_list_reactions.');
}

function shapeSpace(item: chat_v1.Schema$Space) {
  return {
    name: item.name,
    displayName: item.displayName,
    spaceType: item.spaceType,
    spaceThreadingState: item.spaceThreadingState,
    spaceHistoryState: item.spaceHistoryState,
    lastActiveTime: item.lastActiveTime,
    membershipCount: item.membershipCount,
    spaceUri: item.spaceUri,
  };
}

function shapeAttachment(item: chat_v1.Schema$Attachment) {
  return {
    name: item.name,
    contentName: item.contentName,
    contentType: item.contentType,
    source: item.source,
    resourceName: item.attachmentDataRef?.resourceName,
    driveFileId: item.driveDataRef?.driveFileId,
  };
}

function shapeMessage(item: chat_v1.Schema$Message) {
  return {
    name: item.name,
    createTime: item.createTime,
    lastUpdateTime: item.lastUpdateTime,
    deleteTime: item.deleteTime,
    sender: item.sender,
    text: item.text,
    formattedText: item.formattedText,
    thread: item.thread?.name,
    threadReply: item.threadReply,
    attachments: (item.attachment ?? []).map(shapeAttachment),
    reactions: item.emojiReactionSummaries,
    quotedMessageMetadata: item.quotedMessageMetadata,
  };
}

export function registerChatTools(server: McpServer): void {
  register(
    server,
    'chat_list_spaces',
    'List Google Chat spaces, group chats, and direct messages that the selected user has joined. Empty chats might not appear until their first message.',
    {
      account,
      filter: z
        .string()
        .optional()
        .describe('Optional Chat space filter, e.g. spaceType = "SPACE" or spaceType = "DIRECT_MESSAGE".'),
      pageSize: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'list Chat spaces', () =>
        ctx.chat.spaces.list({
          filter: args.filter,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        nextPageToken: result.data.nextPageToken,
        spaces: (result.data.spaces ?? []).map(shapeSpace),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_get_space',
    'Get metadata for one joined Google Chat space.',
    { account, space },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'get Chat space', () =>
        ctx.chat.spaces.get({ name: requireSpaceName(args.space) })
      );
      return { account: ctx.alias, email: ctx.email, ...shapeSpace(result.data) };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_find_direct_message',
    'Find an existing direct-message space with one Google Chat user. This does not create a conversation.',
    {
      account,
      user: z
        .string()
        .describe('Email address or user resource name, e.g. colleague@example.com or users/123456789.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const user = args.user.startsWith('users/') ? args.user : `users/${args.user}`;
      const result = await callChat(ctx, 'find Chat direct message', () =>
        ctx.chat.spaces.findDirectMessage({ name: user })
      );
      return { account: ctx.alias, email: ctx.email, ...shapeSpace(result.data) };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_list_messages',
    'List messages in one joined Google Chat space. Supports date and thread filters; system messages are not returned.',
    {
      account,
      space,
      filter: z
        .string()
        .optional()
        .describe(
          'Optional Chat filter, e.g. createTime > "2026-07-24T00:00:00-04:00" or thread.name = spaces/AAAA/threads/BBBB.'
        ),
      orderBy: z.enum(['ASC', 'DESC']).optional(),
      showDeleted: z.boolean().optional(),
      pageSize: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'list Chat messages', () =>
        ctx.chat.spaces.messages.list({
          parent: requireSpaceName(args.space),
          filter: args.filter,
          orderBy: `createTime ${args.orderBy ?? 'DESC'}`,
          showDeleted: args.showDeleted ?? false,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        space: requireSpaceName(args.space),
        nextPageToken: result.data.nextPageToken,
        messages: (result.data.messages ?? []).map(shapeMessage),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_get_message',
    'Read one Google Chat message, including text, thread, attachment metadata, and reaction summaries.',
    { account, message },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'get Chat message', () =>
        ctx.chat.spaces.messages.get({ name: requireMessageName(args.message) })
      );
      return { account: ctx.alias, email: ctx.email, ...shapeMessage(result.data) };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_download_attachment',
    'Download one Google Chat attachment to ~/Downloads using its attachment resourceName. Drive-backed attachments should use drive_download_file instead.',
    {
      account,
      resourceName: z
        .string()
        .describe('attachmentDataRef.resourceName returned by chat_get_message or chat_list_messages.'),
      filename: z.string(),
    },
    async (args) => {
      if (!/^spaces\/.+\/attachments\/.+/.test(args.resourceName)) {
        throw new Error('resourceName must be the attachmentDataRef.resourceName returned by Chat.');
      }
      const ctx = workspaceFor(args.account);
      const response = await callChat(ctx, 'download Chat attachment', () =>
        ctx.chat.media.download(
          { resourceName: args.resourceName },
          { responseType: 'arraybuffer' }
        )
      );
      const safe = path.basename(args.filename);
      let target = path.join(os.homedir(), 'Downloads', safe);
      const parsed = path.parse(target);
      for (let i = 1; fs.existsSync(target); i++) {
        target = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
      }
      fs.writeFileSync(target, Buffer.from(response.data as ArrayBuffer));
      return {
        account: ctx.alias,
        email: ctx.email,
        resourceName: args.resourceName,
        path: target,
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_list_members',
    'List human or app memberships in one joined Google Chat space. This tool never changes membership.',
    {
      account,
      space,
      filter: z.string().optional().describe('Optional membership filter, e.g. member.type = "HUMAN".'),
      pageSize: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'list Chat members', () =>
        ctx.chat.spaces.members.list({
          parent: requireSpaceName(args.space),
          filter: args.filter,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        space: requireSpaceName(args.space),
        nextPageToken: result.data.nextPageToken,
        memberships: (result.data.memberships ?? []).map((item) => ({
          name: item.name,
          member: item.member,
          groupMember: item.groupMember,
          role: item.role,
          state: item.state,
          createTime: item.createTime,
        })),
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_list_reactions',
    'List reactions on one Google Chat message.',
    {
      account,
      message,
      filter: z.string().optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'list Chat reactions', () =>
        ctx.chat.spaces.messages.reactions.list({
          parent: requireMessageName(args.message),
          filter: args.filter,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        message: requireMessageName(args.message),
        nextPageToken: result.data.nextPageToken,
        reactions: result.data.reactions ?? [],
      };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'chat_send_message',
    'Send a text message or threaded reply as the selected Google Chat user. Only call after explicit user approval.',
    {
      account,
      space,
      text: z.string().min(1).max(4000),
      thread: z
        .string()
        .optional()
        .describe('Optional thread resource name returned by a message, e.g. spaces/AAAA/threads/BBBB.'),
      requestId: z.string().uuid().optional().describe('Optional UUID for retry-safe message creation.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'send Chat message', () =>
        ctx.chat.spaces.messages.create({
          parent: requireSpaceName(args.space),
          requestId: args.requestId,
          ...(args.thread ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
          requestBody: {
            text: args.text,
            ...(args.thread ? { thread: { name: args.thread } } : {}),
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        sent: true,
        message: shapeMessage(result.data),
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'chat_update_message',
    'Replace the text of a named Google Chat message as the selected user. Only call after explicit user approval.',
    { account, message, text: z.string().min(1).max(4000) },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'update Chat message', () =>
        ctx.chat.spaces.messages.patch({
          name: requireMessageName(args.message),
          updateMask: 'text',
          requestBody: { name: requireMessageName(args.message), text: args.text },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        updated: true,
        message: shapeMessage(result.data),
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  );

  register(
    server,
    'chat_delete_message',
    'Permanently delete a named Google Chat message as the selected user. Thread replies are preserved unless force is true. Only call after explicit user approval.',
    { account, message, force: z.boolean().optional() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      await callChat(ctx, 'delete Chat message', () =>
        ctx.chat.spaces.messages.delete({
          name: requireMessageName(args.message),
          force: args.force ?? false,
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        message: requireMessageName(args.message),
        deleted: true,
        force: args.force ?? false,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  );

  register(
    server,
    'chat_add_reaction',
    'Add one Unicode emoji reaction to a Google Chat message as the selected user.',
    { account, message, emoji: z.string().min(1).max(16) },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callChat(ctx, 'add Chat reaction', () =>
        ctx.chat.spaces.messages.reactions.create({
          parent: requireMessageName(args.message),
          requestBody: { emoji: { unicode: args.emoji } },
        })
      );
      return { account: ctx.alias, email: ctx.email, reaction: result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  );

  register(
    server,
    'chat_remove_reaction',
    'Remove one named Google Chat reaction created by the selected user.',
    { account, reaction: z.string() },
    async (args) => {
      const ctx = workspaceFor(args.account);
      await callChat(ctx, 'remove Chat reaction', () =>
        ctx.chat.spaces.messages.reactions.delete({ name: requireReactionName(args.reaction) })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        reaction: requireReactionName(args.reaction),
        deleted: true,
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  );
}
