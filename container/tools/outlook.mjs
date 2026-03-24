#!/usr/bin/env node
/**
 * Outlook/Microsoft Graph API tool for NanoClaw agents.
 *
 * Usage (via bash in agent):
 *   node /tools/outlook.mjs fetch-emails [count]
 *   node /tools/outlook.mjs get-email <id>
 *   node /tools/outlook.mjs create-draft --to "addr" --subject "subj" --body "text"
 *   node /tools/outlook.mjs create-reply --id <email-id> --body "text"
 *
 * Requires env vars (passed via Docker -e):
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_REFRESH_TOKEN
 *   MICROSOFT_TENANT_ID  (optional, defaults to "common")
 */

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'organizations';
const REFRESH_TOKEN = process.env.MICROSOFT_REFRESH_TOKEN;

const SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access';

async function getAccessToken() {
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
    {
      method: 'POST',
      body: params,
    },
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

async function graph(token, path, options = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Graph API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const command = process.argv[2];
const args = process.argv.slice(3);

try {
  const token = await getAccessToken();

  // Safety check: verify we're authenticated as the expected account
  // before performing any write operations (create-draft, create-reply)
  if (['create-draft', 'create-reply'].includes(command)) {
    const me = await graph(token, '/me?$select=mail,userPrincipalName');
    const account = me.mail || me.userPrincipalName;
    console.error(`Authenticated as: ${account}`);
    const expectedEmail = process.env.MICROSOFT_EXPECTED_EMAIL;
    if (expectedEmail && account.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `Account mismatch! Expected ${expectedEmail} but authenticated as ${account}. ` +
        `Aborting to prevent writing to wrong mailbox.`
      );
    }
  }

  if (command === 'fetch-emails') {
    const count = Math.min(parseInt(args[0]) || 10, 25);
    const data = await graph(
      token,
      `/me/messages?$top=${count}&$orderby=receivedDateTime desc` +
        `&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,isDraft` +
        `&$filter=isDraft eq false`,
    );
    const emails = (data.value || []).map((e, i) => ({
      index: i + 1,
      id: e.id,
      subject: e.subject || '(no subject)',
      from: e.from?.emailAddress?.address,
      fromName: e.from?.emailAddress?.name,
      received: e.receivedDateTime,
      preview: (e.bodyPreview || '').slice(0, 300),
      isRead: e.isRead,
    }));
    console.log(JSON.stringify(emails, null, 2));

  } else if (command === 'get-email') {
    const id = args[0];
    if (!id) throw new Error('Usage: outlook get-email <id>');
    const e = await graph(
      token,
      `/me/messages/${id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead`,
    );
    console.log(
      JSON.stringify(
        {
          id: e.id,
          subject: e.subject || '(no subject)',
          from: `${e.from?.emailAddress?.name} <${e.from?.emailAddress?.address}>`,
          to: (e.toRecipients || []).map((r) => r.emailAddress.address),
          cc: (e.ccRecipients || []).map((r) => r.emailAddress.address),
          received: e.receivedDateTime,
          body: stripHtml(e.body?.content).slice(0, 4000),
        },
        null,
        2,
      ),
    );

  } else if (command === 'create-draft') {
    const flags = parseFlags(args);
    if (!flags.to || !flags.subject || !flags.body) {
      throw new Error(
        'Usage: outlook create-draft --to "email" --subject "subject" --body "body"',
      );
    }
    const draft = await graph(token, '/me/messages', {
      method: 'POST',
      body: JSON.stringify({
        subject: flags.subject,
        body: { contentType: 'Text', content: flags.body },
        toRecipients: [{ emailAddress: { address: flags.to } }],
        isDraft: true,
      }),
    });
    console.log(
      JSON.stringify(
        {
          success: true,
          draftId: draft.id,
          subject: draft.subject,
          to: flags.to,
          note: 'Draft saved. Not sent. View in Outlook Drafts folder.',
        },
        null,
        2,
      ),
    );

  } else if (command === 'create-reply') {
    const flags = parseFlags(args);
    if (!flags.id || !flags.body) {
      throw new Error('Usage: outlook create-reply --id <email-id> --body "reply text"');
    }
    const reply = await graph(token, `/me/messages/${flags.id}/createReply`, {
      method: 'POST',
      body: JSON.stringify({ comment: flags.body }),
    });
    console.log(
      JSON.stringify(
        {
          success: true,
          draftId: reply.id,
          subject: reply.subject,
          note: 'Reply draft saved. Not sent. View in Outlook Drafts folder.',
        },
        null,
        2,
      ),
    );

  } else {
    throw new Error(
      `Unknown command "${command}". Available: fetch-emails, get-email, create-draft, create-reply`,
    );
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
