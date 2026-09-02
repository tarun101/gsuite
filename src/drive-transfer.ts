// The single Drive upload path, shared by the MCP tool, the local CLI, and the
// Worker's /upload endpoint. It talks to Drive with fetch rather than through
// googleapis: googleapis' multipart assembly streams the parts through a
// node:stream PassThrough and emits the closing `--boundary--` from that
// stream's `flush` hook, which never fires under workerd — the deployed Worker
// sent bodies with no end boundary and Drive rejected them with "Missing end
// boundary in multipart body". Assembling the bytes here keeps the wire format
// identical in every runtime.
import type { OAuth2Client } from './accounts.js';
import { buildMultipartRelatedBody, driveUploadUrl } from './drive-upload.js';

/** Fields returned for an uploaded file. */
export const DRIVE_UPLOAD_FIELDS = 'id,name,mimeType,size,parents,webViewLink';

/**
 * Above this, use a resumable session instead of a multipart body. Google
 * documents multipart upload as suitable for small files only, and buffering a
 * large body into one request is exactly what a Worker cannot afford.
 */
export const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export interface DriveUpload {
  /** Drive file metadata: at least `name`, optionally `parents`. */
  metadata: Record<string, unknown>;
  mimeType: string;
  data: Uint8Array;
}

export type DriveFile = Record<string, unknown> & { id?: string; name?: string; size?: string };

/** Shape a failed Drive response like a googleapis error so callGmail's retry/auth mapping still applies. */
async function driveFailure(response: Response, context: string): Promise<Error> {
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  const detail =
    (data as any)?.error?.message ?? (typeof data === 'string' && data ? data : response.statusText);
  return Object.assign(new Error(`${context} (${response.status}): ${detail}`), {
    response: { status: response.status, data },
  });
}

async function bearer(auth: OAuth2Client): Promise<string> {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token.');
  return `Bearer ${token}`;
}

async function multipartUpload(auth: OAuth2Client, upload: DriveUpload): Promise<DriveFile> {
  const { contentType, body } = buildMultipartRelatedBody(upload.metadata, {
    mimeType: upload.mimeType,
    data: upload.data,
  });
  const response = await fetch(driveUploadUrl('multipart', DRIVE_UPLOAD_FIELDS), {
    method: 'POST',
    headers: {
      authorization: await bearer(auth),
      'content-type': contentType,
      'content-length': String(body.length),
    },
    // buildMultipartRelatedBody allocates an exact-size buffer, so the whole
    // ArrayBuffer is the body; passing it keeps the Node and workerd fetch
    // typings in agreement.
    body: body.buffer as ArrayBuffer,
  });
  if (!response.ok) throw await driveFailure(response, 'Drive rejected the upload');
  return (await response.json()) as DriveFile;
}

async function resumableUpload(auth: OAuth2Client, upload: DriveUpload): Promise<DriveFile> {
  const authorization = await bearer(auth);
  const start = await fetch(driveUploadUrl('resumable', DRIVE_UPLOAD_FIELDS), {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': upload.mimeType,
      'x-upload-content-length': String(upload.data.length),
    },
    body: JSON.stringify(upload.metadata),
  });
  if (!start.ok) throw await driveFailure(start, 'Drive refused to start the upload session');
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive started an upload session without a session URL.');

  const response = await fetch(session, {
    method: 'PUT',
    headers: { authorization, 'content-type': upload.mimeType, 'content-length': String(upload.data.length) },
    body: upload.data.buffer.byteLength === upload.data.length
      ? (upload.data.buffer as ArrayBuffer)
      : (upload.data.slice().buffer as ArrayBuffer),
  });
  if (!response.ok) throw await driveFailure(response, 'Drive rejected the uploaded content');
  return (await response.json()) as DriveFile;
}

/**
 * Upload bytes to Drive, picking the multipart or resumable protocol by size.
 * Returns the created file's metadata (DRIVE_UPLOAD_FIELDS).
 */
export async function uploadToDrive(auth: OAuth2Client, upload: DriveUpload): Promise<DriveFile> {
  return upload.data.length > RESUMABLE_THRESHOLD_BYTES
    ? resumableUpload(auth, upload)
    : multipartUpload(auth, upload);
}
