# Claudex v0.3.0 Beta Plan

Status: locked implementation plan
Target release: `v0.3.0 beta`
Source of truth for this milestone: this file plus `CLAUDEX_BIBLE.md` and `docs/ARCHITECTURE.md`

This plan intentionally preserves a large amount of context. The release is a
conceptual correction pass, not just a visual patch. Future implementers,
subagents, and adversarial reviewers must not shrink the scope by forgetting the
user-approved decisions and rationale.

## Why This Release Exists

The user found several serious issues within seconds of trying `v0.2.0`:

- onboarding exposes API-key fields but no native login/OAuth-style setup path;
- black or white jagged side artifacts appear around Liquid Glass surfaces;
- animations can look choppy, especially sidebar collapse/expand;
- a simple request can fail and the UI does not clearly show what failed, where
  logs are, or what to do next;
- Cursor/OpenCode can be selected even when they are not installed/configured;
- mode controls such as `Ask` lack hover help;
- Settings is mostly informational and not real preferences;
- the Settings header overlaps the macOS traffic-light/titlebar area;
- Claudex lacks a compact Bible/constitution document and agents do not have a
  single canonical map of what Claudex is and can do;
- native harness install/login expectations are unclear.

The deeper code review confirmed that these are symptoms of larger control-plane
truth problems: UI state, daemon state, harness readiness, review verification,
apply safety, and docs are not yet aligned tightly enough.

## User Directives To Preserve

The following directives came from the user and are binding for this milestone:

- Do deep repo-wide research; do not just grep and patch symptoms.
- Scan every file and every logic fragment relevant to the release.
- Use multiagent review where possible.
- Keep `CLAUDEX_BIBLE.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md` if it
  is added, and the design-system docs close to every implementation and review
  step.
- Prefer elegant, compact, transparent solutions.
- Avoid overengineering, code bloat, and speculative abstractions.
- Do not let adversarial reviewers drift away from the original scope.
- Stop and ask if a critical surprise changes scope.
- Preserve CLI-first architecture: macOS is a truthful control surface, not an
  app-only product fork.
- Keep Claudex harness-agnostic: no privileged Codex/Claude/Cursor/OpenCode
  role.
- Make UI/UX familiar for users moving from Codex, Claude Code, Cursor, and
  OpenCode.
- Follow Apple Liquid Glass guidance, but preserve glow, motion, and smoothness.
  The bug to remove is the harsh black/white cutout edge, not the visual identity.
- After implementation, run two adversarial review rounds max, each with six
  reviewers if possible, print tables in chat, and fix agreed findings only.
- Release path after clean checks: commit on `main`, tag release, push, publish
  artifacts.

## Locked Quiz Decisions

The following product decisions are already answered and must not be re-litigated
by reviewers unless new critical evidence appears:

- Release target: `v0.3.0 beta`.
- Implementation shape: one big pass.
- Backend/control-plane P0/P1 fixes are in scope together with UI/UX.
- Harness unavailable behavior: supported harnesses remain visible but disabled
  per selected intent when not ready; provide Fix/Install/Login/Key/Recheck
  actions.
- Run detail model: Hybrid Diagnostics.
- Settings scope: Full Preferences.
- Bible file: root `CLAUDEX_BIBLE.md`.
- Architecture doc: keep `docs/ARCHITECTURE.md` as the detailed system map.
- Bible context: `CLAUDEX_BIBLE.md` is mandatory context for Claudex development
  runs.
- Settings persistence: policy-aware full config editor.
- Config guardrails: versioned project config can edit only safe keys; sensitive
  keys only global/local/trust.
- Ask project binding: Current Project default.
- Project selector: explicit project picker.
- Product knowledge: bundled product knowledge from Bible/Architecture.
- Motion policy: Maximum Motion, optimized and artifact-free.
- Release artifacts: unsigned DMG + ZIP if signing/notary credentials are absent.

