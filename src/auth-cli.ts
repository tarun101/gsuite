import fs from 'node:fs';
import os from 'node:os';
import { authorizeAccount } from './auth.js';
import { BASE_DIR, CREDENTIALS_PATH } from './accounts.js';

// Convenience: if credentials.json is missing but a freshly downloaded
// client_secret*.json exists in ~/Downloads, install it automatically.
const baseDir = BASE_DIR;
const credPath = CREDENTIALS_PATH;
if (!fs.existsSync(credPath)) {
  const dl = `${os.homedir()}/Downloads`;
  const cands = fs.existsSync(dl) ? fs.readdirSync(dl).filter((f) => /^client_secret.*\.json$/.test(f)) : [];
  if (cands.length > 0) {
    const newest = cands
      .map((f) => ({ f, t: fs.statSync(`${dl}/${f}`).mtimeMs }))
      .sort((x, y) => y.t - x.t)[0].f;
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(`${dl}/${newest}`, credPath);
    fs.chmodSync(credPath, 0o600);
    console.error(`Installed OAuth credentials from ~/Downloads/${newest}`);
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const alias = arg('alias');
if (!alias) {
  console.error(
    'Usage: npm run auth -- --alias <name> [--email <expected@email>] [--credentials /path/to/oauth-client.json]'
  );
  process.exit(1);
}

authorizeAccount(alias, arg('email'), arg('credentials'))
  .then(({ alias, email }) => {
    console.error(`\nAccount "${alias}" (${email}) ready.`);
    process.exit(0);
  })
  .catch((e: Error) => {
    console.error(`\nAuth failed: ${e.message}`);
    process.exit(1);
  });
