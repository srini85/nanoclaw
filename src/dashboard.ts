import http from 'http';

import { CronExpressionParser } from 'cron-parser';

import { DASHBOARD_PORT, TIMEZONE } from './config.js';
import {
  deleteTask,
  getAllTasks,
  getRecentTokenUsage,
  getTaskById,
  getTaskRunLogs,
  getTokenUsageByType,
  getTokenUsageSummary,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// HTML UI
// ---------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NanoClaw · Tasks</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #22263a;
    --border: #2e3250;
    --accent: #6c8ef5;
    --accent2: #4ade80;
    --warn: #fbbf24;
    --danger: #f87171;
    --text: #e2e8f0;
    --muted: #8892b0;
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }

  /* Layout */
  .app { max-width: 1400px; margin: 0 auto; padding: 24px 20px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  header h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
  header h1 span { color: var(--accent); }

  /* Stats */
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 18px; min-width: 110px; }
  .stat-val { font-size: 24px; font-weight: 700; line-height: 1; }
  .stat-label { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .stat.active .stat-val { color: var(--accent2); }
  .stat.paused .stat-val { color: var(--warn); }
  .stat.completed .stat-val { color: var(--muted); }
  .stat.total .stat-val { color: var(--text); }

  /* Toolbar */
  .toolbar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .filter-tabs { display: flex; gap: 4px; }
  .tab { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; cursor: pointer; color: var(--muted); font-size: 13px; transition: all .15s; }
  .tab:hover { border-color: var(--accent); color: var(--text); }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
  .search { flex: 1; min-width: 200px; max-width: 340px; }
  .search input { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; color: var(--text); font-size: 13px; outline: none; }
  .search input:focus { border-color: var(--accent); }
  .search input::placeholder { color: var(--muted); }
  .btn { border: none; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-muted { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* Table */
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: var(--surface2); padding: 10px 14px; text-align: left; font-weight: 500; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid var(--border); cursor: pointer; transition: background .1s; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: var(--surface2); }
  tbody tr.expanded { background: var(--surface2); }
  td { padding: 10px 14px; vertical-align: top; }
  td.prompt { max-width: 280px; }
  .prompt-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; display: block; }
  .group-badge { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 7px; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .schedule-type { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }

  /* Status badges */
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px; font-size: 12px; font-weight: 500; }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; }
  .badge-active { background: rgba(74,222,128,.12); color: var(--accent2); }
  .badge-active::before { background: var(--accent2); }
  .badge-paused { background: rgba(251,191,36,.12); color: var(--warn); }
  .badge-paused::before { background: var(--warn); }
  .badge-completed { background: rgba(136,146,176,.12); color: var(--muted); }
  .badge-completed::before { background: var(--muted); }

  /* Expanded row */
  .expand-row td { padding: 0; }
  .expand-content { padding: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; border-top: 1px solid var(--border); background: var(--bg); }
  .expand-section h4 { font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: .5px; margin-bottom: 8px; }
  .field-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .field-label { font-size: 11px; color: var(--muted); }
  .field-val { font-size: 13px; color: var(--text); }
  .prompt-full { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow-y: auto; }
  .result-box { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; color: var(--muted); }
  .expand-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

  /* Logs */
  .logs-section { grid-column: 1 / -1; }
  .log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .log-table th { text-align: left; color: var(--muted); padding: 4px 10px; font-weight: 500; border-bottom: 1px solid var(--border); }
  .log-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .log-table tr:last-child td { border-bottom: none; }
  .log-success { color: var(--accent2); }
  .log-error { color: var(--danger); }
  .log-result { max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }

  /* Modal */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; width: 540px; max-width: calc(100vw - 40px); max-height: 90vh; overflow-y: auto; padding: 24px; }
  .modal h2 { font-size: 16px; margin-bottom: 20px; }
  .form-row { margin-bottom: 16px; }
  .form-row label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: .4px; }
  .form-row input, .form-row select, .form-row textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text); font-size: 13px; outline: none; font-family: inherit; }
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus { border-color: var(--accent); }
  .form-row textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
  .form-row select option { background: var(--surface); }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  .schedule-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* Misc */
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  .ts { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; font-size: 13px; z-index: 200; transition: opacity .3s; }
  .toast.hide { opacity: 0; pointer-events: none; }
  .refresh-btn { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; color: var(--muted); cursor: pointer; font-size: 13px; }
  .refresh-btn:hover { border-color: var(--accent); color: var(--text); }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>Nano<span>Claw</span> · Tasks</h1>
    <button class="refresh-btn" onclick="load()">↻ Refresh</button>
  </header>

  <div class="stats" id="stats"></div>

  <div class="toolbar">
    <div class="filter-tabs" id="tabs">
      <button class="tab active" data-status="">All</button>
      <button class="tab" data-status="active">Active</button>
      <button class="tab" data-status="paused">Paused</button>
      <button class="tab" data-status="completed">Completed</button>
    </div>
    <div class="search"><input id="search" placeholder="Search prompts, groups…" oninput="render()"></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Group</th>
          <th>Prompt</th>
          <th>Schedule</th>
          <th>Next Run</th>
          <th>Last Run</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="empty" class="empty" style="display:none">No tasks match your filters.</div>
  </div>
