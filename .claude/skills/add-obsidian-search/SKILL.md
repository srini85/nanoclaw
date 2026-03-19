---
name: add-obsidian-search
description: Replace grep-based Obsidian note search with an FTS tool that returns ranked paths + snippets, dramatically reducing token usage when querying the vault.
---

# Add Obsidian FTS Search

Replaces the naive `grep -r` pattern in the agent's vault querying with a scored full-text search tool (`obsidian-search.mjs`). The tool auto-builds a JSON index on first use (or when stale > 5 min) and returns only matching paths + snippets — the agent reads only the top 2-3 files instead of every grep hit.

## Phase 1: Pre-flight

Check if already installed:

```bash
ls container/tools/obsidian-search.mjs
```

If it exists, skip to Phase 3 (Verify).

Also check that the Obsidian vault is mounted. Look in `groups/global/CLAUDE.md` for the vault path — typically `/workspace/extra/obsidian/SriBot/`. If no vault section exists, the user needs to configure the mount first (see `~/.config/nanoclaw/mount-allowlist.json`).

## Phase 2: Apply

### 2a. Write the search tool

Write `container/tools/obsidian-search.mjs` — a self-contained Node.js ESM script with two commands:

- `search "query" [--limit 5] [--vault /path]` — search the index, returns JSON
- `index [--vault /path]` — force rebuild the index

The tool:
1. Walks the vault dir for `.md` files (skipping hidden dirs)
2. Parses YAML frontmatter (date, category, tags)
3. Scores each note against query terms: title (20pts/word), tags (15pts), category (10pts), body (1pt/occurrence)
4. Returns top-N results as `{ path, fullPath, title, date, category, tags, snippet }`
5. Auto-reindexes if `.index/search.json` is older than 5 minutes

### 2b. Update agent instructions

In `groups/global/CLAUDE.md`, replace the `### Querying notes` section grep examples with:

```bash
# Search (returns JSON — read only top 1-3 fullPath files)
node /tools/obsidian-search.mjs search "topic keywords"
node /tools/obsidian-search.mjs search "india transfer" --limit 3
node /tools/obsidian-search.mjs index   # force rebuild (rarely needed)
```

Add a workflow note: parse JSON → read only `fullPath` files from top results → summarise.

### 2c. Rebuild container

```bash
./container/build.sh
```

If the build cache is stale, prune first:

```bash
docker builder prune -f
./container/build.sh
```

### 2d. Restart service

```bash
# Windows (manual)
node dist/index.js

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 3: Verify

Ask the agent (via WhatsApp/Telegram) a question that requires searching notes, e.g.:

> "What did we discuss in the Kangasys meeting?"

The agent should:
1. Run `node /tools/obsidian-search.mjs search "kangasys meeting"`
2. Get back JSON with matching note paths + snippets
3. Read only 1-2 files
4. Summarise the answer

Compare with the old behavior (grep reading every file). The agent's bash output should show the search tool call, not a grep scan.

### Force an index rebuild

```bash
# Inside a test container (or ask the agent):
node /tools/obsidian-search.mjs index --vault /workspace/extra/obsidian/SriBot
```

Should output: `{ "indexed": <N>, "vault": "..." }`

## Troubleshooting

### "No notes found" when notes clearly exist

The vault path may be wrong. Verify the mount:
```bash
ls /workspace/extra/obsidian/SriBot/
```
Pass `--vault` explicitly if needed.

### Index never rebuilds (stale results)

Delete `.index/search.json` from inside the vault folder, or run `obsidian-search.mjs index` explicitly.

### Agent still uses grep

The `groups/global/CLAUDE.md` update did not take effect. Check that the file was saved and the service was restarted. The CLAUDE.md is read at container start — no rebuild needed, just restart.
