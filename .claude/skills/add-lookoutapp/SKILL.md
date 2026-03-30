---
name: add-lookoutapp
description: Add Lookout aged care CRM integration. Enables agents to query clients, workers, services, help plans, visits, and tickets from Lookout.
---

# Add Lookout App Integration

Adds the Lookout CRM API tool so container agents can query and manage aged care data (clients, workers, help plans, visits, tickets, services).

**API docs:** https://developers.thelookoutway.com/docs/overview
**API reference:** https://developers.thelookoutway.com/reference

---

## Phase 1: Pre-flight

1. Check if `container/tools/lookout.mjs` already exists — if so, tell the user the integration is already applied and ask if they want to reconfigure.
2. Check if `.env` has `LOOKOUT_API_KEY` set — if so, credentials are already configured.

## Phase 2: Collect credentials

Ask the user for the following (use AskUserQuestion):

1. **Company ID** (integer) — found in Lookout under Settings > Manage API keys
2. **API Identifier and Secret** — created via Settings > Manage API keys > New Platform API Auth (requires Technical role). The auth header format is `Bearer <IDENTIFIER>:<SECRET>`.
3. **API Base URL** — defaults to `https://api.thelookoutapp.com` but confirm with the user.

## Phase 3: Apply code changes

### 3a. Create the container tool

Write `container/tools/lookout.mjs` — a Node.js CLI tool following the same pattern as `container/tools/jira.mjs`:

- Read env vars: `LOOKOUT_API_BASE_URL`, `LOOKOUT_COMPANY_ID`, `LOOKOUT_API_KEY`
- Base URL constructed as: `${LOOKOUT_API_BASE_URL}/api/${LOOKOUT_COMPANY_ID}/`
- Auth header: `Authorization: Bearer ${LOOKOUT_API_KEY}`
- All responses are JSON
- Pagination: `?page=N&per=N` (default 25, max 250). Response includes `meta.total_pages`, `meta.total_count`.
- Rate limit: 1000 req/min per company. On 429, show `retry-after` header value.

**Commands to implement:**

```
# Clients
lookout list-clients [--page N] [--per N] [--search "name"]
lookout get-client <id>
lookout get-client-notes <id> [--page N]
lookout get-client-workers <id>

# Help Plans (care plans)
lookout get-help-plan <client_id>
lookout get-help-plan-entries <client_id> [--page N]

# Workers
lookout list-workers [--page N] [--per N] [--search "name"]
lookout get-worker <id>
lookout get-worker-clients <id>

# Services
lookout list-services [--page N] [--per N]

# Visits
lookout list-visits [--page N] [--per N] [--client_id N] [--worker_id N]
lookout get-visit <id>

# Tickets
lookout list-tickets [--page N] [--per N]
lookout get-ticket <id>
lookout get-ticket-comments <id>

# Meta
lookout me
lookout meta
```

Each command should:
- Parse CLI args with the same `parseFlags()` pattern as jira.mjs
- Output JSON to stdout on success
- Output `{"error": "..."}` to stderr on failure with exit code 1
- Include pagination meta in list responses

### 3b. Add environment variables to `.env.example`

Append after the AWS section:

```env
# Lookout (optional — enables aged care CRM data access)
# API keys: Settings > Manage API keys > New Platform API Auth (Technical role required)
# Docs: https://developers.thelookoutway.com/docs/overview
LOOKOUT_API_BASE_URL=https://api.thelookoutapp.com
LOOKOUT_COMPANY_ID=
LOOKOUT_API_KEY=
```

### 3c. Add credentials to `.env`

Set the values the user provided:

```bash
# Add to .env (use the actual values collected in Phase 2)
cat >> .env << 'EOF'

# Lookout CRM
LOOKOUT_API_BASE_URL=https://api.thelookoutapp.com
LOOKOUT_COMPANY_ID=<collected_value>
LOOKOUT_API_KEY=<identifier>:<secret>
EOF
```

### 3d. Update `src/container-runner.ts`

Add Lookout credential injection after the AWS section (around line 301):

```typescript
// Pass Lookout credentials if configured
const lookoutEnv = readEnvFile(['LOOKOUT_API_BASE_URL', 'LOOKOUT_COMPANY_ID', 'LOOKOUT_API_KEY']);
for (const key of ['LOOKOUT_API_BASE_URL', 'LOOKOUT_COMPANY_ID', 'LOOKOUT_API_KEY']) {
  const val = lookoutEnv[key] || process.env[key];
  if (val) args.push('-e', `${key}=${val}`);
}
```

### 3e. Add agent documentation to `groups/global/CLAUDE.md`

Append a Lookout section after the existing tool docs:

```markdown
## Lookout (Aged Care CRM)

Query and manage aged care data — clients, workers, help plans, visits, tickets, and services.

\```bash
# List clients (supports search)
node /tools/lookout.mjs list-clients --search "Smith" --per 10

# Get client details
node /tools/lookout.mjs get-client 123

# View client notes
node /tools/lookout.mjs get-client-notes 123

# View workers assigned to a client
node /tools/lookout.mjs get-client-workers 123

# View help plan (care plan) for a client
node /tools/lookout.mjs get-help-plan 123
node /tools/lookout.mjs get-help-plan-entries 123

# List workers
node /tools/lookout.mjs list-workers --search "Jane"

# Get worker details and their clients
node /tools/lookout.mjs get-worker 456
node /tools/lookout.mjs get-worker-clients 456

# List and view visits
node /tools/lookout.mjs list-visits --client_id 123
node /tools/lookout.mjs get-visit 789

# List and view tickets
node /tools/lookout.mjs list-tickets
node /tools/lookout.mjs get-ticket 101
node /tools/lookout.mjs get-ticket-comments 101

# Services
node /tools/lookout.mjs list-services

# Auth check
node /tools/lookout.mjs me
\```

Always parse the JSON output. When showing results, include IDs and names. For lists, show a numbered summary. Use `--search` to narrow results before paginating.
```

## Phase 4: Build and sync

```bash
# Rebuild the container to include the new tool
./container/build.sh

# Sync env to container
mkdir -p data/env && cp .env data/env/env

# Rebuild TypeScript
npm run build
```

## Phase 5: Verify

1. Test the tool locally first:
```bash
LOOKOUT_API_BASE_URL=... LOOKOUT_COMPANY_ID=... LOOKOUT_API_KEY=... node container/tools/lookout.mjs me
```

2. If `me` returns the API key info, credentials are working.
3. Test a list command: `node container/tools/lookout.mjs list-clients --per 3`
4. Restart the service so the new container-runner env injection takes effect:
```bash
systemctl --user restart nanoclaw-aarthi
```
