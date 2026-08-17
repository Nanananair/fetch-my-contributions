import { describe, expect, it } from "vitest";
import type { EventRecord, EventRefs } from "../src/adapters/types.js";
import { extractTextRefs } from "../src/adapters/types.js";
import { resolveThreads } from "../src/threads/resolve.js";

function ev(overrides: Partial<EventRecord> & { id: string }): EventRecord {
  const refs: EventRefs = {
    issueKeys: [],
    prNumbers: [],
    branches: [],
    paths: [],
    ...overrides.refs,
  };
  return {
    source: "github_commit",
    timestamp: "2026-08-01T12:00:00Z",
    repo: "me/app",
    title: overrides.id,
    body: null,
    raw: null,
    ...overrides,
    refs,
  };
}

describe("resolveThreads", () => {
  it("links commits and reviews to the PR thread they reference", () => {
    const pr = ev({
      id: "gh:pr:1",
      source: "github_pr",
      title: "PR #42: Spot auctions v1 [merged]",
      timestamp: "2026-08-02T10:00:00Z",
      refs: { issueKeys: [], prNumbers: [42], branches: ["spot-auctions"], paths: [] },
    });
    const commit = ev({
      id: "gh:commit:a",
      title: "fix rounding (#42)",
      refs: { issueKeys: [], prNumbers: [42], branches: [], paths: [] },
    });
    const review = ev({
      id: "gh:review:r1",
      source: "github_review",
      refs: { issueKeys: [], prNumbers: [42], branches: [], paths: [] },
    });

    const out = resolveThreads({ existing: [], unlinked: [pr, commit, review] });

    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].title).toBe("Spot auctions v1");
    expect(out.links).toHaveLength(3);

    const prLink = out.links.find((l) => l.event_id === "gh:pr:1")!;
    expect(prLink.confidence).toBe(1.0);
    expect(prLink.reason).toBe("seed event");

    const commitLink = out.links.find((l) => l.event_id === "gh:commit:a")!;
    expect(commitLink.thread_id).toBe(prLink.thread_id);
    expect(commitLink.confidence).toBe(0.95);
    expect(commitLink.reason).toBe("references PR me/app#42");
  });

  it("does not join same PR number across different repos", () => {
    const pr = ev({
      id: "gh:pr:1",
      source: "github_pr",
      repo: "me/app",
      refs: { issueKeys: [], prNumbers: [7], branches: [], paths: [] },
    });
    const commit = ev({
      id: "gh:commit:b",
      repo: "me/other",
      refs: { issueKeys: [], prNumbers: [7], branches: [], paths: [] },
    });

    const out = resolveThreads({ existing: [], unlinked: [pr, commit] });
    expect(out.threads).toHaveLength(2);
  });

  it("groups events sharing an issue key, across repos", () => {
    const a = ev({
      id: "gh:commit:a",
      repo: "me/app",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [], branches: [], paths: [] },
    });
    const b = ev({
      id: "gh:commit:b",
      repo: "me/infra",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [], branches: [], paths: [] },
    });

    const out = resolveThreads({ existing: [], unlinked: [a, b] });
    expect(out.threads).toHaveLength(1);
    const link = out.links.find((l) => l.event_id === "gh:commit:b")!;
    expect(link.confidence).toBe(0.9);
    expect(link.reason).toBe("shared issue key PROJ-9");
  });

  it("groups by repo + directory overlap within the time window", () => {
    const a = ev({
      id: "gh:commit:a",
      timestamp: "2026-08-01T00:00:00Z",
      refs: { issueKeys: [], prNumbers: [], branches: [], paths: ["src/billing/x.ts"] },
    });
    const b = ev({
      id: "gh:commit:b",
      timestamp: "2026-08-10T00:00:00Z",
      refs: { issueKeys: [], prNumbers: [], branches: [], paths: ["src/billing/y.ts"] },
    });

    const out = resolveThreads({ existing: [], unlinked: [a, b] });
    expect(out.threads).toHaveLength(1);
    const link = out.links.find((l) => l.event_id === "gh:commit:b")!;
    expect(link.confidence).toBe(0.5);
    expect(link.reason).toBe("repo+dir overlap (src/billing) within 14d");
  });

  it("does NOT group directory overlap outside the time window", () => {
    const a = ev({
      id: "gh:commit:a",
      timestamp: "2026-01-01T00:00:00Z",
      refs: { issueKeys: [], prNumbers: [], branches: [], paths: ["src/billing/x.ts"] },
    });
    const b = ev({
      id: "gh:commit:b",
      timestamp: "2026-08-10T00:00:00Z",
      refs: { issueKeys: [], prNumbers: [], branches: [], paths: ["src/billing/y.ts"] },
    });

    const out = resolveThreads({ existing: [], unlinked: [a, b] });
    expect(out.threads).toHaveLength(2);
  });

  it("attaches new events to existing threads from a previous run", () => {
    const seed = ev({
      id: "gh:pr:1",
      source: "github_pr",
      title: "PR #42: Spot auctions v1 [merged]",
      timestamp: "2026-08-02T10:00:00Z",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [42], branches: [], paths: [] },
    });
    const existingThread = {
      id: "thread:gh:pr:1",
      title: "Spot auctions v1",
      summary: null,
      first_seen: seed.timestamp,
      last_seen: seed.timestamp,
    };
    const late = ev({
      id: "gh:commit:late",
      timestamp: "2026-08-05T10:00:00Z",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [], branches: [], paths: [] },
    });

    const out = resolveThreads({
      existing: [{ thread: existingThread, events: [seed] }],
      unlinked: [late],
    });

    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].id).toBe("thread:gh:pr:1");
    expect(out.threads[0].last_seen).toBe("2026-08-05T10:00:00Z");
    expect(out.links[0].reason).toBe("shared issue key PROJ-9");
  });

  it("retitles a commit-seeded thread when its PR shows up", () => {
    const commit = ev({
      id: "gh:commit:a",
      title: "wip auctions",
      timestamp: "2026-08-01T00:00:00Z",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [], branches: [], paths: [] },
    });
    const pr = ev({
      id: "gh:pr:1",
      source: "github_pr",
      title: "PR #42: Spot auctions v1 [merged]",
      timestamp: "2026-08-03T00:00:00Z",
      refs: { issueKeys: ["PROJ-9"], prNumbers: [42], branches: [], paths: [] },
    });

    // Commit synced first (previous run), PR arrives later.
    const first = resolveThreads({ existing: [], unlinked: [commit] });
    const out = resolveThreads({
      existing: [{ thread: first.threads[0], events: [commit] }],
      unlinked: [pr],
    });

    expect(out.threads[0].title).toBe("Spot auctions v1");
  });
});

describe("extractTextRefs", () => {
  it("finds issue keys and PR numbers, ignores plain words", () => {
    const { issueKeys, prNumbers } = extractTextRefs(
      "PROJ-12: fix flakiness (#345)\nRelates to INFRA-7 and #345 again"
    );
    expect(issueKeys).toEqual(["PROJ-12", "INFRA-7"]);
    expect(prNumbers).toEqual([345]);
  });

  it("does not treat UUID-like fragments as issue keys", () => {
    expect(extractTextRefs("bump to v2-31").issueKeys).toEqual([]);
  });
});
