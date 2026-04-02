#!/usr/bin/env node
/**
 * Lookout CRM API tool for NanoClaw agents.
 *
 * Usage (via bash in agent):
 *   node /tools/lookout.mjs list-clients [--search "name"] [--page N] [--per N] [--full]
 *   node /tools/lookout.mjs get-client <id>
 *   node /tools/lookout.mjs client-summary <id>        # client + workers in one call
 *   node /tools/lookout.mjs get-client-notes <id> [--page N]
 *   node /tools/lookout.mjs get-client-workers <id>
 *   node /tools/lookout.mjs get-help-plan <client_id>
 *   node /tools/lookout.mjs get-help-plan-entries <client_id> [--page N]
 *   node /tools/lookout.mjs list-workers [--search "name"] [--page N] [--per N] [--full]
 *   node /tools/lookout.mjs get-worker <id>
 *   node /tools/lookout.mjs worker-summary <id>        # worker + their clients in one call
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
 * All GET responses are cached in /tmp/lookout-cache for 5 min (lists) or 2 min (detail).
 * Pass --no-cache to bypass. Pass --full on list commands to get all fields.
 *
 * Requires env vars:
 *   LOOKOUT_API_BASE_URL   e.g. https://api.thelookoutapp.com
 *   LOOKOUT_COMPANY_ID     integer company ID
 *   LOOKOUT_API_KEY        <IDENTIFIER>:<SECRET>
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const BASE_URL = (process.env.LOOKOUT_API_BASE_URL || '').replace(/\/$/, '');
const COMPANY_ID = process.env.LOOKOUT_COMPANY_ID;
const API_KEY = process.env.LOOKOUT_API_KEY;

const CACHE_DIR = '/tmp/lookout-cache';
const TTL_LIST = 5 * 60 * 1000;   // 5 min for collection endpoints
const TTL_DETAIL = 2 * 60 * 1000; // 2 min for single-resource endpoints

function checkConfig() {
  if (!BASE_URL || !COMPANY_ID || !API_KEY) {
    throw new Error(
      'Lookout not configured. Set LOOKOUT_API_BASE_URL, LOOKOUT_COMPANY_ID, and LOOKOUT_API_KEY in .env',
    );
  }
}

// --- Cache ---

function cacheKey(url) {
  return createHash('md5').update(url).digest('hex');
}

function cacheGet(url, ttl) {
  try {
    const file = `${CACHE_DIR}/${cacheKey(url)}.json`;
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - cached.ts < ttl) return cached.data;
  } catch {}
  return null;
}

function cacheSet(url, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      `${CACHE_DIR}/${cacheKey(url)}.json`,
      JSON.stringify({ ts: Date.now(), data }),
    );
  } catch {}
}

// --- HTTP ---

async function lookout(path, options = {}, { noCache = false, ttl = TTL_DETAIL } = {}) {
  checkConfig();
  const url = `${BASE_URL}/api/${COMPANY_ID}${path}`;

  if (!noCache && (!options.method || options.method === 'GET')) {
    const hit = cacheGet(url, ttl);
    if (hit) return hit;
  }

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
    const msg =
      data.errors?.join(', ') || data.error || data.message || JSON.stringify(data);
    throw new Error(`Lookout API ${res.status}: ${msg}`);
  }

  if (!options.method || options.method === 'GET') {
    cacheSet(url, data);
  }
  return data;
}

// --- Helpers ---

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-cache') { flags['no-cache'] = true; continue; }
    if (args[i] === '--full') { flags['full'] = true; continue; }
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
  const p = meta.pagination || meta;
  return {
    current_page: p.current_page,
    per_page: p.per_page,
    total_pages: p.total_pages,
    total_count: p.total_count,
  };
}

// Slim projections — used by default on list commands to cut token volume.
// Pass --full to get every field.

function slimClient(c) {
  return {
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(' '),
    status: c.status,
    dob: c.date_of_birth,
    suburb: c.suburb || c.address?.suburb,
    phone: c.phone || c.mobile,
  };
}

function slimWorker(w) {
  return {
    id: w.id,
    name: [w.first_name, w.last_name].filter(Boolean).join(' '),
    status: w.status,
    role: w.role,
    phone: w.phone || w.mobile,
  };
}

function slimVisit(v) {
  return {
    id: v.id,
    client_id: v.client_id,
    worker_id: v.worker_id,
    status: v.status,
    scheduled_at: v.scheduled_at,
    duration_minutes: v.duration_minutes,
    service: v.service?.name || v.service_id,
  };
}

function slimTicket(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee?.name || t.assignee_id,
    created_at: t.created_at,
  };
}

// --- Commands ---

const command = process.argv[2];
const args = process.argv.slice(3);

try {
  if (command === 'list-clients') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.search) params.set('search', flags.search);
    const noCache = !!flags['no-cache'];
    const data = await lookout(appendParams('/clients', params), {}, { noCache, ttl: TTL_LIST });
    const items = (data.data || data).map(flags.full ? (c) => c : slimClient);
    console.log(JSON.stringify({ meta: formatMeta(data.meta), clients: items }, null, 2));

  } else if (command === 'get-client') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/clients/${id}`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'client-summary') {
    // Combines client detail + assigned workers in a single compact response.
    // Use this instead of separate get-client + get-client-workers calls.
    const id = args[0];
    if (!id) throw new Error('Usage: lookout client-summary <id>');
    const flags = parseFlags(args.slice(1));
    const noCache = !!flags['no-cache'];
    const [clientData, workersData] = await Promise.all([
      lookout(`/clients/${id}`, {}, { noCache }),
      lookout(`/clients/${id}/workers`, {}, { noCache }),
    ]);
    const client = clientData.data || clientData;
    const workers = (workersData.data || workersData).map(slimWorker);
    console.log(JSON.stringify({
      id: client.id,
      name: [client.first_name, client.last_name].filter(Boolean).join(' '),
      status: client.status,
      dob: client.date_of_birth,
      suburb: client.suburb || client.address?.suburb,
      phone: client.phone || client.mobile,
      assigned_workers: workers,
    }, null, 2));

  } else if (command === 'get-client-notes') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client-notes <id> [--page N]');
    const flags = parseFlags(args.slice(1));
    const params = paginationParams(flags);
    const data = await lookout(appendParams(`/clients/${id}/notes`, params), {}, { noCache: !!flags['no-cache'], ttl: TTL_LIST });
    console.log(JSON.stringify({ meta: formatMeta(data.meta), notes: data.data || data }, null, 2));

  } else if (command === 'get-client-workers') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-client-workers <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/clients/${id}/workers`, {}, { noCache: !!flags['no-cache'] });
    const items = (data.data || data).map(flags.full ? (w) => w : slimWorker);
    console.log(JSON.stringify({ workers: items }, null, 2));

  } else if (command === 'get-help-plan') {
    const clientId = args[0];
    if (!clientId) throw new Error('Usage: lookout get-help-plan <client_id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/clients/${clientId}/help_plans`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-help-plan-entries') {
    const clientId = args[0];
    if (!clientId) throw new Error('Usage: lookout get-help-plan-entries <client_id> [--page N]');
    const flags = parseFlags(args.slice(1));
    const params = paginationParams(flags);
    const data = await lookout(appendParams(`/clients/${clientId}/help_plans/entries`, params), {}, { noCache: !!flags['no-cache'], ttl: TTL_LIST });
    console.log(JSON.stringify({ meta: formatMeta(data.meta), entries: data.data || data }, null, 2));

  } else if (command === 'list-workers') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.search) params.set('search', flags.search);
    const noCache = !!flags['no-cache'];
    const data = await lookout(appendParams('/workers', params), {}, { noCache, ttl: TTL_LIST });
    const items = (data.data || data).map(flags.full ? (w) => w : slimWorker);
    console.log(JSON.stringify({ meta: formatMeta(data.meta), workers: items }, null, 2));

  } else if (command === 'get-worker') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-worker <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/workers/${id}`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'worker-summary') {
    // Combines worker detail + their clients in a single compact response.
    const id = args[0];
    if (!id) throw new Error('Usage: lookout worker-summary <id>');
    const flags = parseFlags(args.slice(1));
    const noCache = !!flags['no-cache'];
    const [workerData, clientsData] = await Promise.all([
      lookout(`/workers/${id}`, {}, { noCache }),
      lookout(`/workers/${id}/clients`, {}, { noCache }),
    ]);
    const worker = workerData.data || workerData;
    const clients = (clientsData.data || clientsData).map(slimClient);
    console.log(JSON.stringify({
      id: worker.id,
      name: [worker.first_name, worker.last_name].filter(Boolean).join(' '),
      status: worker.status,
      role: worker.role,
      phone: worker.phone || worker.mobile,
      assigned_clients: clients,
    }, null, 2));

  } else if (command === 'get-worker-clients') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-worker-clients <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/workers/${id}/clients`, {}, { noCache: !!flags['no-cache'] });
    const items = (data.data || data).map(flags.full ? (c) => c : slimClient);
    console.log(JSON.stringify({ clients: items }, null, 2));

  } else if (command === 'list-services') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    const data = await lookout(appendParams('/services', params), {}, { noCache: !!flags['no-cache'], ttl: TTL_LIST });
    console.log(JSON.stringify({ meta: formatMeta(data.meta), services: data.data || data }, null, 2));

  } else if (command === 'list-visits') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    if (flags.client_id) params.set('client_id', flags.client_id);
    if (flags.worker_id) params.set('worker_id', flags.worker_id);
    const noCache = !!flags['no-cache'];
    const data = await lookout(appendParams('/visits', params), {}, { noCache, ttl: TTL_LIST });
    const items = (data.data || data).map(flags.full ? (v) => v : slimVisit);
    console.log(JSON.stringify({ meta: formatMeta(data.meta), visits: items }, null, 2));

  } else if (command === 'get-visit') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-visit <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/visits/${id}`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'list-tickets') {
    const flags = parseFlags(args);
    const params = paginationParams(flags);
    const noCache = !!flags['no-cache'];
    const data = await lookout(appendParams('/tickets', params), {}, { noCache, ttl: TTL_LIST });
    const items = (data.data || data).map(flags.full ? (t) => t : slimTicket);
    console.log(JSON.stringify({ meta: formatMeta(data.meta), tickets: items }, null, 2));

  } else if (command === 'get-ticket') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-ticket <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/tickets/${id}`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'get-ticket-comments') {
    const id = args[0];
    if (!id) throw new Error('Usage: lookout get-ticket-comments <id>');
    const flags = parseFlags(args.slice(1));
    const data = await lookout(`/tickets/${id}/comments`, {}, { noCache: !!flags['no-cache'] });
    console.log(JSON.stringify({ comments: data.data || data }, null, 2));

  } else if (command === 'me') {
    const data = await lookout('/me');
    console.log(JSON.stringify(data, null, 2));

  } else if (command === 'meta') {
    const data = await lookout('/meta');
    console.log(JSON.stringify(data, null, 2));

  } else {
    throw new Error(
      `Unknown command "${command}". Available: list-clients, get-client, client-summary, get-client-notes, get-client-workers, get-help-plan, get-help-plan-entries, list-workers, get-worker, worker-summary, get-worker-clients, list-services, list-visits, get-visit, list-tickets, get-ticket, get-ticket-comments, me, meta`,
    );
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
