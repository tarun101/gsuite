import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { handleAccessRequest } from './access-handler.js';
import { registerChatTools } from './chat-tools.js';
import { registerContactsTools } from './contacts-tools.js';
import { registerDriveCollabTools } from './drive-collab-tools.js';
import { registerTools } from './tools.js';
import { registerWorkspaceTools } from './workspace-tools.js';

type Props = { email: string; name: string };

export class GSuiteMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: 'gsuite', version: '0.6.0' });

  async init(): Promise<void> {
    if (this.props?.email.toLowerCase() !== this.env.ALLOWED_EMAIL.toLowerCase()) {
      throw new Error('Forbidden');
    }
    registerTools(this.server);
    registerWorkspaceTools(this.server);
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
  defaultHandler: { fetch: handleAccessRequest },
});
