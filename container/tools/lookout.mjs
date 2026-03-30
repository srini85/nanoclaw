#!/usr/bin/env node
/**
 * Lookout CRM API tool for NanoClaw agents.
 *
 * Usage (via bash in agent):
 *   node /tools/lookout.mjs list-clients [--page N] [--per N] [--search "name"]
 *   node /tools/lookout.mjs get-client <id>
 *   node /tools/lookout.mjs get-client-notes <id> [--page N]
 *   node /tools/lookout.mjs get-client-workers <id>
 *   node /tools/lookout.mjs get-help-plan <client_id>
 *   node /tools/lookout.mjs get-help-plan-entries <client_id> [--page N]
 *   node /tools/lookout.mjs list-workers [--page N] [--per N] [--search "name"]
 *   node /tools/lookout.mjs get-worker <id>
 *   node /tools/lookout.mjs get-worker-clients <id>
 *   node /tools/lookout.mjs list-services [--page N] [--per N]
 *   node /tools/lookout.mjs list-visits [--page N] [--per N] [--client_id N] [--worker_id N]
 *   node /tools/lookout.mjs get-visit <id>
 *   node /tools/lookout.mjs list-tickets [--page N] [--per N]
 *   node /tools/lookout.mjs get-ticket <id>
 *   node /tools/lookout.mjs get-ticket-comments <id>
 *   node /tools/lookout.mjs me
 *   node /tools/lookout.mjs meta
 *
 * Requires env vars:
 *   LOOKOUT_API_BASE_URL   e.g. https://api.thelookoutapp.com
 *   LOOKOUT_COMPANY_ID     integer company ID
 *   LOOKOUT_API_KEY        <IDENTIFIER>:<SECRET>
 */

const BASE_URL = (process.env.LOOKOUT_API_BASE_URL || '').replace(/\/$/, '');
const COMPANY_ID = process.env.LOOKOUT_COMPANY_ID;
const API_KEY = process.env.LOOKOUT_API_KEY;

function checkConfig() {
  if (!BASE_URL || !COMPANY_ID || !API_KEY) {
    throw new Error(
      'Lookout not configured. Set LOOKOUT_API_BASE_URL, LOOKOUT_COMPANY_ID, and LOOKOUT_API_KEY in .env',
    );
  }
}

async function lookout(path, options = {}) {
  checkConfig();
  const url = `${BASE_URL}/api/${COMPANY_ID}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...options,
  });
  if (res.status === 204) return null;
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || 'unknown';
    throw new Error(`Rate limited (429). Retry after ${retryAfter} seconds.`);
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.join(', ') ||
      data.error ||
      data.message ||
      JSON.stringify(data);
    throw new Error(`Lookout API ${res.status}: ${msg}`);
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

function paginationParams(flags) {
  const params = new URLSearchParams();
  if (flags.page) params.set('page', flags.page);
  if (flags.per) params.set('per', Math.min(parseInt(flags.per) || 25, 250).toString());
  return params;
}

function appendParams(path, params) {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function formatMeta(meta) {
  if (!meta) return undefined;
  // Pagination info is nested under meta.pagination
  const p = meta.pagination || meta;
  return {
    current_page: p.current_page,
    per_page: p.per_page,
    total_pages: p.total_pages,
    total_count: p.total_count,
  };
}

const command = process.argv[2];
const args = process.argv.slice(3);

try {
  if (command === 'list-clients') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.search) params.set('search', flags.search);
    const data = await lookout(appendParams('/clients', params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), clients: data.data || data }, null, 2));

  } else if (command === 'get-client') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client <id>');
    const data = await lookout(`/clients/${id}`);
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-client-notes') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client-notes <id> [--page N]');
    const flags = parseFlags(args.slice(1));
    const params = paginationParams(flags);
    const data = await lookout(appendParams(`/clients/${id}/notes`, params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), notes: data.data || data }, null, 2));

  } else if (command === 'get-client-workers') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client-workers <id>');
    const data = await lookout(`/clients/${id}/workers`);
    console.log(JSON.stringify({ workers: data.data || data }, null, 2));

  } else if (command === 'get-help-plan') {
    const clientId = args[0];
    if (!clientId) throw new Error('Usage: lookout get-help-plan <client_id>');
    const data = await lookout(`/clients/${clientId}/help_plans`);
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-help-plan-entries') {
    const clientId = args[0];
    if (!clientId) throw new Error('Usage: lookout get-help-plan-entries <client_id> [--page N]');
    const flags = parseFlags(args.slice(1));
    const params = paginationParams(flags);
    const data = await lookout(appendParams(`/clients/${clientId}/help_plans/entries`, params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), entries: data.data || data }, null, 2));

  } else if (command === 'list-workers') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.search) params.set('search', flags.search);
    const data = await lookout(appendParams('/workers', params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), workers: data.data || data }, null, 2));

  } else if (command === 'get-worker') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-worker <id>');
    const data = await lookout(`/workers/${id}`);
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-worker-clients') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-worker-clients <id>');
    const data = await lookout(`/workers/${id}/clients`);
    console.log(JSON.stringify({ clients: data.data || data }, null, 2));

  } else if (command === 'list-services') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    const data = await lookout(appendParams('/services', params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), services: data.data || data }, null, 2));

  } else if (command === 'list-visits') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.client_id) params.set('client_id', flags.client_id);
    if (flags.worker_id) params.set('worker_id', flags.worker_id);
    const data = await lookout(appendParams('/visits', params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), visits: data.data || data }, null, 2));

  } else if (command === 'get-visit') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-visit <id>');
    const data = await lookout(`/visits/${id}`);
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'list-tickets') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    const data = await lookout(appendParams('/tickets', params));
    console.log(JSON.stringify({ meta: formatMeta(data.meta), tickets: data.data || data }, null, 2));

  } else if (command === 'get-ticket') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-ticket <id>');
    const data = await lookout(`/tickets/${id}`);
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-ticket-comments') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-ticket-comments <id>');
    const data = await lookout(`/tickets/${id}/comments`);
    console.log(JSON.stringify({ comments: data.data || data }, null, 2));

  } else if (command === 'me') {
    const data = await lookout('/me');
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'meta') {
    const data = await lookout('/meta');
    console.log(JSON.stringify(data, null, 2));

  } else {
    throw new Error(
      `Unknown command "${command}". Available: list-clients, get-client, get-client-notes, get-client-workers, get-help-plan, get-help-plan-entries, list-workers, get-worker, get-worker-clients, list-services, list-visits, get-visit, list-tickets, get-ticket, get-ticket-comments, me, meta`,
    );
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
