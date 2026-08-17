#!/usr/bin/env node
import { Command } from "commander";
import { GitHubAdapter } from "./adapters/github/index.js";
import { resolveAuth } from "./auth.js";
import { isDenylisted, loadConfig } from "./config.js";
import { Db } from "./db.js";
import { dbPath, ensureDirs } from "./paths.js";
import { runCheckin } from "./commands/checkin.js";
import { runReport } from "./commands/report.js";
import { runSync } from "./commands/sync.js";

function parseDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${value}". Use e.g. 2026-05-01.`);
  }
  return d;
}

function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
}

/** "2026Q1", "2026-Q1", "2026 q3" → calendar-quarter window (UTC, inclusive). */
function parseQuarter(value: string): { since: Date; until: Date } {
  const m = value.trim().match(/^(\d{4})[-\s]?[Qq]([1-4])$/);
  if (!m) {
    throw new Error(`Invalid quarter: "${value}". Use e.g. 2026Q1.`);
  }
  const year = Number(m[1]);
  const q = Number(m[2]);
  return {
    since: new Date(Date.UTC(year, (q - 1) * 3, 1)),
    until: new Date(Date.UTC(year, q * 3, 1) - 1),
  };
}

function openDb(): Db {
  ensureDirs();
  return new Db(dbPath());
}

const program = new Command("fmc")
  .description(
    "Local-first work summaries from your real GitHub activity. Data stays in ~/.fmc."
  )
  .version("0.1.0");

program
  .command("sync")
  .description("Pull commits, PRs, and reviews from GitHub into the local db")
  .option("--since <date>", "fetch from this date instead of the stored cursor")
  .action(async (opts: { since?: string }) => {
    const config = loadConfig();
    const auths = resolveAuth();
    const db = openDb();
    try {
      const result = await runSync({
        db,
        adapters: auths.map((a) => new GitHubAdapter(a)),
        isRepoDenylisted: (repo) => isDenylisted(repo, config.denylist),
        since: opts.since ? parseDate(opts.since) : undefined,
        log: (m) => console.error(m),
      });
      const parts = Object.entries(result.bySource)
        .map(([s, n]) => `${n} ${s.replace("github_", "")}`)
        .join(", ");
      console.log(
        `\nsync done: ${result.newEvents} new event(s)${parts ? ` (${parts})` : ""}, ${result.threadsTouched} thread(s) touched`
      );
      if (result.failedAdapters.length > 0) {
        console.error(
          `some sources failed: ${result.failedAdapters.join(", ")} — re-run to retry`
        );
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
  });

program
  .command("report")
  .description("Generate a markdown work summary from stored events")
  .option("--since <date>", "report window start")
  .option("--until <date>", "report window end (inclusive, default: today)")
  .option(
    "--quarter <q>",
    'report a calendar quarter, e.g. "2026Q1" (instead of --since/--until)'
  )
  .option("--out <file>", "output file (default report-<since>-<until>.md)")
  .option(
    "--only <patterns>",
    'restrict to repos, comma-separated: "innoctive/*" or "owner/repo"'
  )
  .option(
    "--dry-run",
    "print exactly what would be sent to the LLM, send nothing",
    false
  )
  .action(async (opts: {
    since?: string;
    until?: string;
    quarter?: string;
    out?: string;
    only?: string;
    dryRun: boolean;
  }) => {
    let since: Date;
    let until: Date | undefined;
    if (opts.quarter) {
      if (opts.since || opts.until) {
        throw new Error("--quarter cannot be combined with --since/--until.");
      }
      ({ since, until } = parseQuarter(opts.quarter));
    } else if (opts.since) {
      since = parseDate(opts.since);
      until = opts.until ? endOfDay(parseDate(opts.until)) : undefined;
    } else {
      throw new Error("Provide --since <date> or --quarter <YYYYQn>.");
    }
    const db = openDb();
    try {
      await runReport({
        db,
        config: loadConfig(),
        since,
        until,
        out: opts.out,
        only: opts.only
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        dryRun: opts.dryRun,
      });
    } finally {
      db.close();
    }
  });

program
  .command("check-in")
  .description("Interactive weekly check-in: add context the data can't show")
  .action(async () => {
    const db = openDb();
    try {
      await runCheckin({ db });
    } finally {
      db.close();
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
