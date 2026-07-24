import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('exposes the bounded GSuite tool surface with safety annotations', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-mcp-test-'));
  const client = new Client({ name: 'gsuite-test', version: '1' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, GSUITE_MCP_DIR: stateDir },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const required of [
      'search_threads',
      'update_draft',
      'schedule_send',
      'sheets_read_range',
      'sheets_update_range',
      'drive_search_files',
      'drive_trash_file',
      'calendar_list_events',
      'calendar_create_event',
      'docs_get_document',
      'docs_replace_text',
      'chat_list_spaces',
      'chat_find_direct_message',
      'chat_list_messages',
      'chat_get_message',
      'chat_download_attachment',
      'chat_list_members',
      'chat_send_message',
      'chat_update_message',
      'chat_delete_message',
      'chat_add_reaction',
      'chat_remove_reaction',
    ]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
    assert.ok(!names.has('drive_delete_file'));
    assert.ok(!names.has('gmail_delete_message'));
    assert.ok(!names.has('drive_create_permission'));
    assert.ok(!names.has('chat_create_space'));
    assert.ok(!names.has('chat_delete_space'));
    assert.ok(!names.has('chat_add_member'));
    assert.ok(!names.has('chat_search_messages'));

    const send = tools.find((tool) => tool.name === 'send_message');
    assert.equal(send.annotations?.openWorldHint, true);
    assert.equal(send.annotations?.destructiveHint, true);

    const driveTrash = tools.find((tool) => tool.name === 'drive_trash_file');
    assert.equal(driveTrash.annotations?.destructiveHint, true);

    const driveRead = tools.find((tool) => tool.name === 'drive_search_files');
    assert.equal(driveRead.annotations?.readOnlyHint, true);

    const chatRead = tools.find((tool) => tool.name === 'chat_list_messages');
    assert.equal(chatRead.annotations?.readOnlyHint, true);
    assert.ok(chatRead.inputSchema.required.includes('account'));
    assert.ok(chatRead.inputSchema.required.includes('space'));

    const chatSend = tools.find((tool) => tool.name === 'chat_send_message');
    assert.equal(chatSend.annotations?.openWorldHint, true);
    assert.equal(chatSend.annotations?.destructiveHint, true);

    const chatDelete = tools.find((tool) => tool.name === 'chat_delete_message');
    assert.equal(chatDelete.annotations?.destructiveHint, true);
  } finally {
    await client.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
