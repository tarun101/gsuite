# gsuite-mcp

`gsuite-mcp` is a self-hosted [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
server for Google Workspace. It gives an MCP client one account-explicit interface to Gmail,
Google Calendar, Drive, Docs, Sheets, Chat, and Contacts.

## Why not just use a Gmail MCP?

A Gmail-only MCP is enough when an agent only needs to read or send email. Real Workspace tasks,
however, rarely stop at the inbox: a message refers to a Drive file, a meeting needs a Calendar
availability check, a decision belongs in a Sheet or Doc, and the people involved may need to be
resolved through Contacts or Chat.

You can assemble separate MCP servers for each service, but then the client has to coordinate
multiple connectors, authentication stores, account-selection conventions, tool shapes, and safety
models. `gsuite-mcp` keeps that workflow inside one server:

- **One connected tool surface:** 89 tools span Gmail, Calendar, Drive, Docs, Sheets, Chat, and
  Contacts, so an agent can complete cross-service work without switching integrations.
- **Explicit multi-account routing:** every Google service call names an account alias or exact
  email. Personal and work accounts can coexist without relying on a hidden default.
- **One authorization flow per account:** authorize an account once for the supported Workspace
  services, while still allowing separate OAuth clients where an organization requires them.
- **Practical read and write coverage:** the server goes beyond search and retrieval to drafts,
  sends, uploads, calendar changes, document edits, Sheet updates, comments, and other operational
  workflows.
- **Consistent safety behavior:** tool annotations identify read-only, mutating, destructive, and
  external actions; Gmail and Drive deletion uses recoverable Trash; account identity is returned
  in results.
- **Local or remote operation:** run over local stdio with files and scheduled sends, or deploy the
  OAuth-protected Worker for remote access. Large Drive uploads can bypass the model context
  entirely.

If you only need narrow, read-only Gmail access, a smaller single-purpose server may still be the
better choice. This project is for users who want one coherent MCP for multi-account work across
the broader Google Workspace suite.

The recommended setup runs locally over stdio. You clone the repository, authorize your own
Google accounts, and point your MCP client at the built server. An optional Cloudflare Workers
entry point is included for operators who need a remote, OAuth-protected deployment.

## What it supports

The current server exposes 89 tools across these services:

- **Gmail:** search and read threads/messages, work with drafts and attachments, send mail,
  schedule local sends, manage labels, archive, and move messages or threads to recoverable Trash.
- **Sheets:** read metadata and ranges, update exact ranges, append rows, hide rows, and permanently
  delete rows.
- **Drive:** search, inspect, download/export, upload, create folders, rename, move, use recoverable
  Trash, work with shared drives, inspect activity and changes, and manage comments and replies.
- **Calendar:** list calendars and events, calculate cross-calendar availability, create or update
  events and recurrence, add Google Meet, RSVP, and delete events.
- **Docs:** read plain text, create documents, append text, replace text, and list suggestions.
- **Chat:** list spaces, messages, members, and reactions; send or update messages; transfer
  attachments; and manage reactions.
- **Contacts:** list, search, read, create, update, and permanently delete personal Google Contacts.

Every Google service tool requires an `account` alias or exact email address. This prevents a
client from silently acting through the wrong account. Separate accounts may also use separate
Google OAuth clients when an organization's policies require it.

The Gmail foundation is based on
[Vinksj/claude-gmail-multi](https://github.com/Vinksj/claude-gmail-multi) and retains its MIT
license.

## Requirements

- Node.js 20 or newer
- A Google Cloud project you control
- A Desktop OAuth client for that project
- An MCP client that can launch a local stdio server

## Quick start: local stdio server

### 1. Download and build

```bash
git clone https://github.com/tarun101/gsuite.git
cd gsuite
npm ci
npm run build
```

The compiled server is `dist/index.js`.

### 2. Configure Google Cloud

In your Google Cloud project:

1. Enable the Gmail, Google Sheets, Google Drive, Google Calendar, Google Docs, Google Drive
   Activity, Google Chat, and People APIs.
2. Configure the OAuth consent screen. If the app is in testing mode, add every Google account you
   plan to connect as a test user.
3. Create an OAuth 2.0 client ID with application type **Desktop app** and download its JSON file.

Google's [OAuth 2.0 for native apps](https://developers.google.com/identity/protocols/oauth2/native-app)
guide covers the Desktop client flow used here. Keep the downloaded client JSON private.

### 3. Authorize an account

Choose any short alias, such as `personal` or `work`:

```bash
npm run auth -- \
  --alias personal \
  --email you@example.com \
  --credentials /absolute/path/to/desktop-oauth-client.json
```

The command starts a loopback OAuth flow, prints the authorization URL, and stores the resulting
configuration and tokens under `~/.gsuite-mcp/`. Repeat it with another alias to connect more
accounts:

```bash
npm run auth -- \
  --alias work \
  --email you@company.com \
  --credentials /absolute/path/to/that-accounts-oauth-client.json
```

`--email` is optional, but recommended: it makes authorization fail if the browser signs into a
different account than the one you intended. Set `GSUITE_MCP_DIR` if you want the private runtime
state stored somewhere other than `~/.gsuite-mcp/`.

### 4. Connect an MCP client

For Codex CLI, use the absolute path to the compiled entry point:

```bash
codex mcp add gsuite -- node /absolute/path/to/gsuite/dist/index.js
codex mcp list
```

For clients that accept an `mcpServers` JSON object, including Claude Desktop, use:

```json
{
  "mcpServers": {
    "gsuite": {
      "command": "node",
      "args": ["/absolute/path/to/gsuite/dist/index.js"]
    }
  }
}
```

Restart the client after changing its MCP configuration. The server's `list_accounts` tool should
then show the aliases you authorized.

## Verify the installation

Run the automated checks:

```bash
npm test
```

The suite builds the project, starts the server through the MCP stdio transport, validates the tool
surface and safety annotations, and runs the unit tests. To inspect the tools interactively:

```bash
npm run inspect
```

These checks do not call Google. A real Google API call still depends on your enabled APIs,
consent-screen configuration, OAuth client, account permissions, and stored authorization.

## Local behavior and data

Local runtime state is stored under `~/.gsuite-mcp/` by default:

- `config.json` maps aliases to accounts.
- `credentials/` holds the copied OAuth client JSON for each alias.
- `tokens/` holds Google OAuth tokens.
- Scheduled-send and retry state is stored alongside them when those tools are used.

These files contain secrets. Do not commit, sync, or share that directory. The repository's
`.gitignore` excludes the corresponding development files when they are placed in the checkout.

Local mode also supports operations that a remote Worker cannot safely perform on your machine:

- downloading attachments to local paths;
- attaching files by local path;
- authorizing accounts through `add_account`; and
- running the scheduled-send loop.

The scheduled-send worker checks every 30 seconds while the MCP process is running. If it is
offline at the scheduled time, the draft sends the next time the process starts. An ambiguous send
failure is recorded and is not retried automatically, which reduces duplicate-send risk.

## Uploading files to Drive

`drive_upload_file` takes inline base64 content, which means the whole file travels through the MCP
client's context. For anything larger than a small file, use the `gsuite-upload` command instead:
it reads from disk and prints only the resulting Drive metadata, so the bytes never enter a
conversation.

```bash
npm run upload -- --account work --path ./report.pdf --parent <folderId>
```

Uploads under 5 MB use a single multipart request; larger ones use a Drive resumable session.

## Optional remote deployment

The repository includes a Cloudflare Worker entry point with OAuth protection. Remote mode uses
HTTP transport and Worker secrets instead of the local token directory. It intentionally disables
local-path downloads and attachments, account provisioning, and the local scheduled-send loop.

The remote build does not advertise the tools and parameters it cannot honor: `drive_download_file`
is absent, and `drive_upload_file` offers no `path`.

The checked-in `wrangler.jsonc` describes the maintainer's private deployment. It contains
deployment-specific Worker, KV, Cloudflare Access, allowed-user, and Google account settings; it is
not a portable one-command template. Before deploying a fork, replace those values with resources
and identities you control and configure the matching secrets referenced by `src/access-handler.ts`
and `src/accounts.ts`.

After deploying your own Worker, a Codex client can connect to it with:

```bash
codex mcp add gsuite --url https://YOUR-WORKER.example/mcp
codex mcp login gsuite
```

### Upload endpoint

A deployed Worker can also accept a file directly, for a machine that holds no Google credentials of
its own. The endpoint is served **only** when the `GSUITE_UPLOAD_TOKEN` secret is set, so a
deployment that has not opted in exposes no upload surface at all:

```bash
wrangler secret put GSUITE_UPLOAD_TOKEN
```

```bash
export GSUITE_UPLOAD_URL=https://YOUR-WORKER.example/upload
export GSUITE_UPLOAD_TOKEN=...
npm run upload -- --remote --account work --path ./report.pdf
```

The raw file is the request body, `account` and `filename` are query parameters, and the bearer
token authenticates. Uploads are capped at 20 MB, since a Worker buffers the body in memory.

The maintainer's hosted endpoint is access-restricted and is not a shared public Google Workspace
service. For most users, the local stdio quick start above is the supported path.

## Safety and scope

This MCP requests powerful Google scopes: `gmail.modify`, `spreadsheets`, `drive`, `calendar`,
`documents`, `drive.activity.readonly`, `chat.spaces.readonly`, `chat.messages`,
`chat.memberships.readonly`, and `contacts`.

Review the tool surface and your MCP client's approval settings before connecting an important
account. In particular:

- sending Gmail or Chat messages and creating invitations affects other people;
- Sheets row deletion and Contacts deletion are permanent;
- Calendar deletion is destructive;
- Gmail and Drive removal tools use recoverable Trash rather than permanent deletion; and
- sharing, forwarding, permission changes, and Workspace administration are not exposed.

Mutating and external-action tools include MCP safety annotations, but the operator remains
responsible for deciding which actions an agent may perform.

## Updating

```bash
git pull --ff-only
npm ci
npm run build
npm test
```

Restart the MCP client after rebuilding so it launches the new server code.

## Development

```bash
npm run build
npm run typecheck:worker
npm run bundle
npm audit
```

`dist/` is generated and intentionally not committed. The project is licensed under the
[MIT License](LICENSE).

## Related MCPs

- [corp-travel](https://github.com/tarun101/corp-travel) — policy-aware corporate flight search.
- [simplefin](https://github.com/tarun101/simplefin) — read-only balances and transactions through
  SimpleFIN Bridge.
