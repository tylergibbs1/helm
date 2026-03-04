import { Database } from "bun:sqlite";
import type { SiteMemoryEntry, PageMemory, ActionRecord } from "../types.js";
import { join } from "path";
import { mkdirSync } from "fs";

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const dir = join(import.meta.dir, "..", "..", "data");
    mkdirSync(dir, { recursive: true });
    db = new Database(join(dir, "memory.sqlite"));
    db.run("PRAGMA journal_mode=WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS site_memory (
        domain TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        last_visited INTEGER NOT NULL
      )
    `);
  }
  return db;
}

export function getMemory(domain: string): SiteMemoryEntry | null {
  const row = getDb()
    .query("SELECT data FROM site_memory WHERE domain = ?")
    .get(domain) as { data: string } | null;

  if (!row) return null;
  return JSON.parse(row.data);
}

export function saveMemory(entry: SiteMemoryEntry): void {
  getDb()
    .query(
      "INSERT OR REPLACE INTO site_memory (domain, data, last_visited) VALUES (?, ?, ?)"
    )
    .run(entry.domain, JSON.stringify(entry), entry.last_visited);
}

export function deleteMemory(domain: string): void {
  getDb().query("DELETE FROM site_memory WHERE domain = ?").run(domain);
}

/**
 * Record a successful page visit and action into site memory.
 */
export function recordAction(
  url: string,
  title: string,
  action: ActionRecord
): void {
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return;
  }

  const existing = getMemory(domain);
  const now = Date.now();

  if (existing) {
    let pageMemory = existing.pages.find((p) => p.url === url);
    if (!pageMemory) {
      pageMemory = {
        url,
        title,
        reliable_labels: [],
        actions_taken: [],
        last_visited: now,
      };
      existing.pages.push(pageMemory);
    }

    pageMemory.last_visited = now;
    pageMemory.actions_taken.push(action);

    // Track reliable labels (labels that resolved successfully)
    if (action.success && !pageMemory.reliable_labels.includes(action.label)) {
      pageMemory.reliable_labels.push(action.label);
    }

    // Cap history per page
    if (pageMemory.actions_taken.length > 50) {
      pageMemory.actions_taken = pageMemory.actions_taken.slice(-50);
    }

    // Cap pages per domain
    if (existing.pages.length > 20) {
      existing.pages.sort((a, b) => b.last_visited - a.last_visited);
      existing.pages = existing.pages.slice(0, 20);
    }

    existing.last_visited = now;
    saveMemory(existing);
  } else {
    const entry: SiteMemoryEntry = {
      domain,
      pages: [
        {
          url,
          title,
          reliable_labels: action.success ? [action.label] : [],
          actions_taken: [action],
          last_visited: now,
        },
      ],
      last_visited: now,
    };
    saveMemory(entry);
  }
}

export function closeDb(): void {
  if (db) {
    // Evict domains not visited in 90 days
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    db.run("DELETE FROM site_memory WHERE last_visited < ?", [cutoff]);
    db.run("PRAGMA optimize");
    db.close();
    db = null;
  }
}