</div>

<!-- Edit Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2>Edit Task</h2>
    <input type="hidden" id="edit-id">
    <div class="form-row">
      <label>Prompt</label>
      <textarea id="edit-prompt" rows="4"></textarea>
    </div>
    <div class="form-row">
      <label>Schedule Type</label>
      <select id="edit-stype" onchange="updateScheduleHint()">
        <option value="cron">Cron</option>
        <option value="interval">Interval (ms)</option>
        <option value="once">Once (ISO timestamp)</option>
      </select>
    </div>
    <div class="form-row">
      <label>Schedule Value</label>
      <input id="edit-svalue" type="text">
      <div class="schedule-hint" id="schedule-hint"></div>
    </div>
    <div class="form-row">
      <label>Status</label>
      <select id="edit-status">
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="completed">Completed</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-muted" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEdit()">Save Changes</button>
    </div>
  </div>
</div>

<div class="toast hide" id="toast"></div>

<script>
let allTasks = [];
let expandedId = null;
let activeFilter = '';

async function load() {
  try {
    const res = await fetch('/api/tasks');
    allTasks = await res.json();
    updateStats();
    render();
  } catch(e) { toast('Failed to load tasks', true); }
}

function updateStats() {
  const counts = { total: allTasks.length, active: 0, paused: 0, completed: 0 };
  allTasks.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
  document.getElementById('stats').innerHTML = \`
    <div class="stat total"><div class="stat-val">\${counts.total}</div><div class="stat-label">Total</div></div>
    <div class="stat active"><div class="stat-val">\${counts.active}</div><div class="stat-label">Active</div></div>
    <div class="stat paused"><div class="stat-val">\${counts.paused}</div><div class="stat-label">Paused</div></div>
    <div class="stat completed"><div class="stat-val">\${counts.completed}</div><div class="stat-label">Completed</div></div>
  \`;
}

function render() {
  const q = document.getElementById('search').value.toLowerCase();
  let tasks = allTasks;
  if (activeFilter) tasks = tasks.filter(t => t.status === activeFilter);
  if (q) tasks = tasks.filter(t =>
    t.prompt.toLowerCase().includes(q) || t.group_folder.toLowerCase().includes(q) || t.chat_jid.toLowerCase().includes(q)
  );

  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (tasks.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = tasks.map(t => {
    const expanded = expandedId === t.id;
    return \`
      <tr class="\${expanded ? 'expanded' : ''}" onclick="toggleExpand('\${t.id}')">
        <td><span class="badge badge-\${t.status}">\${t.status}</span></td>
        <td><span class="group-badge">\${esc(t.group_folder)}</span></td>
        <td class="prompt"><span class="prompt-text" title="\${esc(t.prompt)}">\${esc(t.prompt)}</span></td>
        <td>
          <div class="schedule-type">\${t.schedule_type}</div>
          <div style="font-size:12px;color:#aaa;margin-top:2px">\${esc(fmtSchedule(t))}</div>
        </td>
        <td class="ts">\${t.next_run ? fmtDate(t.next_run) : '—'}</td>
        <td class="ts">\${t.last_run ? fmtDate(t.last_run) : '—'}</td>
        <td onclick="event.stopPropagation()">
          <div style="display:flex;gap:6px">
            <button class="btn btn-muted btn-sm" onclick="openEdit('\${t.id}')">Edit</button>
          </div>
        </td>
      </tr>
      \${expanded ? expandRow(t) : ''}
    \`;
  }).join('');
}

function expandRow(t) {
  return \`<tr class="expand-row" id="exp-\${t.id}">
    <td colspan="7">
      <div class="expand-content">
        <div class="expand-section">
          <h4>Full Prompt</h4>
          <div class="prompt-full">\${esc(t.prompt)}</div>
          <div class="expand-actions">
            \${t.status === 'active' ? \`<button class="btn btn-muted btn-sm" onclick="setStatus('\${t.id}','paused')">⏸ Pause</button>\` : ''}
            \${t.status === 'paused' ? \`<button class="btn btn-primary btn-sm" onclick="setStatus('\${t.id}','active')">▶ Resume</button>\` : ''}
            <button class="btn btn-muted btn-sm" onclick="openEdit('\${t.id}')">✎ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDelete('\${t.id}')">✕ Delete</button>
          </div>
        </div>
        <div class="expand-section">
          <h4>Details</h4>
          <div class="field-group">
            <div class="field-label">Task ID</div><div class="field-val" style="font-size:11px;font-family:monospace">\${esc(t.id)}</div>
          </div>
          <div class="field-group">
            <div class="field-label">Chat JID</div><div class="field-val" style="font-size:11px;font-family:monospace">\${esc(t.chat_jid)}</div>
          </div>
          <div class="field-group">
            <div class="field-label">Context Mode</div><div class="field-val">\${esc(t.context_mode)}</div>
          </div>
          <div class="field-group">
            <div class="field-label">Created</div><div class="field-val">\${fmtDate(t.created_at)}</div>
          </div>
          \${t.last_result ? \`<h4 style="margin-top:12px">Last Result</h4><div class="result-box">\${esc(t.last_result)}</div>\` : ''}
        </div>
        <div class="logs-section">
          <h4>Run History</h4>
          <div id="logs-\${t.id}"><span class="spin">⟳</span> Loading…</div>
        </div>
      </div>
    </td>
  </tr>\`;
}

async function toggleExpand(id) {
  if (expandedId === id) { expandedId = null; render(); return; }
  expandedId = id;
  render();
  // Load logs
  try {
    const res = await fetch(\`/api/tasks/\${encodeURIComponent(id)}/logs\`);
    const logs = await res.json();
    const el = document.getElementById(\`logs-\${id}\`);
    if (!el) return;
    if (!logs.length) { el.innerHTML = '<span style="color:var(--muted)">No runs yet.</span>'; return; }
    el.innerHTML = \`<table class="log-table">
      <thead><tr><th>Run At</th><th>Status</th><th>Duration</th><th>Result / Error</th></tr></thead>
      <tbody>\${logs.map(l => \`
        <tr>
          <td class="ts">\${fmtDate(l.run_at)}</td>
          <td class="\${l.status === 'success' ? 'log-success' : 'log-error'}">\${l.status}</td>
          <td class="ts">\${fmtMs(l.duration_ms)}</td>
          <td class="log-result">\${esc(l.error || l.result || '—')}</td>
        </tr>
      \`).join('')}</tbody>
    </table>\`;
  } catch(e) { }
}

function openEdit(id) {
  const t = allTasks.find(x => x.id === id);
  if (!t) return;
  document.getElementById('edit-id').value = t.id;
  document.getElementById('edit-prompt').value = t.prompt;
  document.getElementById('edit-stype').value = t.schedule_type;
  document.getElementById('edit-svalue').value = t.schedule_value;
  document.getElementById('edit-status').value = t.status;
  updateScheduleHint();
  document.getElementById('modal').classList.add('open');
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }

function updateScheduleHint() {
  const t = document.getElementById('edit-stype').value;
  const hints = {
    cron: 'e.g. 0 9 * * 1-5 (weekdays at 9am)',
    interval: 'milliseconds, e.g. 3600000 for 1 hour',
    once: 'ISO 8601 datetime, e.g. 2025-12-31T09:00:00.000Z'
  };
  document.getElementById('schedule-hint').textContent = hints[t] || '';
}

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const body = {
    prompt: document.getElementById('edit-prompt').value.trim(),
    schedule_type: document.getElementById('edit-stype').value,
    schedule_value: document.getElementById('edit-svalue').value.trim(),
    status: document.getElementById('edit-status').value,
  };
  try {
    const res = await fetch(\`/api/tasks/\${encodeURIComponent(id)}\`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    if (!res.ok) { const e = await res.json(); toast(e.error || 'Save failed', true); return; }
    closeModal();
    toast('Task updated');
    await load();
  } catch(e) { toast('Save failed', true); }
}

async function setStatus(id, status) {
  try {
    await fetch(\`/api/tasks/\${encodeURIComponent(id)}\`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status })
    });
    toast('Status updated');
    await load();
  } catch(e) { toast('Failed', true); }
}

async function confirmDelete(id) {
  if (!confirm('Delete this task and all its run logs? This cannot be undone.')) return;
  try {
    const res = await fetch(\`/api/tasks/\${encodeURIComponent(id)}\`, { method: 'DELETE' });
    if (!res.ok) { toast('Delete failed', true); return; }
    expandedId = null;
    toast('Task deleted');
    await load();
  } catch(e) { toast('Delete failed', true); }
}

// Tabs
document.getElementById('tabs').addEventListener('click', e => {
  if (!e.target.matches('.tab')) return;
  activeFilter = e.target.dataset.status;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  render();
});

// Close modal on overlay click
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});

// Helpers
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch { return s; }
}

function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.floor((ms%60000)/1000) + 's';
}

function fmtSchedule(t) {
  if (t.schedule_type === 'interval') {
    const ms = parseInt(t.schedule_value, 10);
    if (!isNaN(ms)) {
      if (ms < 60000) return 'every ' + (ms/1000) + 's';
      if (ms < 3600000) return 'every ' + Math.round(ms/60000) + 'm';
      if (ms < 86400000) return 'every ' + (ms/3600000).toFixed(1) + 'h';
      return 'every ' + (ms/86400000).toFixed(1) + 'd';
    }
  }
  return t.schedule_value;
}

function toast(msg, err) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = err ? 'var(--danger)' : 'var(--accent2)';
  el.classList.remove('hide');
  setTimeout(() => el.classList.add('hide'), 3000);
}

load();
setInterval(load, 30000); // auto-refresh every 30s
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost`);
  const path = url.pathname;
  const method = req.method?.toUpperCase() ?? 'GET';

  // Serve UI
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // GET /api/tasks
  if (method === 'GET' && path === '/api/tasks') {
    const tasks = getAllTasks();
    jsonResponse(res, 200, tasks);
    return;
  }

  // GET /api/tasks/:id
  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);

    if (method === 'GET') {
      const task = getTaskById(id);
      if (!task) {
        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }
      jsonResponse(res, 200, task);
      return;
    }

    if (method === 'PATCH') {
      const task = getTaskById(id);
      if (!task) {
        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }

      let body: Record<string, string>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (body.prompt !== undefined) updates.prompt = String(body.prompt);
      if (body.status !== undefined) {
        const s = body.status as ScheduledTask['status'];
        if (!['active', 'paused', 'completed'].includes(s)) {
          jsonResponse(res, 400, { error: 'Invalid status' });
          return;
        }
        updates.status = s;
      }

      const newType = (body.schedule_type ??
        task.schedule_type) as ScheduledTask['schedule_type'];
      const newValue = body.schedule_value ?? task.schedule_value;

      if (
        body.schedule_type !== undefined ||
        body.schedule_value !== undefined
      ) {
        if (!['cron', 'interval', 'once'].includes(newType)) {
          jsonResponse(res, 400, { error: 'Invalid schedule_type' });
          return;
        }
        updates.schedule_type = newType;
        updates.schedule_value = newValue;

        // Recompute next_run
        if (newType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(newValue, {
              tz: TIMEZONE,
            });
            updates.next_run = interval.next().toISOString();
          } catch {
            jsonResponse(res, 400, { error: 'Invalid cron expression' });
            return;
          }
        } else if (newType === 'interval') {
          const ms = parseInt(newValue, 10);
          if (isNaN(ms) || ms <= 0) {
            jsonResponse(res, 400, {
              error: 'Invalid interval (must be positive ms)',
            });
            return;
          }
          updates.next_run = new Date(Date.now() + ms).toISOString();
        } else if (newType === 'once') {
          const d = new Date(newValue);
          if (isNaN(d.getTime())) {
            jsonResponse(res, 400, { error: 'Invalid ISO timestamp for once' });
            return;
          }
          updates.next_run = d.toISOString();
        }
      }

      updateTask(id, updates);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === 'DELETE') {
      const task = getTaskById(id);
      if (!task) {
        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }
      deleteTask(id);
      jsonResponse(res, 200, { ok: true });
      return;
    }
  }

  // GET /api/tasks/:id/logs
  const logsMatch = path.match(/^\/api\/tasks\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    const id = decodeURIComponent(logsMatch[1]);
    const logs = getTaskRunLogs(id, 50);
    jsonResponse(res, 200, logs);
    return;
  }

  // GET /api/token-usage — summary, breakdown by type, and recent runs
  if (method === 'GET' && path === '/api/token-usage') {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const since = url.searchParams.get('since') || undefined;
    const group = url.searchParams.get('group') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    jsonResponse(res, 200, {
      summary: getTokenUsageSummary(since, group),
      by_type: getTokenUsageByType(since),
      recent: getRecentTokenUsage(limit),
    });
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

export function startDashboard(): http.Server {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'Dashboard request error');
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal server error' });
      }
    });
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    logger.info(
      { port: DASHBOARD_PORT },
      `Dashboard running at http://localhost:${DASHBOARD_PORT}`,
    );
  });

  return server;
}
