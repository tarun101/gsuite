import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { startScheduledSendWorker } from './scheduler.js';
import { registerWorkspaceTools } from './workspace-tools.js';

// stdout is the JSON-RPC channel — all diagnostics must go to stderr (console.error).
const server = new McpServer({ name: 'gsuite', version: '0.3.1' });
registerTools(server);
registerWorkspaceTools(server);
startScheduledSendWorker();

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('gsuite MCP server running (stdio, multi-account Google Workspace build)');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