## External UX Anchors

Claudex should feel familiar to users of Codex, Claude Code, Cursor, and OpenCode.
The common pattern is project-bound local work:

- native tools run in a current working directory / project context;
- read-only ask/explain modes are distinct from edit/apply modes;
- project instructions/rules such as `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`,
  and tool permissions are part of the context;
- auth is usually native-login first with API-key fallback;
- dangerous permissions are explicit.

Apple Liquid Glass guidance is interpreted as:

- use glass for navigation/chrome/control affordances;
- keep dense content on readable solid surfaces;
- avoid custom backgrounds fighting system sidebars/toolbars;
- keep motion and glow only when it remains smooth and legible;
- honor Reduce Motion and Reduce Transparency.

## Product Model

### Claudex Product Repo

The Claudex product repo is the repository containing Claudex itself. In Anton's
workspace it is currently:

```text
/Users/anton/Clawdexor
```

It owns:

- Claudex source code;
- `CLAUDEX_BIBLE.md`;
- `docs/ARCHITECTURE.md`;
- `docs/DESIGN_SYSTEM.md`;
- public docs;
- local operator `AGENTS.md`.

### Target Project Repo

The target project repo is any repository the user asks Claudex to work on.

This may be:

- a user app repo;
- a disposable dogfood repo;
- the Claudex repo itself when dogfooding Claudex.

### Current Project

The macOS app and daemon must expose an explicit Current Project.

Every run must record:

- project id;
- `repoRoot`;
- display name;
- path;
- git branch;
- dirty state;
- config sources;
- trust state.

The Home composer must show a project chip. It must be clear what project `Ask`,
`Agent`, `Plan`, `Best-of-N`, and other modes operate on.

If no project is selected:

- `Ask` may work as plain/general Ask;
- edit-capable modes are disabled until a project is selected.

## Ask Model

`Ask` is the default mode and is read-only.

It must not:

- edit files;
- apply patches;
- show apply controls;
- silently start a heavy edit/review/gates pipeline;
- make a simple `2+2` request look like a dangerous agent run.

It must:

- answer ordinary questions quickly;
- be attached to Current Project when a project exists;
- expose `Project context: Auto / Deep / Off`;
- render the answer inline;
- preserve a read-only run record/artifact when useful;
- show diagnostics if it fails.

Recommended v0.3 behavior:

- `Ask + Current Project + Auto` uses lightweight project context and read/search
  capability.
- It should not inline the entire repository or full Scope Atlas for every
  prompt.
- If the prompt is clearly codebase-specific, it may build/read ContextPack.
- If the user chooses `Deep`, it builds a full ContextPack.
- If the user chooses `Off`, it answers without project context.

For questions about Claudex itself:

- use bundled product knowledge generated from `CLAUDEX_BIBLE.md` and
  `docs/ARCHITECTURE.md`;
- do not depend on Current Project being the Claudex repo.

## Hybrid Diagnostics UX

Canonical truth:

```text
RunEvent + RunDetail + Artifacts + Logs + WorkProduct + DecisionRecord
```

UI projections:

```text
Ask/Plan answer view
Task summary
Activity timeline
Artifacts/apply view
Review queue
Diagnostics/Console
```

Task Detail must include:

- Summary or Answer tab first, depending on mode;
- Activity timeline;
- Artifacts;
- Review;
- Diagnostics/Console;
- Apply controls only when WorkProduct and policy allow it.

For `Ask`:

- first tab is Answer;
- answer comes from `final/answer.md` or typed answer artifact;
- no apply controls.

For edit modes:

- first tab is Summary or Work Product;
- show patch/gates/review/apply state.

Diagnostics must include:

- failed phase;
- harness if relevant;
- safe message;
- raw debug detail behind disclosure;
- run dir;
- log refs;
- event stream tail;
- copy diagnostics;
- open logs;
- retry/reconnect actions.

## P0/P1 Findings In Scope

