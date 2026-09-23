export const MAX_INLINE_TEXT_BYTES = 102_400;
export const LEAN_DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents';

export function driveMetadataFields(verbose = false, fields?: string, list = false): string {
  if (fields) return list && !/(^|,)\s*nextPageToken\s*(,|$)/.test(fields) ? `nextPageToken,${fields}` : fields;
  return (list
    ? `nextPageToken,files(${verbose ? 'id,name,mimeType,modifiedTime,modifiedByMeTime,createdTime,viewedByMeTime,sharedWithMeTime,size,trashed,parents,driveId,description,webViewLink,resourceKey,permissionIds,hasAugmentedPermissions,inheritedPermissionsDisabled,owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),capabilities(canComment,canEdit,canShare)' : LEAN_DRIVE_FILE_FIELDS})`
    : verbose
      ? 'id,name,mimeType,modifiedTime,modifiedByMeTime,createdTime,viewedByMeTime,sharedWithMeTime,size,trashed,parents,driveId,description,webViewLink,resourceKey,permissionIds,hasAugmentedPermissions,inheritedPermissionsDisabled,owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),capabilities(canComment,canEdit,canShare)'
      : LEAN_DRIVE_FILE_FIELDS);
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function driveSearchQuery(options: {
  query?: string;
  parentId?: string;
  nameContains?: string;
  modifiedAfter?: string;
}): string {
  const clauses = [options.query ? `(${options.query})` : 'trashed = false'];
  if (options.parentId) clauses.push(`'${escapeDriveQueryValue(options.parentId)}' in parents`);
  if (options.nameContains) clauses.push(`name contains '${escapeDriveQueryValue(options.nameContains)}'`);
  if (options.modifiedAfter) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(options.modifiedAfter) || Number.isNaN(Date.parse(options.modifiedAfter))) {
      throw new Error('modifiedAfter must be an RFC3339 timestamp.');
    }
    clauses.push(`modifiedTime > '${options.modifiedAfter}'`);
  }
  return clauses.join(' and ');
}

export function textExportMimeType(mimeType: string): string | undefined {
  switch (mimeType) {
    case 'application/vnd.google-apps.document': return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet': return 'text/csv';
    case 'application/vnd.google-apps.presentation': return 'text/plain';
    default: return undefined;
  }
}

export function isTextBlobMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || new Set([
    'application/json', 'application/xml', 'application/javascript',
    'application/yaml', 'application/x-yaml',
  ]).has(mimeType);
}

export function textByteLimit(maxBytes?: number): number {
  if (maxBytes === undefined) return MAX_INLINE_TEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INLINE_TEXT_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${MAX_INLINE_TEXT_BYTES}.`);
  }
  return maxBytes;
}

export function assertTextSize(size: number, maxBytes: number): void {
  if (size > maxBytes) throw new Error(`Text file is ${size} bytes; use drive_issue_download_ticket for files above ${maxBytes} bytes.`);
}

export function assertInlineUploadSize(base64: string, decodedSize?: number): void {
  if (base64.length > 4 * Math.ceil(MAX_INLINE_TEXT_BYTES / 3) + 4 || (decodedSize !== undefined && decodedSize > MAX_INLINE_TEXT_BYTES)) {
    throw new Error(`Inline upload exceeds ${MAX_INLINE_TEXT_BYTES} bytes; use drive_issue_upload_ticket.`);
  }
}

export async function readBoundedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ content: string; byteSize: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assertTextSize(size, maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), byteSize: size };
  } catch {
    throw new Error('Drive content is not valid UTF-8 text.');
  }
}

export function buildDriveBatchBody(fileIds: string[], fields: string): { boundary: string; body: string } {
  const boundary = `gsuite_${crypto.randomUUID()}`;
  const parts = fileIds.map((id, index) => {
    const path = `/drive/v3/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields, supportsAllDrives: 'true' })}`;
    return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <file-${index}>\r\n\r\nGET ${path} HTTP/1.1\r\n\r\n`;
  });
  return { boundary, body: parts.join('') + `--${boundary}--\r\n` };
}

export function parseDriveBatchResponse(body: string, contentType: string, fileIds: string[]): Array<Record<string, unknown>> {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) throw new Error('Drive batch response has no multipart boundary.');
  const boundary = match[1] ?? match[2];
  const results: Array<Record<string, unknown> | undefined> = Array(fileIds.length);
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) break;
    const idMatch = part.match(/Content-ID:\s*<?response-file-(\d+)>?/i);
    const statusMatch = part.match(/HTTP\/1\.1\s+(\d+)/i);
    if (!idMatch || !statusMatch) continue;
    const index = Number(idMatch[1]);
    if (index >= fileIds.length || results[index]) continue;
    const payloadStart = part.search(/\r?\n\r?\n(?=\{)/);
    let data: Record<string, unknown> = {};
    if (payloadStart >= 0) {
      const payload = part.slice(payloadStart).trim();
      try { data = JSON.parse(payload); } catch { /* report malformed part below */ }
    }
    const status = Number(statusMatch[1]);
    results[index] = status >= 200 && status < 300 && data.id
      ? data
      : { id: fileIds[index], error: (data.error as { message?: string } | undefined)?.message ?? `Drive returned HTTP ${status}` };
  }
  return results.map((result, index) => result ?? { id: fileIds[index], error: 'Drive omitted this batch result.' });
}
