import { describe, expect, it } from "vitest";
import type {
  EventRecord,
  FetchOptions,
  SourceAdapter,
} from "../src/adapters/types.js";
import { Db } from "../src/db.js";
import { runSync } from "../src/commands/sync.js";

function ev(id: string, timestamp: string, repo = "me/app"): EventRecord {
  return {
    id,
    source: "github_commit",
    timestamp,
    repo,
    title: `commit ${id}`,
    body: null,
    refs: { issueKeys: ["PROJ-1"], prNumbers: [], branches: [], paths: [] },
    raw: { id },
  };
}

class FakeAdapter implements SourceAdapter {
  name = "fake";
  identity?: () => Promise<string>;
  calls: Array<{ since: Date; until: Date }> = [];
  detailFetches = 0;

  constructor(
    private events: EventRecord[],
    private failAfter: number | null = null
  ) {}

  async *fetchEvents(opts: FetchOptions): AsyncIterable<EventRecord> {
    this.calls.push({ since: opts.since, until: opts.until });
    let i = 0;
    for (const e of this.events) {
      if (this.failAfter !== null && i >= this.failAfter) {
        throw new Error("boom");
      }
      // Mirror the real adapter: skip "expensive detail fetch" for known ids.
      if (!opts.hasEvent(e.id)) this.detailFetches++;
      if (Date.parse(e.timestamp) >= opts.since.getTime()) yield e;
      i++;
    }
  }
}

const NOW = new Date("2026-08-15T00:00:00Z");

describe("runSync", () => {
  it("inserts events, links them into threads, and advances the cursor", async () => {
    const db = new Db(":memory:");
    const adapter = new FakeAdapter([
      ev("gh:commit:a", "2026-08-01T00:00:00Z"),
      ev("gh:commit:b", "2026-08-02T00:00:00Z"),
    ]);

    const result = await runSync({
      db,
      adapters: [adapter],
      isRepoDenylisted: () => false,
      now: NOW,
    });

    expect(result.newEvents).toBe(2);
    expect(result.bySource.github_commit).toBe(2);
    expect(db.getState("cursor:fake")).toBe(NOW.toISOString());
    // Both events share PROJ-1 → one thread.
    expect(db.getThreads()).toHaveLength(1);
    expect(db.getUnlinkedEvents()).toHaveLength(0);
  });

  it("is incremental: a second run refetches nothing already stored", async () => {
    const db = new Db(":memory:");
    const events = [
      ev("gh:commit:a", "2026-08-01T00:00:00Z"),
      ev("gh:commit:b", "2026-08-02T00:00:00Z"),
    ];

    await runSync({
      db,
      adapters: [new FakeAdapter(events)],
      isRepoDenylisted: () => false,
      now: NOW,
    });

    const second = new FakeAdapter([...events, ev("gh:commit:c", "2026-08-14T20:00:00Z")]);
    const later = new Date("2026-08-15T06:00:00Z");
    const result = await runSync({
      db,
      adapters: [second],
      isRepoDenylisted: () => false,
      now: later,
    });

    expect(result.newEvents).toBe(1); // only the new commit
    expect(second.detailFetches).toBe(1); // known ids skip the detail fetch
    // Second run starts from the stored cursor (minus overlap), not 90 days back.
    const since = second.calls[0].since.getTime();
    expect(since).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(db.getState("cursor:fake")).toBe(later.toISOString());
  });

  it("does not advance the cursor when the adapter fails mid-stream", async () => {
    const db = new Db(":memory:");
    const failing = new FakeAdapter(
      [ev("gh:commit:a", "2026-08-01T00:00:00Z"), ev("gh:commit:b", "2026-08-02T00:00:00Z")],
      1
    );

    const result = await runSync({
      db,
      adapters: [failing],
      isRepoDenylisted: () => false,
      now: NOW,
    });

    expect(result.failedAdapters).toEqual(["fake"]);
    expect(db.getState("cursor:fake")).toBeNull();
    // Events received before the failure are kept — refetching them is free.
    expect(result.newEvents).toBe(1);
    // And they still get threaded.
    expect(db.getUnlinkedEvents()).toHaveLength(0);
  });

  it("keys cursors by adapter identity, not host, so accounts don't collide", async () => {
    const db = new Db(":memory:");
    const asAlice = new FakeAdapter([ev("gh:commit:a", "2026-08-01T00:00:00Z")]);
    asAlice.identity = async () => "fake:alice";
    await runSync({ db, adapters: [asAlice], isRepoDenylisted: () => false, now: NOW });
    expect(db.getState("cursor:fake:alice")).toBe(NOW.toISOString());

    // A different account on the same source starts from scratch, not from alice's cursor.
    const asBob = new FakeAdapter([]);
    asBob.identity = async () => "fake:bob";
    await runSync({ db, adapters: [asBob], isRepoDenylisted: () => false, now: NOW });
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(asBob.calls[0].since.getTime()).toBe(NOW.getTime() - ninetyDays);
    expect(db.getState("cursor:fake:bob")).toBe(NOW.toISOString());
  });

  it("honors an explicit --since over the cursor", async () => {
    const db = new Db(":memory:");
    db.setState("cursor:fake", "2026-08-10T00:00:00Z");
    const adapter = new FakeAdapter([]);

    await runSync({
      db,
      adapters: [adapter],
      isRepoDenylisted: () => false,
      since: new Date("2026-01-01T00:00:00Z"),
      now: NOW,
    });

    expect(adapter.calls[0].since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("drops events from denylisted repos", async () => {
    const db = new Db(":memory:");
    const adapter = new FakeAdapter([
      ev("gh:commit:a", "2026-08-01T00:00:00Z", "me/secret"),
      ev("gh:commit:b", "2026-08-02T00:00:00Z", "me/app"),
    ]);

    const result = await runSync({
      db,
      adapters: [adapter],
      isRepoDenylisted: (repo) => repo === "me/secret",
      now: NOW,
    });

    expect(result.newEvents).toBe(1);
    expect(db.getEvents().map((e) => e.repo)).toEqual(["me/app"]);
  });
});
