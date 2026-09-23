import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { handleAccessRequest } from './access-handler.js';
import { screenClientRegistration } from './redirect-policy.js';
import { registerChatTools } from './chat-tools.js';
import { registerContactsTools } from './contacts-tools.js';
import { registerDriveCollabTools } from './drive-collab-tools.js';
import { registerTools } from './tools.js';
import { registerWorkspaceTools } from './workspace-tools.js';
import {
  hashTicket,
  randomOpaqueTicket,
  ROUTESPRING_DRIVE_DOWNLOAD_URL,
  ticketShard,
  type DriveDownloadTicketRecord,
} from './drive-download-ticket.js';

export { DriveTicketBroker } from './drive-ticket-broker.js';

type Props = { email: string; name: string };

export class GSuiteMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: 'gsuite', version: '0.6.3' });

  async init(): Promise<void> {
    if (this.props?.email.toLowerCase() !== this.env.ALLOWED_EMAIL.toLowerCase()) {
      throw new Error('Forbidden');
    }
    if (this.env.DRIVE_DOWNLOAD_URL !== ROUTESPRING_DRIVE_DOWNLOAD_URL) {
      throw new Error('Drive download endpoint configuration mismatch.');
    }
    registerTools(this.server);
    registerWorkspaceTools(this.server, {
      driveDownload: {
        requester: this.props.email,
        downloadUrl: this.env.DRIVE_DOWNLOAD_URL,
        issue: async (record: DriveDownloadTicketRecord) => {
          const ticket = randomOpaqueTicket();
          const hash = await hashTicket(ticket);
          await this.env.DRIVE_TICKETS.getByName(ticketShard(hash)).issue(hash, record);
          return ticket;
        },
      },
    });
    registerChatTools(this.server);
    registerDriveCollabTools(this.server);
    registerContactsTools(this.server);
  }
}

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: GSuiteMCP.serve('/mcp'),
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientRegistrationCallback: screenClientRegistration,
  allowPlainPKCE: false,
  defaultHandler: { fetch: handleAccessRequest },
});
