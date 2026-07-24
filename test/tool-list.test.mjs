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
      'drive_get_start_page_token',
      'drive_list_changes',
      'drive_query_activity',
      'drive_list_comments',
      'drive_list_comment_replies',
      'drive_list_permissions',
      'drive_list_access_proposals',
      'calendar_list_events',
      'calendar_create_event',
      'docs_get_document',
      'docs_replace_text',
      'docs_list_suggestions',
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
    assert.ok(!names.has('drive_update_permission'));
    assert.ok(!names.has('drive_resolve_access_proposal'));
    assert.ok(!names.has('drive_create_comment'));
    assert.ok(!names.has('drive_create_comment_reply'));
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

    for (const name of [
      'drive_get_start_page_token',
      'drive_list_changes',
      'drive_query_activity',
      'drive_list_comments',
      'drive_list_comment_replies',
      'drive_list_permissions',
      'drive_list_access_proposals',
      'docs_list_suggestions',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be read-only`);
      assert.ok(tool.inputSchema.required.includes('account'), `${name} must require account`);
    }

    const driveComments = tools.find((tool) => tool.name === 'drive_list_comments');
    assert.ok(driveComments.inputSchema.required.includes('file'));

    const driveChanges = tools.find((tool) => tool.name === 'drive_list_changes');
    assert.ok(driveChanges.inputSchema.required.includes('pageToken'));

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
