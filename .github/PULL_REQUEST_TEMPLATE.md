## What changed and why

<!-- One or two sentences. Link the issue this addresses, if any. -->

## How was this tested?

<!-- Paste the relevant output, or describe manual steps (e.g. ran `fmc sync`
against a real account with FMC_HOME pointed at a scratch dir). -->

```
npm test
npm run typecheck
```

## Checklist

- [ ] Tests added/updated for the behavior changed (`test/resolve.test.ts` /
      `test/sync.test.ts` if thread resolution or sync semantics changed)
- [ ] `npm test` and `npm run typecheck` pass locally
- [ ] `README.md` updated if user-facing behavior changed (flags, commands, config)
- [ ] `CLAUDE.md` updated if an architectural invariant changed
