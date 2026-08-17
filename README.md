# fetch-my-contributions (`fmc`)

Local-first CLI that turns your real GitHub activity — commits, PRs, and the
reviews you leave on other people's PRs, private repos included — into a
markdown work summary you can bring to 1:1s and review cycles.

Everything runs on your machine. No server, no accounts, no telemetry. The
only thing that ever leaves your machine is the report prompt sent to
OpenRouter, and that is logged verbatim before it goes.

## Setup

```sh
npm install
npm run build && npm link
gh auth login            # skip if gh is already authenticated
export OPENROUTER_API_KEY=sk-or-...
fmc sync && fmc report --since 2026-05-01
```

`GITHUB_TOKEN` / `GH_TOKEN` in the environment work as a fallback when the
`gh` CLI isn't installed. Tokens are read per run and never written to disk.
GitHub Enterprise hosts that `gh` is logged into are picked up automatically.

## Commands

### `fmc sync [--since <date>]`

Pulls your activity into a local SQLite db (`~/.fmc/data.db`):

- commits you authored (message, changed file paths, additions/deletions)
- PRs you opened / merged / closed (title + body)
- reviews and review comments you left on **other people's** PRs

Sync is incremental — a cursor per source means re-runs only fetch the new
window, and already-stored commits/PRs skip their detail fetches. The cursor
only advances when a source completes without error. First run looks back 90
days; use `--since` to backfill further.

Discovery runs through the GraphQL `contributionsCollection` *and* REST
fallbacks (repo listing + issue search), because GitHub can restrict private
contributions in `contributionsCollection` even for your own token.

After fetching, events are grouped into **threads** (units of work) by
deterministic heuristics — shared PR references (0.95), shared issue keys
(0.9), repo+directory overlap within 14 days (0.5). Every link stores the
reason it was made:

```sh
sqlite3 ~/.fmc/data.db "SELECT confidence, reason FROM links LIMIT 10"
```

### `fmc report (--since <date> [--until <date>] | --quarter <YYYYQn>) [--out <file>] [--only <patterns>] [--dry-run]`

Generates the markdown summary via OpenRouter, with sections:

- **What shipped**
- **Reviewed & unblocked for others**
- **Platform & infra work**
- **Gaps — thin evidence** (threads that need better receipts)

The prompt forbids invented impact claims: numbers only appear if they are in
the data (diff stats, PR counts) or in your own check-in answers.

`--quarter 2026Q1` is shorthand for a calendar-quarter window; `--until` sets
an explicit end. GitHub events are windowed strictly, so quarterly reports
don't bleed into each other (check-in notes on surviving threads always ride
along). E.g. quarter-wise review prep:

```sh
for q in 2025Q4 2026Q1 2026Q2; do fmc report --quarter $q --only 'myorg/*'; done
```

`--only` scopes the report to matching repos — e.g. `--only 'myorg/*'` for a
work-only report, keeping personal repos out entirely. Comma-separate multiple
patterns (`'myorg/*,me/side-project'`). Check-in notes on surviving threads are
kept.

`--dry-run` prints the exact prompt and sends nothing — use it to review what
would leave your machine.

### `fmc check-in`

Weekly interactive prompt. For each thread active since your last check-in it
asks: *what did you do here that isn't in the data?* and *did it move a
number?* Answers are stored as first-class `manual` events linked to the
thread, and future reports quote them instead of guessing.

## Configuration — `~/.fmc/config.json`

Created on first run:

```json
{
  "models": {
    "report":   "anthropic/claude-sonnet-4.5",
    "resolve":  "google/gemini-2.5-flash",
    "fallback": "openai/gpt-4o-mini"
  },
  "denylist": []
}
```

- **models** — OpenRouter model per task; swap freely without touching code.
  `fallback` is used when the primary model is unavailable.
- **denylist** — repos that must never be fetched or included in a report:
  `"owner/repo"` exact or `"owner/*"` wildcard.

## Privacy & what leaves your machine

Commit messages from private repos are sensitive, so egress is explicit:

- Before any LLM call the CLI prints how many threads/events/repos are in the
  payload, and writes the exact payload to `~/.fmc/logs/egress-<ts>.txt`.
- Every call's token usage and dollar cost is appended to
  `~/.fmc/logs/usage.jsonl` and printed after each report.
- `sync` and `check-in` never call the LLM at all.
- Secrets come from `gh` or the environment only; nothing is persisted.

## Data model

Three tables designed so new sources (Jira, Linear, Notion, calendar) are new
adapters, not schema changes:

- **events** — one atomic record from any source (`github_commit`,
  `github_pr`, `github_review`, `manual`, ...), with timestamp, repo, title,
  body, extracted refs (issue keys, PR numbers, branches, paths), and raw
  JSON.
- **threads** — a unit of work spanning many events, with a title and a
  first/last-seen span.
- **links** — event → thread, with a confidence score and the human-readable
  reason the link was made.

Adapters implement one interface (`src/adapters/types.ts`):

```ts
interface SourceAdapter {
  name: string;
  fetchEvents(opts: FetchOptions): AsyncIterable<EventRecord>;
}
```

## Development

```sh
npm run dev -- sync        # run from source via tsx
npm test                   # vitest: thread resolution + incremental sync
npm run typecheck
```

Prompts live in `prompts/*.md` — edit them without touching TypeScript.
