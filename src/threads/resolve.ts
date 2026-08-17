import type { EventRecord } from "../adapters/types.js";
import type { Link, Thread } from "../db.js";

const PROXIMITY_MS = 14 * 24 * 60 * 60 * 1000;

interface ThreadIndex {
  thread: Thread;
  prKeys: Set<string>; // "owner/repo#123"
  issueKeys: Set<string>;
  repos: Set<string>;
  dirs: Set<string>; // "owner/repo:src/billing"
  hasPr: boolean;
}

export interface ResolveInput {
  /** Current threads with the events already linked to them. */
  existing: Array<{ thread: Thread; events: EventRecord[] }>;
  /** Events not yet linked to any thread. */
  unlinked: EventRecord[];
}

export interface ResolveOutput {
  /** New threads plus existing threads whose span/title changed. Upsert all. */
  threads: Thread[];
  links: Link[];
}

/**
 * Deterministic thread resolution v1. For each unlinked event, in priority order:
 *   1. shared PR reference in the same repo        (confidence 0.95)
 *   2. shared issue key                            (confidence 0.9)
 *   3. same repo + directory overlap + 14d window  (confidence 0.5)
 *   4. otherwise seed a new thread                 (confidence 1.0)
 * Every link records the reason so groupings can be audited and tuned.
 */
export function resolveThreads(input: ResolveInput): ResolveOutput {
  const indexes: ThreadIndex[] = input.existing.map(({ thread, events }) => {
    const idx = emptyIndex({ ...thread });
    for (const e of events) addEventToIndex(idx, e);
    return idx;
  });
  const touched = new Set<string>();
  const links: Link[] = [];

  // PR events establish threads; reviews and commits then attach to them.
  const order: Record<string, number> = {
    github_pr: 0,
    github_review: 1,
    github_commit: 2,
    manual: 3,
  };
  const events = [...input.unlinked].sort(
    (a, b) =>
      (order[a.source] ?? 9) - (order[b.source] ?? 9) ||
      a.timestamp.localeCompare(b.timestamp)
  );

  for (const event of events) {
    const match = findMatch(indexes, event);
    let idx: ThreadIndex;
    let confidence: number;
    let reason: string;

    if (match) {
      ({ idx, confidence, reason } = match);
      // A PR arriving in a commit-seeded thread is a better name for the work.
      if (event.source === "github_pr" && !idx.hasPr) {
        idx.thread.title = threadTitle(event);
      }
    } else {
      idx = emptyIndex({
        id: `thread:${event.id}`,
        title: threadTitle(event),
        summary: null,
        first_seen: event.timestamp,
        last_seen: event.timestamp,
      });
      indexes.push(idx);
      confidence = 1.0;
      reason = "seed event";
    }

    links.push({
      event_id: event.id,
      thread_id: idx.thread.id,
      confidence,
      reason,
    });
    if (event.timestamp < idx.thread.first_seen)
      idx.thread.first_seen = event.timestamp;
    if (event.timestamp > idx.thread.last_seen)
      idx.thread.last_seen = event.timestamp;
    addEventToIndex(idx, event);
    touched.add(idx.thread.id);
  }

  return {
    threads: indexes
      .filter((i) => touched.has(i.thread.id))
      .map((i) => i.thread),
    links,
  };
}

function findMatch(
  indexes: ThreadIndex[],
  event: EventRecord
): { idx: ThreadIndex; confidence: number; reason: string } | null {
  const prKeys = event.repo
    ? event.refs.prNumbers.map((n) => `${event.repo}#${n}`)
    : [];
  for (const idx of indexes) {
    const hit = prKeys.find((k) => idx.prKeys.has(k));
    if (hit) {
      return { idx, confidence: 0.95, reason: `references PR ${hit}` };
    }
  }

  for (const idx of indexes) {
    const hit = event.refs.issueKeys.find((k) => idx.issueKeys.has(k));
    if (hit) {
      return { idx, confidence: 0.9, reason: `shared issue key ${hit}` };
    }
  }

  if (event.repo) {
    const dirs = eventDirs(event);
    const ts = Date.parse(event.timestamp);
    for (const idx of indexes) {
      if (!idx.repos.has(event.repo)) continue;
      const hit = dirs.find((d) => idx.dirs.has(d));
      if (!hit) continue;
      const near =
        ts >= Date.parse(idx.thread.first_seen) - PROXIMITY_MS &&
        ts <= Date.parse(idx.thread.last_seen) + PROXIMITY_MS;
      if (near) {
        const dir = hit.split(":")[1];
        return {
          idx,
          confidence: 0.5,
          reason: `repo+dir overlap (${dir}) within 14d`,
        };
      }
    }
  }

  return null;
}

function emptyIndex(thread: Thread): ThreadIndex {
  return {
    thread,
    prKeys: new Set(),
    issueKeys: new Set(),
    repos: new Set(),
    dirs: new Set(),
    hasPr: false,
  };
}

function addEventToIndex(idx: ThreadIndex, e: EventRecord): void {
  if (e.repo) {
    idx.repos.add(e.repo);
    for (const n of e.refs.prNumbers) idx.prKeys.add(`${e.repo}#${n}`);
    for (const d of eventDirs(e)) idx.dirs.add(d);
  }
  for (const k of e.refs.issueKeys) idx.issueKeys.add(k);
  if (e.source === "github_pr") idx.hasPr = true;
}

/** Top-two path segments, repo-scoped: "owner/repo:src/billing". */
function eventDirs(e: EventRecord): string[] {
  if (!e.repo) return [];
  const dirs = new Set<string>();
  for (const p of e.refs.paths) {
    const parts = p.split("/");
    if (parts.length < 2) continue; // top-level files are too generic to group on
    dirs.add(`${e.repo}:${parts.slice(0, 2).join("/")}`);
  }
  return [...dirs];
}

function threadTitle(e: EventRecord): string {
  if (e.source === "github_pr") {
    return e.title.replace(/^PR #\d+: /, "").replace(/ \[[a-z]+\]$/, "");
  }
  if (e.refs.issueKeys.length > 0) {
    return `${e.refs.issueKeys[0]}: ${e.title}`;
  }
  return e.title;
}
