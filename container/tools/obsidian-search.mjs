#!/usr/bin/env node
/**
 * Obsidian full-text search for NanoClaw agents.
 *
 * Builds a scored JSON index of all vault notes and searches them efficiently,
 * returning only matching paths + snippets — not full file contents.
 * This keeps token usage low: agent reads only the top 2-3 matching files.
 *
 * Usage:
 *   node /tools/obsidian-search.mjs search "kangasys meeting" [--vault /path] [--limit 5]
 *   node /tools/obsidian-search.mjs index [--vault /path]
 *
 * Output: JSON array of { path, title, date, category, tags, snippet }
 *
 * Auto-reindexes if the index is stale (> 5 minutes old).
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';

const DEFAULT_VAULT = '/workspace/extra/obsidian/SriBot';
const INDEX_RELATIVE = '.index/search.json';
const STALE_MS = 5 * 60 * 1000; // 5 minutes

// ── Frontmatter parser ────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: content, meta: {} };

  const body = content.slice(match[0].length);
  const meta = {};

  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { body, meta };
}

// ── File walker ───────────────────────────────────────────────────────────────

function walkDir(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, files);
    else if (extname(entry.name) === '.md') files.push(full);
  }
  return files;
}

// ── Index builder ─────────────────────────────────────────────────────────────

function buildIndex(vault) {
  const files = walkDir(vault);
  const entries = [];

  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf8');
      const { body, meta } = parseFrontmatter(raw);
      const relPath = relative(vault, file).replace(/\\/g, '/');

      const titleMatch = body.match(/^#\s+(.+)$/m);
      const title = titleMatch
        ? titleMatch[1].trim()
        : basename(file, '.md')
            .replace(/^\d{4}-\d{2}-\d{2}-/, '')
            .replace(/-/g, ' ');

      const tags = Array.isArray(meta.tags)
        ? meta.tags
        : typeof meta.tags === 'string'
          ? [meta.tags]
          : [];

      const category = meta.category || relPath.split('/')[0] || '';

      // Non-empty, non-heading lines for snippet extraction
      const bodyLines = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      entries.push({
        path: relPath,
        title,
        date: meta.date || '',
        category,
        tags,
        bodyLines,
        bodyLower: body.toLowerCase(),
        titleLower: title.toLowerCase(),
        tagsLower: tags.map((t) => t.toLowerCase()),
        categoryLower: category.toLowerCase(),
      });
    } catch {
      // skip unreadable files
    }
  }

  const indexDir = join(vault, dirname(INDEX_RELATIVE));
  if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });

  // Persist: store body as joined string (for future snippet extraction on re-load)
  const persisted = {
    built: Date.now(),
    count: entries.length,
    entries: entries.map((e) => ({
      path: e.path,
      title: e.title,
      date: e.date,
      category: e.category,
      tags: e.tags,
      body: e.bodyLines.join('\n'),
    })),
  };

  writeFileSync(join(vault, INDEX_RELATIVE), JSON.stringify(persisted));
  process.stderr.write(`[obsidian-search] indexed ${entries.length} notes\n`);

  return entries;
}

// ── Index loader (with staleness check) ──────────────────────────────────────

function loadIndex(vault) {
  const indexPath = join(vault, INDEX_RELATIVE);
  let rebuild = true;

  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, 'utf8'));
      const age = Date.now() - (data.built || 0);
      if (age < STALE_MS) {
        // Hydrate with derived fields
        return data.entries.map((e) => ({
          ...e,
          bodyLines: e.body.split('\n'),
          bodyLower: e.body.toLowerCase(),
          titleLower: e.title.toLowerCase(),
          tagsLower: e.tags.map((t) => t.toLowerCase()),
          categoryLower: e.category.toLowerCase(),
        }));
      }
      process.stderr.write(`[obsidian-search] index stale (${Math.round(age / 1000)}s), rebuilding\n`);
    } catch {
      // fall through to rebuild
    }
  }

  return buildIndex(vault);
}

// ── Scorer ────────────────────────────────────────────────────────────────────

function score(entry, terms) {
  let s = 0;
  for (const term of terms) {
    // Title exact: 40, contains: 20
    if (entry.titleLower === term) s += 40;
    else if (entry.titleLower.includes(term)) s += 20;

    // Tags: 15 each
    if (entry.tagsLower.some((t) => t.includes(term))) s += 15;

    // Category: 10
    if (entry.categoryLower.includes(term)) s += 10;

    // Date: 8 (e.g. "2026-03")
    if (entry.date.includes(term)) s += 8;

    // Body: count occurrences, capped at 15
    let count = 0;
    let idx = 0;
    while ((idx = entry.bodyLower.indexOf(term, idx)) !== -1) {
      count++;
      idx += term.length;
      if (count >= 15) break;
    }
    s += count;
  }
  return s;
}

// ── Snippet extractor ─────────────────────────────────────────────────────────

function extractSnippet(entry, terms) {
  // Find first body line containing any term
  for (const line of entry.bodyLines) {
    const lower = line.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      return line.length > 150 ? line.slice(0, 147) + '...' : line;
    }
  }
  // Fallback: first non-empty line
  return entry.bodyLines[0]?.slice(0, 150) || '';
}

// ── Search ────────────────────────────────────────────────────────────────────

function search(query, vault, limit) {
  const entries = loadIndex(vault);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) {
    return { error: 'Query too short — provide at least one word with 2+ characters' };
  }

  const scored = entries
    .map((e) => ({ entry: e, score: score(e, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    return { results: [], message: `No notes found matching "${query}"` };
  }

  return {
    results: scored.map(({ entry, score: s }) => ({
      path: entry.path,
      fullPath: `/workspace/extra/obsidian/SriBot/${entry.path}`,
      title: entry.title,
      date: entry.date,
      category: entry.category,
      tags: entry.tags,
      snippet: extractSnippet(entry, terms),
      score: s,
    })),
    totalIndexed: entries.length,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const vault = getArg('--vault', DEFAULT_VAULT);

if (command === 'index') {
  const entries = buildIndex(vault);
  console.log(JSON.stringify({ indexed: entries.length, vault }));
} else if (command === 'search') {
  const query = args[1];
  if (!query) {
    console.log(JSON.stringify({ error: 'Usage: obsidian-search search "query" [--limit 5] [--vault /path]' }));
    process.exit(1);
  }
  const limit = parseInt(getArg('--limit', '5'), 10);
  const result = search(query, vault, limit);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    JSON.stringify({
      error: 'Unknown command',
      usage: [
        'node /tools/obsidian-search.mjs search "query" [--limit 5] [--vault /path]',
        'node /tools/obsidian-search.mjs index [--vault /path]',
      ],
    }),
  );
  process.exit(1);
}
