import { Buffer } from 'node:buffer';
import { workspaceFor } from './workspace.js';
import { gmailFor } from './gmail.js';
import { hashTicket, ticketShard } from './drive-download-ticket.js';
import { CLOUD_DOWNLOAD_MAX_BYTES, type CloudDownloadTicketRecord } from './cloud-download-ticket.js';

export const CLOUD_DOWNLOAD_PATH = '/cloud/download';
type Broker = { consumeCloudDownload(hash: string, now: number): Promise<any> };
export interface CloudDownloadEnv { ALLOWED_EMAIL: string; DRIVE_TICKETS: { getByName(name: string): Broker } }
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });

function bearer(request: Request): string | null { return request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? null; }
function bounded(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = body.getReader(); let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) return controller.close();
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); return controller.error(new Error('Downloaded content exceeds its ticket limit.')); }
      controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
async function accessToken(alias: string): Promise<{ ctx: ReturnType<typeof workspaceFor>; token: string }> {
  const ctx = workspaceFor(alias); const { token } = await ctx.auth.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token.');
  return { ctx, token };
}
async function source(record: CloudDownloadTicketRecord): Promise<Response> {
  const { ctx, token } = await accessToken(record.accountAlias);
  if (ctx.alias !== record.accountAlias || ctx.email.toLowerCase() !== record.accountEmail.toLowerCase()) throw new Error('The authorized Google account changed.');
  if (record.source === 'drive.export') {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.fileId!)}/export`);
    url.searchParams.set('mimeType', record.exportMimeType!);
    return fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
  }
  if (record.source === 'gmail.attachment') {
    const gmail = gmailFor(record.accountAlias);
    if (gmail.alias !== record.accountAlias || gmail.email.toLowerCase() !== record.accountEmail.toLowerCase()) throw new Error('The authorized Google account changed.');
    const data = await gmail.gmail.users.messages.attachments.get({ userId: 'me', messageId: record.messageId!, id: record.attachmentId! });
    if (!data.data.data) throw new Error('Gmail attachment has no content.');
    const bytes = Buffer.from(data.data.data, 'base64url');
    return new Response(bytes, { headers: { 'content-type': record.mimeType, 'content-length': String(bytes.length) } });
  }
  const url = new URL(`https://chat.googleapis.com/v1/${record.resourceName}`);
  url.searchParams.set('alt', 'media');
  return fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
}

export async function handleCloudDownloadRequest(request: Request, env: CloudDownloadEnv): Promise<Response | null> {
  const url = new URL(request.url); if (url.pathname !== CLOUD_DOWNLOAD_PATH) return null;
  if (request.method !== 'GET' || url.search) return json({ error: 'Use GET without query parameters.' }, 400);
  const ticket = bearer(request); if (!ticket) return json({ error: 'Unauthorized.' }, 401);
  const hash = await hashTicket(ticket); const result = await env.DRIVE_TICKETS.getByName(ticketShard(hash)).consumeCloudDownload(hash, Date.now());
  if (!result.ok) return json({ error: result.reason === 'expired' ? 'Ticket expired.' : 'Ticket is invalid or already used.' }, result.reason === 'expired' ? 410 : 409);
  const record = result.record as CloudDownloadTicketRecord;
  if (record.requester.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) return json({ error: 'Ticket is no longer authorized.' }, 403);
  try {
    const upstream = await source(record);
    if (!upstream.ok || !upstream.body || upstream.status >= 300) return json({ error: 'Google refused this download.' }, 502);
    const contentLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > Math.min(record.maxBytes, CLOUD_DOWNLOAD_MAX_BYTES)) return json({ error: 'Content exceeds ticket limit.' }, 413);
    return new Response(bounded(upstream.body, Math.min(record.maxBytes, CLOUD_DOWNLOAD_MAX_BYTES)), {
      headers: { 'cache-control': 'no-store, private', 'content-type': record.mimeType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`, 'x-content-type-options': 'nosniff' },
    });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Cloud download failed.' }, 502); }
}
