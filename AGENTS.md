# AGENTS.md — Claudex

Guidance for any agent (or human) working in this repository. This is the portable, tool-agnostic instruction file (read by Codex, Claude Code, Cursor, OpenCode, etc.).

## What this is

Claudex is a harness-agnostic AI coding control plane. It orchestrates external coding harnesses (Codex/Claude/Cursor/OpenCode) behind one `ExecutionEngine`. See [docs/SPEC.md](docs/SPEC.md) for the full design and [docs/PLAN.md](docs/PLAN.md) for the build sequence.

## Project shape

- pnpm + Turborepo monorepo. Source lives under `packages/*`. TypeScript, ESM, Node LTS.
- `packages/schema` is the **single source of truth** for all data shapes (Zod → generated JSON Schema). Everything else imports types from there. Do not define competing shapes elsewhere.
- Surfaces (CLI, daemon, MCP server, ACP server, plugins) hold **no business logic** — they call `@claudex/core`'s `ExecutionEngine`.
- Adapters (`packages/harness-*`) **never** contain orchestration logic; they only translate a native harness's I/O to typed Claudex events.

## Build / test / check

```bash
pnpm install
pnpm build        # turbo run build
pnpm typecheck    # tsc -b / tsc --noEmit across packages
pnpm test         # vitest
pnpm lint
```

Local Node note: on macOS 26.4 the code-signing monitor SIGKILLs Homebrew's adhoc-signed node. Use an official notarized Node (e.g. installed under `~/.claudex/node`) on PATH. CI uses standard Ubuntu Node.

## Non-negotiable engineering principles

- **SOLID / DRY / SSOT.** One reason to change per module; shapes only in `packages/schema`.
- **Fail loudly.** Use typed errors (`AdapterParseError`, `HarnessUnavailableError`, `PolicyDeniedError`, `BudgetExhaustedError`, `ReviewStaleError`, `ContextOverflowError`, …). No broad swallow-and-continue.
- **No silent truncation.** Account for omitted context explicitly; never `slice(0, N)` away content silently.
- **No regex governance.** Decisions (risk, validity of a finding, winner, tests-passed) use typed events / exit codes / AST / structured artifacts — never keyword regex over human text.
- **Evidence-grounded.** No `file:line`/diff/command/log evidence → a finding cannot BLOCK.
- **Meta over patch.** Prefer the root-cause / smaller-surface fix over patching the last error.
- **Strict TS**, exhaustive discriminated unions, no implicit `any`.

## Conventions

- Conventional-ish commit messages: `feat: …`, `fix: …`, `chore: …`, `docs: …`, `test: …`, prefixed with the phase where useful.
- Each package: `src/`, `src/index.ts` barrel, `*.test.ts` colocated, `package.json` with `"type": "module"`, `tsconfig.json` extending the base.
- Keep modules focused; extract before they sprawl. No giant `if harness === ...` chains — use the adapter registry.
