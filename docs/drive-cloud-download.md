# Cloud Drive download prototype

This prototype moves one ordinary Drive blob directly from Google, through the existing Worker,
into a task-scoped temporary directory. MCP returns only a 90-second ticket and expected metadata;
it never returns file bytes or base64. The ticket itself is visible to the MCP client and model.

Google-native Docs, Sheets, Slides, shortcuts, and folders are rejected. Their export bytes are not
immutably identified by Drive's blob `headRevisionId` and SHA-256 fields, so export needs a separate
approved design.

## API

Call `drive_issue_download_ticket` through the authenticated remote MCP with:

- `account`: explicit alias or exact email address.
- `fileId`: exact Drive identifier; URLs are rejected.
- `expectedSha256`: trusted 64-character SHA-256 for the exact blob.

The tool verifies current download and revision-read capabilities, effective download restrictions,
MIME allowlist, positive size up to 20 MiB, `headRevisionId`, and Drive's `sha256Checksum`. It
returns the expected filename, MIME type, byte size, head revision, SHA-256, endpoint, expiry, and
opaque bearer ticket.

Redeem once with `GET /drive/download` and `Authorization: Bearer <ticket>`. The endpoint accepts no
query parameters. It atomically consumes the hashed ticket before any Google request, rechecks the
account, permission, restrictions, metadata, head revision, size, and SHA-256, refuses redirects,
then streams the fixed Drive `revisions.get?alt=media` response for that exact head revision with
backpressure and a 30-second limit.

The head revision and SHA-256, not `modifiedTime`, bind the authorized content version. The
downloader independently hashes the delivered stream and does not rename the private partial file
to its final name until both exact size and trusted SHA-256 match.

## Downloader

Build with `npm run build`. Put the ticket in `GSUITE_DRIVE_DOWNLOAD_TICKET` through the task
runtime's environment/secret mechanism; never place it in argv, a URL, or logs. Then run:

```bash
npm run download -- \
  --url https://gsuite-mcp.tarun-me.workers.dev/drive/download \
  --file-id DRIVE_FILE_ID \
  --filename EXPECTED_FILENAME \
  --mime-type EXPECTED_MIME_TYPE \
  --size EXPECTED_BYTE_SIZE \
  --version EXPECTED_HEAD_REVISION_ID \
  --sha256 EXPECTED_SHA256 \
  --task-scope CLOUD_TASK_ID
```

Successful output is one JSON object containing only the private filesystem path and verified
metadata. Failure removes the partial file and its temporary directory. Delete the returned
directory after processing. That cleanup does not prove immediate deletion of hosted execution
snapshots; Work Cloud execution state follows its own retention lifecycle.

The downloader pins the exact Routespring Worker URL shown above and refuses every other host
before sending the bearer ticket. Changing the deployment hostname requires a reviewed code and
configuration change; it cannot be overridden at runtime.

## Security and audit

- Tickets contain 256 random bits, expire after 90 seconds, and are distributed by hash across 256
  SQLite-backed Durable Object shards. Only SHA-256 ticket hashes are stored.
- A single atomic `UPDATE ... RETURNING` consumes a ticket across concurrent requests and Worker
  instances. Failed or interrupted transfers require a newly authorized ticket.
- Ticket records bind the authenticated requester, Google account, exact file, operation, head
  revision, SHA-256, filename, MIME type, and size.
- Google credentials remain inside the Worker. The only upstream URL is the encoded Drive file-ID
  endpoint and redirects are refused, preventing SSRF and credential forwarding.
- Structured issuance, redemption, rejection, completion, and interruption events omit tickets,
  Authorization headers, credentials, and content.

## Deployment and rollback

Deployment exposes a new bearer-ticket route on the existing Worker and applies migration `v2` for
the `DriveTicketBroker` Durable Object binding. It does not change the existing MCP OAuth flow,
Cloudflare Access identity provider, sharing, Google scopes, or upload endpoint. Production deploy
and creation of the Durable Object namespace require explicit approval.

After approval:

1. Record the current Worker version with `wrangler versions list`.
2. Run the complete tests and `wrangler deploy --dry-run`.
3. Deploy with `wrangler deploy`.
4. Run the cloud acceptance test from the existing Routespring verification task.

Rollback with `wrangler rollback <PREVIOUS_VERSION_ID>`. The MCP action and download route disappear
immediately; all tickets expire within 90 seconds. Durable Object storage is retained but contains
only hashes and bounded metadata. Removing that stored namespace later is a separate destructive
migration and requires approval.