### Run State Truth

Known problems:

- Swift can leave an optimistic queued row when no client exists.
- Daemon can mark a resolved engine failure as `succeeded`.
- Swift reconciliation can mark a missing active run as `succeeded`.
- Unknown states can map to `running`.

Required fixes:

- Split scheduler state from engine terminal result.
- Never mark a run succeeded only because a promise resolved.
- Unknown statuses display as unknown/needs attention.
- Lost SSE stream triggers reconnect/unknown, not success.
- Every failure gets a run id/path when possible.

### Artifact Safety

Known problem:

- artifact fetch path checks are lexical and may follow symlinks outside run dir.

Required fixes:

- use `lstat` and/or `realpath`;
- reject symlink escapes;
- require target realpath under run dir realpath;
- add traversal and symlink tests.

### Apply Safety

Known problem:

- apply endpoint can apply `final/patch.diff` without verifying terminal success,
  decision status, work product kind, patch hash, or repo binding.

Required fixes:

- apply only if run terminal state is success;
- decision status is success;
- WorkProduct kind is patch/branch/commit/pr-compatible;
- patch hash matches the reviewed artifact;
- repoRoot matches original target or trusted override is explicit;
- dry-run passes.

No apply controls for:

- Ask;
- Plan-only;
- reports;
- in-place non-git diffs;
- failed runs;
- exhausted runs;
- not-converged runs unless an explicit expert override is designed later.

### Routing And Readiness

Known problems:

- Gateway/orchestrator often select by `discover()` rather than `doctor()` and
  enabled intents.
- UI lets users select Cursor/OpenCode even when not installed/authenticated.
- Degraded adapters can leak non-critical intents too broadly.
- OpenCode workspace_write maps too close to dangerous full access.

Required fixes:

- readiness must be SSOT across CLI, control API, daemon, and macOS UI;
- `resolve(intent)` must require doctor-backed `enabledIntents`;
- degraded adapters only keep explicitly enabled intents;
- UI disables harness chips per selected mode/intent;
- disabled chips remain visible with reason and Fix action;
- OpenCode dangerous bypass only for explicit full access.

### Review Truth

Known problems:

- reviewer error/empty/malformed output can become no findings;
- `review_verified` may be based on requested provider families rather than
  observed route proofs;
- reviewer selection is not fully doctor/capability gated;
- evidence preflight is not enforced everywhere.

Required fixes:

- reviewer failures become `INSUFFICIENT_EVIDENCE` or fail closed;
- verified review requires observed route proofs, distinct provider families, no
  same-model fallback;
- reviewers require doctor ok, review capability, readonly support;
- evidence packet preflight runs before review;
- diff hash at review time is recorded;
- if final diff changes after review, mark review stale or rerun.

### Context Truth

Known problems:

- `buildContextPack(...).catch(() => null)` can hide failures;
- ContextPack records docs paths/hashes, but mandatory context may not be
  forcefully propagated;
- in-place diff truncation can be treated like complete patch.

Required fixes:

- context failures become typed errors/artifacts;
- `CLAUDEX_BIBLE.md` and `docs/ARCHITECTURE.md` are mandatory for Claudex
  development;
- no silent context disappearance;
- truncated diffs are represented as structured omission/error;
- in-place `diff -ruN` outputs are not applyable patch WorkProducts unless
  converted/verified.

## macOS UI/UX Requirements

### Liquid Glass And Motion

Keep:

- glowing composer;
- visible motion;
- smooth ambient background;
- Liquid Glass feeling.

Fix:

- black/white jagged side artifacts;
- Settings titlebar overlap;
- choppy sidebar transitions where practical.

Implementation direction:

- Move `GlowBackground` to one root app layer around `NavigationSplitView`.
- Remove per-screen glow/background-extension behavior and repeated
  `backgroundExtensionEffect()`. A no-op compatibility helper is acceptable as
  long as it does not create a second background layer.
