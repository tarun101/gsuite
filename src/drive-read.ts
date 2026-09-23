import type { WorkspaceContext } from './workspace.js';
import { createHash } from 'node:crypto';
import { callGmail } from './gmail.js';
import { invalidateRemoteAccessToken } from './accounts.js';
import {
  assertTextSize,
  isTextBlobMimeType,
  readBoundedText,
  textByteLimit,
  textExportMimeType,
} from './drive-operations.js';

export async function authorizedGoogleFetch(ctx: WorkspaceContext, url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token } = await ctx.auth.getAccessToken();
    if (!token) throw new Error('Could not obtain a Google access token.');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Google redirect refused.');
    }
    if (response.status !== 401 || attempt === 1) return response;
    await response.body?.cancel();
    invalidateRemoteAccessToken(ctx.alias);
    ctx.auth.setCredentials({ ...ctx.auth.credentials, access_token: undefined, expiry_date: 0 });
  }
  throw new Error('Google authorization failed.');
}

export async function readDriveText(
  ctx: WorkspaceContext,
  fileId: string,
  maxBytes?: number,
): Promise<Record<string, unknown>> {
  const limit = textByteLimit(maxBytes);
  const metadata = (await callGmail(ctx, 'get Drive text metadata', () =>
    ctx.drive.files.get({
      fileId,
      fields: 'id,name,mimeType,modifiedTime,size,sha256Checksum',
      supportsAllDrives: true,
    })
  )).data;
  if (!metadata.id || !metadata.mimeType) throw new Error('Drive returned incomplete file metadata.');
  const exportMimeType = textExportMimeType(metadata.mimeType);
  if (!exportMimeType && !isTextBlobMimeType(metadata.mimeType)) {
    throw new Error(`Binary MIME type is not supported by drive_read_text: ${metadata.mimeType}.`);
  }
  if (!exportMimeType && metadata.size !== undefined && metadata.size !== null) {
    assertTextSize(Number(metadata.size), limit);
  }
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}${exportMimeType ? '/export' : ''}`);
  if (exportMimeType) url.searchParams.set('mimeType', exportMimeType);
  else url.searchParams.set('alt', 'media');
  const response = await authorizedGoogleFetch(ctx, url.href);
  if (!response.ok || !response.body) throw new Error(`Drive text read failed with HTTP ${response.status}.`);
  const { content } = await readBoundedText(response.body, limit);
  if (!exportMimeType && metadata.sha256Checksum) {
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    if (digest !== metadata.sha256Checksum.toLowerCase()) throw new Error('Drive text content changed during read (SHA-256 mismatch).');
  }
  return {
    account: ctx.alias,
    email: ctx.email,
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    modifiedTime: metadata.modifiedTime,
    ...(!exportMimeType ? { sha256: metadata.sha256Checksum ?? null } : {}),
    content,
  };
}
