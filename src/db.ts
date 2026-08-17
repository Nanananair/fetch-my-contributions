import Database from "better-sqlite3";
import type { EventRecord, EventRefs } from "./adapters/types.js";

export interface Thread {
  id: string;
  title: string;
  summary: string | null;
  first_seen: string;
  last_seen: string;
}

export interface Link {
  event_id: string;
  thread_id: string;
  confidence: number;
  reason: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  repo       TEXT,
  title      TEXT NOT NULL,
  body       TEXT,
  refs       TEXT NOT NULL,
  raw_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
CREATE INDEX IF NOT EXISTS idx_events_repo ON events (repo);

CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  summary    TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  event_id   TEXT NOT NULL REFERENCES events(id),
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  confidence REAL NOT NULL,
  reason     TEXT NOT NULL,
  PRIMARY KEY (event_id, thread_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Db {
  readonly raw: Database.Database;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  // --- events ---

  hasEvent(id: string): boolean {
    return (
      this.raw.prepare("SELECT 1 FROM events WHERE id = ?").get(id) !==
      undefined
    );
  }

  /** INSERT OR IGNORE on the natural id; returns true if the row was new. */
  insertEvent(e: EventRecord): boolean {
    const info = this.raw
      .prepare(
        `INSERT OR IGNORE INTO events (id, source, timestamp, repo, title, body, refs, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.id,
        e.source,
        e.timestamp,
        e.repo,
        e.title,
        e.body,
        JSON.stringify(e.refs),
        JSON.stringify(e.raw ?? null)
      );
    return info.changes > 0;
  }

  getEvents(opts: { since?: string; until?: string } = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.since) {
      clauses.push("timestamp >= ?");
      params.push(opts.since);
    }
    if (opts.until) {
      clauses.push("timestamp <= ?");
      params.push(opts.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.raw
      .prepare(`SELECT * FROM events ${where} ORDER BY timestamp ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  getUnlinkedEvents(): EventRecord[] {
    const rows = this.raw
      .prepare(
        `SELECT e.* FROM events e
         LEFT JOIN links l ON l.event_id = e.id
         WHERE l.event_id IS NULL
         ORDER BY e.timestamp ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  // --- threads & links ---

  getThreads(): Thread[] {
    return this.raw
      .prepare("SELECT * FROM threads ORDER BY last_seen DESC")
      .all() as Thread[];
  }

  getLinks(): Link[] {
    return this.raw.prepare("SELECT * FROM links").all() as Link[];
  }

  upsertThread(t: Thread): void {
    this.raw
      .prepare(
        `INSERT INTO threads (id, title, summary, first_seen, last_seen)
         VALUES (@id, @title, @summary, @first_seen, @last_seen)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           first_seen = excluded.first_seen,
           last_seen = excluded.last_seen`
      )
      .run(t);
  }

  insertLink(l: Link): void {
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO links (event_id, thread_id, confidence, reason)
         VALUES (@event_id, @thread_id, @confidence, @reason)`
      )
      .run(l);
  }

  /** Threads with at least one linked event in [since, now], with their events. */
  getThreadsWithEvents(since: string): Array<{
    thread: Thread;
    events: Array<EventRecord & { confidence: number; reason: string }>;
  }> {
    const threads = this.getThreads();
    const stmt = this.raw.prepare(
      `SELECT e.*, l.confidence, l.reason FROM events e
       JOIN links l ON l.event_id = e.id
       WHERE l.thread_id = ?
       ORDER BY e.timestamp ASC`
    );
    const out = [];
    for (const thread of threads) {
      const rows = stmt.all(thread.id) as Array<Record<string, unknown>>;
      const events = rows.map((r) => ({
        ...rowToEvent(r),
        confidence: r.confidence as number,
        reason: r.reason as string,
      }));
      if (events.some((e) => e.timestamp >= since)) out.push({ thread, events });
    }
    return out;
  }

  // --- sync state ---

  getState(key: string): string | null {
    const row = this.raw
      .prepare("SELECT value FROM sync_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.raw
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: row.id as string,
    source: row.source as EventRecord["source"],
    timestamp: row.timestamp as string,
    repo: (row.repo as string | null) ?? null,
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    refs: JSON.parse(row.refs as string) as EventRefs,
    raw: JSON.parse(row.raw_json as string),
  };
}
