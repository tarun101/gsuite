import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_DRIVE_DOWNLOAD_MIME_TYPES,
  MAX_DRIVE_DOWNLOAD_BYTES,
  ROUTESPRING_DRIVE_DOWNLOAD_URL,
  ticketLooksValid,
} from './drive-download-ticket.js';

export interface CloudDriveDownloadOptions {
  url: string;
  ticket: string;
  fileId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  headRevisionId: string;
  sha256: string;
  taskScope?: string;
  timeoutMs?: number;
}

export interface CloudDriveDownloadResult {
  path: string;
  fileId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  headRevisionId: string;
  sha256: string;
}

function safeComponent(value: string, fallback: string, maxLength: number): string {
  const cleaned = path.basename(value).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, maxLength);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function requireHeader(response: Response, name: string, expected: string): void {
  if (response.headers.get(name) !== expected) throw new Error(`Download response ${name} did not match the ticket metadata.`);
}

/** Pull bytes into an exclusive private temp file, then atomically reveal it only after integrity checks pass. */
export async function downloadDriveFile(
  options: CloudDriveDownloadOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudDriveDownloadResult> {
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Download URL must be a credential-free HTTPS endpoint without query parameters or fragments.');
  }
  if (endpoint.href !== ROUTESPRING_DRIVE_DOWNLOAD_URL) {
    throw new Error('Download URL is not the pinned Routespring GSuite endpoint.');
  }
  if (!ticketLooksValid(options.ticket)) throw new Error('Download ticket is malformed.');
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(options.fileId)) throw new Error('Drive file ID is malformed.');
  if (!options.headRevisionId || options.headRevisionId.length > 200) {
    throw new Error('Drive head revision ID is malformed.');
  }
  if (!ALLOWED_DRIVE_DOWNLOAD_MIME_TYPES.has(options.mimeType)) {
    throw new Error('Expected MIME type is not allowed.');
  }
  if (!Number.isSafeInteger(options.byteSize) || options.byteSize <= 0 || options.byteSize > MAX_DRIVE_DOWNLOAD_BYTES) {
    throw new Error(`Expected byte size must be between 1 and ${MAX_DRIVE_DOWNLOAD_BYTES}.`);
  }
  const expectedSha = options.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error('Expected SHA-256 must be 64 hexadecimal characters.');

  const taskScope = safeComponent(options.taskScope ?? 'task', 'task', 40);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), `gsuite-drive-${taskScope}-`));
  await fs.promises.chmod(directory, 0o700);
  const filename = safeComponent(options.filename, 'download.bin', 140);
  const finalPath = path.join(directory, filename);
  const partialPath = path.join(directory, `.${filename}.${randomUUID()}.part`);
  let handle: fs.promises.FileHandle | undefined;

  try {
    handle = await fs.promises.open(partialPath, 'wx', 0o600);
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.ticket}` },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!response.ok || !response.body) throw new Error(`Download endpoint returned HTTP ${response.status}.`);
    requireHeader(response, 'content-length', String(options.byteSize));
    requireHeader(response, 'content-type', options.mimeType);
    requireHeader(response, 'x-gsuite-file-id', options.fileId);
    requireHeader(response, 'x-gsuite-head-revision-id', options.headRevisionId);
    requireHeader(response, 'x-gsuite-sha256', expectedSha);

    const reader = response.body.getReader();
    const digest = createHash('sha256');
    let byteSize = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteSize += chunk.value.byteLength;
      if (byteSize > options.byteSize || byteSize > MAX_DRIVE_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error('Downloaded content exceeded its authorized size.');
      }
      digest.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk.value,
          offset,
          chunk.value.byteLength - offset,
          null,
        );
        if (bytesWritten <= 0) throw new Error('Could not write downloaded content to the temporary file.');
        offset += bytesWritten;
      }
    }
    if (byteSize !== options.byteSize) throw new Error('Downloaded byte size did not match the authorized size.');
    const sha256 = digest.digest('hex');
    if (sha256 !== expectedSha) throw new Error('Downloaded SHA-256 did not match the trusted expected value.');

    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(partialPath, finalPath);
    return {
      path: finalPath,
      fileId: options.fileId,
      filename,
      mimeType: options.mimeType,
      byteSize,
      headRevisionId: options.headRevisionId,
      sha256,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function argumentsFrom(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key || !value || !argv[i].startsWith('--')) throw new Error('Arguments must be --name value pairs.');
    result[key] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const ticket = process.env.GSUITE_DRIVE_DOWNLOAD_TICKET;
  if (!ticket) throw new Error('GSUITE_DRIVE_DOWNLOAD_TICKET is required.');
  for (const name of ['url', 'file-id', 'filename', 'mime-type', 'size', 'version', 'sha256']) {
    if (!args[name]) throw new Error(`--${name} is required.`);
  }
  const result = await downloadDriveFile({
    url: args.url,
    ticket,
    fileId: args['file-id'],
    filename: args.filename,
    mimeType: args['mime-type'],
    byteSize: Number(args.size),
    headRevisionId: args.version,
    sha256: args.sha256,
    taskScope: args['task-scope'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    const ticket = process.env.GSUITE_DRIVE_DOWNLOAD_TICKET ?? '';
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(ticket, '[REDACTED]');
    process.stderr.write(`Drive download failed: ${message}\n`);
    process.exitCode = 1;
  });
}
