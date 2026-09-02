// Pure helpers for the Drive upload flow, extracted so MIME inference and the
// path/content input validation can be unit-tested without any live Google
// calls or filesystem access. This module has no runtime dependencies.

// A small, dependency-free extension -> MIME map covering the common cases.
// Anything unmapped falls back to application/octet-stream, which Drive accepts
// and will often sniff on its own.
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** Best-effort MIME type from a filename's extension. */
export function mimeTypeForFilename(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? DEFAULT_MIME_TYPE;
}

/**
 * Validate that exactly one of `path` / `content` was supplied for an upload.
 * Throws a clear error otherwise. Returns the chosen source discriminant.
 */
export function resolveUploadSource(source: {
  path?: string;
  content?: string;
}): 'path' | 'content' {
  if (source.path && source.content) {
    throw new Error('Provide "path" or "content", not both.');
  }
  if (source.path) return 'path';
  if (source.content) return 'content';
  throw new Error('Provide either "path" (local file) or "content" (base64) to upload.');
}

/**
 * Assemble a `multipart/related` body for Drive's `files.create` upload endpoint.
 *
 * We build this ourselves rather than letting googleapis do it. googleapis'
 * multipart assembly (googleapis-common `multipartUpload`) streams the parts
 * through a `node:stream` PassThrough and emits the closing `--boundary--`
 * delimiter from the PassThrough's `flush` hook. That hook never fires under
 * workerd, so the deployed Worker sent a body with no end boundary and Drive
 * rejected it with "Missing end boundary in multipart body". Building the bytes
 * up front is deterministic, identical locally and on Workers, and testable.
 *
 * Layout (RFC 2387, matching Google's documented multipart upload):
 *
 *     --BOUNDARY CRLF
 *     Content-Type: application/json; charset=UTF-8 CRLF CRLF
 *     {metadata} CRLF
 *     --BOUNDARY CRLF
 *     Content-Type: <mimeType> CRLF CRLF
 *     <raw bytes> CRLF
 *     --BOUNDARY--
 */
export function buildMultipartRelatedBody(
  metadata: Record<string, unknown>,
  media: { mimeType: string; data: Uint8Array },
  boundary: string = crypto.randomUUID()
): { contentType: string; boundary: string; body: Uint8Array } {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${media.mimeType}\r\n\r\n`
  );
  // The trailing CRLF here is what closes the media part. Omitting it is the
  // other way to produce "Missing end boundary" — the delimiter has to start
  // on its own line.
  const tail = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(head.length + media.data.length + tail.length);
  body.set(head, 0);
  body.set(media.data, head.length);
  body.set(tail, head.length + media.data.length);

  return { contentType: `multipart/related; boundary=${boundary}`, boundary, body };
}

/** Drive's upload endpoint, with the query Drive needs for shared drives. */
export function driveUploadUrl(uploadType: 'multipart' | 'resumable', fields: string): string {
  const params = new URLSearchParams({ uploadType, supportsAllDrives: 'true', fields });
  return `https://www.googleapis.com/upload/drive/v3/files?${params}`;
}