- Let system sidebars/toolbars own their glass.
- Keep content on solid surfaces.
- Add adaptive animation cadence or performance guards if needed.
- Honor Reduce Motion and Reduce Transparency.

### Settings

Settings must become real preferences, not an info dashboard.

Sections:

- General;
- Projects;
- Appearance;
- Ask/Agent defaults;
- Routing;
- Harnesses;
- Auth;
- Secrets;
- Budget;
- Access/Trust;
- Delivery;
- Review;
- Diagnostics;
- About.

Policy-aware config layers:

- global `~/.claudex/config.yaml`;
- project local `<repo>/.claudex/local.yaml`;
- versioned project config `<repo>/.claudex/config.yaml`;
- user-local project trust profile.

Sensitive keys cannot be saved into versioned project config.

### Onboarding

Required onboarding steps:

1. Choose Current Project or skip.
2. Harness setup cards:
   - Codex;
   - Claude;
   - Cursor;
   - OpenCode;
   - Raw API when enabled.
3. Defaults:
   - default mode Ask;
   - project context behavior;
   - routing portfolio;
   - enabled harness pool;
   - primary bias;
   - budget cap;
   - access default.
4. Smoke test:
   - `Ask "2+2?"`;
   - show answer;
   - show that no edit/apply happened.

Each harness setup card:

- installed status;
- detected binary path;
- version;
- auth status;
- supported auth modes;
- install/update button;
- native login button;
- API-key fallback field;
- recheck button;
- clear explanation.

Native auth principle:

- Claudex does not own subscription OAuth tokens.
- It launches native login flows where possible.
- It stores only API-key fallback refs in Keychain/0600 store.

### Tooltips And Help

Every ambiguous/risky/important control needs:

- `.help` tooltip;
- accessibility label;
- info popover for complex/risky controls.

Controls requiring coverage:

- mode menu items;
- Ask/Agent/Best-of-N/etc.;
- harness chips;
- primary harness;
- portfolio;
- model;
- access profile;
- full/elevated access;
- budget cap;
- project context;
- install/login/key actions;
- apply/check/branch/commit/pr;
- retry/reconnect/cancel;
- diagnostics copy/open.

`docs/DESIGN_SYSTEM.md` must define the help contract.

## CLI And Control API Requirements

CLI remains first-class. macOS must call the same engine/control API.

Add or improve:

- `claudex setup`;
- project list/open/status command or equivalent;
- `claudex ask`;
- `claudex runs list`;
- `claudex inspect <run> --events --attempts --logs`;
- `claudex logs <run>`;
- `claudex harness status`;
- `claudex harness enable|disable`;
- `claudex auth login <harness>` or rename hint-only behavior;
- `claudex settings get/set`;
- `claudex secrets list/set/delete`;
- `claudex release verify`.

Control API:

- `POST /runs` returns schema-backed `started | queued | failed`;
- run start validates repoRoot/project;
- readiness failures are traceable;
- `GET /runs/:id` includes safe failure detail, final answer refs,
  WorkProduct/DecisionRecord state;
- artifact fetch has safe views and symlink containment;
- diagnostics/log tail endpoint includes explicit truncation metadata.

## Documentation Requirements

### `CLAUDEX_BIBLE.md`

Create root `CLAUDEX_BIBLE.md`.

It must be compact but authoritative:

- current product identity;
- CLI-first/local-first;
- control-plane truth;
- no app-only logic;
- no privileged harness;
- roles are intents;
- adapters translate I/O only;
- schemas in `packages/schema`;
- evidence beats summaries;
- no silent truncation;
- fail loudly;
- no regex governance;
- no dangerous access from versioned config;
- design-system discipline;
- Liquid Glass rules;
- Current Project model;
- Ask read-only default;
- review freshness;
- release honesty.

### `docs/ARCHITECTURE.md`

Keep as detailed current system map.

Must include:

