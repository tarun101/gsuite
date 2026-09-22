import { DriveTicketBroker } from '../src/drive-ticket-broker.js';
import type { DriveDownloadTicketRecord } from '../src/drive-download-ticket.js';
import type { DriveUploadTicketRecord } from '../src/drive-upload-ticket.js';

export { DriveTicketBroker };

interface TestEnv {
  DRIVE_TICKETS: DurableObjectNamespace<DriveTicketBroker>;
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response('ready');
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    const input = await request.json<{
      shard: string;
      ticketHash: string;
      now?: number;
      record?: DriveDownloadTicketRecord;
      uploadRecord?: DriveUploadTicketRecord;
    }>();
    const broker = env.DRIVE_TICKETS.getByName(input.shard);
    if (url.pathname === '/issue' && input.record) {
      await broker.issue(input.ticketHash, input.record);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/issue-upload' && input.uploadRecord) {
      await broker.issueUpload(input.ticketHash, input.uploadRecord);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/consume' && input.now !== undefined) {
      return Response.json(await broker.consume(input.ticketHash, input.now));
    }
    if (url.pathname === '/consume-upload' && input.now !== undefined) {
      return Response.json(await broker.consumeUpload(input.ticketHash, input.now));
    }
    return new Response('bad request', { status: 400 });
  },
} satisfies ExportedHandler<TestEnv>;
