import { google, gmail_v1 } from 'googleapis';
import { getClient, resolveAccount, dropClient } from './accounts.js';

export interface AccountContext {
  alias: string;
  email: string;
  gmail: gmail_v1.Gmail;
}

export function gmailFor(accountParam: string): AccountContext {
  const { alias, entry } = resolveAccount(accountParam);
  const client = getClient(alias, entry);
  return { alias, email: entry.email, gmail: google.gmail({ version: 'v1', auth: client }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 3;

/**
 * Wraps every Gmail API call: retries 429/5xx with backoff+jitter, and maps auth and
 * not-found failures to actionable plain-language errors.
 */
export async function callGmail<T>(
  ctx: Pick<AccountContext, 'alias' | 'email'>,
  op: string,
  fn: () => Promise<T>
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const status: number | undefined =
        err?.response?.status ?? (typeof err?.status === 'number' ? err.status : undefined);
      const data = err?.response?.data;
      const oauthError = typeof data?.error === 'string' ? data.error : '';
      const message = String(err?.message ?? err);

      if (oauthError === 'invalid_grant' || message.includes('invalid_grant')) {
        dropClient(ctx.alias);
        throw new Error(
          `Authorization for account "${ctx.alias}" (${ctx.email}) has expired or been revoked. ` +
            `Re-run: npm run auth -- --alias ${ctx.alias} (in the gmail-mcp project), ` +
            `or use the add_account tool with alias "${ctx.alias}".`
        );
      }
      if (oauthError === 'invalid_client' || message.includes('invalid_client')) {
        throw new Error(
          `OAuth client credentials problem (~/.gmail-mcp/credentials.json): ${message}. ` +
            'Re-download the Desktop-app OAuth client JSON from Google Cloud Console.'
        );
      }
      if (status === 403 && /insufficient/i.test(message)) {
        throw new Error(
          `Token for "${ctx.alias}" (${ctx.email}) was granted with narrower scopes than this server needs. ` +
            `Re-run: npm run auth -- --alias ${ctx.alias}`
        );
      }
      if (status === 404) {
        throw new Error(
          `${op}: not found in ${ctx.email}. Gmail thread/message IDs are account-specific — ` +
            `was this ID from a different account's search?`
        );
      }
      if (status === 429 || (status !== undefined && status >= 500)) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt + Math.random() * 250);
          attempt++;
          continue;
        }
        throw new Error(
          `Gmail ${status === 429 ? 'rate limit' : `server error (${status})`} for "${ctx.alias}" ` +
            `(${ctx.email}) — retried ${MAX_RETRIES} times, please retry shortly.`
        );
      }
      throw new Error(`${op} failed for "${ctx.alias}" (${ctx.email}): ${message}`);
    }
  }
}
