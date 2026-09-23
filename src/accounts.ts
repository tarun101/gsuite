import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { google } from 'googleapis';

// Use googleapis' own OAuth2 client to avoid duplicate google-auth-library type copies.
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export const BASE_DIR =
  process.env.GSUITE_MCP_DIR || path.join(os.homedir(), '.gsuite-mcp');
export const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
export const CREDENTIALS_PATH = path.join(BASE_DIR, 'credentials.json');

export const isRemote = () => process.env.GSUITE_REMOTE === '1';
const envName = (alias: string, suffix: string) =>
  `GOOGLE_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;

export interface AccountEntry {
  email: string;
  tokenFile: string;
  credentialFile?: string;
}

export interface Config {
  defaultAccount: string | null;
  accounts: Record<string, AccountEntry>;
}

export function loadConfig(): Config {
  if (isRemote()) {
    const accounts = Object.fromEntries(
      ['personal', 'work'].flatMap((alias) => {
        const email = process.env[envName(alias, 'EMAIL')];
        return email
          ? [[alias, { email, tokenFile: `env:${alias}`, credentialFile: `env:${alias}` }]]
          : [];
      })
    );
    return { defaultAccount: null, accounts };
  }
  if (!fs.existsSync(CONFIG_PATH)) return { defaultAccount: null, accounts: {} };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
}

export function saveConfig(config: Config): void {
  if (isRemote()) throw new Error('Remote accounts are configured with Worker secrets, not MCP tools.');
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

interface ClientCredentials {
  client_id: string;
  client_secret: string;
}

export function loadClientCredentials(entry?: Pick<AccountEntry, 'credentialFile'>): ClientCredentials {
  if (isRemote()) {
    const alias = entry?.credentialFile?.replace(/^env:/, '');
    if (!alias) throw new Error('Remote account alias is missing.');
    const client_id = process.env[envName(alias, 'CLIENT_ID')];
    const client_secret = process.env[envName(alias, 'CLIENT_SECRET')];
    if (!client_id || !client_secret) throw new Error(`Remote OAuth client secret is missing for "${alias}".`);
    return { client_id, client_secret };
  }
  const credentialPath = entry?.credentialFile
    ? path.join(BASE_DIR, entry.credentialFile)
    : CREDENTIALS_PATH;
  if (!fs.existsSync(credentialPath)) {
    throw new Error(
      `Missing OAuth client credentials at ${credentialPath}. ` +
        'Download the "Desktop app" OAuth client JSON from Google Cloud Console ' +
        '(APIs & Services > Credentials) and save it there.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  const key = raw.installed ?? raw.web;
  if (!key?.client_id || !key?.client_secret) {
    throw new Error(
      `${credentialPath} does not look like an OAuth client JSON ` +
        '(expected an "installed" object with client_id and client_secret).'
    );
  }
  return { client_id: key.client_id, client_secret: key.client_secret };
}

export function describeAccounts(config: Config = loadConfig()): string {
  const entries = Object.entries(config.accounts);
  if (entries.length === 0) {
    return 'No accounts configured yet — use the add_account tool or run: npm run auth -- --alias <name>';
  }
  return entries.map(([alias, a]) => `${alias} (${a.email})`).join(', ');
}

export function resolveAccount(param: string, config: Config = loadConfig()): { alias: string; entry: AccountEntry } {
  const wanted = param.trim().toLowerCase();
  const aliasHit = Object.keys(config.accounts).find((a) => a.toLowerCase() === wanted);
  if (aliasHit) return { alias: aliasHit, entry: config.accounts[aliasHit] };
  const emailHit = Object.entries(config.accounts).find(([, a]) => a.email.toLowerCase() === wanted);
  if (emailHit) return { alias: emailHit[0], entry: emailHit[1] };
  throw new Error(`Unknown account "${param}". Available: ${describeAccounts(config)}`);
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  email: string;
}

function tokenPath(entry: AccountEntry): string {
  return path.join(BASE_DIR, entry.tokenFile);
}

export function writeToken(entry: AccountEntry, token: StoredToken): void {
  if (isRemote()) return;
  const file = tokenPath(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
}

const clientCache = new Map<string, OAuth2Client>();
type CachedAccessToken = { accessToken: string; expiryDate: number };
type AccessTokenStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
};
const remoteTokens = new Map<string, CachedAccessToken>();
const primedAliases = new Set<string>();
let remoteTokenStore: AccessTokenStore | undefined;
let remoteWaitUntil: ((promise: Promise<unknown>) => void) | undefined;
const cacheKey = (alias: string) => `google-access-token:${alias}`;
const tokenIsFresh = (token: CachedAccessToken, now = Date.now()) => token.expiryDate > now + 60_000;

/** Load only access tokens, never refresh tokens, from KV on a cold Worker instance. */
export async function primeRemoteTokenCache(store: AccessTokenStore, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  remoteTokenStore = store;
  remoteWaitUntil = waitUntil;
  await Promise.all(['personal', 'work'].map(async (alias) => {
    if (primedAliases.has(alias)) return;
    primedAliases.add(alias);
    try {
      const value = await store.get(cacheKey(alias));
      if (!value) return;
      const token = JSON.parse(value) as CachedAccessToken;
      if (!token.accessToken || !tokenIsFresh(token)) return;
      remoteTokens.set(alias, token);
      const client = clientCache.get(alias);
      if (client) client.setCredentials({ ...client.credentials, access_token: token.accessToken, expiry_date: token.expiryDate });
    } catch {
      // KV is an acceleration layer; Google refresh remains the fallback.
    }
  }));
}

export function invalidateRemoteAccessToken(alias: string): void {
  if (!isRemote()) return;
  remoteTokens.delete(alias);
  const client = clientCache.get(alias);
  if (client) client.setCredentials({ ...client.credentials, access_token: undefined, expiry_date: 0 });
  if (remoteTokenStore) {
    const deletion = remoteTokenStore.delete(cacheKey(alias)).catch(() => undefined);
    if (remoteWaitUntil) remoteWaitUntil(deletion);
  }
}

export function getClient(alias: string, entry: AccountEntry): OAuth2Client {
  const remote = isRemote();
  const cached = clientCache.get(alias);
  if (cached) return cached;

  const creds = loadClientCredentials(entry);
  const file = tokenPath(entry);
  if (!remote && !fs.existsSync(file)) {
    throw new Error(
      `No stored authorization for account "${alias}" (${entry.email}). ` +
        `Run: npm run auth -- --alias ${alias}`
    );
  }
  const remoteAccess = remoteTokens.get(alias);
  const stored = remote
    ? {
        refresh_token: process.env[envName(alias, 'REFRESH_TOKEN')] ?? '',
        access_token: remoteAccess && tokenIsFresh(remoteAccess) ? remoteAccess.accessToken : undefined,
        expiry_date: remoteAccess && tokenIsFresh(remoteAccess) ? remoteAccess.expiryDate : undefined,
        email: entry.email,
      }
    : (JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken);
  if (!stored.refresh_token) throw new Error(`Remote refresh token is missing for "${alias}".`);

  const client = new google.auth.OAuth2({ clientId: creds.client_id, clientSecret: creds.client_secret });
  client.setCredentials({
    refresh_token: stored.refresh_token,
    access_token: stored.access_token,
    expiry_date: stored.expiry_date,
  });
  // Persist refreshed access tokens (and any rotated refresh token) so cold starts skip a refresh round-trip.
  if (!remote) client.on('tokens', (tokens) => {
    try {
      stored.refresh_token = tokens.refresh_token ?? stored.refresh_token;
      stored.access_token = tokens.access_token ?? stored.access_token;
      stored.expiry_date = tokens.expiry_date ?? stored.expiry_date;
      writeToken(entry, stored);
    } catch (e) {
      console.error(`gmail-multi: failed to persist refreshed token for "${alias}":`, e);
    }
  });

  if (remote) client.on('tokens', (tokens) => {
    if (!tokens.access_token || !tokens.expiry_date) return;
    const token = { accessToken: tokens.access_token, expiryDate: tokens.expiry_date };
    remoteTokens.set(alias, token);
    const ttl = Math.floor((token.expiryDate - Date.now()) / 1000);
    if (remoteTokenStore && ttl >= 120) {
      const write = remoteTokenStore.put(cacheKey(alias), JSON.stringify(token), { expirationTtl: ttl }).catch(() => undefined);
      if (remoteWaitUntil) remoteWaitUntil(write);
    }
  });

  clientCache.set(alias, client);
  return client;
}

export function dropClient(alias: string): void {
  clientCache.delete(alias);
  if (isRemote()) invalidateRemoteAccessToken(alias);
}
