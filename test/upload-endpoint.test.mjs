// The /upload endpoint is a public write surface on a public Worker, so its
// gate matters more than its happy path: unset secret means no route at all,
// and a wrong token must never reach Drive.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_UPLOAD_BYTES, handleUploadRequest } from '../dist/upload-endpoint.js';

const TOKEN = 'test-upload-token';
const env = { GSUITE_UPLOAD_TOKEN: TOKEN };

const post = (query = '?account=work&filename=a.txt', init = {}) =>
  new Request(`https://gsuite-mcp.example.workers.dev/upload${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    body: init.body ?? 'hello',
    ...(init.rest ?? {}),
  });

test('other paths are left to the rest of the router', async () => {
  const request = new Request('https://example.workers.dev/callback');
  assert.equal(await handleUploadRequest(request, env), null);
});

test('the route does not exist when GSUITE_UPLOAD_TOKEN is unset', async () => {
  // Fail closed: a deployment that has not opted in must expose no upload surface.
  assert.equal(await handleUploadRequest(post(), {}), null);
  assert.equal(await handleUploadRequest(post(), { GSUITE_UPLOAD_TOKEN: '' }), null);
});

test('a missing or wrong bearer token is rejected before any Drive call', async () => {
  for (const authorization of ['', 'Bearer nope', 'Basic abc', `Bearer ${TOKEN}x`]) {
    const request = new Request('https://example.workers.dev/upload?account=work&filename=a.txt', {
      method: 'POST',
      headers: authorization ? { authorization } : {},
      body: 'hello',
    });
    const response = await handleUploadRequest(request, env);
    assert.equal(response.status, 401, `expected 401 for "${authorization}"`);
  }
});

test('GET is refused', async () => {
  const request = new Request('https://example.workers.dev/upload?account=work&filename=a.txt', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal((await handleUploadRequest(request, env)).status, 405);
});

test('account and filename are required', async () => {
  for (const query of ['', '?account=work', '?filename=a.txt']) {
    const response = await handleUploadRequest(post(query), env);
    assert.equal(response.status, 400, `expected 400 for "${query}"`);
  }
});

test('an empty body is refused', async () => {
  const request = new Request('https://example.workers.dev/upload?account=work&filename=a.txt', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal((await handleUploadRequest(request, env)).status, 400);
});

test('an oversized upload is refused on the declared length, without buffering it', async () => {
  const request = post('?account=work&filename=big.bin', {
    headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
  });
  const response = await handleUploadRequest(request, env);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /upload limit/);
});
