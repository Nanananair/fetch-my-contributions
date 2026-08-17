# Contributing to fmc

Thanks for taking a look. `fmc` is a small, local-first CLI — most changes
are self-contained and don't need much ceremony, but a few invariants keep
the data model and privacy guarantees intact, so read on before diving in.

## Setup

```sh
npm install
npm run dev -- sync                 # run any subcommand from source via tsx, no build needed
npm test                            # vitest run (test/*.test.ts)
npm run typecheck                   # tsc --noEmit
```

`npm run dev --` is the fast loop — it runs straight from `src/` via `tsx`.
You only need `npm run build && npm link` if you want to exercise the real
`fmc` binary; `dist/` is gitignored and goes stale the moment you edit `src/`
without rebuilding.

**Runtime prerequisites** (only needed for the commands that use them):
- `gh auth login` (or `GITHUB_TOKEN`/`GH_TOKEN` in the environment) for `fmc sync`
- `OPENROUTER_API_KEY` for `fmc report`
- `fmc sync` and `fmc check-in` never call an LLM, so you can develop and test
  most of the codebase without an OpenRouter key

**Sandbox your data dir.** Set `FMC_HOME` to point `~/.fmc` (db, config,
egress logs) somewhere disposable while testing, so you don't touch your own
synced data:

```sh
FMC_HOME=/tmp/fmc-dev npm run dev -- sync
```

## Before you write code

Read [`CLAUDE.md`](./CLAUDE.md) first. It documents the architecture
(adapters → events → threads → report) and, more importantly, the invariants
that PRs are expected to preserve — things like:

- new data sources are new adapters, never schema changes
- thread-resolution heuristics are pinned by `test/resolve.test.ts`; changing
  them changes existing users' groupings
- a sync cursor only advances after its adapter completes without error
- the denylist is checked at both fetch time and report time
- every LLM call goes through `Llm.complete()` so egress logging can't be
  bypassed
- reports never invent numbers that aren't in the underlying data

If your change touches one of these areas, say so in the PR description and
make sure the relevant test file still encodes the behavior.

## Making a change

1. Fork and clone, then run the setup above.
2. Make your change. Prefer `npm run dev --` over building while iterating.
3. Add or update tests — `test/resolve.test.ts` and `test/sync.test.ts` are
   the closest thing this project has to a spec for thread resolution and
   incremental sync. If you're not sure whether a change needs a test,
   assume it does.
4. Run `npm test` and `npm run typecheck` before opening a PR.
5. Update `README.md` if you changed user-facing behavior (a flag, a
   command, config shape), and `CLAUDE.md` if you changed an architectural
   invariant.

## Commit style

Short, imperative summary lines, similar to the existing log
(`git log --oneline`) — e.g. "sync: retry transient GraphQL errors" rather
than "Fixed a bug" or "Updates".

## Opening a PR

Use the PR template — it asks what changed, why, and how you tested it.
Small, focused PRs are easier to review than ones that bundle unrelated
changes; if you find yourself fixing something unrelated along the way,
consider splitting it into its own PR.

## Reporting issues

Open a GitHub issue. For bugs, include the `fmc` command you ran and the
error/output — most issues here involve GitHub API edge cases, so the exact
command and repo visibility (public/private/org) matters.

Issues labeled `good first issue` are scoped intentionally small and are a
good place to start.