- package map;
- control plane data flow;
- Current Project;
- run lifecycle;
- storage locations;
- secrets locations;
- logs locations;
- macOS thin-client boundary;
- settings/config precedence;
- readiness model;
- artifact/apply model;
- docs ownership.

### Existing Docs

Update:

- `README.md`;
- `docs/ARCHITECTURE.md`;
- `docs/SPEC.md`;
- `docs/PLAN.md`;
- `docs/REVIEW.md`;
- `docs/DESIGN_SYSTEM.md`;
- `apps/macos/README.md`;
- local `AGENTS.md`.

Fix current-vs-target drift:

- label v1 content as target or historical where not implemented;
- do not overclaim benchmark/apply/review/gates/new-repo/settings;
- document v0.3 truthfully.

## Verification

TypeScript:

```bash
PATH="$HOME/.claudex/node/bin:$PATH" pnpm typecheck
PATH="$HOME/.claudex/node/bin:$PATH" pnpm test
PATH="$HOME/.claudex/node/bin:$PATH" pnpm schema:gen
git diff --exit-code packages/schema/generated
PATH="$HOME/.claudex/node/bin:$PATH" pnpm build
```

Swift:

```bash
PATH="$HOME/.swiftly/bin:$PATH" swift test
PATH="$HOME/.swiftly/bin:$PATH" swift build
```

Dogfood in disposable repos:

- fresh onboarding;
- no harness configured;
- Codex configured only;
- Claude degraded;
- Cursor absent;
- OpenCode absent;
- `claudex ask "2+2?"`;
- Ask about Current Project;
- Ask about Claudex itself when Current Project is another repo;
- Agent mode small edit;
- failed auth;
- failed harness;
- failed apply check;
- settings save/reload;
- secret set/list/delete;
- diagnostics copy/open;
- release verify.

Visual QA:

- dark;
- light;
- Reduce Motion;
- Reduce Transparency;
- 1280x820;
- compact widths;
- Settings titlebar;
- sidebar collapse/expand;
- composer sheet;
- menus/tooltips;
- disabled harness chips;
- Ask answer;
- failed run diagnostics.

## Adversarial Review Protocol

After implementation:

Round 1 with six reviewers if agent limits allow:

- UI/UX reviewer;
- Schema/API reviewer;
- CLI/routing reviewer;
- Secrets/security reviewer;
- Docs/design-system reviewer;
- Release/test reviewer.

Print table in chat:

- finding;
- evidence;
- severity;
- decision;
- fix/defer reason;
- file refs.

Rules:

- reviewer findings are hypotheses;
- verify against code/logs/tests;
- fix agreed findings only;
- reject overengineering;
- reject scope drift;
- do not reopen explicitly decided quiz answers unless critical evidence appears.

Then fix agreed findings.

Round 2:

- same maximum six reviewers, focused on changed diff;
- print same table;
- fix agreed findings only.

No third adversarial round unless the user explicitly asks.

If agent thread limits prevent six reviewers:

- report the limitation;
- reuse existing agents or ask before release.

## Release

Before release:

- checks clean;
- visual QA complete;
- dogfood complete;
- docs updated;
- no raw secrets;
- `git status --short` reviewed.

Release steps:

- commit directly on `main`;
- bump to `v0.3.0`;
- tag `v0.3.0`;
- push `main`;
- push tag;
- publish GitHub release;
- attach unsigned DMG + ZIP if no signing/notary credentials;
- release notes explicitly say unsigned when unsigned;
- signed/notarized DMG only if credentials are available.

## Explicit Non-Goals For v0.3

Do not build:

- SaaS OAuth broker;
- full benchmark-maxxing v1 platform;
- full plugin marketplace;
- remote multi-user control plane;
- app-only logic that bypasses CLI/control API;
- hidden hardcoded harness roles;
- new personality/agent identity for Claudex;
- complete per-hunk apply UI unless backend-selected scope is safe.
