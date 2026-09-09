import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mimeTypeForFilename } from './drive-upload.js';

export const DEFAULT_CHAT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const MAX_CHAT_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CHAT_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface ChatUploadInput {
  filename: string;
  path?: string;
  contentBase64?: string;
  mimeType?: string;
}

export interface PreparedChatUpload {
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  openBody: () => Readable;
}

interface DriveExportChoice {
  mimeType: string;
  extension: string;
}

const DEFAULT_DRIVE_EXPORTS: Record<string, DriveExportChoice> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
};

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/plain': '.txt',
};

function cleanFilename(filename: string): string {
  const safe = path.basename(filename.trim()).replace(/[\u0000-\u001f\u007f]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('filename must name a file.');
  return safe;
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (
    !normalized ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error('contentBase64 must be valid, non-empty base64 data.');
  }
  const decoded = Buffer.from(normalized, 'base64');
  const canonicalInput = normalized.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalDecoded) {
    throw new Error('contentBase64 must be valid base64 data.');
  }
  return decoded;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function prepareChatUpload(input: ChatUploadInput): Promise<PreparedChatUpload> {
  const filename = cleanFilename(input.filename);
  if (Boolean(input.path) === Boolean(input.contentBase64)) {
    throw new Error('Provide exactly one of path or contentBase64 for each Chat attachment.');
  }

  const mimeType = input.mimeType?.trim() || mimeTypeForFilename(filename);
  if (input.path) {
    const file = path.resolve(input.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`No readable file at path: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`No readable file at path: ${file}`);
    if (stat.size > MAX_CHAT_UPLOAD_BYTES) {
      throw new Error(`Chat attachments cannot exceed ${MAX_CHAT_UPLOAD_BYTES} bytes: ${filename}`);
    }
    const sha256 = await sha256File(file);
    return {
      filename,
      mimeType,
      size: stat.size,
      sha256,
      openBody: () => fs.createReadStream(file),
    };
  }

  const content = decodeBase64(input.contentBase64 as string);
  if (content.byteLength > MAX_CHAT_UPLOAD_BYTES) {
    throw new Error(`Chat attachments cannot exceed ${MAX_CHAT_UPLOAD_BYTES} bytes: ${filename}`);
  }
  return {
    filename,
    mimeType,
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    openBody: () => Readable.from(content),
  };
}

export function resolveAttachmentDownloadSource(input: {
  resourceName?: string;
  driveFileId?: string;
}): 'chat' | 'drive' {
  if (Boolean(input.resourceName) === Boolean(input.driveFileId)) {
    throw new Error('Provide exactly one of resourceName or driveFileId for a Chat attachment.');
  }
  if (input.resourceName) {
    if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+\/attachments\/[A-Za-z0-9_.-]+$/.test(input.resourceName)) {
      throw new Error('resourceName must be attachmentDataRef.resourceName returned by a Chat message tool.');
    }
    return 'chat';
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input.driveFileId as string)) {
    throw new Error('driveFileId must be driveDataRef.driveFileId returned by a Chat message tool.');
  }
  return 'drive';
}

export function resolveDriveExport(
  driveMimeType: string,
  requestedMimeType?: string
): DriveExportChoice | undefined {
  if (!driveMimeType.startsWith('application/vnd.google-apps.')) {
    if (requestedMimeType) throw new Error('exportMimeType is only valid for Google Workspace files.');
    return undefined;
  }
  if (driveMimeType === 'application/vnd.google-apps.folder') {
    throw new Error('A Google Drive folder cannot be downloaded as a Chat attachment.');
  }
  if (requestedMimeType) {
    return {
      mimeType: requestedMimeType,
      extension: EXTENSION_BY_MIME_TYPE[requestedMimeType] ?? '',
    };
  }
  const choice = DEFAULT_DRIVE_EXPORTS[driveMimeType];
  if (!choice) {
    throw new Error(
      `No default export is configured for ${driveMimeType}; provide exportMimeType explicitly.`
    );
  }
  return choice;
}

export function downloadFilename(
  requestedFilename: string | undefined,
  sourceFilename: string | null | undefined,
  exportChoice?: DriveExportChoice
): string {
  const filename = cleanFilename(requestedFilename || sourceFilename || 'chat-attachment');
  if (!requestedFilename && exportChoice?.extension && !filename.toLowerCase().endsWith(exportChoice.extension)) {
    return filename + exportChoice.extension;
  }
  return filename;
}

export async function saveDownloadStream(
  body: Readable,
  filename: string,
  options: { directory?: string; maxBytes?: number } = {}
): Promise<{ path: string; bytes: number; sha256: string }> {
  const directory = options.directory ?? path.join(os.homedir(), 'Downloads');
  const maxBytes = options.maxBytes ?? DEFAULT_CHAT_DOWNLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHAT_DOWNLOAD_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${MAX_CHAT_DOWNLOAD_BYTES}.`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const safe = cleanFilename(filename);
  const temp = path.join(directory, `.${safe}.${randomUUID()}.part`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(`Attachment exceeds the ${maxBytes}-byte download limit.`));
        return;
      }
      hash.update(data);
      callback(null, data);
    },
  });

  try {
    await pipeline(body, meter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const parsed = path.parse(path.join(directory, safe));
    let target = path.join(directory, safe);
    for (let suffix = 1; ; suffix++) {
      try {
        fs.linkSync(temp, target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        target = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
      }
    }
    fs.unlinkSync(temp);
    return { path: target, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best-effort cleanup of an incomplete private temp file.
    }
    throw error;
  }
}
