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
      'drive_list_shared_drives',
      'drive_trash_file',
      'drive_upload_file',
      'calendar_list_events',
      'calendar_get_availability',
      'calendar_create_event',
      'calendar_respond_to_event',
      'docs_get_document',
      'docs_replace_text',
      'contacts_list',
      'contacts_search',
      'contacts_get',
      'contacts_create',
      'contacts_update',
      'contacts_delete',
      'drive_list_comments',
      'drive_list_comment_replies',
      'drive_create_comment',
      'drive_update_comment',
      'drive_delete_comment',
      'drive_create_reply',
      'drive_delete_reply',
    ]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
    assert.ok(!names.has('drive_delete_file'));
    assert.ok(!names.has('gmail_delete_message'));
    assert.ok(!names.has('drive_create_permission'));

    const send = tools.find((tool) => tool.name === 'send_message');
    assert.equal(send.annotations?.openWorldHint, true);
    assert.equal(send.annotations?.destructiveHint, true);

    const driveTrash = tools.find((tool) => tool.name === 'drive_trash_file');
    assert.equal(driveTrash.annotations?.destructiveHint, true);

    const driveRead = tools.find((tool) => tool.name === 'drive_search_files');
    assert.equal(driveRead.annotations?.readOnlyHint, true);

    for (const name of ['contacts_list', 'contacts_search', 'contacts_get']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be read-only`);
      assert.ok(tool.inputSchema.required.includes('account'), `${name} must require account`);
    }
    for (const name of ['contacts_create', 'contacts_update']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.readOnlyHint, false, `${name} must be mutating`);
      assert.equal(tool.annotations?.destructiveHint, false, `${name} must not be destructive`);
    }
    const contactsUpdate = tools.find((tool) => tool.name === 'contacts_update');
    assert.ok(contactsUpdate.inputSchema.required.includes('resourceName'));
    assert.ok(contactsUpdate.inputSchema.required.includes('etag'));
    const contactsDelete = tools.find((tool) => tool.name === 'contacts_delete');
    assert.equal(contactsDelete.annotations?.destructiveHint, true);
    assert.ok(contactsDelete.inputSchema.required.includes('resourceName'));
    assert.ok(
      driveRead.inputSchema.properties.driveId,
      'drive_search_files must expose a driveId param for shared-drive scoping'
    );

    const sharedDrives = tools.find((tool) => tool.name === 'drive_list_shared_drives');
    assert.equal(sharedDrives.annotations?.readOnlyHint, true);
    assert.ok(sharedDrives.inputSchema.required.includes('account'));

    for (const name of ['drive_list_comments', 'drive_list_comment_replies']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be read-only`);
    }
    for (const name of ['drive_create_comment', 'drive_update_comment', 'drive_create_reply']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.readOnlyHint, false, `${name} must be mutating`);
      assert.equal(tool.annotations?.destructiveHint, false, `${name} must not be destructive`);
      assert.ok(tool.inputSchema.required.includes('account'), `${name} must require account`);
      assert.ok(tool.inputSchema.required.includes('file'), `${name} must require file`);
      assert.ok(tool.inputSchema.required.includes('content'), `${name} must require content`);
    }
    for (const name of ['drive_delete_comment', 'drive_delete_reply']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.destructiveHint, true, `${name} must be destructive`);
      assert.ok(tool.inputSchema.required.includes('commentId'), `${name} must require commentId`);
    }
    assert.ok(
      tools.find((t) => t.name === 'drive_delete_reply').inputSchema.required.includes('replyId')
    );
    assert.ok(
      tools.find((t) => t.name === 'drive_create_reply').inputSchema.required.includes('commentId')
    );

    const calendarRespond = tools.find((tool) => tool.name === 'calendar_respond_to_event');
    assert.equal(calendarRespond.annotations?.readOnlyHint, false);
    assert.equal(calendarRespond.annotations?.destructiveHint, false);
    assert.equal(calendarRespond.annotations?.idempotentHint, true);
    assert.equal(calendarRespond.annotations?.openWorldHint, true);
    assert.deepEqual(calendarRespond.inputSchema.properties.responseStatus.enum, [
      'accepted',
      'declined',
      'tentative',
    ]);
    assert.ok(calendarRespond.inputSchema.required.includes('account'));
    assert.ok(calendarRespond.inputSchema.required.includes('eventId'));
    assert.ok(calendarRespond.inputSchema.required.includes('responseStatus'));

    const createEvent = tools.find((tool) => tool.name === 'calendar_create_event');
    assert.equal(createEvent.inputSchema.properties.addGoogleMeet.type, 'boolean');
    assert.ok(!(createEvent.inputSchema.required ?? []).includes('addGoogleMeet'));

    const driveUpload = tools.find((tool) => tool.name === 'drive_upload_file');
    assert.equal(driveUpload.annotations?.readOnlyHint, false);
    assert.ok(driveUpload.inputSchema.required.includes('filename'));
    assert.equal(driveUpload.inputSchema.properties.path.type, 'string');
    assert.equal(driveUpload.inputSchema.properties.content.type, 'string');

    const availability = tools.find((tool) => tool.name === 'calendar_get_availability');
    assert.equal(availability.annotations?.readOnlyHint, true);
    assert.ok(availability.inputSchema.required.includes('account'));
    assert.ok(availability.inputSchema.required.includes('timeMin'));
    assert.ok(availability.inputSchema.required.includes('timeMax'));
    // calendarIds is the explicit narrow-scope opt-in and must stay optional.
    assert.equal(availability.inputSchema.properties.calendarIds.type, 'array');
    assert.ok(!(availability.inputSchema.required ?? []).includes('calendarIds'));
  } finally {
    await client.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
