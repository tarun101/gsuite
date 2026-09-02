// POST /upload — push a file into Drive without its bytes passing through an
// MCP client (and so without passing through a model's context).
//
// The MCP tool takes base64 inline content, which makes every uploaded byte part
// of the conversation. This endpoint takes the raw body instead, so the local
// `gsuite-upload --remote` handler can stream a file straight from disk to Drive
// via the Worker.
//
// Auth is a bearer token held in the GSUITE_UPLOAD_TOKEN secret. When that
// secret is unset the route is not served at all — a deployment that has not
// opted in exposes no upload surface.
import { workspaceFor } from './workspace.js';
import { mimeTypeForFilename } from './drive-upload.js';
import { uploadToDrive } from './drive-transfer.js';

/**
 * Cap on a single upload. The body is buffered to build the request, and a
 * Worker has 128 MB of memory for everything it is doing; anything larger
 * belongs on a machine that can talk to Drive directly.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Compare two secrets without leaking their length or contents through timing. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]).then((digests) => digests.map((digest) => new Uint8Array(digest)));
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

/** Handles POST /upload; returns null for anything else so the caller can keep routing. */
export async function handleUploadRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/upload') return null;
  // Unconfigured deployments look like they have no such route.
  if (!env.GSUITE_UPLOAD_TOKEN) return null;
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const presented = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!presented || !(await tokenMatches(presented, env.GSUITE_UPLOAD_TOKEN))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const account = url.searchParams.get('account');
  const filename = url.searchParams.get('filename');
  if (!account || !filename) return json({ error: 'Both "account" and "filename" are required.' }, 400);

  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return json({ error: `File exceeds the ${MAX_UPLOAD_BYTES} byte upload limit.` }, 413);
  }
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length === 0) return json({ error: 'Empty request body.' }, 400);
  if (data.length > MAX_UPLOAD_BYTES) {
    return json({ error: `File exceeds the ${MAX_UPLOAD_BYTES} byte upload limit.` }, 413);
  }

  const parent = url.searchParams.get('parent');
  const contentType = request.headers.get('content-type');
  const mimeType =
    contentType && contentType !== 'application/octet-stream'
      ? contentType
      : mimeTypeForFilename(filename);

  try {
    const ctx = workspaceFor(account);
    const file = await uploadToDrive(ctx.auth, {
      metadata: { name: filename, ...(parent ? { parents: [parent] } : {}) },
      mimeType,
      data,
    });
    return json({ account: ctx.alias, email: ctx.email, ...file });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: 'upload endpoint failed', error: message }));
    const status = (error as any)?.response?.status;
    return json({ error: message }, typeof status === 'number' && status >= 400 && status < 500 ? status : 502);
  }
}
