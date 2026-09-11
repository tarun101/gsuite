import { workspaceFor } from './workspace.js';
import { callGmail } from './gmail.js';
import {
  MAX_DRIVE_DOWNLOAD_BYTES,
  DRIVE_DOWNLOAD_METADATA_FIELDS,
  assertMetadataStillMatches,
  hashTicket,
  ticketLooksValid,
  ticketShard,
  type DriveDownloadMetadata,
  type DriveDownloadTicketRecord,
  type TicketConsumeResult,
} from './drive-download-ticket.js';

export const DRIVE_DOWNLOAD_PATH = '/drive/download';
export const DRIVE_TRANSFER_TIMEOUT_MS = 30_000;

type AuditOutcome = 'redeemed' | 'rejected' | 'complete' | 'interrupted';

interface DownloadAudit {
  outcome: AuditOutcome;
  transferId?: string;
  requester?: string;
  account?: string;
  fileId?: string;
  reason?: string;
  bytes?: number;
}

export interface DriveDownloadEndpointDependencies {
  consume(ticket: string, now: number): Promise<TicketConsumeResult>;
  loadMetadata(record: DriveDownloadTicketRecord): Promise<{ accountEmail: string; metadata: DriveDownloadMetadata }>;
  fetchBytes(record: DriveDownloadTicketRecord, signal: AbortSignal): Promise<Response>;
  audit(event: DownloadAudit): void;
  now(): number;
}

interface DriveDownloadEnv {
  DRIVE_TICKETS: {
    getByName(name: string): {
      consume(ticketHash: string, now: number): Promise<TicketConsumeResult>;
    };
  };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export function driveRevisionDownloadUrl(fileId: string, headRevisionId: string): URL {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(headRevisionId)}`,
  );
  url.searchParams.set('alt', 'media');
  return url;
}

function productionDependencies(env: DriveDownloadEnv): DriveDownloadEndpointDependencies {
  return {
    async consume(ticket, now) {
      const hash = await hashTicket(ticket);
      return env.DRIVE_TICKETS.getByName(ticketShard(hash)).consume(hash, now);
    },
    async loadMetadata(record) {
      const ctx = workspaceFor(record.accountAlias);
      const response = await callGmail(ctx, 'recheck Drive cloud download', () =>
        ctx.drive.files.get({
          fileId: record.fileId,
          fields: DRIVE_DOWNLOAD_METADATA_FIELDS,
          supportsAllDrives: true,
        }),
      );
      return { accountEmail: ctx.email.toLowerCase(), metadata: response.data };
    },
    async fetchBytes(record, signal) {
      const ctx = workspaceFor(record.accountAlias);
      const { token } = await ctx.auth.getAccessToken();
      if (!token) throw new Error('Could not obtain a Google access token.');
      const url = driveRevisionDownloadUrl(record.fileId, record.headRevisionId);
      return fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal,
      });
    },
    audit(event) {
      console.info(JSON.stringify({ event: 'drive_download', ...event }));
    },
    now: Date.now,
  };
}

function boundedBody(
  upstream: ReadableStream<Uint8Array>,
  record: DriveDownloadTicketRecord,
  audit: (event: DownloadAudit) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let bytes = 0;
  let finished = false;

  const finish = (outcome: AuditOutcome, reason?: string) => {
    if (finished) return;
    finished = true;
    audit({
      outcome,
      transferId: record.transferId,
      requester: record.requester,
      account: record.accountAlias,
      fileId: record.fileId,
      bytes,
      ...(reason ? { reason } : {}),
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (bytes !== record.byteSize) {
            finish('rejected', 'size_mismatch');
            controller.error(new Error('Drive content size changed during transfer.'));
            return;
          }
          finish('complete');
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > record.byteSize || bytes > MAX_DRIVE_DOWNLOAD_BYTES) {
          await reader.cancel();
          finish('rejected', 'size_limit');
          controller.error(new Error('Drive content exceeded its authorized size.'));
          return;
        }
        controller.enqueue(chunk.value);
      } catch {
        finish('interrupted', 'upstream_interrupted');
        controller.error(new Error('Drive transfer was interrupted.'));
      }
    },
    async cancel() {
      finish('interrupted', 'client_disconnected');
      await reader.cancel();
    },
  });
}

/** Handles GET /drive/download and leaves every other route to the existing router. */
export async function handleDriveDownloadRequest(
  request: Request,
  env: DriveDownloadEnv,
  injected?: DriveDownloadEndpointDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DRIVE_DOWNLOAD_PATH) return null;
  const dependencies = injected ?? productionDependencies(env);
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
  if (url.search) return json({ error: 'Query parameters are not accepted.' }, 400);

  const authorization = request.headers.get('authorization') ?? '';
  const ticket = authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  if (!ticketLooksValid(ticket)) {
    dependencies.audit({ outcome: 'rejected', reason: 'invalid_ticket' });
    return json({ error: 'Unauthorized' }, 401);
  }

  let consumed: TicketConsumeResult;
  try {
    consumed = await dependencies.consume(ticket, dependencies.now());
  } catch {
    dependencies.audit({ outcome: 'rejected', reason: 'ticket_broker_unavailable' });
    return json({ error: 'Download authorization unavailable' }, 503);
  }
  if (!consumed.ok) {
    dependencies.audit({ outcome: 'rejected', transferId: consumed.transferId, reason: consumed.reason });
    return json({ error: consumed.reason === 'expired' ? 'Ticket expired' : 'Unauthorized' }, 401);
  }
  const record = consumed.record;
  dependencies.audit({ outcome: 'redeemed', transferId: record.transferId, requester: record.requester, account: record.accountAlias, fileId: record.fileId });

  try {
    if (record.operation !== 'drive.download') throw new Error('Ticket operation mismatch.');
    const current = await dependencies.loadMetadata(record);
    if (current.accountEmail !== record.accountEmail) throw new Error('Google account binding changed.');
    assertMetadataStillMatches(current.metadata, record);

    const upstream = await dependencies.fetchBytes(record, AbortSignal.timeout(DRIVE_TRANSFER_TIMEOUT_MS));
    if (upstream.status >= 300 && upstream.status < 400) throw new Error('Google redirect refused.');
    if (!upstream.ok || !upstream.body) throw new Error('Google refused the Drive download.');
    const declared = Number(upstream.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared !== record.byteSize) {
      await upstream.body.cancel();
      throw new Error('Drive content size changed before transfer.');
    }

    const headers = new Headers({
      'cache-control': 'no-store, private',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      'content-length': String(record.byteSize),
      'content-type': record.mimeType,
      'x-content-type-options': 'nosniff',
      'x-gsuite-file-id': record.fileId,
      'x-gsuite-head-revision-id': record.headRevisionId,
      'x-gsuite-sha256': record.sha256,
      'x-gsuite-transfer-id': record.transferId,
    });
    return new Response(boundedBody(upstream.body, record, dependencies.audit), { status: 200, headers });
  } catch (error) {
    const reason = error instanceof Error && /changed|mismatch/i.test(error.message)
      ? 'content_changed'
      : 'authorization_recheck_failed';
    dependencies.audit({ outcome: 'rejected', transferId: record.transferId, requester: record.requester, account: record.accountAlias, fileId: record.fileId, reason });
    return json({ error: 'Download could not be authorized' }, 409);
  }
}
