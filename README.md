# gsuite-mcp

A local-first MCP server for operating multiple Google Workspace accounts through one explicit interface.

## Services

- **Gmail:** search/read threads and messages; drafts; HTML and attachments; send; scheduled drafts; labels; archive; recoverable Trash.
- **Sheets:** metadata, range reads, exact range updates, and row append.
- **Drive:** search, metadata, download/export, folders, rename, move, and recoverable Trash.
- **Calendar:** calendar/event reads plus event create, update, and delete.
- **Docs:** plain-text read, create, append, and replace-all.
- **Google Chat:** joined-space and direct-message discovery, messages, attachments, members, reactions, send/reply, edit, and named-message deletion.

Every service tool requires an `account` alias or exact email. Each account can use a different Desktop OAuth client when Workspace organization policies require it.

The Gmail foundation is based on [Vinksj/claude-gmail-multi](https://github.com/Vinksj/claude-gmail-multi) and retains its MIT license.

## Install

Requires Node.js 20 or newer. Enable the Gmail, Sheets, Drive, Calendar, Docs, and Google Chat APIs in your Google Cloud project.

```bash
npm install
npm run build
```

Create a Google Cloud Desktop OAuth client, then authorize each account:

```bash
npm run auth -- --alias personal --email you@gmail.com \
  --credentials /path/to/desktop-oauth-client.json

npm run auth -- --alias work --email you@company.com \
  --credentials /path/to/desktop-oauth-client.json
```

Register `dist/index.js` as a stdio MCP server:

```json
{
  "mcpServers": {
    "gsuite": {
      "command": "node",
      "args": ["/absolute/path/to/gsuite-mcp/dist/index.js"]
    }
  }
}
```

State is stored under `~/.gsuite-mcp/`. Set `GSUITE_MCP_DIR` to override that location.

## Scheduled email

`schedule_send` creates a Gmail draft and queues it. `schedule_draft_send` queues an existing draft. Use `list_scheduled_sends` and `cancel_scheduled_send` to inspect or cancel the queue.

Scheduling authorizes the later send. The MCP process checks every 30 seconds. If it is offline at the requested time, the draft sends on its next startup. An ambiguous failure is recorded and never retried automatically, preventing duplicate mail.

## Safety

- Account selection is mandatory and results echo the authenticated account.
- Gmail and Drive expose recoverable Trash, never permanent deletion.
- Sharing, forwarding, permissions, and Workspace administration are not exposed.
- Chat does not expose global/admin search, space creation/deletion, membership mutation, history settings, or Developer Preview methods.
- Chat sends, edits, reactions, and deletions require explicit user approval; message deletion is permanent.
- Mutating and external tools carry MCP safety annotations.
- Scheduled-send processing uses a cross-process lock.
- OAuth clients, tokens, schedule state, downloaded data, and generated account exports are excluded by `.gitignore`.

The OAuth scopes are `gmail.modify`, `spreadsheets`, `drive`, `calendar`, `documents`, `chat.spaces.readonly`, `chat.messages`, and `chat.memberships.readonly`. Google classifies `chat.messages` as restricted; a Workspace administrator might need to trust the OAuth client, and public deployments can require Google verification. These are powerful scopes intended for self-hosted use; review the tool surface before authorizing an agent.

## Related MCPs

- [corp-travel](https://github.com/tarun101/corp-travel) — policy-aware corporate flight search.
- [simplefin](https://github.com/tarun101/simplefin) — read-only balances and transactions through SimpleFIN Bridge.

## Development

```bash
npm run build
npm run bundle
npm audit
```
