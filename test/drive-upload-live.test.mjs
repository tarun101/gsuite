// End-to-end regression for the Drive multipart upload path.
//
// Guards the "Missing end boundary in multipart body" bug: the body Drive
// receives has to be a complete multipart/related document, and the bytes have
// to survive intact. A unit test can check the layout, but only a real upload
// proves the assembled body is one Drive accepts, so this test uploads a small
// binary and reads the stored metadata back.
//
// Skipped unless a real account is configured, so CI without credentials stays
// green. Run against a chosen account with:
//   GSUITE_LIVE_TEST=1 GSUITE_LIVE_ACCOUNT=work node --test test/drive-upload-live.test.mjs
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ACCOUNT = process.env.GSUITE_LIVE_ACCOUNT || 'personal';
const STATE_DIR = process.env.GSUITE_MCP_DIR || path.join(os.homedir(), '.gsuite-mcp');
const CONFIG = path.join(STATE_DIR, 'config.json');

// A 1x1 transparent PNG: small, genuinely binary, and byte-identical on readback.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function configured() {
  if (process.env.GSUITE_LIVE_TEST !== '1') return false;
  if (!fs.existsSync(CONFIG)) return false;
  const { accounts = {} } = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const entry = accounts[ACCOUNT];
  return Boolean(entry) && fs.existsSync(path.join(STATE_DIR, entry.tokenFile));
}

const callJson = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => part.text).join('');
  assert.equal(result.isError, undefined, `${name} failed: ${text}`);
  return JSON.parse(text);
};

test(
  'uploads a small binary to Drive and reads its metadata back',
  { skip: configured() ? false : `set GSUITE_LIVE_TEST=1 and configure the "${ACCOUNT}" account` },
  async (t) => {
    const bytes = Buffer.from(PNG_BASE64, 'base64');
    const filename = `zz-upload-regression-${Date.now()}.png`;
    const client = new Client({ name: 'gsuite-upload-regression', version: '1' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: process.env,
      stderr: 'pipe',
    });
    let uploadedId;
    try {
      await client.connect(transport);

      const uploaded = await callJson(client, 'drive_upload_file', {
        account: ACCOUNT,
        filename,
        mimeType: 'image/png',
        content: PNG_BASE64,
      });
      uploadedId = uploaded.id;
      assert.ok(uploadedId, 'upload returned no file id');
      assert.equal(uploaded.name, filename);

      const metadata = await callJson(client, 'drive_get_file', {
        account: ACCOUNT,
        fileId: uploadedId,
      });
      assert.equal(metadata.name, filename);
      assert.equal(metadata.mimeType, 'image/png');
      // The truncation symptom of the old bug: Drive either rejected the body or
      // stored fewer bytes than we sent.
      assert.equal(Number(metadata.size), bytes.length);
    } finally {
      if (uploadedId) {
        await callJson(client, 'drive_trash_file', { account: ACCOUNT, fileId: uploadedId }).catch(
          (error) => t.diagnostic(`cleanup failed for ${uploadedId}: ${error.message}`)
        );
      }
      await client.close();
    }
  }
);
