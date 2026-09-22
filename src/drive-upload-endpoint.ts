import { workspaceFor } from './workspace.js';
import { uploadStreamToDrive } from './drive-transfer.js';
import { hashTicket, ticketShard, type DriveUploadTicketRecord } from './drive-upload-ticket.js';

export const DRIVE_UPLOAD_TICKET_PATH = '/drive/upload';

type UploadBroker = {
  consumeUpload(ticketHash: string, now: number): Promise<
    | { ok: true; record: DriveUploadTicketRecord }
    | { ok: false; reason: 'expired' | 'unknown_or_replayed'; transferId?: string }
  >;
};

export interface DriveUploadTicketEndpointEnv {
  ALLOWED_EMAIL: string;
  DRIVE_TICKETS: { getByName(name: string): UploadBroker };
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status,
  headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' },
});

function bearer(request: Request): string | null {
  return request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? null;
}

/** Handles one raw-body upload. Account, file, and parent come only from the consumed ticket. */
export async function handleDriveUploadTicketRequest(request: Request, env: DriveUploadTicketEndpointEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DRIVE_UPLOAD_TICKET_PATH) return null;
  if (request.method !== 'PUT') return json({ error: 'Use PUT with curl --upload-file.' }, 405);
  if (url.search) return json({ error: 'Query parameters are not accepted.' }, 400);
  const ticket = bearer(request);
  if (!ticket) return json({ error: 'Unauthorized.' }, 401);
  const ticketHash = await hashTicket(ticket);
  const consumed = await env.DRIVE_TICKETS.getByName(ticketShard(ticketHash)).consumeUpload(ticketHash, Date.now());
  if (!consumed.ok) {
    return json({ error: consumed.reason === 'expired' ? 'Ticket expired.' : 'Ticket is invalid or already used.' }, consumed.reason === 'expired' ? 410 : 409);
  }
  const record = consumed.record;
  if (record.requester.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) return json({ error: 'Ticket is no longer authorized.' }, 403);
  const declared = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(declared) || declared !== record.byteSize || !request.body) {
    return json({ error: 'Content-Length must match the ticket byteSize exactly.' }, 400);
  }
  const requestMime = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (requestMime && requestMime !== record.mimeType.toLowerCase()) return json({ error: 'Content-Type must match the ticket mimeType.' }, 400);
  const ctx = workspaceFor(record.accountAlias);
  if (ctx.alias !== record.accountAlias || ctx.email.toLowerCase() !== record.accountEmail.toLowerCase()) {
    return json({ error: 'The authorized Google account changed.' }, 403);
  }
  try {
    const file = await uploadStreamToDrive(ctx.auth, {
      metadata: {
        ...(record.filename ? { name: record.filename } : {}),
        ...(record.parentId ? { parents: [record.parentId] } : {}),
      },
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      body: request.body,
      ...(record.fileId ? { fileId: record.fileId } : {}),
    });
    const actualHash = typeof file.sha256Checksum === 'string' ? file.sha256Checksum.toLowerCase() : undefined;
    if (!actualHash || actualHash !== record.sha256) {
      return json({ error: 'Drive did not confirm the expected SHA-256; do not treat this upload as successful.' }, 502);
    }
    return json({ account: ctx.alias, operation: record.fileId ? 'replaced' : 'created', ...file }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Drive upload failed.' }, 502);
  }
}
