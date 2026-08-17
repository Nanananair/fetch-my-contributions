import type { SourceAdapter } from "../adapters/types.js";
import type { Db } from "../db.js";
import { resolveThreads } from "../threads/resolve.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 90 * DAY_MS;
// Re-fetch a day of overlap so events that landed mid-sync are never missed;
// INSERT OR IGNORE makes the overlap free.
const OVERLAP_MS = DAY_MS;

export interface SyncDeps {
  db: Db;
  adapters: SourceAdapter[];
  isRepoDenylisted: (repo: string) => boolean;
  since?: Date;
  now?: Date;
  log?: (message: string) => void;
}

export interface SyncResult {
  newEvents: number;
  bySource: Record<string, number>;
  threadsTouched: number;
  failedAdapters: string[];
}

/**
 * Core sync loop, separated from CLI wiring so tests can drive it with an
 * in-memory db and a fake adapter. Incremental: each adapter has a cursor in
 * sync_state that only advances after the adapter completes without error.
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, log = () => {} } = deps;
  const now = deps.now ?? new Date();
  const bySource: Record<string, number> = {};
  const failedAdapters: string[] = [];
  let newEvents = 0;

  for (const adapter of deps.adapters) {
    let cursorKey: string;
    try {
      cursorKey = `cursor:${(await adapter.identity?.()) ?? adapter.name}`;
    } catch (err) {
      failedAdapters.push(adapter.name);
      log(`${adapter.name}: FAILED to authenticate (${(err as Error).message})`);
      continue;
    }
    const cursor = db.getState(cursorKey);
    const since =
      deps.since ??
      (cursor
        ? new Date(Date.parse(cursor) - OVERLAP_MS)
        : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS));
    log(`${adapter.name}: syncing since ${since.toISOString()}`);

    try {
      for await (const event of adapter.fetchEvents({
        since,
        until: now,
        hasEvent: (id) => db.hasEvent(id),
        isRepoDenylisted: deps.isRepoDenylisted,
        onProgress: (m) => log(`  ${m}`),
      })) {
        if (event.repo && deps.isRepoDenylisted(event.repo)) continue;
        if (db.insertEvent(event)) {
          newEvents++;
          bySource[event.source] = (bySource[event.source] ?? 0) + 1;
        }
      }
      db.setState(cursorKey, now.toISOString());
    } catch (err) {
      failedAdapters.push(adapter.name);
      log(
        `${adapter.name}: FAILED (${(err as Error).message}) — cursor not advanced, next run will retry this window`
      );
    }
  }

  const resolved = resolveThreads({
    existing: db
      .getThreadsWithEvents("")
      .map(({ thread, events }) => ({ thread, events })),
    unlinked: db.getUnlinkedEvents(),
  });
  const txn = db.raw.transaction(() => {
    for (const t of resolved.threads) db.upsertThread(t);
    for (const l of resolved.links) db.insertLink(l);
  });
  txn();

  return {
    newEvents,
    bySource,
    threadsTouched: resolved.threads.length,
    failedAdapters,
  };
}
