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
