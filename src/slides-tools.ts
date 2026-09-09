import { z } from 'zod';
import type { slides_v1 } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callGmail } from './gmail.js';
import { workspaceFor, type WorkspaceContext } from './workspace.js';
import { account, register } from './register.js';

async function callGoogle<T>(
  ctx: WorkspaceContext,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return callGmail(ctx, operation, fn);
}

function presentationId(input: string): string {
  const match = input.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  throw new Error('presentation must be a Google Slides URL or presentation ID.');
}

export function registerSlidesTools(server: McpServer): void {
  register(
    server,
    'slides_get_presentation',
    'Get a native Google Slides presentation, including slide elements, layouts, masters, and speaker notes.',
    {
      account,
      presentation: z.string(),
      fields: z
        .string()
        .optional()
        .describe('Optional Google Slides API fields selector; omit for the complete presentation resource.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'get Google Slides presentation', () =>
        ctx.slides.presentations.get({
          presentationId: presentationId(args.presentation),
          ...(args.fields ? { fields: args.fields } : {}),
        })
      );
      return { account: ctx.alias, email: ctx.email, ...result.data };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'slides_batch_update',
    'Apply native Google Slides API batchUpdate requests to an existing presentation.',
    {
      account,
      presentation: z.string(),
      requests: z.array(z.record(z.string(), z.unknown())).min(1),
      requiredRevisionId: z
        .string()
        .optional()
        .describe('Optional revision ID from slides_get_presentation for optimistic concurrency control.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callGoogle(ctx, 'update Google Slides presentation', () =>
        ctx.slides.presentations.batchUpdate({
          presentationId: presentationId(args.presentation),
          requestBody: {
            requests: args.requests as slides_v1.Schema$Request[],
            ...(args.requiredRevisionId
              ? { writeControl: { requiredRevisionId: args.requiredRevisionId } }
              : {}),
          },
        })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        presentationId: result.data.presentationId,
        writeControl: result.data.writeControl,
        replies: result.data.replies ?? [],
      };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  );
}
