import fs from "node:fs";
import type { EventRecord } from "../adapters/types.js";
import type { Config } from "../config.js";
import { isDenylisted, repoMatches } from "../config.js";
import type { Db, Thread } from "../db.js";
import { Llm, renderPrompt, type CompleteResult } from "../llm.js";

// Keep the evidence payload well inside every provider's context window
// (~250K chars ≈ 60-70K tokens). Bigger windows compact, then chunk+merge.
const MAX_EVIDENCE_CHARS = 250_000;

// Progressive compaction: body truncation limits and per-thread event caps.
const LEVELS = [
  { prBody: 1500, body: 700, maxEvents: Number.POSITIVE_INFINITY },
  { prBody: 500, body: 250, maxEvents: 8 },
  { prBody: 250, body: 100, maxEvents: 5 },
] as const;

type LinkedEvent = EventRecord & { confidence: number; reason: string };

interface ThreadEvidence {
  title: string;
  span: string;
  thin: boolean;
  omitted_events?: number;
  events: Array<Record<string, unknown>>;
}

export interface ReportOptions {
  db: Db;
  config: Config;
  since: Date;
  /** Window end, inclusive. Defaults to now. */
  until?: Date;
  out?: string;
  dryRun: boolean;
  /** Restrict to repos matching these patterns ("owner/repo" or "owner/*"). */
  only?: string[];
  now?: Date;
}

export async function runReport(opts: ReportOptions): Promise<void> {
  const now = opts.now ?? new Date();
  const sinceIso = opts.since.toISOString();
  const untilIso = (opts.until ?? now).toISOString();
  const threads = opts.db.getThreadsWithEvents(sinceIso);
  const only = opts.only;

  const pairs: Array<{ thread: Thread; kept: LinkedEvent[] }> = [];
  const repos = new Set<string>();
  let eventCount = 0;
  for (const { thread, events } of threads) {
    let kept = events.filter((e) => !isDenylisted(e.repo, opts.config.denylist));
    // Strict window for GitHub events so quarter reports don't bleed into each
    // other; manual check-in notes ride along (they're often recorded later).
    kept = kept.filter(
      (e) =>
        e.source === "manual" ||
        (e.timestamp >= sinceIso && e.timestamp <= untilIso)
    );
    if (!kept.some((e) => e.source !== "manual")) continue;
    if (only && only.length > 0) {
      // Scope by repo; a thread stays only if it has in-scope GitHub events.
      // Manual check-in notes (repo: null) ride along with a surviving thread.
      const inScope = kept.filter(
        (e) => e.repo !== null && repoMatches(e.repo, only)
      );
      if (inScope.length === 0) continue;
      kept = [...inScope, ...kept.filter((e) => e.repo === null)];
    }
    if (kept.length === 0) continue;
    for (const e of kept) if (e.repo) repos.add(e.repo);
    eventCount += kept.length;
    pairs.push({ thread, kept });
  }

  if (pairs.length === 0) {
    console.error(
      `No threads with activity in ${sinceIso.slice(0, 10)}..${untilIso.slice(0, 10)}. Run \`fmc sync\` first.`
    );
    process.exitCode = 1;
    return;
  }

  // Compact until the evidence fits, then chunk whatever still doesn't.
  let level = 0;
  let evidence = pairs.map((p) => threadEvidence(p.thread, p.kept, level));
  while (evidenceSize(evidence) > MAX_EVIDENCE_CHARS && level < LEVELS.length - 1) {
    level++;
    evidence = pairs.map((p) => threadEvidence(p.thread, p.kept, level));
  }
  if (level > 0) {
    console.error(
      `evidence compacted (level ${level}: tighter truncation, ≤${LEVELS[level].maxEvents} events/thread)`
    );
  }
  const chunks = chunkEvidence(evidence, MAX_EVIDENCE_CHARS);

  console.error(
    `→ report input: ${evidence.length} threads, ${eventCount} events from repos [${[...repos].join(", ")}]` +
      (chunks.length > 1 ? ` in ${chunks.length} chunks` : "")
  );

  const since = sinceIso.slice(0, 10);
  const until = untilIso.slice(0, 10);
  const chunkPrompts = chunks.map((c, i) =>
    renderPrompt("report", {
      since,
      until,
      evidence:
        (chunks.length > 1
          ? `NOTE: this is part ${i + 1} of ${chunks.length}; other parts are summarized separately and merged later.\n\n`
          : "") + JSON.stringify(c, null, 1),
    })
  );

  if (opts.dryRun) {
    console.error("--dry-run: printing the exact prompt(s), sending nothing.\n");
    chunkPrompts.forEach((p, i) => {
      if (chunkPrompts.length > 1)
        console.log(`\n${"=".repeat(30)} CHUNK ${i + 1}/${chunkPrompts.length} ${"=".repeat(30)}\n`);
      console.log(p);
    });
    if (chunkPrompts.length > 1) {
      console.error(
        `\n(then one merge call combines the ${chunkPrompts.length} partial reports — template: prompts/report-merge.md)`
      );
    }
    return;
  }

  const llm = new Llm(opts.config);
  const results: CompleteResult[] = [];
  let text: string;
  if (chunkPrompts.length === 1) {
    const r = await llm.complete(chunkPrompts[0], { task: "report", maxTokens: 8192 });
    results.push(r);
    text = r.text;
  } else {
    const partials: string[] = [];
    for (const [i, prompt] of chunkPrompts.entries()) {
      console.error(`chunk ${i + 1}/${chunkPrompts.length}:`);
      const r = await llm.complete(prompt, { task: "report", maxTokens: 4096 });
      results.push(r);
      partials.push(r.text);
    }
    console.error("merging partial reports:");
    const merged = await llm.complete(
      renderPrompt("report-merge", {
        since,
        until,
        partials: partials
          .map((p, i) => `## Partial report ${i + 1}\n\n${p}`)
          .join("\n\n---\n\n"),
      }),
      { task: "report", maxTokens: 8192 }
    );
    results.push(merged);
    text = merged.text;
  }

  const outFile = opts.out ?? `report-${since}-${until}.md`;
  fs.writeFileSync(outFile, text.trimEnd() + "\n");
  console.error(`wrote ${outFile}`);
  const prompt = results.reduce((s, r) => s + r.usage.promptTokens, 0);
  const completion = results.reduce((s, r) => s + r.usage.completionTokens, 0);
  const costs = results.map((r) => r.costUsd).filter((c): c is number => c != null);
  console.error(
    `cost: ${prompt} prompt + ${completion} completion tokens over ${results.length} call(s) on ${results[results.length - 1].model}` +
      (costs.length > 0 ? ` ≈ $${costs.reduce((a, b) => a + b, 0).toFixed(4)}` : "")
  );
}

