import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsuite-ticket-do-'));

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const env = { ...process.env };
if (!env.ESBUILD_BINARY_PATH && fs.existsSync('/opt/homebrew/bin/esbuild')) {
  env.ESBUILD_BINARY_PATH = '/opt/homebrew/bin/esbuild';
}
const child = spawn('wrangler', [
  'dev',
  '--config', 'test/wrangler.drive-ticket.jsonc',
  '--ip', '127.0.0.1',
  '--port', String(port),
  '--local',
  '--persist-to', stateDir,
], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });

let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
}

const baseUrl = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) break;
    } catch {
      if (child.exitCode !== null) throw new Error(`wrangler exited early:\n${output}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for wrangler:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const now = Date.now();
  const record = {
    transferId: 'integration-transfer',
    operation: 'drive.download',
    requester: 'i@tarun.me',
    accountAlias: 'work',
    accountEmail: 'tarun@routespring.com',
    fileId: '1Abcdefghijklmnopqrstuvwxyz',
    filename: 'fixture.pdf',
    mimeType: 'application/pdf',
    byteSize: 12,
    headRevisionId: 'rev-1',
    sha256: 'a'.repeat(64),
    modifiedTime: '2026-09-11T00:00:00.000Z',
    issuedAt: now,
    expiresAt: now + 90_000,
  };
  const ticketHash = 'b'.repeat(64);
  const post = (pathname, body) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shard: 'ticket-shard-bb', ticketHash, ...body }),
  }).then((response) => response.json());

  assert.deepEqual(await post('/issue', { record }), { ok: true });
  const concurrent = await Promise.all([
    post('/consume', { now: now + 1 }),
    post('/consume', { now: now + 1 }),
  ]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal(concurrent.filter((result) => !result.ok && result.reason === 'unknown_or_replayed').length, 1);
  assert.deepEqual(await post('/consume', { now: now + 2 }), {
    ok: false,
    reason: 'unknown_or_replayed',
    transferId: record.transferId,
  });

  const expiredHash = 'c'.repeat(64);
  await fetch(`${baseUrl}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shard: 'ticket-shard-cc', ticketHash: expiredHash, record: { ...record, transferId: 'expired-transfer', expiresAt: now - 1 } }),
  });
  const expired = await fetch(`${baseUrl}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shard: 'ticket-shard-cc', ticketHash: expiredHash, now }),
  }).then((response) => response.json());
  assert.deepEqual(expired, { ok: false, reason: 'expired', transferId: 'expired-transfer' });
  process.stdout.write('Durable Object replay, concurrent consume, and expiry checks passed.\n');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000).unref();
  });
  fs.rmSync(stateDir, { recursive: true, force: true });
}
