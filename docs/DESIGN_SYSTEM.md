# Claudexor for macOS — Design System

Status: living document. SSOT for the native macOS app's visual + interaction design.
Target platform: macOS 26 (Tahoe), SwiftUI/AppKit, Liquid Glass. Apple Silicon.

This document is normative. The app implements these tokens and rules; deviations
must be justified here. It pairs with [`../CLAUDEXOR_BIBLE.md`](../CLAUDEXOR_BIBLE.md)
(product constitution), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the app talks
to the engine-service), [`DEVELOPMENT.md`](DEVELOPMENT.md) (contributor
workflow), and [`CHECKLISTS.md`](CHECKLISTS.md) (visual QA gates).

---

## 1. North star

Claudexor is a native **chat-first cockpit** over multiple coding harnesses (Codex,
Claude Code, Cursor, OpenCode): ONE screen — a thread list, the conversation, and a
persistent composer. You just type; the first message starts a thread; turns run
in-place so the next turn sees the work; a run's detail opens in the trailing
Workbench (Run Detail, with Canvas for the project's produced outputs). Its
single real differentiator from a bare harness is multi-vendor
**race + review** with the winner adopted into the tree. It must feel instantly
familiar to users of Claude Code / Cursor / Codex, with honest run outcomes and a
calm, native, matte-glass surface (the desktop shows faintly through the window;
nothing animates when idle).

Three design commitments:

1. **Content-first; Liquid Glass on the navigation layer; frosted materials on
   content cards (user-locked).** `glassEffect` Liquid Glass lives on the
   chrome (sidebar, toolbars, inspector, floating composer/action controls,
   sheets, menus). Ordinary content cards use **frosted system materials with a
   tuned surface tint** so the ambient glow shows through in BOTH themes — one
   visual language with the floating composer, the "floating card" feel that
   previously existed only in Light Mode. Code, diffs, transcripts, settings
   groups, and any dense small text still sit on SOLID, high-contrast surfaces
   (`surface/code`): never put glass OR translucency behind code text. Reduce
   Transparency falls back to solid raised fills everywhere.
2. **Honesty is visible.** Evidence, route-diversity proof, estimated-vs-exact cost,
   and gate status are surfaced as quiet always-on badges with deep evidence one click
   away. The UI never implies more certainty (or more multi-model rigor) than the data
   supports.
3. **Legible at a glance, even after days away.** A long autonomous run must be
   understandable in 3 seconds: phase, health, budget, "what changed since you last
   looked," and "does it need me."

### 1.1 Presentation doctrine (INV-134)

Four owner-locked rules every surface obeys:

1. **One presentational owner per fact.** A displayed fact (apply state, auth
   route, cash spend, readiness, outcome) is formatted by exactly ONE mapper
   (`RunFacts`, `OutcomePresentation`, `TurnPresentation`,
   `HarnessReadinessPresentation`, `CashSpend`, `AuthSheetPresentation`);
   surfaces compose LAYOUT from those values. Two surfaces may lay a fact out
   differently — they may never fork its vocabulary.
2. **A disabled control explains why.** Every `.disabled(...)` carries a
   `.help(...)` (or adjacent text) naming the reason; a dead-looking button
   with no explanation is a defect, not a style.
3. **New chips/badges/pills only through this document.** A status capsule,
   badge, or chip enters the UI only when its section here names its states,
   tones, and owner mapper. Ad-hoc capsules are how the 16-chip header
   happened.
4. **Fixed grids — nothing drifts with text length.** Icon and name columns
   have fixed widths, capsules have fixed minimum widths, rows keep anchored
   left/right clusters; a longer label truncates or wraps inside its cell and
   never moves its neighbors.

---

## 2. Foundations

### 2.1 Appearance

- Support **Light, Dark, and system** following the app's effective system
  appearance.
- **Signature default is a deep-graphite Dark** ("command center"), never pure black.
  Pure black + saturated text is the exact readability trap competitors fell into;
  we use layered graphite surfaces and desaturated accents. Dark cards use the
  **frosted floating** recipe (see 2.4): system material + graphite tint, a
  top-lit gradient hairline, and a VISIBLE separation shadow — never a flat
  charcoal slab with a uniform white outline (the "cheap dark card" trap,
  a removed defect class).
- A user-facing **Appearance** control (Light / Dark / System) is required from day one.
  Do not ship a single forced theme with no toggle.

### 2.2 Color tokens (semantic, not raw)

Define colors as semantic tokens in an asset catalog with Light/Dark + Increased
Contrast variants. Never hardcode hex in views.

Surfaces (Dark default shown; Light mirrors with inverted luminance):

- `surface/base` — window background, deep graphite (e.g. ~ `#1A1B1E`), not `#000`.
- `surface/raised` — cards, lists; in dark mode this must be visibly lifted from
  base, closer to crisp graphite than flat charcoal.
- `surface/overlay` — popovers/sheets content backing (above glass).
- `surface/code` — editor/diff/transcript background, solid, max legibility (~ `#16171A`).
- `separator` — hairline dividers; respects Increase Contrast.

Text:

- `text/primary`, `text/secondary`, `text/tertiary`, `text/onAccent`.
- Body/code text on `surface/code` must hit **WCAG AA 4.5:1** (verify every theme).

Brand + accent:

- `brand/accent` — single Claudexor identity accent (a cool, slightly desaturated
  **steel-blue** — neutral chrome so the harness identity hues pop). Used for primary
  actions, **selection/list tint** (the app tints controls with the brand, never the system
  blue), section-header icons, and inline links (`link` == `brand/accent`).
- Accent/tint conveys **meaning**, never decoration (Apple's Tahoe guidance).

Harness-family palette (functional color-coding of candidates/findings/routes):

- `harness/codex` (teal), `harness/claude` (warm orange), `harness/cursor` (violet),
  `harness/opencode` (lime), `harness/raw-api` (magenta), `harness/fake` (neutral) — each a
  distinct, AA-legible hue tuned to differ from each other AND from the status palette.
  Used for candidate chips, race lanes, route-proof, per-harness budget, and harness dots.
  These are the ONLY place we use multiple strong hues.

Status semantics (shared across badges, pipeline, lists):

- `status/running` (azure), `status/success` (green), `status/needs-review` (periwinkle),
  `status/blocked` (amber), `status/failed` (red), `status/cancelled` (neutral/gray),
  `status/interrupted` (muted amber), `status/queued` (tertiary),
  `status/exhausted` (red/blocked blend), `status/not-converged` (amber),
  `status/unknown` (neutral warning).
- Always pair color with a glyph + label (never color alone — accessibility).

**Color discipline (the one rule that keeps it from looking "mixed").** Strong hues are
*budgeted*: harness hues appear only in harness UI, status hues only on state, and
everything that is "the app itself" (chrome, selection, links, icons) uses the
single brand steel-blue + neutral graphite. The window backdrop is the neutral
behind-window material (§3.1) — it must never pull in harness or status hues, or the
whole window reads as a rainbow. Severity maps onto
the status scale (blocker→failed, major→blocked, minor→running, nit→neutral), not new hues.

### 2.3 Typography

- UI: **SF Pro** (system) via SwiftUI semantic styles (`.largeTitle … .caption2`).
  Respect **Dynamic Type**; do not hardcode point sizes for body UI.
- Code / diffs / transcript / IDs / budgets: **SF Mono**.
- Numerals in meters/budgets: monospaced digits (`.monospacedDigit()`).
- Section headers use title-style capitalization (Tahoe convention), not ALL CAPS.

### 2.4 Spacing, shape, elevation

- Spacing scale (pt): `2, 4, 8, 12, 16, 24, 32` (`Theme.Spacing.xxs…xxl`). Default gutter
  16; compact 12. Screen gutter is `xxl` (32). Use tokens — never off-scale literals
  (`1,3,5,6` etc.).
- One **radius ladder** (`Theme.Radius`): `control 8` (chips/segments/small code wells),
  `card 12` (softened from 8 per owner visual QA, 2.1.0), `hero 22` (floating
  composer). Cards stay compact; controls inherit system
  metrics — do not hardcode control heights. (Concentric radii via Apple's
  ConcentricRectangle are a tracked deferred refinement.)
- Elevation — the ONE card recipe (centralized in `cardSurface`):
  - **Fill:** system `.regularMaterial` + a tuned `surface/raised` tint veil
    (dark ≈ 40%, light ≈ 55%) so the ambient glow shows through without
    hurting text contrast. Reduce Transparency → solid `surface/raised`.
  - **Edge:** a **top-lit gradient hairline** (light falls from above: dark
    white 22%→5%, light black 10%→4%) instead of a uniform outline; emphasis
    strokes (winner candidate, pending question) override it in their color.
  - **Depth:** one scheme-aware separation shadow cast by the card SHAPE —
    visible in Dark Mode too (dark: black 40%, radius 13, y 5; light: black
    13%, radius 8, y 3). The old dark shadow (black 14%) was mathematically
    invisible on graphite — that bug class is what this recipe replaces.
  - **Hover:** clickable rows opt into a lift (deeper shadow + brighter veil);
    static panels never twitch.
  - Settings groups are flat and use no shadow. No heavy, stacked, or black
    cutout shadows. Row lists are **individual floating row-cards with gaps**,
    not one slab with hairline dividers, except the floating glass thread
    sidebar: it uses a native `.sidebar` `List` with hidden scroll background so
    the `sidebarGlass` panel carries the chrome treatment.

### 2.5 Density

- **Compact by default** (pro density) with a comfortable option in Settings.
  Density adjusts gutters/row heights/inset via a single environment value; never
  hardcode per-view.

### 2.6 Motion

- **Static glass; idle means ZERO animation.** Glass surfaces use static
  `.regular` — never `.interactive()` pointer lensing (a measured scroll/idle
  FPS regression; see §3.1) — and there is no always-animating backdrop and no
  perpetual pulsing anywhere. A window left open for hours must cost nothing
  while nothing is happening.
- Motion is reserved for **state changes and user interactions**: short, calm
  transitions (tab indicator, popover expand, hover lift) and low-frequency
  progress indication on the live surfaces (turn transcript, run-inspector
  telemetry, the active phase node) — never continuous decoration.
- **Non-negotiable guardrails:** honor **Reduce Motion** (state-toggle
  animations degrade to instant/cross-fade) and **Reduce Transparency** (fall
  back to solid surfaces).

### 2.7 Iconography

- **SF Symbols** first (monochrome in toolbars per Tahoe; tint only for meaning).
  Animated symbols for run state. Provide an accessibility label for every icon.
- A small set of custom marks: the Claudexor app icon (Icon Composer, layered,
  Light/Dark/Clear/Tinted) and harness-family glyphs.

---

## 3. Liquid Glass & materials rules

- **Where Liquid Glass (`glassEffect`) goes:** sidebar, toolbars, the
  inspector/review panel, the floating composer, action controls, sheets,
  popovers, and menus.
- **The threads sidebar is a FLOATING Liquid Glass panel** (`sidebarGlass`
  modifier): the list is INSET from the window edges so it floats over the
  behind-window backdrop, rendered with `.glassEffect(.regular, in:)` inside a
  `GlassEffectContainer` — not a flush split pane with a hard divider (that read
  flat/dated, especially in light mode). The `List` hides its scroll background
  (`.scrollContentBackground(.hidden)`) so the glass shows through; there is no
  visible divider (the gap floats the panel and an INVISIBLE trailing hot-zone
  keeps drag-resize). Reduce Transparency → solid `surface/raised` panel +
  hairline + a soft shadow so it still reads as floating. The conversation is
  content and stays off glass.
- **Where frosted materials go:** content cards and row-cards — the
  `cardSurface` recipe (`.regularMaterial` + tint veil, top-lit hairline,
  scheme-aware shadow). Materials are NOT `glassEffect`; cards never lens or
  morph.
- **Where neither goes:** behind code, diffs, terminal/transcript output,
  tables, or any dense small text. Those use `surface/code` solids.
- Use standard structure (`NavigationSplitView` + `.inspector`, `Toolbar`, `Sheet`) to
  get the material for free; avoid custom backgrounds behind bars/sheets. EXCEPTION:
  the chat cockpit uses a custom `HStack` (floating `sidebarGlass` panel +
  conversation) rather than `NavigationSplitView` — the window is custom-clear with a
  behind-window backdrop, the composer belongs to the detail (not the sidebar), and
  drag-resize is custom. This is intentional; do not "fix" it by reintroducing
  `NavigationSplitView` (it would re-plumb the window/backdrop/toolbar and relocate
  the composer for no visual gain).
- When a view intentionally uses custom morphing glass, group those elements in a
  `GlassEffectContainer` and share a namespace for morphs. Do not require every
  normal screen/card to opt into custom glass.
- Do not put window-edge material or background-extension effects on full-window
  glow layers or repeated per-screen backgrounds. Custom background effects must
  be local, clipped to their owning surface, and visually QAed in dark/light,
  Reduce Transparency, and compact widths.
- Do not stack glass on glass; do not "glass everything" — it fights legibility and battery.
- Test every screen with Reduce Transparency, Reduce Motion, Increase Contrast, and the
  system Liquid Glass tint settings.

### 3.1 macOS 26 Liquid Glass APIs (first-class, not availability-gated)

The app targets macOS 26 (Tahoe), so these are used directly (no `if #available`):

- **`glassEffect(.regular[.tint(...)], in: shape)`** — the floating chrome surface
  (composer panel, floating actions). Use **static `.regular`** — NOT `.interactive()`:
  pointer lensing re-composites the glass on every mouse move AND every re-render,
  which was a measured scroll/idle FPS regression even on fast Apple Silicon. Apple reserves
  `.interactive()` for elements that physically move under the cursor, not a static
  composer. Reserve `.tint(...)` for one or two primary accents per surface.
- **`GlassEffectContainer { ... }`** — wrap a cluster of glass elements so they share
  one sampling region (constrains the sample zone — it *helps* perf). Group; don't
  scatter bare `glassEffect`s.
- **Chrome controls inside glass** — the chat composer controls use custom solid
  capsule/menu labels (`IntentMenu`, `ProjectChip`, `PrimaryHarnessChip`, and the
  options icon button) inside `GlassEffectContainer`, not system `.glass` buttons.
  That keeps repeated controls legible on the floating glass panel and avoids a
  glass-on-glass read. Native `.buttonStyle(.glass)` remains available for sparse
  chrome actions where it stays legible. The one prominent action (Send) does NOT
  use `.glassProminent` — system glass-prominent can render near-white on the
  light-mode glass (invisible). Send uses `AccentButtonStyle`: a SOLID
  `accentSolid` capsule with white text, legible in BOTH themes (WCAG). See §5.1.
- **Behind-window transparency (the desktop shows faintly through the window)** —
  three pieces, all required: (1) `GlassBackground` → `NSVisualEffectView`
  with `.behindWindow` blending and appearance-aware material (`.hudWindow` in
  dark mode, `.fullScreenUI` in light mode) as the window backdrop, at FULL
  alpha; (2) the window made non-opaque in `AppDelegate` (`isOpaque=false`,
  `backgroundColor=.clear`, set
  reliably once the window exists — a per-frame SwiftUI guard never fired); (3)
  `.containerBackground(.clear, for: .window)` + `.toolbarBackgroundVisibility(.hidden,
  for: .windowToolbar)` on the root so the SwiftUI container and toolbar don't paint an
  opaque panel over it. Miss any one and the window reads as solid gray. The frost
  comes from the MATERIAL, not a reduced `alphaValue`: lowering the vibrancy view's
  alpha fades the frost and reveals the un-blurred desktop (a flat, too-transparent
  wash), so the backdrop stays full-alpha and uses the appearance-aware material
  pair above instead of the most-transparent `.underWindowBackground`. Reduce
  Transparency → solid `surfaceBase`.
- **Glass vs `Material`** — Liquid Glass is the FLOATING chrome layer; `Material`
  (`.regularMaterial`, the `cardSurface` recipe) is the CONTENT
  layer. Dense/input content (the composer text field, the "⋯" option rows, code,
  diffs) sits on a **SOLID inset** (`surfaceRaised`/`surfaceCode`) INSIDE the glass —
  never a second `glassEffect` and never a frosted card inside glass.
- **Reduce Transparency** — every custom glass surface needs a SOLID fallback
  (`surfaceRaised` + hairline). `composerGlass` and `GlassBackground` branch on
  `accessibilityReduceTransparency` already; new glass must do the same.
- **Reduce Motion** — gate state-toggle animations (e.g. the "⋯" expand) on
  `accessibilityReduceMotion`; glass lensing/morph degrade to instant.
- References: developer.apple.com — Adopting Liquid Glass, `glassEffect(_:in:)`,
  `GlassEffectContainer`, the glass button styles, Materials (HIG); WWDC25
  #219/#323/#356.

### 3.2 Live-stream render granularity (performance contract)

Glass/transparency are NOT the streaming-performance lever — recomposition
frequency and volume are. The contracts:

- **Per-run live box.** A streaming run's HIGH-FREQUENCY state (activity feed,
  transcript, spend ticks) lives in a per-run `@Observable` `RunLiveBox`; SSE
  batches mutate only that box, so one live run repaints ONE card/tab — never
  every list that projects the tasks array. `TaskRun` (the tasks array) keeps
  low-frequency truths (status flips, findings, interactions, caps) and is
  written only when one of those actually changes. At terminal the box folds
  back into the task snapshot and is retired.
- **Adaptive coalescing.** SSE events flush in batches: a 64 ms window when
  calm, stretching to ~250 ms under sustained bursts (racing multi-harness
  runs) — four honest repaints per second, not fifteen.
- **Per-run detail single-flight.** Gate/reviewer/finding/output/terminal event
  bursts share one in-flight detail GET and request at most one trailing
  refresh. Run-list refresh never N+1-fetches details merely because a row has
  zero findings; selected thread/inspector hydration owns detail loading.
- **Bounded feeds with honest truncation.** The live activity feed is a ring
  of the newest 1000 events with a visible "N older events collapsed" note
  (mirroring the server's capped timeline); transcripts cap at 200 blocks with
  the same disclosure. Full logs stay in `events.jsonl` — the UI never
  pretends the capped view is complete.
- **Bounded chat presentation.** The chat card is a progress SUMMARY: it lazily
  renders only the newest 80 folded rows and at most 4,000 characters from one
  narration block, with an honest omitted count/link to raw evidence. The
  reducer's larger 200-block / text budgets protect evidence retention; they
  are not permission to lay all retained text out on the main thread.
- **Diagnostics are metadata-first.** Thread/run hydration never fetches raw
  `events.jsonl`, rollout, or log bodies. Diagnostics renders typed failure/web
  facts, a bounded primary diagnostic preview, and path+byte metadata; complete
  evidence opens from the run folder on demand. A multi-megabyte monospaced
  `Text` is forbidden.
- **Tab-demand payloads.** Multi-megabyte `final/patch.diff` is fetched and
  parsed only when Diff opens, with an explicit loading state — never during
  generic thread/run hydration. Control API primary-output text is a bounded
  256 KiB inline preview with `truncated=true` + full artifact path/byte size;
  complete output opens on demand. Patch availability comes from result/artifact
  metadata, not the loaded `[DiffFile]`; a pre-metadata tab open retriggers when
  metadata lands, while 413/network/non-text failures show the reason, artifact
  path, and Retry instead of a perpetual spinner.
- **Lazy timelines.** The Timeline tab renders newest-first through a lazy
  reversed collection inside `LazyVStack` — no materialized reversed copies,
  no eagerly-built thousand-row stacks.
- **Off-screen eviction.** Terminal runs outside the open thread / inspected
  run release their heavy feed and transcript arrays on route/thread change;
  reopening reloads the feed from the server timeline (`loadRunDetail`).
  Live/streaming runs are never evicted.

---

## 4. App shell & information architecture

- Mental model (chat-first): **Thread → Turns → (run) Outcome**. A thread is
  the conversation; each turn is a run; the honest outcome (answer / plan / patch)
  lives on the turn.
- **ONE screen.** The app is chat-first: the main window is the thread list, the
  conversation, and the always-live composer, with the selected run's detail in
  the trailing region. There is no Home, no Tasks list, and no separate
  Review-Queue screen — review verdicts and diagnostics live on the turn and in
  the run inspector.
- Single window, **three regions**:
  - **Thread list (glass sidebar):** the conversations, with a needs-you marker;
    "New" enters the draft state (the first message materializes the thread).
    Each row carries a context menu — Rename… (title sheet) and
    Archive/Reopen — riding the server-owned `PATCH /threads/:id`
    (`title`/`state`); no local-only thread state. The sidebar's BOTTOM-LEFT
    carries ONE compact accounts control (Claude-Code style, INV-135): a quiet
    single-line trigger — worst-readiness dot + the account name (or "N
    accounts") + worst quota % + chevron — that opens a popover to manage
    accounts in-app — no commands to copy; the native login itself still runs
    the official vendor CLI in an auto-opened Terminal window (the setup-job
    handoff below). Each popover row is one account (a
    default vendor login labeled with the harness name, or a registered
    credential profile): a readiness dot, its name, ONE compact quota line
    (worst window % + reset), one "Log in" / "Manage" action, a **Use/Using**
    thread-pin action for ready named profiles (ready means that exact source is
    `available + passed`, never aggregate harness health). Use atomically makes
    that harness primary and the sole eligible pool member, and — on
    registered profiles only — a confirmed Remove (trash) that deletes the
    registration plus the account's own login/key
    (`DELETE /v2/credential-profiles/:harness/:id`; the default vendor login
    is never Claudexor's to delete); delete also clears matching thread pins,
    native-session caches, and quota rows. The popover adds accounts inline
    (harness + optional name → `POST /v2/credential-profiles`, then that
    account's native login) and toggles "Auto-switch accounts at quota limit"
    (the per-harness `profileLimitAction` rotate/fail); a quota refresh and
    the full per-window quota detail stay one click away. Two subscriptions
    of one vendor NEVER merge — quota keys on
    `(harness, credential route, profile)`. The account list + add + remove
    block is ONE shared component (`AccountsSurface`, SSOT): the Settings
    Harness Doctor's "Manage" sheet hosts the same surface scoped to its
    family — account control is never forked per surface. In that sheet the
    implicit default login is simply the first account row; named profiles
    follow, and "Add another account" is the only add flow. There is no
    parallel "Native setup" card competing with "Additional accounts". "Use
    automatic account routing" clears a manual pin; selection persists through
    the thread DTO, never local-only UI state.
  - **Conversation (a message feed; code solid):** each turn is a right-aligned
    accent USER BUBBLE over the assistant's frosted card (Chat-V2, F2.5). The
    user bubble is the QUIET ACCENT side of the conversation: the proven
    `accent.opacity(0.14)` fill and compact `Radius.control` corner — never a
    saturated block. The assistant stays a neutral frosted `cardSurface` but
    carries one subtle accent hairline (`accent.opacity(0.22)`) so it belongs
    to the same family without merging the two speakers. The final answer is
  the loudest assistant element: solid `surfaceRaisedHi` dense-content inset,
  `Radius.control`, body-sized prose, and a restrained 2 pt accent leading
  edge. Then: a
    status line (harness identity + honest status pill + live elapsed clock),
    the live transcript disclosure (reasoning segments with duration timers,
    DIMMED mid-run narration, humane tool rows), the reconciled outcome line,
    decision/apply actions, and the FINAL ANSWER as the loudest element — its
    own accent-edged bubble rendering markdown with scope-gated inline images.
    The always-live composer closes the feed.
  - **Workbench (trailing region, glass chrome):** a two-plane switch,
    `[Run Detail | Canvas]`. **Run Detail** (`.inspector`) is the selected run's
    tabbed detail over Claudexor's internal run evidence (§5). **Canvas** is the
    project's PRODUCED outputs and a user-driven mini-browser (§5). The two
    planes are labeled so the user always knows whether they are looking at run
    evidence or project deliverables. The Workbench is the sanctioned extension
    of the one-screen doctrine — never a third top-level screen.
- Budget, Harness Doctor, and preferences live in the Settings scene (⌘,), not in
  the main window. Detachable pop-out windows remain out of scope.

---

## 5. Signature surfaces & components

Each component lists purpose + key tokens. Components are reusable SwiftUI
views in the shared design-system files; screens compose them.

- **Turn card — the messenger layout (F4 V1a).** The card reads top-down as a
  conversation and grows strictly downward; live and terminal are ONE shape:
  1. the user's right-aligned bubble;
  2. ONE status line — two anchored clusters: identity + quiet state word on
     the left ("Codex · Working…", retry folds into the word: "Retrying
     2/10"; a race says "Best-of N" — a losing candidate's name is never
     guessed), time + cash-$ on the right, the explicit ⧉ inspector
     affordance trailing. No permanent status pill (F4 V2a): attention
     states raise ONE loud chip only when they exist ("Needs your answer" >
     "Needs you" > the red terminal label), and the quiet state word goes
     silent when the chip voices it. Success carries no chip — the outcome
     row already says what happened. Owner mapper: `TurnPresentation`.
  3. ONE labeled Activity strip — the counter «Thinking 40s · 9 tools ·
     3 files» (components with no evidence are absent; empty stream = no
     strip). Clicking the CARD toggles it; expanded while live by default; a
     user toggle pins it.
  4. the answer bubble (the loudest element, W22 markdown);
  5. quiet outcome rows (plan/diffstat + the reconciled W21 line via
     `OutcomePresentation` ← `RunFacts.applyFact`);
  6. the action footer, fixed position last (decision bar, apply pre-flight,
     apply/revert), then the silent-failure card when honest.
  The inspector opens ONLY via the explicit ⧉ (or the toolbar toggle) —
  never by clicking the card, never automatically on navigation; a manual
  close stays closed (F4 V17a, one `inspectorPresented` binding).
- **Run inspector (Run Detail).** A long run at a glance — the opened turn's
  detail in the trailing Workbench. Its header is a PRIMARY row of at most
  the material facts (route, apply, needs-answer + BudgetMini and Cancel);
  provenance and the route-proof badge are EVIDENCE and live behind the
  Details disclosure with everything else, composed from
  `RunFacts.headerDetails` — the header never retells the card (F4 V19a):
  - **Phase pipeline**: contract → context → risk → budget → envelope → gates → review →
    synthesis → arbitration → final, each a node with `status/*` color+glyph; the active
    node animates (calm). It rides the active turn's transcript and the inspector's
    Timeline, not a top-level pane.
  - **Candidate cards — the Candidates-tab contract**: one card per race
    candidate, colored by `harness/*`, showing that candidate's deterministic
    gates, cost (with the estimated-vs-exact badge), and review state, with the
    winner emphasized (`CandidateCard(strokeColor:)`). They live on a race turn
    and in the Run Detail Candidates tab, projected LIVE from the run
    detail's `candidates` DTO (per-attempt gates/cost/diffstat/review
    evidence; candidate glyphs inherit the run terminal so a clean loser card
    in a failed run never renders green).
  - **Budget meter**: spend vs cap, circuit-breaker tier, per-harness split; honest quota.
    Money values are typed currency fields when editable; never use a slider for dollar input.
    The live meter rides the run inspector; the editable budget cockpit is a Settings tab.
  - **Timeline feed**: streamed `HarnessEvent` transcript with verbosity Verbose/Normal/
    Summary in the inspector's Timeline tab; code/log text sits on `surface/code`.
    The CHAT transcript (the card's Activity strip) is a FLAT log (F4 V9a,
    `TranscriptPresentation`): one line per tool (status glyph + typed-kind
    icon + humane title — a command shows its binary's basename, the full
    command line is the subtitle); a FAILED tool stands alone and carries its
    error summary (or "exit N") as a second dimmed line; runs of MORE THAN
    THREE consecutive same-name OK tools collapse into one quiet group row
    («Read · 6 calls»); thinking is a single timer row («◐ Thinking · 12s» —
    the reasoning text and full tool output live only in the inspector); zero
    inline chevrons. Honest degradation: a stream without an event kind has
    no such rows, an empty stream renders nothing. Mid-run narration renders
    dimmed markdown (a TYPED final never enters the transcript — it is the
    answer bubble); typed `status` events (e.g. claude api_retry) fold into
    the status line's state word, never the reasoning disclosure; with
    `stream_deltas` the current message grows live and the complete text
    replaces it. Agent images render inline ONLY inside the thread's
    repoRoot / run dir (canonical-path scope, bounded decode, disclosed
    refusal outside the scope); file links open through the same gate.
  - **"What changed since this turn"** marker + an **attention state** (working /
    blocked / needs-permission / done) on the turn card and its thread row.
- **Chat composer.** ONE floating Liquid-Glass panel
  (`composerGlass` — **static `.regular`**, solid fallback under Reduce Transparency).
  Two stacked zones, all with SOLID contents (no glass-on-glass):
  - a controls row — the intent `Menu` (Ask, Agent, Plan, Spec, Audit, plus
    Best-of as the best-of-N agent strategy),
    the `ProjectChip` (the working directory — MRU recent + Browse…; sets the new
    thread's project, an open thread's repo is bound; the ONLY place project
    selection lives in the app), the `PrimaryHarnessChip` (which
    harness answers in chat; sticky on the thread), the composite **`AccessChip`**
    (the per-turn write scope — Read-only / Workspace write / Full access — as a
    first-class chip; it reads "Full access · Browser" and DISABLES while the
    agent browser is armed, because Browser derives Full access and a downgrade
    would be a contradiction; choosing Full access for an ungranted repo surfaces
    an inline "Full access requires a one-time grant" row with the grant action —
    the grant stays a separate explicit act, never implied by the chip),
    the attachment controls
    (paperclip picker + the **Capture** button, below), and the borderless options
    icon button with an active accent capsule that opens the advanced options as a
    native dismissible **`.popover`** — NOT an inline panel (the inline version read
    as glass-on-glass and was cramped);
  - the input — `GlassField`: a `TextField(axis:.vertical)` on a SOLID `surfaceRaised`
    inset with a real focus ring (scheme-aware — heavier in light mode where a faint
    ring vanishes on white) and 1→6-line growth, with `Send` (`AccentButtonStyle` —
    solid `accentSolid` + white text, visible in BOTH themes, ⌘↩, dims when empty).
    While the thread's head turn is running, **Send swaps to a Stop button** — a
    server-owned cancel of the running turn (a new turn cannot start over the live
    native session); ⌘↩ mirrors the swapped button.
  The "⋯" popover holds the per-turn engine knobs as clean SOLID
  `OptionSection`/`OptionRow` rows — every one a projection of a typed run/DTO
  field, never UI-invented state:
  - the **harness pool** multiselect chips (the eligible pool Best-of runs — one
    candidate per harness; the primary answers in chat);
  - the **per-harness model rows** (`Models — per harness for THIS turn`): one
    row per pooled harness, `[harness label][model dropdown]`, each dropdown
    fed by THAT harness's model truth source (`/harnesses/:id/models` — live
    `api` inventory or `manifest` known-good hints, with the freshness note in
    hover help). The enumeration is **route-scoped**: the effective per-turn
    credential route rides `?route=` and route-annotated models foreign to it
    are hidden (with a hidden-count note in help — the strict preflight would
    refuse them anyway); an already-chosen id the route hides stays visible so
    it can be seen and cleared. There is NO free-text model entry: a harness
    without a truth source shows "Harness default only" (strict model
    governance — an arbitrary id would be refused at run preflight). Selections
    build the harness-scoped `models` map on the turn; model choice is
    harness-scoped — there is no cross-harness model value, and a race pool is
    never poisoned by one vendor's id;
  - the **budget** field (typed per-turn USD cap; validated currency text, never
    a slider) and the **web** policy picker (the access profile lives on the
    controls-row `AccessChip`, not here);
  - the **Auth route** row (Auto / Subscription / API key — the per-turn
    `authPreference` request over the thread preference), with a caption
    stating the REQUESTED route in honest language: auto may switch routes
    (typed, policy-governed fallback), and the route actually taken is
    disclosed as a badge on the finished run — the composer never claims what
    "will be charged";
  - the **reviewer panel editor** (ordered explicit `harness[=model[:effort]]`
    entries; invalid entries block Send with an inline reason) and typed
    **protected-path approvals** for auto-protected gate/test paths;
  - the **browser** toggle (see below);
  - the **Workspace** section with the **isolated-workspace toggle** (a draft
    thread can choose `isolated` — turns accumulate in a persistent thread
    worktree — instead of the default in-place execution);
  - **repair strategies** (until-clean / max-attempts) for agent turns.
  Routing goal, quality tiers, and deterministic gate commands are engine/Settings
  concerns, not per-turn composer controls. The paid-fallback/auth-route CHOICE is a
  per-turn composer control (the Auth route row above); its outcome is a post-run
  route receipt, never a composer promise.
  Default intent is `Agent`; project intents need a project; a **no-project thread is
  `Ask`-only** — the `ProjectChip` remains visible as the choose-project CTA, the
  primary harness chip and project-scoped controls are hidden or disabled, the
  "⋯" options popover remains available for no-project Ask, and an inline
  "Pick a project to use Agent · Plan · Best-of" hint prevents sending into the void.
  Project-only controls inside the options popover are hidden or disabled rather
  than faking project scope. The draft-state first message materializes the
  thread. The composer's intent menu surfaces four everyday canonical modes —
  `ask` / `agent` / `plan` / `audit` — plus **Spec** as the grounding flow and
  **Best-of** as `agent` + the best-of-N strategy flag, not a mode. The fifth
  canonical mode `orchestrate` (and `explore` / `create`) are intentionally
  **CLI-only**: they are power-user / scripted flows, so the composer keeps the everyday
  surface small. race width / until-clean / attempts are engine strategy flags, not modes.
- **Composer attachments + Capture.** The paperclip picker attaches files to a
  turn; attached files render as removable chips above the input. Generic file
  attachments ride any non-Spec turn; IMAGE attachments and the **Capture**
  button (system `screencapture` region select, off the main thread; a
  denied/cancelled grab yields no attachment — never a blank fake image) are
  gated by the pool's finite `capability_profile.attachment_inputs` declarations.
  Upload progress/cancel happens before Send; if any selected lane lacks the
  MIME/size/count transport, Send is blocked with the engine's typed reason — an
  attachment the model never saw must never look delivered. The Spec interview takes no attachments
  and says so instead of silently dropping them.
- **Agent-driven browser toggle.** A per-turn `Browser` toggle in the "⋯"
  popover, offered ONLY when a pooled harness reports the `browser_tool`
  capability (hidden otherwise — never a dead switch). It is live egress and is
  disclosed as such: arming it forces Full access and lifts a `web: off` policy
  to `auto` — never a silent escalation ("Agent browses in a real window · runs
  at Full access" renders under the switch). The hover help explains that the
  agent drives a real HEADED browser window (navigate / screenshot / read) and
  that navigation snapshots are recorded in the run's artifacts. The run
  inspector projects engine receipts for mixed pools: each lane says whether
  Browser was effective and why not; the app never infers that from the toggle.
- **One minimal toolbar, no second header.** The thread title/subtitle live in the
  system window toolbar (`.navigationTitle`/`.navigationSubtitle`) — there is NO custom
  header strip below it. The toolbar holds ONLY the standard trailing icon cluster:
  appearance · run-inspector · settings · new (each with a `.help()` tooltip). There is
  **no engine-status capsule and no Refresh button** in the toolbar (custom capsules
  overlapped the window edge and read out-of-app; the engine auto-reconnects on launch
  and over SSE). Project/primary chips live in the composer, not the toolbar.
- **Markdown output surfaces.** Outcome, reports, plans, summaries, and diagnostics
  render native markdown with BLOCK structure: headings get heading type
  styles, paragraphs stay separated (never collapsed into one run-on line),
  list items render as bulleted rows, and fenced code renders on solid
  `surface/code`. Text is selectable. Patch/diff work products are never
  markdown-rendered as Outcome; they belong to the Diff tab parsed from
  `final/patch.diff`. Dense output uses solid `surface/raised`; never put
  Liquid Glass behind dense output.
- **Evidence badges.** Header/timeline badges show output readiness
  (`pending/finalizing/ready/diagnostic`), requested/effective access, web policy,
  web evidence (`none/attempted/satisfied/failed/unverified`), tool errors,
  budget source, artifact path, and route fallback. Badges are projections of
  Control API fields, not UI-invented state. Raw wire strings are humanized
  ("Web verified", not `satisfied`); `unverified` web evidence gets a distinct
  warning treatment from a benign `attempted`; telemetry-unavailable runs say
  so instead of guessing. Engine-typed event severity (info/warning/error)
  tints timeline rows.
- **Read-only report surfaces.** Ask/Audit (single report or research swarm)
  primary output appears in
  Outcome as markdown. Technical artifacts (`context/task.yaml`, `events.jsonl`)
  stay in Diagnostics/artifact lists and must not be transformed into Plan rows.
- **Setup job lifecycle.** Auth/setup sheets show compatible coarse state plus
  the login-only typed phase (`preparing`, `launching`, `awaiting_user`,
  `verifying`, `cancelling`, `completed`), native source
  availability/verification, deadline/countdown, outcome/exit/signal, command
  preview, and official guide. Actions are contextual: Extend 15 min, Cancel
  Login, Retry, Reconnect, and Guide. SSE reconnect begins with GET resnapshot and has five bounded
  retries. The client validates the exact predecessor cursor while allowing
  sparse global journal sequence numbers; malformed, duplicate, regressive,
  dropped, unknown, or prematurely ended streams visibly resnapshot. Exhausted
  transport keeps the honest active job and exposes
  Reconnect instead of inventing failure. Every terminal result triggers a
  fresh harness refresh. A job stuck active after process exit/cancel/timeout/
  restart is a defect, not a state. A filtered active lookup (`harness`,
  `active=true`, `limit=1`) runs when the sheet/app reopens before new actions are enabled,
  so a background login cannot create a duplicate Terminal. Cancel remains in
  progress until the server proves termination; `interrupted_unknown` is a
  terminal unknown outcome rather than success, and `termination_unconfirmed`
  blocks Login/Retry and exposes recovery instead of opening a replacement
  process. API-key storage is an independent secret-store operation and is not
  blocked by a native-login replacement fence. Launch/manual-command failures
  keep the selectable command, official guide, and actionable Retry/Reconnect state.
- **Best-of / candidates.** Per-family candidate lanes; the best-of-N
  "attempts/re-roll" primitive. (See the Candidate cards contract above — the
  Candidates tab renders live server-projected evidence.)
- **Cross-family review (inline, per turn).** Review/findings are NOT a separate
  Review-Queue screen — they live on the turn that produced them and in the run
  inspector's Review tab: severity, finding, reviewer, evidence, and state, on solid
  `surface/code`-backed rows. Local accept/rebut toggles are forbidden unless backed by a
  server endpoint (`POST /runs/:id/decision`).
- **Convergence.** Round timeline; accepted findings fed back; convergence predicate state.
- **Diff + Apply (inline, per turn).** Git-scoped diff from server artifacts, shown in the
  run inspector's Diff tab. Apply/check actions use `POST /runs/:id/apply/check` and
  `POST /runs/:id/apply` (an isolated thread delivers its accumulated diff via
  `POST /threads/:id/apply`). Do not present per-file or per-hunk apply controls until the
  backend exposes selected scope.
- **Decision bar (blocked turns).** A turn whose run is `blocked`/needs-review
  and has NO persisted operator decision renders a decision bar on the turn
  card — typed server decisions via `POST /runs/:id/decision`:
  - "Accept risk & unblock…" → `accept_risk`, with an EDITABLE risks note
    sheet (the operator's own words become the audit record — never a canned
    string);
  - "Rerun with feedback…" → `rerun_with_feedback`, with a real feedback text
    sheet (the ellipsis promises an input, so an input exists);
  - "Override needs-human" → `override_needs_human`, destructive-styled with
    an explicit confirmation dialog (it unblocks apply past a needs-human
    escalation; a mutated patch invalidates the override).
  Apply is offered through the server-gated apply bar once unblocked. The
  unblocked state is server-derived (a persisted decision from ANY surface
  collapses the bar) — never a local accept/unblock flag. The turn's
  apply-state is shown honestly: `applied` is green, `applied_review_blocked`
  is amber (never a green "succeeded"), `reverted` is neutral; while a mutation
  is still safely revertable the turn offers Revert (server-owned `revert_run`;
  it refuses when the tree diverged, and the refusal is surfaced verbatim).
  Apply pre-flight runs when the apply bar appears, so a refusal reason shows
  UP FRONT, not only on press.
- **Thread apply bar (isolated threads).** An isolated thread with runs shows a
  persistent apply affordance for delivering its accumulated worktree diff to
  the project (`POST /threads/:id/apply`). In-place threads write the project
  directly and never show it.
- **Inline failure card.** A terminal turn that FAILED with no answer/transcript
  renders an inline failure card with the engine's honest failure reason,
  instead of reading as idle next to a red status pill. The card also carries
  the run's TYPED failure category as a small chip and the auth route the turn
  actually ran under (from the route receipt) — never inferred from prose.
- **Run route disclosure (Run Detail header).** The finished run's header shows
  the auth route ACTUALLY taken (Subscription / API key, from the engine's
  route receipt; hover reveals requested preference, source, and the typed
  reason) next to the route-proof badge, plus an orange `observed ≠ requested`
  model-mismatch badge when the vendor served a different model than requested.
  A route or model downgrade is visible evidence, never quiet.
- **Refused-turn card + one-click trust.** A turn whose run was refused before
  it started (server-persisted `enqueueError` — e.g. the trust gate rejecting
  `access: full`) renders an inline "Not started" card with the engine's exact
  refusal text. The TRUST refusal carries a one-click remedy — "Allow full
  access & Retry": no confirmation sheet by design; the button label + hover
  help state the persistent user-level grant it performs, then the SAME turn is
  retried (`POST /trust` → `POST /threads/:id/turns/:turnId/retry`, no
  duplicate bubble). Other refusals get a plain Retry. A repeat refusal
  replaces the card's reason; a successful retry replaces the card with the
  live run.
- **Trust section (Settings → Secrets tab).** Lists the projects with
  full access (user-level trust files) with per-row Revoke; legacy
  pre-provenance grants (no recorded repo root) are disclosed as revocable only
  via `claudexor trust` in that repo.
- **Spec interview cards.** The Spec intent runs the server-owned interview as
  cards in the conversation: each round renders the structured multiple-choice
  questions (single/multi/text with options), and the answer card ends with two
  explicit continuations — **"Ask deeper"** (another durable `/spec/sessions` round
  carrying the accumulated `priorDecisions`) and **"Enough — freeze"**
  (`/spec/sessions/:id/freeze` → the frozen SpecPack, then Implement as a normal agent turn
  carrying the returned `specPath`). Spec is a macOS UI intent over the
  server-owned spec flow, not a wire run mode; the grounding plan uses the
  composer's eligible pool with each harness's default model, while the
  per-turn model/budget/access/web/repair options are captured and applied to
  the write Implement turn. Header and action footer remain fixed; the
  potentially long question/options middle is a max-height `ScrollView` with a
  `LazyVStack`, so an interview never grows beyond the window or forces the
  entire card to re-layout on every chip selection. The durable server session
  carries its owning `threadId`; reopening that thread after app restart
  restores the interview and prior answers instead of showing a blank chat.
- **Budget cockpit (Settings tab).** Spend, circuit breaker, portfolio weights,
  pre-exhaustion warnings — a Settings tab, not a top-level screen; the live per-run meter
  rides the run inspector.
- **Harness Doctor — ONE readiness card, three surfaces (F4 V20a/V22a).**
  Settings, Onboarding step 0, and the AuthSheet all render the same
  `HarnessReadinessCard` from one `HarnessReadinessPresentation`: identity
  chip, the SERVER routability truth, a fixed-width health capsule, the
  daemon-normalized TYPED check rows (`readiness` on the DTO: icon by
  pass/fail/skip in a fixed glyph column, name in a fixed name column,
  detail), the strict configured-model verdict, and "Copy raw" for the
  un-normalized evidence. Each surface passes its OWN actions as a
  @ViewBuilder slot — workflows never centralize into one conditional.
  Manifest auth modes are source availability only; nothing renders as ready
  unless doctor/smoke checks pass. Swift renders the typed rows verbatim and
  never parses id substrings or joined prose.
- **AuthSheet (state-driven, F4 V21a).** ONE primary CTA derived from the
  cause in a severity ladder (Reconnect > observe-the-active-job/Done >
  Log in > Store key > Retry check), rendered prominent in the footer with
  Done demoted beside it; secondary actions stay bordered in their panels.
  A setup job speaks with ONE merged status line (state+phase+outcome —
  "Waiting for you to finish the login", "Login verified", "Failed (exit
  1)", "Process termination is unconfirmed"); "Extend login wait (15 min)"
  is offered only for a live login. For account-capable harnesses, the ONE
  `AccountsSurface` owns each row's Log in/Manage action — no duplicate login
  CTA. A healthy sheet closes with the always-visible header Done; the footer
  appears only for a live status or a real primary action. Profile drill-in uses an explicit
  leading **Accounts** back button; every sheet has a labeled trailing
  **Done** button (not an unlabeled x). Back is disabled while an active login
  requires keep-running/cancel confirmation. Owner mapper:
  `AuthSheetPresentation`.
- **Workbench: Run Detail | Canvas.** The trailing region is a Workbench with the
  two labeled planes from §4.
  - **Run Detail** — every run's detail has explicit `Outcome`, `Timeline`,
    `Plan`, `Candidates`, `Diff`, `Review`, `Artifacts`, and `Diagnostics` tabs
    (all eight, via the shared `SegmentedTabs` in a horizontal scroller; the
    Swift `Tab` enum cases are `answer`, `plan`, `activity`, `candidates`,
    `diff`, `review`, `artifacts`, `diagnostics`) —
    inline per-turn review and apply live here, not a separate screen.
    `Outcome` reads the control API `primaryOutput` first and then falls back to
    `final/answer.md`, `final/explore.md`, `final/report.md`, `final/plan.md`, or
    `final/summary.md`. Default tab: completed runs open on `Outcome`, active
    runs on `Timeline`, and failures without output on `Diagnostics` (a blocked
    run with findings opens on `Review` — its deliverable IS the findings that
    need a human). `Artifacts` lists the run's internal orchestration tree
    (`/runs/:id/artifacts`). `Diagnostics` renders bounded typed error/context
    summaries plus raw-evidence paths and byte sizes; full `events.jsonl`,
    rollouts and logs remain one click away in the run folder and are never
    eagerly laid out inline. A failed run must never leave the user hunting for
    invisible logs or freeze the UI by loading them.
  - **Canvas** — the project's PRODUCED outputs, distinct from Run Detail's
    run-internal tree and labeled as such. Two panes: the **artifacts gallery**
    renders the repo `artifacts/` dir via `GET /runs/:id/produced` (images
    inline, text/code readable), and the **mini-browser** (`WKWebView`, driven
    by the user — `loadFileURL` for the project's `index.html`, localhost
    dev-server previews, arbitrary URLs) sits on SOLID surfaces: web content is
    dense content, never glass-backed.
- **Honesty badges.** route-proof (verified / unverified / same-model-fallback), estimated $,
  gate status — quiet, always-on, expandable to evidence.
- **Settings.** Native macOS `Settings` scene (`Cmd+,`) with grouped tabs: General,
  Routing, Harnesses (per-harness defaults + doctor), Budget, Secrets, and
  Appearance. The editable budget cockpit and the Harness Doctor are Settings
  tabs, not top-level screens. (Review is inline per turn, not a Settings
  section; delivery is server-owned via the run decision/apply endpoints.)
  Settings groups are flat, solid, and shadowless. Settings does NOT own
  project selection — there is no Current Project field; the working directory
  is picked only in the chat composer's `ProjectChip`. The Per-Harness Defaults
  editor (enable/disable, model override, effort, web policy, per-harness
  budget cap, tool allow/deny lists, fallback model) **auto-saves** PARTIAL
  patches to the engine config via `/settings` — there is no Save button; an
  empty field is an explicit "clear the override", and in-flight saves must not
  clobber the user's typing. Quick-launch and Retry honor saved engine defaults
  instead of hardcoded portfolio/cap values.
- **Help and tooltips.** Every compact/non-obvious control gets `.help(...)` hover help.
  Mode menus and harness chips expose descriptions on hover directly; do not add a
  separate adjacent info button just to explain a normal mode. Use a richer click popover
  only for risky controls where explanation affects cost, access, auth, routing, or data
  deletion. Future controls must document their consequence at the control, not only in docs.
- **Modal exit and navigation.** Every sheet/popup that can outlive a single click has an
  obvious close or Done affordance in a predictable corner/footer. Wizard-like sheets also
  show Back/Continue where there is a sequence. A user must always know whether they are in
  setup, a blocking task intervention, or a settings subflow, and how to leave without
  guessing.
- **Harness chips.** Chips reflect Gateway status for the active mode intent. A
  harness that is not installed, not authenticated, degraded without the required
  intent, or unable to enforce read-only is visible but disabled, with a hover
  reason and a path to Harness Doctor/Auth setup.
- **Onboarding.** First run is native-first: explain Codex/Claude/Cursor native auth
  and expose daemon-owned native-login jobs, then offer API-key fallback
  that writes only to the local secret store. Claudexor does not broker SaaS OAuth itself; it
  launches each official CLI in Terminal and verifies its native session when available without
  receiving/copying/storing vendor session tokens or credential files. Native
  readiness is distinct from overall/API-key readiness: absent means unavailable/not-run,
  an indeterminate probe remains unknown/not-run, and present-but-unusable is available/failed.
  Login/Manage Login is driven by that native source, never aggregate harness health. The
  sheet never closes/cancels an active login ambiguously: closing offers Keep Running, Cancel
  Login, or Stay, and a background login is recovered when the sheet/app reopens. Terminal is
  not auto-closed; it remains available with the vendor result until the user presses Return.
  The wizard may store secret refs, mark
  setup complete, or skip, but it must not invent app-only auth state. Offline or unimplemented
  surfaces show honest empty states — there is no sample/demo data mode; every surface
  reflects live engine truth.

### 5.1 Component contracts (SSOT for the smallest details)

These are exact, non-negotiable recipes. Screens MUST compose these shared views rather than
re-implement them, so every screen is pixel-consistent. (Swift: Components.swift,
DesignSystemComponents.swift, DesignTokens.swift.)

- **`GlassField`** — the composer input. `TextField(axis:.vertical)` on `surfaceRaised`
  (solid), `Radius.control`, a focus ring (`@FocusState` → `accent` stroke on focus,
  `separator` otherwise) that is **scheme-aware** (alpha 0.85 / width 1.75 in light;
  0.6 / 1.5 in dark — a faint ring is invisible on a white field), animation scoped to
  the stroke overlay only. `.lineLimit(1...maxLines)`. NEVER the glass or code surface.
- **`AccentButtonStyle`** — the Send button (and any "must be visible in both themes"
  prominent action). SOLID `accentSolid` capsule + white text (NOT system
  `.glassProminent`, which can vanish on light-mode glass); dims to
  `accentSolid.opacity(0.35)` when disabled.
- **`ProjectChip`** — the composer's working-directory picker. Capsule (logo + folder
  name + chevron) opening a `Menu` of MRU recents (`model.recentProjects`, persisted) +
  "Browse…" (`NSOpenPanel`). In the draft state it sets the new thread's project; an
  open thread's repo is bound, so picking another project starts a new draft there.
  Highlighted (accent border) when no project is set.
- **`OptionSection` / `OptionRow`** — the "⋯" popover building blocks: a caption-titled
  section, and a `labelWidth`-aligned label+control row (replaces ad-hoc `.fixedSize()` /
  magic-width pickers so every option lines up). Solid surface, token spacing.
- **`composerGlass()`** — the floating-panel glass modifier: static `.glassEffect(.regular)`
  (NOT `.interactive()` — see §3.1) with a `surfaceRaised` solid fallback under Reduce
  Transparency. Chrome only.
- **`PrimaryHarnessChip`** — a single shared view (one instance in the composer controls row),
  logo + label + chevron `Menu`, switching the thread's sticky primary harness (a change
  applies from the next turn).

- **Titles / H1.** Headed surfaces (Settings tabs, the run inspector's `TaskDetail` header)
  use the shared `ScreenHeader` recipe (`.title2.weight(.bold)` + optional `.callout`
  secondary subtitle); never re-implement the title inline. The chat-first main window is
  deliberately header-less: the thread title/subtitle live in the system window toolbar
  (`.navigationTitle`/`.navigationSubtitle`) and the floating composer *is* the hero — the
  conversation does not get a redundant in-content H1.
- **Screen scaffold.** Settings tabs and other scrolling reading surfaces use a standard
  scaffold/`settingsTab` scroll container. Gutter: horizontal `Spacing.xxl` (32), vertical
  `Spacing.xl` (24). Content column is centered and capped at a width token:
  `Layout.contentMaxWidth` (1040) for wide content, `Layout.readableMaxWidth` (860) for
  forms/reading (settings). Backgrounds use the shared solid/glow surface without window-edge
  extension effects. Do **not** hardcode per-screen widths or margins. Nothing may force a
  very wide minimum window; dense content must adapt columns and/or scroll inside its own
  region instead of resizing the whole app window.
- **Segmented tabs.** In-content tab/segment rows use the shared `SegmentedTabs` (one font,
  `Radius.control` indicator via `matchedGeometryEffect`, optional per-tab count badge,
  `.isSelected` trait, Reduce-Motion-aware). Do not hand-roll a tab bar (TaskDetail wraps
  `SegmentedTabs` in a horizontal `ScrollView` so a long tab set never pins a wide minimum).
- **Filter chip.** `FilterChip` is
  the only filter pill: label `.callout` (`.semibold` when active, `.regular` otherwise),
  optional leading SF Symbol `.imageScale(.small)`, optional trailing count `.caption2`
  semibold secondary; padding horizontal `Spacing.md` / vertical `Spacing.sm`; selected fill
  via `selectedChip(active:tint:)`. `tint` defaults to `accent`; pass a status/severity color
  ONLY when the chip *is* that status/severity. The row that hosts the chips
  owns the gutter (token spacing, not per-chip margins). Never hand-roll a chip
  with a different font/padding.
- **Toolbar.** There is exactly ONE window toolbar, defined in `RootView`
  (`ToolbarItemGroup(.primaryAction)`): **appearance · inspector · settings · new**, all
  `.labelStyle(.iconOnly)` with a `.help()` tooltip. There is NO Refresh button (the engine
  auto-reconnects on launch + over SSE) and NO global `.searchable` / status capsule (a custom
  capsule overlapped the window edge and read out-of-app). The thread title/subtitle render in
  the system toolbar via `.navigationTitle`/`.navigationSubtitle` — never a second header strip.
  Project + primary harness chips live in the COMPOSER, not the toolbar. Monochrome SF Symbols;
  don't mix text+icon in one group.
- **Sidebar selection.** The glass sidebar is the THREAD LIST. `List(selection:)` binds a
  `Hashable` route with a distinct case per selectable concept. Every row gets a UNIQUE
  `.tag(…)`; the detail is a `switch` over the route. NEVER alias two concepts to one tag
  (e.g. a thread row must use its own `.thread(id)`, not another thread's id) — shared tags
  make one click select multiple rows.
- **List rows.** A row is a full-width `Button(.plain)` whose action sets the route; row
  content uses the shared row/`FindingCard` views. Run/finding lists render
  each row as its OWN floating row-card — `cardSurface(hover: true)` with
  `Spacing.sm` gaps — not one slab with inset dividers (the floating-rows
  doctrine). The thread sidebar is the exception: it uses
  the native `.sidebar` `List` inside the floating `sidebarGlass` panel per §3.
- **Cards.** One recipe: `cardSurface()` (radius `Radius.card`, 12pt): frosted
  `.regularMaterial` + `surfaceRaised` tint veil, top-lit gradient hairline, one
  scheme-aware separation shadow cast by the shape, optional `hover` lift, and a
  Reduce Transparency solid fallback. `Panel`, `FindingCard` (`clip: true` for its leading
  severity bar), `CandidateCard` (`strokeColor` for the winner emphasis), and
  `InteractionCard` (pending-question emphasis stroke) all call it; do not duplicate
  ad-hoc background+stroke+shadow stacks.

**Known gaps:** colors are a programmatic `Color(dark:light:)` projection rather than an asset
catalog, and there is no Increased-Contrast variant yet (`§2.2`/`§6` aspiration); density is
currently fixed compact; concentric radii (§2.4) are not adopted; a few
tiny count/label pills still carry per-call padding pending a shared CountBadge
component.

---

## 6. Accessibility (required, not optional)

- WCAG AA contrast for all text, especially code/diff on `surface/code`, in every theme.
- Honor Reduce Motion, Reduce Transparency, Increase Contrast, Dynamic Type.
- Full VoiceOver labels (every icon/badge), keyboard navigation, focus order.
- Never encode state with color alone — always glyph + text.

---

## 7. Do / Don't

- Do: use system structure for free Liquid Glass; color = meaning; solid surfaces for code;
  frosted `cardSurface` for content cards (both themes).
- Do: keep core actions one-click; persist layout/density; ship a theme toggle.
- Don't: pure-black dark mode; saturated text on dark; glass behind code; flat opaque
  card slabs with uniform white outlines; invisible dark-mode shadows; color-only status;
  per-command permission nags (use pre-authorized scopes); silent quota lockouts.

---

## 8. Design Review Gate

UI diffs require screenshot evidence for the affected surface in Light and Dark
unless the change is non-visual. Dark screenshots must be checked against the
crisp graphite token direction: lifted cards, clear strokes, strong text
contrast, restrained glow, and no muddy gray fills.

Block a UI change on clipped or overlapping text, hidden terminal/output-ready
state, glass behind dense output, hardcoded colors outside tokens, weak contrast,
fixed-width overflow, technical artifacts shown as user plans/outcomes, or UI
semantics that disagree with CLI/Control API projections for output, web
evidence, tool errors, budget, access, fallback, setup jobs, or artifacts.

---

## 9. References

- Apple: Adopting Liquid Glass; "Build a SwiftUI app with the new design" (WWDC25);
  macOS Tahoe HIG. APIs: `glassEffect(_:in:)`, `GlassEffectContainer`,
  glassEffectID, `.interactive`, `NavigationSplitView`, `.inspector`,
  ConcentricRectangle, `.backgroundExtensionEffect()`, ToolbarSpacer, glass
  button styles.
- Data shapes the UI renders: `@claudexor/schema` (generated JSON Schema → Swift Codable).
