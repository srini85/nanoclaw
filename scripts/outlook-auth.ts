/**
 * Outlook OAuth2 setup — authorization code + PKCE flow.
 * Works with work/school accounts and conditional access policies.
 *
 * Run: npx tsx scripts/outlook-auth.ts
 *
 * Requires MICROSOFT_CLIENT_ID (and optionally MICROSOFT_TENANT_ID) in .env.
 * On success, writes MICROSOFT_REFRESH_TOKEN to .env.
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access openid';

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(ENV_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

function setEnvVar(key: string, value: string): void {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.endsWith('\n') ? content : content + '\n';
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { shell: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {
    // ignore — user will open manually
  }
}

async function main() {
  const env = readEnv();
  const clientId = env.MICROSOFT_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = env.MICROSOFT_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = env.MICROSOFT_TENANT_ID || 'organizations';

  if (!clientId) {
    console.error(
      '\nMICROSOFT_CLIENT_ID not set in .env\n\n' +
        'To register an app in Azure:\n' +
        '  1. portal.azure.com → Azure Active Directory → App registrations → New registration\n' +
        '     - Name: NanoClaw\n' +
        '     - Supported account types: Accounts in this organizational directory only\n' +
        '     - Redirect URI: Web → http://localhost:3333/callback\n' +
        '  2. Authentication → Advanced settings → Allow public client flows: Yes → Save\n' +
        '  3. API permissions → Add → Microsoft Graph → Delegated:\n' +
        '     Mail.Read, Mail.ReadWrite, offline_access\n' +
        '  4. Add MICROSOFT_CLIENT_ID=<app-id> to .env\n' +
        '  5. Add MICROSOFT_TENANT_ID=<tenant-id> to .env  (Azure AD → Overview → Tenant ID)\n',
    );
    process.exit(1);
  }

  const { verifier, challenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  const authUrl =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

  // Start local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') return;

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400);
        res.end(`<h2>Auth error: ${error}</h2><p>${url.searchParams.get('error_description')}</p>`);
        server.close();
        reject(new Error(`${error}: ${url.searchParams.get('error_description')}`));
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400);
        res.end('<h2>State mismatch — possible CSRF. Try again.</h2>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      const authCode = url.searchParams.get('code');
      if (!authCode) {
        res.writeHead(400);
        res.end('<h2>No code returned.</h2>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:sans-serif;padding:40px">' +
          '<h2>✓ Authenticated!</h2>' +
          '<p>You can close this tab. Return to the terminal.</p>' +
          '</body></html>',
      );
      server.close();
      resolve(authCode);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is already in use. Stop whatever is using it and retry.`));
      } else {
        reject(err);
      }
    });

    server.listen(PORT, () => {
      console.log(`\nOpening browser for sign-in...`);
      console.log(`\nIf the browser doesn't open, go to:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  // Exchange code for tokens
  console.log('\nExchanging code for tokens...');
  const tokenParams: Record<string, string> = {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: SCOPES,
  };
  if (clientSecret) tokenParams.client_secret = clientSecret;

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams).toString(),
    },
  );

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenData.refresh_token) {
    console.error('\nToken exchange failed:', tokenData.error_description || tokenData.error);
    process.exit(1);
  }

  setEnvVar('MICROSOFT_REFRESH_TOKEN', tokenData.refresh_token);
  console.log('\n✓ MICROSOFT_REFRESH_TOKEN saved to .env');

  const dataEnvDir = path.join(ROOT, 'data', 'env');
  if (fs.existsSync(dataEnvDir)) {
    fs.copyFileSync(ENV_FILE, path.join(dataEnvDir, 'env'));
    console.log('✓ Synced to data/env/env');
  }

  console.log('\nDone. Restart the service for changes to take effect.');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
