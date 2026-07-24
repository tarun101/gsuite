import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';
import {
  BASE_DIR,
  CREDENTIALS_PATH,
  loadClientCredentials,
  loadConfig,
  saveConfig,
  writeToken,
  dropClient,
} from './accounts.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthResult {
  alias: string;
  email: string;
}

/**
 * Loopback OAuth flow (RFC 8252): ephemeral localhost server captures the redirect,
 * exchanges the code, discovers the real email via getProfile, and persists the token
 * under the alias. Shared by the auth CLI and the add_account MCP tool.
 */
export async function authorizeAccount(
  alias: string,
  expectedEmail?: string,
  credentialsPath?: string,
  log: (msg: string) => void = (m) => console.error(m)
): Promise<AuthResult> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
    throw new Error(`Alias "${alias}" must be alphanumeric (dashes/underscores allowed).`);
  }
  const sourceCredentialsPath = credentialsPath ? path.resolve(credentialsPath) : CREDENTIALS_PATH;
  if (!fs.existsSync(sourceCredentialsPath)) {
    throw new Error(`OAuth client credentials not found at ${sourceCredentialsPath}.`);
  }
  const credentialsDir = path.join(BASE_DIR, 'credentials');
  const storedCredentialFile = `credentials/${alias}.json`;
  const storedCredentialsPath = path.join(BASE_DIR, storedCredentialFile);
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  if (path.resolve(sourceCredentialsPath) !== path.resolve(storedCredentialsPath)) {
    fs.copyFileSync(sourceCredentialsPath, storedCredentialsPath);
  }
  fs.chmodSync(storedCredentialsPath, 0o600);
  const creds = loadClientCredentials({ credentialFile: storedCredentialFile });

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const client = new google.auth.OAuth2({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri,
  });
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on re-auth
    scope: GOOGLE_SCOPES,
    login_hint: expectedEmail,
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out after 5 minutes waiting for browser authorization. Re-run the auth.'));
    }, AUTH_TIMEOUT_MS);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:sans-serif;margin:40px"><h2>gmail-mcp</h2><p>' +
          (code ? 'Authorized. You can close this tab.' : `Authorization failed: ${error ?? 'unknown error'}`) +
          '</p></body></html>'
      );
      clearTimeout(timer);
      if (code) resolve(code);
      else reject(new Error(`Authorization failed: ${error ?? 'no code returned'}`));
    });
  });

  log(`Authorize ${expectedEmail ?? `account "${alias}"`} in the browser (URL below if it didn't open):\n${authUrl}`);
  try {
    spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // browser open is best-effort; the URL was printed
  }

  try {
    const code = await codePromise;
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Re-run the auth; if it persists, remove this app at ' +
          'myaccount.google.com/permissions and try again.'
      );
    }
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress ?? '';
    if (!email) throw new Error('Could not determine the authorized email address from the Gmail profile.');
    if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `Authorized ${email}, but expected ${expectedEmail}. This usually means the wrong Google session ` +
          'was active in the browser — re-run and pick the right account on the consent screen.'
      );
    }

    const config = loadConfig();
    const dupe = Object.entries(config.accounts).find(
      ([a, e]) => a !== alias && e.email.toLowerCase() === email.toLowerCase()
    );
    if (dupe) throw new Error(`${email} is already connected as alias "${dupe[0]}".`);

    const entry = { email, tokenFile: `tokens/${alias}.json`, credentialFile: storedCredentialFile };
    writeToken(entry, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      email,
    });
    config.accounts[alias] = entry;
    saveConfig(config);
    dropClient(alias); // any cached client for this alias is stale now

    return { alias, email };
  } finally {
    server.close();
  }
}
