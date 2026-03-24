/**
 * Shared Outlook/Microsoft Graph authentication module.
 * ALL scripts that call the Microsoft Graph API MUST import from here
 * instead of implementing their own token exchange.
 *
 * Usage:
 *   import { getAccessToken, graph, verifyAccount } from '/tools/outlook-auth.mjs';
 *   const token = await getAccessToken();
 *   await verifyAccount(token); // throws if wrong account
 *   const data = await graph(token, '/me/messages', { method: 'POST', body: ... });
 */

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'organizations';
const REFRESH_TOKEN = process.env.MICROSOFT_REFRESH_TOKEN;
const EXPECTED_EMAIL = process.env.MICROSOFT_EXPECTED_EMAIL;

const SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access';

export async function getAccessToken() {
  if (!CLIENT_ID || !REFRESH_TOKEN) {
    throw new Error(
      'Outlook not configured. MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN must be set in .env',
    );
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    scope: SCOPES,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', body: params },
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

export async function graph(token, path, options = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Verify the authenticated account matches MICROSOFT_EXPECTED_EMAIL.
 * MUST be called before any write operation (create draft, reply, send).
 * Throws if the account doesn't match.
 */
export async function verifyAccount(token) {
  const me = await graph(token, '/me?$select=mail,userPrincipalName');
  const account = (me.mail || me.userPrincipalName || '').toLowerCase();
  console.error(`Authenticated as: ${account}`);
  if (EXPECTED_EMAIL && account !== EXPECTED_EMAIL.toLowerCase()) {
    throw new Error(
      `ACCOUNT MISMATCH! Expected ${EXPECTED_EMAIL} but authenticated as ${account}. ` +
      `Aborting to prevent writing to wrong mailbox.`,
    );
  }
  return account;
}

/**
 * Convenience: get token + verify account in one call.
 * Use this at the top of any script that creates/modifies emails.
 */
export async function getVerifiedToken() {
  const token = await getAccessToken();
  await verifyAccount(token);
  return token;
}
