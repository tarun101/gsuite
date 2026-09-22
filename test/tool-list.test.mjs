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
      'sheets_delete_rows',
      'sheets_hide_rows',
      'drive_search_files',
      'drive_list_shared_drives',
      'drive_trash_file',
      'drive_upload_file',
      'drive_import_presentation',
      'slides_get_presentation',
      'slides_batch_update',
      'calendar_list_events',
      'calendar_get_availability',
      'calendar_create_event',
      'calendar_respond_to_event',
      'chat_get_message',
      'chat_download_attachment',
      'chat_send_message',
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

    const sheetsDeleteRows = tools.find((tool) => tool.name === 'sheets_delete_rows');
    assert.equal(sheetsDeleteRows.annotations?.readOnlyHint, false);
    assert.equal(sheetsDeleteRows.annotations?.destructiveHint, true);
    assert.equal(sheetsDeleteRows.annotations?.idempotentHint, false);
    for (const field of ['account', 'spreadsheet', 'sheetId', 'startRow', 'endRow']) {
      assert.ok(
        sheetsDeleteRows.inputSchema.required.includes(field),
        `sheets_delete_rows must require ${field}`
      );
    }

    const sheetsHideRows = tools.find((tool) => tool.name === 'sheets_hide_rows');
    assert.equal(sheetsHideRows.annotations?.readOnlyHint, false);
    assert.equal(sheetsHideRows.annotations?.destructiveHint, false);
    assert.equal(sheetsHideRows.annotations?.idempotentHint, true);
    for (const field of ['account', 'spreadsheet', 'sheetId', 'startRow', 'endRow']) {
      assert.ok(
        sheetsHideRows.inputSchema.required.includes(field),
        `sheets_hide_rows must require ${field}`
      );
    }

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
    assert.ok(!(driveUpload.inputSchema.required ?? []).includes('filename'));
    assert.equal(driveUpload.inputSchema.properties.fileId.type, 'string');
    assert.equal(driveUpload.inputSchema.properties.path.type, 'string');
    assert.equal(driveUpload.inputSchema.properties.content.type, 'string');

    assert.equal(tools.find((tool) => tool.name === 'drive_issue_download_ticket'), undefined);
    assert.equal(tools.find((tool) => tool.name === 'drive_issue_upload_ticket'), undefined);

    const driveImportPresentation = tools.find((tool) => tool.name === 'drive_import_presentation');
    assert.equal(driveImportPresentation.annotations?.readOnlyHint, false);
    assert.equal(driveImportPresentation.annotations?.destructiveHint, false);
    assert.ok(driveImportPresentation.inputSchema.required.includes('account'));
    assert.ok(driveImportPresentation.inputSchema.required.includes('path'));
    assert.ok(driveImportPresentation.inputSchema.required.includes('title'));
    assert.equal(driveImportPresentation.inputSchema.properties.parentId.type, 'string');

    const slidesRead = tools.find((tool) => tool.name === 'slides_get_presentation');
    assert.equal(slidesRead.annotations?.readOnlyHint, true);
    assert.ok(slidesRead.inputSchema.required.includes('account'));
    assert.ok(slidesRead.inputSchema.required.includes('presentation'));

    const slidesUpdate = tools.find((tool) => tool.name === 'slides_batch_update');
    assert.equal(slidesUpdate.annotations?.readOnlyHint, false);
    assert.equal(slidesUpdate.annotations?.destructiveHint, true);
    assert.ok(slidesUpdate.inputSchema.required.includes('account'));
    assert.ok(slidesUpdate.inputSchema.required.includes('presentation'));
    assert.ok(slidesUpdate.inputSchema.required.includes('requests'));

    const chatDownload = tools.find((tool) => tool.name === 'chat_download_attachment');
    // Not readOnly: it writes the attachment into ~/Downloads. Clients auto-approve on this hint.
    assert.equal(chatDownload.annotations?.readOnlyHint, false);
    assert.equal(chatDownload.inputSchema.properties.resourceName.type, 'string');
    assert.equal(chatDownload.inputSchema.properties.driveFileId.type, 'string');
    assert.ok(!(chatDownload.inputSchema.required ?? []).includes('resourceName'));
    assert.ok(!(chatDownload.inputSchema.required ?? []).includes('driveFileId'));

    const chatSend = tools.find((tool) => tool.name === 'chat_send_message');
    assert.equal(chatSend.annotations?.destructiveHint, true);
    assert.equal(chatSend.annotations?.openWorldHint, true);
    assert.equal(chatSend.inputSchema.properties.attachments.type, 'array');
    assert.equal(chatSend.inputSchema.properties.attachments.items.properties.path.type, 'string');
    assert.equal(chatSend.inputSchema.properties.attachments.items.properties.contentBase64.type, 'string');
    assert.equal(chatSend.inputSchema.properties.requestId.format, 'uuid');
    assert.match(chatSend.inputSchema.properties.requestId.description, /identical request/);

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

test('the remote build only advertises tools it can actually run', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-mcp-remote-test-'));
  const client = new Client({ name: 'gsuite-remote-test', version: '1' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, GSUITE_REMOTE: '1', GSUITE_MCP_DIR: stateDir },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    // Writes into ~/Downloads on the server host — meaningless on a Worker, so
    // the remote build must not offer it at all.
    assert.ok(!names.has('drive_download_file'));

    const driveUpload = tools.find((tool) => tool.name === 'drive_upload_file');
    assert.ok(driveUpload, 'drive_upload_file must stay available remotely');
    // "read from disk on the machine running this server" is a lie on Workers.
    assert.equal(driveUpload.inputSchema.properties.path, undefined);
    assert.equal(driveUpload.inputSchema.properties.content.type, 'string');
    assert.ok(!/local file/.test(driveUpload.description));

    const driveTicket = tools.find((tool) => tool.name === 'drive_issue_download_ticket');
    assert.ok(driveTicket, 'remote build must advertise cloud Drive download ticket issuance');
    assert.equal(driveTicket.annotations?.readOnlyHint, false);
    assert.ok(driveTicket.inputSchema.required.includes('account'));
    assert.ok(driveTicket.inputSchema.required.includes('fileId'));
    assert.ok(driveTicket.inputSchema.required.includes('expectedSha256'));
    assert.equal(driveTicket.inputSchema.properties.expectedSha256.pattern, '^[A-Fa-f0-9]{64}$');

    const uploadTicket = tools.find((tool) => tool.name === 'drive_issue_upload_ticket');
    assert.ok(uploadTicket, 'remote build must advertise cloud Drive upload ticket issuance');
    assert.equal(uploadTicket.annotations?.readOnlyHint, false);
    assert.ok(uploadTicket.inputSchema.required.includes('account'));
    assert.ok(uploadTicket.inputSchema.required.includes('byteSize'));
    assert.ok(uploadTicket.inputSchema.required.includes('sha256'));
    assert.match(uploadTicket.description, /20 KB/);

    for (const name of [
      'drive_issue_export_download_ticket',
      'gmail_issue_attachment_download_ticket',
      'chat_issue_attachment_download_ticket',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be available remotely`);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.ok(tool.inputSchema.required.includes('account'));
      assert.ok(tool.inputSchema.required.includes('filename'));
      assert.ok(tool.inputSchema.required.includes('mimeType'));
    }
  } finally {
    await client.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
