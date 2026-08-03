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
      'drive_upload_file',
      'calendar_list_events',
      'calendar_get_availability',
      'calendar_create_event',
      'calendar_respond_to_event',
      'docs_get_document',
      'docs_replace_text',
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