function evidenceSize(evidence: ThreadEvidence[]): number {
  return JSON.stringify(evidence, null, 1).length;
}

/** Split threads into batches that each fit the budget. Order is preserved. */
function chunkEvidence(
  evidence: ThreadEvidence[],
  maxChars: number
): ThreadEvidence[][] {
  const chunks: ThreadEvidence[][] = [];
  let current: ThreadEvidence[] = [];
  let size = 0;
  for (const t of evidence) {
    const s = JSON.stringify(t, null, 1).length + 2;
    if (current.length > 0 && size + s > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function threadEvidence(
  thread: Thread,
  events: LinkedEvent[],
  level: number
): ThreadEvidence {
  const limits = LEVELS[level];
  const reviewOnly = events.every((e) => e.source === "github_review");
  const hasMergedPr = events.some(
    (e) =>
      e.source === "github_pr" &&
      (e.raw as { merged?: boolean } | null)?.merged === true
  );
  const hasManual = events.some((e) => e.source === "manual");

  // When capping, PRs and check-in notes carry the most signal; keep the
  // most recent of the rest.
  let picked = events;
  let omitted = 0;
  if (events.length > limits.maxEvents) {
    const priority = events.filter(
      (e) => e.source === "github_pr" || e.source === "manual"
    );
    const rest = events
      .filter((e) => e.source !== "github_pr" && e.source !== "manual")
      .slice(-(Math.max(0, limits.maxEvents - priority.length)));
    picked = [...priority.slice(0, limits.maxEvents), ...rest].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );
    omitted = events.length - picked.length;
  }

  return {
    title: thread.title,
    span: `${thread.first_seen.slice(0, 10)}..${thread.last_seen.slice(0, 10)}`,
    thin: !reviewOnly && !hasMergedPr && !hasManual,
    ...(omitted > 0 ? { omitted_events: omitted } : {}),
    events: picked.map((e) => {
      const stats =
        e.source === "github_commit"
          ? (e.raw as { stats?: { additions?: number; deletions?: number } })
              ?.stats
          : e.source === "github_pr"
            ? pick(e.raw as Record<string, unknown>, [
                "additions",
                "deletions",
                "changedFiles",
              ])
            : undefined;
      return compact({
        type: e.source,
        date: e.timestamp.slice(0, 10),
        repo: e.repo,
        title: e.title,
        body: truncate(
          e.body,
          e.source === "github_pr" ? limits.prBody : limits.body
        ),
        stats,
        refs: compact({
          issues: emptyToUndef(e.refs.issueKeys),
          prs: emptyToUndef(e.refs.prNumbers),
          dirs: emptyToUndef(topDirs(e.refs.paths)),
        }),
        linked_because: e.reason,
      });
    }),
  };
}

function topDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    dirs.add(parts.length < 2 ? p : parts.slice(0, 2).join("/"));
  }
  return [...dirs].slice(0, 15);
}

function truncate(s: string | null, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

function emptyToUndef<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

function pick(
  obj: Record<string, unknown> | null,
  keys: string[]
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (
      v === undefined ||
      v === null ||
      (typeof v === "object" && v !== null && Object.keys(v).length === 0)
    ) {
      delete obj[k];
    }
  }
  return obj;
}
