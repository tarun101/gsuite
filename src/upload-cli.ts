#!/usr/bin/env node
// Upload a local file to Drive without routing its bytes through an MCP client.
//
// `drive_upload_file` takes base64 inline content, which means an agent driving
// the remote server has to carry the whole file through its own context. This
// command reads the file from disk, uploads it with the Google tokens already in
// ~/.gsuite-mcp, and prints only the resulting Drive metadata as JSON — so a
// caller can shell out to it and read back a few hundred bytes.
//
//   gsuite-upload --account work --path ./BCP-v6.0.pdf [--parent <folderId>]
//                 [--name report.pdf] [--mime application/pdf] [--remote]
//
// With --remote the file is pushed to the deployed Worker's /upload endpoint
// instead (GSUITE_UPLOAD_URL + GSUITE_UPLOAD_TOKEN), for machines that hold no
// Google credentials of their own.
import fs from 'node:fs';
import path from 'node:path';
import { getClient, resolveAccount } from './accounts.js';
import { mimeTypeForFilename } from './drive-upload.js';
import { uploadToDrive } from './drive-transfer.js';

const USAGE = `Usage: gsuite-upload --account <alias|email> --path <file> [options]

  --account, -a   Account alias or email (required)
  --path, -p      Local file to upload (required)
  --name, -n      Name in Drive (defaults to the file's basename)
  --parent        Destination folder ID (defaults to My Drive root)
  --mime          MIME type (inferred from the name when omitted)
  --remote        Push through the Worker endpoint instead of uploading directly.
                  Reads GSUITE_UPLOAD_URL and GSUITE_UPLOAD_TOKEN.
  --help, -h      Show this message

Prints the created file's Drive metadata as JSON on stdout.`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const aliases: Record<string, string> = { a: 'account', p: 'path', n: 'name', h: 'help' };
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) throw new Error(`Unexpected argument "${arg}".`);
    const [rawKey, inlineValue] = arg.replace(/^--?/, '').split('=', 2);
    const key = aliases[rawKey] ?? rawKey;
    if (key === 'help' || key === 'remote') {
      flags[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}.`);
    flags[key] = value;
  }
  return flags;
}

async function uploadViaWorker(
  file: { name: string; mimeType: string; data: Uint8Array },
  account: string,
  parent?: string
): Promise<unknown> {
  const endpoint = process.env.GSUITE_UPLOAD_URL;
  const token = process.env.GSUITE_UPLOAD_TOKEN;
  if (!endpoint || !token) {
    throw new Error('--remote needs GSUITE_UPLOAD_URL and GSUITE_UPLOAD_TOKEN in the environment.');
  }
  const url = new URL(endpoint);
  url.searchParams.set('account', account);
  url.searchParams.set('filename', file.name);
  if (parent) url.searchParams.set('parent', parent);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': file.mimeType },
    body: file.data.buffer as ArrayBuffer,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload endpoint returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || process.argv.length === 2) {
    console.log(USAGE);
    return;
  }
  const account = flags.account as string;
  const filePath = flags.path as string;
  if (!account) throw new Error('--account is required.');
  if (!filePath) throw new Error('--path is required.');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`No readable file at path: ${filePath}`);
  }

  const name = (flags.name as string) ?? path.basename(filePath);
  const mimeType = (flags.mime as string) ?? mimeTypeForFilename(name);
  const data = new Uint8Array(fs.readFileSync(filePath));

  let result: unknown;
  if (flags.remote) {
    result = await uploadViaWorker({ name, mimeType, data }, account, flags.parent as string | undefined);
  } else {
    const { alias, entry } = resolveAccount(account);
    result = await uploadToDrive(getClient(alias, entry), {
      metadata: { name, ...(flags.parent ? { parents: [flags.parent as string] } : {}) },
      mimeType,
      data,
    });
  }
  // stdout is the machine-readable channel; everything else goes to stderr.
  console.log(JSON.stringify(result, null, 1));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
