#!/usr/bin/env node
/**
 * Jira REST API tool for NanoClaw agents.
 *
 * Usage (via bash in agent):
 *   node /tools/jira.mjs get-issue PROJECT-123
 *   node /tools/jira.mjs search --jql "project = PROJ AND status = 'In Progress'" [--max 20]
 *   node /tools/jira.mjs create-issue --project PROJ --type Task --summary "..." [--description "..."] [--assignee accountId]
 *   node /tools/jira.mjs update-issue PROJECT-123 [--summary "..."] [--description "..."] [--assignee accountId]
 *   node /tools/jira.mjs get-transitions PROJECT-123
 *   node /tools/jira.mjs transition-issue PROJECT-123 --transition "In Progress"
 *   node /tools/jira.mjs add-comment PROJECT-123 --body "..."
 *   node /tools/jira.mjs update-comment PROJECT-123 --comment-id 12345 --body "..."
 *   node /tools/jira.mjs get-comments PROJECT-123
 *
 * Requires env vars:
 *   JIRA_URL           e.g. https://yourcompany.atlassian.net
 *   JIRA_EMAIL         your Atlassian account email
 *   JIRA_API_TOKEN     API token from https://id.atlassian.com/manage-profile/security/api-tokens
 */

const JIRA_URL = (process.env.JIRA_URL || '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

function authHeader() {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      'Jira not configured. Set JIRA_URL, JIRA_EMAIL, and JIRA_API_TOKEN in .env',
    );
  }
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jira(path, options = {}) {
  const res = await fetch(`${JIRA_URL}/rest/api/3${path}`, {
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errorMessages?.join(', ') ||
      Object.values(data.errors || {}).join(', ') ||
      data.message ||
      JSON.stringify(data);
    throw new Error(`Jira API ${res.status}: ${msg}`);
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

function adfText(text) {
  // Convert plain text to Atlassian Document Format (ADF)
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: text || '' }],
      },
    ],
  };
}

function extractText(adf) {
  // Extract plain text from ADF or return raw string
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  const texts = [];
  function walk(node) {
    if (node.type === 'text') texts.push(node.text);
    if (node.content) node.content.forEach(walk);
  }
  walk(adf);
  return texts.join('');
}

function formatIssue(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    type: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    created: f.created,
    updated: f.updated,
    description: extractText(f.description).slice(0, 1000),
    labels: f.labels || [],
    url: `${JIRA_URL}/browse/${issue.key}`,
  };
}

const command = process.argv[2];
const args = process.argv.slice(3);

try {
  if (command === 'get-issue') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira get-issue <ISSUE-KEY>');
    const issue = await jira(
      `/issue/${key}?fields=summary,status,issuetype,priority,assignee,reporter,created,updated,description,labels`,
    );
    console.log(JSON.stringify(formatIssue(issue), null, 2));

  } else if (command === 'search') {
    const flags = parseFlags(args);
    if (!flags.jql) throw new Error('Usage: jira search --jql "<JQL query>" [--max 20]');
    const max = Math.min(parseInt(flags.max) || 20, 50);
    const data = await jira('/search', {
      method: 'POST',
      body: JSON.stringify({
        jql: flags.jql,
        maxResults: max,
        fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated'],
      }),
    });
    const issues = (data.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      type: i.fields.issuetype?.name,
      priority: i.fields.priority?.name,
      assignee: i.fields.assignee?.displayName || null,
      updated: i.fields.updated,
      url: `${JIRA_URL}/browse/${i.key}`,
    }));
    console.log(JSON.stringify({ total: data.total, issues }, null, 2));

  } else if (command === 'create-issue') {
    const flags = parseFlags(args);
    if (!flags.project || !flags.summary)
      throw new Error('Usage: jira create-issue --project PROJ --summary "..." [--type Task] [--description "..."] [--assignee accountId]');
    const body = {
      fields: {
        project: { key: flags.project },
        summary: flags.summary,
        issuetype: { name: flags.type || 'Task' },
        ...(flags.description ? { description: adfText(flags.description) } : {}),
        ...(flags.assignee ? { assignee: { accountId: flags.assignee } } : {}),
      },
    };
    const issue = await jira('/issue', { method: 'POST', body: JSON.stringify(body) });
    console.log(JSON.stringify({
      success: true,
      key: issue.key,
      url: `${JIRA_URL}/browse/${issue.key}`,
    }, null, 2));

  } else if (command === 'update-issue') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira update-issue <ISSUE-KEY> [--summary "..."] [--description "..."] [--assignee accountId]');
    const flags = parseFlags(args.slice(1));
    const fields = {};
    if (flags.summary) fields.summary = flags.summary;
    if (flags.description) fields.description = adfText(flags.description);
    if (flags.assignee) fields.assignee = { accountId: flags.assignee };
    if (Object.keys(fields).length === 0)
      throw new Error('Provide at least one of: --summary, --description, --assignee');
    await jira(`/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields }) });
    console.log(JSON.stringify({ success: true, key, updated: Object.keys(fields) }, null, 2));

  } else if (command === 'get-transitions') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira get-transitions <ISSUE-KEY>');
    const data = await jira(`/issue/${key}/transitions`);
    const transitions = (data.transitions || []).map((t) => ({ id: t.id, name: t.name }));
    console.log(JSON.stringify(transitions, null, 2));

  } else if (command === 'transition-issue') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira transition-issue <ISSUE-KEY> --transition "In Progress"');
    const flags = parseFlags(args.slice(1));
    if (!flags.transition) throw new Error('--transition is required');
    // Look up the transition by name
    const data = await jira(`/issue/${key}/transitions`);
    const match = (data.transitions || []).find(
      (t) => t.name.toLowerCase() === flags.transition.toLowerCase(),
    );
    if (!match)
      throw new Error(
        `Transition "${flags.transition}" not found. Available: ${(data.transitions || []).map((t) => t.name).join(', ')}`,
      );
    await jira(`/issue/${key}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    console.log(JSON.stringify({ success: true, key, transition: match.name }, null, 2));

  } else if (command === 'get-comments') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira get-comments <ISSUE-KEY>');
    const data = await jira(`/issue/${key}/comment?maxResults=20&orderBy=-created`);
    const comments = (data.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName,
      created: c.created,
      updated: c.updated,
      body: extractText(c.body).slice(0, 500),
    }));
    console.log(JSON.stringify({ total: data.total, comments }, null, 2));

  } else if (command === 'add-comment') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira add-comment <ISSUE-KEY> --body "..."');
    const flags = parseFlags(args.slice(1));
    if (!flags.body) throw new Error('--body is required');
    const comment = await jira(`/issue/${key}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: adfText(flags.body) }),
    });
    console.log(JSON.stringify({ success: true, commentId: comment.id, key }, null, 2));

  } else if (command === 'update-comment') {
    const key = args[0];
    if (!key) throw new Error('Usage: jira update-comment <ISSUE-KEY> --comment-id 12345 --body "..."');
    const flags = parseFlags(args.slice(1));
    if (!flags['comment-id'] || !flags.body) throw new Error('--comment-id and --body are required');
    await jira(`/issue/${key}/comment/${flags['comment-id']}`, {
      method: 'PUT',
      body: JSON.stringify({ body: adfText(flags.body) }),
    });
    console.log(JSON.stringify({ success: true, key, commentId: flags['comment-id'] }, null, 2));

  } else {
    throw new Error(
      `Unknown command "${command}". Available: get-issue, search, create-issue, update-issue, get-transitions, transition-issue, get-comments, add-comment, update-comment`,
    );
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
