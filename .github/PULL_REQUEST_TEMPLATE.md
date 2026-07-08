## What & why

<!-- Summary of the change and the reason it exists. -->

## Checks

- [ ] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm test` pass
- [ ] Docs updated in the SAME PR where behavior they describe changed
      (`docs/FEATURES.md` row updated/deleted; ARCHITECTURE/README where relevant)
- [ ] If `CLAUDEXOR_BIBLE.md` changed: the commit carries a
      `CONCEPT-CHANGE(INV-xxx)` marker approved by the maintainer
- [ ] No secrets, tokens, or machine-local paths in the diff
