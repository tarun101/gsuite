// Pure client-registration policy, extracted so it can be unit-tested without a
// Workers runtime (access-handler.ts and worker.ts are excluded from the Node build).

/**
 * Redirect URIs this server is willing to hand an authorization code to.
 * Loopback HTTP is always allowed — only a process on the user's own machine can
 * receive a code there. Everything else must be listed here: an origin or exact
 * callback URI for http(s), or the full URI for a custom app scheme. Self-hosters:
 * add your MCP client's callback below.
 *
 * Without this list, open dynamic client registration lets anyone register
 * `https://evil.example/cb` and phish a fully-scoped grant with a single link.
 */
export const ALLOWED_REDIRECT_URIS = [
  'https://www.cursor.com',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  // Claude web/desktop custom connectors post the code back to Anthropic's own
  // callback; both origins are listed because claude.ai and claude.com are both live.
  'https://claude.ai',
  'https://claude.com',
  // Exact callback observed during Routespring GSuite registration in ChatGPT.
  // Do not allow the whole origin: a recreated connection needs its own URI.
  'https://chatgpt.com/connector/oauth/B9-y6O1lMTcV',
  // Antigravity desktop OAuth callback.
  'https://antigravity.google/oauth-callback',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export function redirectUriAllowed(
  uri: string,
  allowed: readonly string[] = ALLOWED_REDIRECT_URIS
): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return true;
  // Exact callbacks stay byte-for-byte matches, including path/query/fragment.
  // Existing origin entries still match by origin, never by a hostname prefix.
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return allowed.includes(url.origin) || allowed.includes(uri);
  }
  return allowed.includes(uri);
}

/** RFC 7591 registration policy: every redirect URI must pass, or the whole registration is refused. */
export function screenClientRegistration({ clientMetadata }: { clientMetadata: Record<string, unknown> }) {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { code: 'invalid_redirect_uri', description: 'redirect_uris is required.', status: 400 };
  }
  const rejected = uris.filter((uri) => typeof uri !== 'string' || !redirectUriAllowed(uri));
  if (rejected.length > 0) {
    return {
      code: 'invalid_redirect_uri',
      description: `Redirect URI is not permitted by this server's policy: ${rejected.join(', ')}`,
      status: 403,
    };
  }
}
