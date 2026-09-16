import assert from 'node:assert/strict';
import test from 'node:test';
import { redirectUriAllowed, screenClientRegistration } from '../dist/redirect-policy.js';

const ALLOWED = ['https://www.cursor.com', 'cursor://anysphere.cursor-mcp/oauth/callback'];

test('loopback redirect URIs are always allowed', () => {
  for (const uri of [
    'http://127.0.0.1:54397/callback/zHu_pcZxCCTJ', // Codex, random port each login
    'http://localhost:3118/callback',               // Claude Code
    'http://localhost:8787/callback',               // Cursor local
    'http://[::1]:9000/cb',
  ]) {
    assert.equal(redirectUriAllowed(uri, ALLOWED), true, uri);
  }
});

test('allowlisted origins and custom schemes are allowed', () => {
  assert.equal(redirectUriAllowed('https://www.cursor.com/agents/mcp/oauth/callback', ALLOWED), true);
  assert.equal(redirectUriAllowed('https://www.cursor.com/bot/mcp/oauth/callback', ALLOWED), true);
  assert.equal(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback', ALLOWED), true);
});

test('the phishing redirect is refused', () => {
  for (const uri of [
    'https://evil.example/cb',
    'https://www.cursor.com.evil.example/cb', // lookalike host must not prefix-match
    'https://wwwXcursor.com/cb',
    'http://evil.example/cb',
    'https://localhost.evil.example/cb',
    'cursor://anysphere.cursor-mcp/oauth/other', // custom scheme must match in full
    'not a url',
  ]) {
    assert.equal(redirectUriAllowed(uri, ALLOWED), false, uri);
  }
});

test('http loopback rule does not extend to https or to remote hosts', () => {
  assert.equal(redirectUriAllowed('https://localhost/cb', ALLOWED), false);
  assert.equal(redirectUriAllowed('http://127.0.0.2/cb', ALLOWED), false);
});

test('only the exact Routespring ChatGPT callback is allowed', () => {
  const callback = 'https://chatgpt.com/connector/oauth/B9-y6O1lMTcV';
  assert.equal(redirectUriAllowed(callback), true);
  assert.equal(screenClientRegistration({ clientMetadata: { redirect_uris: [callback] } }), undefined);
  for (const uri of [
    'https://chatgpt.com',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/another-connection',
    `${callback}/`,
    `${callback}?redirect=https://evil.example`,
    `${callback}#fragment`,
    'http://chatgpt.com/connector/oauth/B9-y6O1lMTcV',
    'https://chatgpt.com:8443/connector/oauth/B9-y6O1lMTcV',
    'https://chatgpt.com.evil.example/connector/oauth/B9-y6O1lMTcV',
    'https://chatgpt.com@evil.example/connector/oauth/B9-y6O1lMTcV',
    'https://user@chatgpt.com/connector/oauth/B9-y6O1lMTcV',
    'https://chatgpt.com/connector/oauth/%429-y6O1lMTcV',
  ]) {
    assert.equal(redirectUriAllowed(uri), false, uri);
    assert.equal(screenClientRegistration({ clientMetadata: { redirect_uris: [callback, uri] } })?.status, 403, uri);
  }
});

test('existing Claude and Cursor callbacks remain allowed', () => {
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'https://antigravity.google/oauth-callback',
  ]) assert.equal(redirectUriAllowed(uri), true, uri);
});

test('a supplied exact HTTPS callback does not allow other paths on its origin', () => {
  const callback = 'https://example.com/exact-callback';
  assert.equal(redirectUriAllowed(callback, [callback]), true);
  assert.equal(redirectUriAllowed('https://example.com/other', [callback]), false);
  assert.equal(redirectUriAllowed(`${callback}?next=other`, [callback]), false);
});

test('registration is refused when any single redirect URI fails', () => {
  const ok = screenClientRegistration({
    clientMetadata: { redirect_uris: ['http://127.0.0.1:5000/cb'] },
  });
  assert.equal(ok, undefined);

  // One good URI must not launder a bad one alongside it.
  const mixed = screenClientRegistration({
    clientMetadata: { redirect_uris: ['http://127.0.0.1:5000/cb', 'https://evil.example/cb'] },
  });
  assert.equal(mixed?.status, 403);

  assert.equal(screenClientRegistration({ clientMetadata: {} })?.status, 400);
  assert.equal(screenClientRegistration({ clientMetadata: { redirect_uris: [] } })?.status, 400);
  assert.equal(screenClientRegistration({ clientMetadata: { redirect_uris: [42] } })?.status, 403);
});
