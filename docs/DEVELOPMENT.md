# Developing Claudexor

This document is for contributors changing Claudexor itself. It is not a guide for
using Claudexor on a target project. User-facing behavior belongs in the README
and the current runtime map belongs in `docs/ARCHITECTURE.md`.

Read these together before changing shared behavior:

- `CLAUDEXOR_BIBLE.md` - product and engineering invariants.
- `docs/ARCHITECTURE.md` - current package map, run flow, artifacts, and
  control API.
- `docs/DESIGN_SYSTEM.md` - macOS visual and interaction contract.
- `docs/CHECKLISTS.md` - human gates for reviews, releases, docs, visual QA,
  and security.

## Repository Shape

- `packages/schema` owns Zod schemas, TypeScript types, and generated JSON
  Schema. Change data contracts here first.
- `packages/core` owns adapter contracts, process helpers, typed errors, and
  the minimal single-harness execution path.
- `packages/orchestrator` owns higher-level modes such as Ask, Explore, Agent,
  Best-of-N, convergence, Plan, Create, and Read-only Audit.
- `packages/gateway` owns harness discovery, doctor output, and capability
  gating.
- `packages/harness-*` translate native CLI/API streams into typed events. They
  do not select winners, manage budgets, or decide review policy.
- `packages/workspace` owns worktree envelopes, scoped harness homes, diff
  capture, and cleanup.
- `packages/review`, `packages/arbitration`, `packages/synthesis`,
  `packages/budget`, `packages/secrets`, and `packages/delivery` own their
  named control-plane subsystems.
- `packages/cli`, `packages/daemon`, `packages/control-api`,
  `packages/mcp-server`, `packages/acp-server`, and `apps/macos` are surfaces.
  Keep them thin.

## Development Commands

Use the repository package manager and keep generated schema output checked.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
```

There is no root `pnpm lint` script at the moment. `pnpm format:check` checks
Prettier formatting when a formatting pass is relevant.

macOS app checks:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift build
```

Release verification is wrapped by:

```bash
pnpm release:verify
```

It runs Node/schema checks, Swift build/test checks, and unsigned app packaging.

## Schema-First Workflow

Any change to modes, DTOs, artifacts, events, config, run control, auth,
routing, review, or delivery must start in `packages/schema`.

1. Update the schema and exported types.
2. Regenerate JSON Schema with `pnpm schema:gen`.
3. Update TypeScript consumers.
4. Update Swift DTOs when the control API payload changes.
5. Update README, Architecture, Integrations, Design System, or app docs when
   behavior changes.
6. Add or update focused tests for the behavior.

Do not fork contracts in UI code, CLI parsing, adapter output, or docs.

## Boundaries

- Adapters translate I/O only. They never orchestrate.
- Surfaces call the engine/control plane. They do not create app-only semantics.
- Routing and capability decisions come from Gateway/doctor/capability data.
- Discovery can describe static capabilities and auth source availability, but
  readiness comes from doctor status, enabled intents, and smoke/conformance
  checks. Do not route, mark Auth UI ready, or select reviewers from source
  availability alone.
- Diffs come from git in the target workspace or envelope.
- Files and typed artifacts are the source of truth; terminal text and UI rows
  are projections.
- Unknown modes, invalid config, unavailable harnesses, stale reviews, malformed
  artifacts, and missing required context should fail loudly.

## Public Docs Discipline

Public docs describe current product truth, current contributor workflow, or
current integration surfaces. They must not store private planning packets,
review transcripts, local operator notes, local paths, token handling details, or
one-off release scratch.

Use this split:

- `README.md`: product entrypoint and detailed quickstart.
- `CLAUDEXOR_BIBLE.md`: compact product constitution.
- `docs/ARCHITECTURE.md`: current runtime and package map.
- `docs/INTEGRATIONS.md`: current external integration surfaces and limitations.
- `docs/DESIGN_SYSTEM.md`: macOS UI/UX contract.
- `docs/DEVELOPMENT.md`: developing Claudexor itself.
- `docs/CHECKLISTS.md`: human gates for changes and releases.
- `apps/macos/README.md`: macOS app contributor notes.

Local operator guidance belongs in gitignored local files such as `AGENTS.md`.
Temporary adversarial review packets and release scratch belong outside public
docs. Review gates must be file-backed and diagnosable: persist local/redacted
per-reviewer artifacts and progress events, and point reviewers at evidence
files instead of embedding large diffs in process argv.
