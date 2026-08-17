# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev -- sync                 # run any subcommand from source via tsx (no build)
npm run dev -- report --since 2026-05-01 --dry-run
npm test                            # vitest run (test/*.test.ts)
npx vitest run test/resolve.test.ts  # single file
npx vitest run -t "links commits"    # single test by name
npm run typecheck                   # tsc --noEmit
npm run build && npm link            # only needed to exercise the real `fmc` binary
```

`bin.fmc` points at `dist/cli.js`, and `dist/` is gitignored — a linked `fmc` runs stale code until you re-`npm run build`. Prefer `npm run dev --` while iterating.

Runtime needs: `gh auth login` (or `GITHUB_TOKEN`/`GH_TOKEN`) for `sync`, and `OPENROUTER_API_KEY` for `report`. `sync` and `check-in` never call the LLM.

Set `FMC_HOME` to point the data dir somewhere disposable when testing anything that touches `~/.fmc` (db, config, egress logs).

## Architecture

Pipeline: **adapters → events → threads → report**. Everything is local; `~/.fmc/data.db` (SQLite via better-sqlite3, WAL) is the only state.

**Three tables, source-agnostic** (`src/db.ts`): `events` (one atomic record from any source), `threads` (a unit of work), `links` (event→thread with `confidence` + human-readable `reason`). New sources are new adapters, never schema changes. The `reason` column exists so groupings can be audited with plain SQL — preserve it.

**Adapters** (`src/adapters/types.ts`) implement `SourceAdapter`: an async-iterable `fetchEvents`, plus optional `identity()` used as the incremental-sync cursor key. `identity()` must include the authenticated user (`github:github.com:alice`) so switching accounts never reuses another account's cursor.

Event ids are natural and stable (`gh:commit:<sha>`, `gh:pr:<node_id>`, `gh:review:<id>`, `manual:<uuid>`); dedupe is `INSERT OR IGNORE` on that id. On GHE hosts the prefix becomes `gh:<host>:` so ids stay unique across hosts. Because re-inserting is free, sync re-fetches a 1-day overlap window and adapters can safely yield duplicates.

**`runSync`** (`src/commands/sync.ts`) is deliberately separated from CLI wiring so tests drive it with `new Db(":memory:")` and a fake adapter. Two invariants the tests pin down: a cursor advances **only** after its adapter completes without error (a mid-stream failure keeps events already received but leaves the cursor put), and one adapter's failure never blocks the others. Thread resolution runs once after all adapters, in a single transaction.

**Thread resolution** (`src/threads/resolve.ts`) is deterministic — no LLM. Priority order per unlinked event: shared PR ref in the same repo (0.95) → shared issue key (0.9) → same repo + top-two-segment directory overlap within 14 days (0.5) → seed a new thread (1.0). Events are processed PR-first so PRs establish threads that commits and reviews then attach to. Changing these heuristics changes existing users' groupings; `test/resolve.test.ts` is the contract.

**GitHub adapter** (`src/adapters/github/`) uses GraphQL `contributionsCollection` for cheap bulk discovery **and** REST fallbacks (repo listing for commits, issue search for PRs/reviews) for everything. This redundancy is load-bearing: `contributionsCollection` silently restricts private contributions even for the viewer's own token. The union dedupes by natural id, and `opts.hasEvent(id)` skips expensive per-item detail fetches. `contributionsCollection` accepts at most a 1-year window, hence `windows()`. Only reviews on *other people's* PRs count as review work. Per-repo/per-item failures warn via `onProgress` and continue rather than aborting the sync.

**LLM** (`src/llm.ts`) is the only module that talks to a provider (OpenRouter via the `openai` SDK). It owns 429 backoff (`maxRetries: 0` on the client keeps retry policy in one place) and falls back to `config.models.fallback` when the primary model is unavailable. Prompts are `prompts/*.md` with `{{placeholder}}` substitution via `renderPrompt` — edit prompts without touching TypeScript. Placeholder validation runs against the *template*, not substituted values, since evidence data legitimately contains braces.

**Report** (`src/commands/report.ts`) shapes evidence JSON, never prose. It applies progressive compaction (`LEVELS`: tighter body truncation + per-thread event caps, keeping PRs and check-in notes first) until it fits `MAX_EVIDENCE_CHARS`, then chunks and does a merge call (`prompts/report-merge.md`). GitHub events are windowed strictly so quarterly reports don't bleed; `manual` check-in notes ride along with a surviving thread regardless of date.

## Constraints worth preserving

**Egress is explicit.** Private commit messages are sensitive. Every LLM payload is written verbatim to `~/.fmc/logs/egress-<ts>.txt` *before* the call, token/cost usage is appended to `usage.jsonl`, and `--dry-run` must print exactly what would be sent. Don't add an LLM call that bypasses `Llm.complete()`.

**Denylist filters twice** — at fetch time and again at report time (`isDenylisted` in both `runSync` and `runReport`). A denylisted repo already in the db must still never reach a prompt, so keep both checks.

**No invented impact.** The report prompt forbids numbers that aren't in the data (diff stats, PR counts) or in the user's own check-in answers. `thin: true` marks threads with weak evidence instead of embellishing them.

**Secrets are never persisted** — read per run from `gh` or the environment (`src/auth.ts`).

Stdout is the artifact (report text, dry-run prompt); progress, warnings, and cost go to stderr via `console.error`.
