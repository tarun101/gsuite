# gsuite-mcp

A Cloudflare-hosted MCP server for operating multiple Google Workspace accounts through one
OAuth-protected interface. Production is deployed at
`https://gsuite-mcp.tarun-me.workers.dev/mcp`; the local Node entry point is for development only.

## Services

- **Gmail:** search/read threads and messages; drafts; HTML and attachments; send; scheduled drafts; labels; archive; recoverable Trash.
- **Sheets:** metadata, range reads, exact range updates, row append, row hiding, and permanent row deletion.
- **Drive:** search, metadata, download/export, upload, folders, rename, move, and recoverable Trash.
- **Calendar:** calendar/event reads (every event reports explicit `transparency`/`busy`, and `expandRecurring: false` returns the recurring series with its rules), cross-calendar free/busy availability (aggregates every calendar the account can see by default, with an explicit narrow-scope opt-in), plus event create and update with Busy/Free transparency and RFC 5545 recurrence (RRULE/EXRULE/RDATE/EXDATE, validated before the call), optional Google Meet, RSVP, and delete.
- **Chat:** spaces, messages, members, reactions, text/file sends, and streamed attachment downloads for both Chat-uploaded and Drive-backed files.
- **Docs:** plain-text read, create, append, and replace-all.
- **Contacts:** list, search, get, create, and update personal Google Contacts; delete is available but permanent.

Every service tool requires an `account` alias or exact email. Each account can use a different Desktop OAuth client when Workspace organization policies require it.

The Gmail foundation is based on [Vinksj/claude-gmail-multi](https://github.com/Vinksj/claude-gmail-multi) and retains its MIT license.

## Production connection

The production Worker is protected by Cloudflare Access and configured for the `personal` and
`work` account aliases. Register and authenticate it in Codex:

```bash
codex mcp add gsuite --url https://gsuite-mcp.tarun-me.workers.dev/mcp
codex mcp login gsuite
```

Do not register `dist/index.js` as the operational connector. Remote mode intentionally disables
server-side downloads to local paths, path-based attachments, account provisioning, and the local
scheduled-send loop. The remote build does not advertise the tools and parameters it cannot honor:
`drive_download_file` is absent, and `drive_upload_file` offers no `path`. Attachment sends use
inline base64 content; use an approved client-side ingestion or external-automation workflow for
the other local-only operations.

## Uploading files to Drive

`drive_upload_file` takes inline base64 content, which means the whole file travels through the MCP
client's context. For anything but a small file, use the `gsuite-upload` command instead: it reads
from disk and prints only the resulting Drive metadata, so the bytes never enter a conversation.

```bash
npm run upload -- --account work --path ./BCP-v6.0.pdf --parent <folderId>
```

Uploads under 5 MB use a multipart request; larger ones use a Drive resumable session.

### Remote upload endpoint

For a machine that holds no Google credentials of its own, the Worker can accept the file and
forward it. The endpoint is served **only** when the `GSUITE_UPLOAD_TOKEN` secret is set — an
unconfigured deployment has no upload surface at all:

```bash
wrangler secret put GSUITE_UPLOAD_TOKEN
```

```bash
export GSUITE_UPLOAD_URL=https://gsuite-mcp.tarun-me.workers.dev/upload
export GSUITE_UPLOAD_TOKEN=...
npm run upload -- --remote --account work --path ./BCP-v6.0.pdf
```

The raw file is the request body; `account` and `filename` are query parameters and the bearer
token authenticates. Uploads are capped at 20 MB, since a Worker buffers the body in memory.

## Local development

Requires Node.js 20 or newer. Enable the Gmail, Sheets, Drive, Calendar, Docs, People, and Google Chat APIs in your Google Cloud project.

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

For isolated development or MCP Inspector testing, run `dist/index.js` over stdio:

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

Development state is stored under `~/.gsuite-mcp/`. Set `GSUITE_MCP_DIR` to override that location.

### Drive downloads

`drive_download_file` writes into `~/Downloads` on the machine running the server, so it exists
only in the local build. In production, download or export from the MCP client instead.

### Google Chat attachments

`chat_download_attachment` is available only in local development. In production, use an approved
client-side download workflow.

`chat_send_message` accepts up to ten attachments. Production requires inline `contentBase64`;
absolute local paths are development-only. Attachment sends require a UUID `requestId` and reuse
persisted upload references on retry.

## Scheduled email

The scheduled-send queue is local-development-only and is not enabled on the production Worker.
Production scheduling belongs in an external automation that calls the remote MCP at execution
time.

Scheduling authorizes the later send. The MCP process checks every 30 seconds. If it is offline at the requested time, the draft sends on its next startup. An ambiguous failure is recorded and never retried automatically, preventing duplicate mail.

## Safety

- Account selection is mandatory and results echo the authenticated account.
- Gmail and Drive expose recoverable Trash, never permanent deletion.
- Sharing, forwarding, permissions, and Workspace administration are not exposed.
- Mutating and external tools carry MCP safety annotations.
- Scheduled-send processing uses a cross-process lock.
- OAuth clients, tokens, schedule state, downloaded data, and generated account exports are excluded by `.gitignore`.

The OAuth scopes are `gmail.modify`, `spreadsheets`, `drive`, `calendar`, `documents`, `drive.activity.readonly`, `chat.spaces.readonly`, `chat.messages`, `chat.memberships.readonly`, and `contacts`. These are powerful scopes intended for self-hosted use; review the tool surface before authorizing an agent.

## Related MCPs

- [corp-travel](https://github.com/tarun101/corp-travel) — policy-aware corporate flight search.
- [simplefin](https://github.com/tarun101/simplefin) — read-only balances and transactions through SimpleFIN Bridge.

## Development

```bash
npm run build
npm run bundle
npm audit
```
