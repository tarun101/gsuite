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
