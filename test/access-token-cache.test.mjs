import assert from 'node:assert/strict';
import test from 'node:test';
import { getClient, invalidateRemoteAccessToken, primeRemoteTokenCache } from '../dist/accounts.js';

test('remote access token cache uses fresh per-account tokens and rejects expired ones', async () => {
  const keys = ['GSUITE_REMOTE', 'GOOGLE_PERSONAL_CLIENT_ID', 'GOOGLE_PERSONAL_CLIENT_SECRET', 'GOOGLE_PERSONAL_REFRESH_TOKEN', 'GOOGLE_WORK_CLIENT_ID', 'GOOGLE_WORK_CLIENT_SECRET', 'GOOGLE_WORK_REFRESH_TOKEN'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.GSUITE_REMOTE = '1';
  for (const alias of ['PERSONAL', 'WORK']) {
    process.env[`GOOGLE_${alias}_CLIENT_ID`] = `${alias.toLowerCase()}-client`;
    process.env[`GOOGLE_${alias}_CLIENT_SECRET`] = 'secret';
    process.env[`GOOGLE_${alias}_REFRESH_TOKEN`] = 'refresh';
  }
  const now = Date.now();
  const deleted = [];
  const store = {
    get: async (key) => JSON.stringify(key.endsWith('personal')
      ? { accessToken: 'fresh', expiryDate: now + 3_600_000 }
      : { accessToken: 'expired', expiryDate: now + 30_000 }),
    put: async () => {},
    delete: async (key) => { deleted.push(key); },
  };
  try {
    await primeRemoteTokenCache(store);
    const personal = getClient('personal', { email: 'i@example.test', tokenFile: 'env:personal', credentialFile: 'env:personal' });
    const work = getClient('work', { email: 'w@example.test', tokenFile: 'env:work', credentialFile: 'env:work' });
    assert.equal(personal.credentials.access_token, 'fresh');
    assert.equal(work.credentials.access_token, undefined);
    invalidateRemoteAccessToken('personal');
    assert.equal(personal.credentials.access_token, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deleted, ['google-access-token:personal']);
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});
