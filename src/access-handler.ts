import { Buffer } from 'node:buffer';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { handleUploadRequest } from './upload-endpoint.js';

type AccessEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
type StoredState = { request: AuthRequest; verifier: string };

const cookieAttributes = 'HttpOnly; Secure; Path=/; SameSite=None; Partitioned';

function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function digest(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
}

async function equal(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]).then((values) => values.map((value) => Buffer.from(value)));
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return different === 0;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function beginAccessLogin(
  request: Request,
  env: AccessEnv,
  oauthRequest: AuthRequest,
  headers = new Headers(),
): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = await digest(verifier);
  await env.OAUTH_KV.put(`access-state:${state}`, JSON.stringify({ request: oauthRequest, verifier } satisfies StoredState), {
    expirationTtl: 600,
  });
  headers.append('Set-Cookie', `__Host-GSUITE_STATE=${await digest(state)}; ${cookieAttributes}; Max-Age=600`);
  const url = new URL(env.ACCESS_AUTHORIZATION_URL);
  url.searchParams.set('client_id', env.ACCESS_CLIENT_ID);
  url.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  headers.set('Location', url.href);
  return new Response(null, { status: 302, headers });
}

async function verifyAccessIdToken(env: AccessEnv, token: string): Promise<{ email: string; name?: string; sub: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { kid?: string };
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
    aud?: string | string[];
    email?: string;
    exp?: number;
    iss?: string;
    name?: string;
    nbf?: number;
    sub?: string;
  };
  const keysResponse = await fetch(env.ACCESS_JWKS_URL);
  if (!keysResponse.ok) throw new Error('Could not load Access signing keys');
  const { keys } = (await keysResponse.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error('Unknown Access signing key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(parts[2], 'base64url'),
    Buffer.from(`${parts[0]}.${parts[1]}`),
  );
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid ||
    !claims.email ||
    !claims.sub ||
    claims.iss !== env.ACCESS_ISSUER ||
    !audience.includes(env.ACCESS_CLIENT_ID) ||
    !claims.exp ||
    claims.exp < now ||
    (claims.nbf !== undefined && claims.nbf > now)
  ) throw new Error('Invalid Access identity');
  if (claims.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) throw new Error('Forbidden');
  return { email: claims.email, name: claims.name, sub: claims.sub };
}

export async function handleAccessRequest(request: Request, env: AccessEnv): Promise<Response> {
  const url = new URL(request.url);
  try {
    // Bearer-token file upload, so bytes reach Drive without going through an
    // MCP client. Returns null when the route does not apply.
    const upload = await handleUploadRequest(request, env);
    if (upload) return upload;

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('gsuite-mcp remote server');
    }

    if (request.method === 'GET' && url.pathname === '/authorize') {
      const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthRequest.clientId) return new Response('Invalid request', { status: 400 });
      return beginAccessLogin(request, env, oauthRequest);
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const boundState = cookie(request, '__Host-GSUITE_STATE');
      if (!state || !code || !boundState || !(await equal(await digest(state), boundState))) {
        return new Response('Invalid OAuth callback', { status: 400 });
      }
      const storedJson = await env.OAUTH_KV.get(`access-state:${state}`);
      await env.OAUTH_KV.delete(`access-state:${state}`);
      if (!storedJson) return new Response('Expired OAuth callback', { status: 400 });
      const stored = JSON.parse(storedJson) as StoredState;
      const body = new URLSearchParams({
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
        code,
        code_verifier: stored.verifier,
        grant_type: 'authorization_code',
        redirect_uri: new URL('/callback', request.url).href,
      });
      const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tokens = (await tokenResponse.json()) as { id_token?: string; error?: string };
      if (!tokenResponse.ok || !tokens.id_token) throw new Error(tokens.error ?? 'Access token exchange failed');
      const user = await verifyAccessIdToken(env, tokens.id_token);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: stored.request,
        userId: user.sub,
        metadata: { label: user.name ?? user.email },
        scope: stored.request.scope,
        props: { email: user.email, name: user.name ?? user.email },
      });
      const headers = new Headers({
        Location: redirectTo,
        'Set-Cookie': `__Host-GSUITE_STATE=; ${cookieAttributes}; Max-Age=0`,
      });
      return new Response(null, { status: 302, headers });
    }

    return new Response('Not found', { status: 404 });
  } catch (error) {
    console.error(JSON.stringify({ message: 'authentication failed', error: error instanceof Error ? error.message : String(error) }));
    return new Response('Authentication failed', { status: 500 });
  }
}
