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
inspector. Its single real differentiator from a bare harness is multi-vendor
**race + review** with the winner adopted into the tree. It must feel instantly
familiar to users of Claude Code / Cursor / Codex, with honest run outcomes and a
calm, native, matte-glass surface (the desktop shows faintly through the window;
nothing animates when idle).

Three design commitments:

1. **Content-first; Liquid Glass on the navigation layer; frosted materials on
   content cards (v0.8, user-locked).** `glassEffect` Liquid Glass lives on the
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

---

## 2. Foundations

### 2.1 Appearance

- Support **Light, Dark, and system** following `NSApp.effectiveAppearance`.
- **Signature default is a deep-graphite Dark** ("command center"), never pure black.
  Pure black + saturated text is the exact readability trap competitors fell into;
  we use layered graphite surfaces and desaturated accents. Dark cards use the
  **frosted floating** recipe (see 2.4): system material + graphite tint, a
  top-lit gradient hairline, and a VISIBLE separation shadow — never a flat
  charcoal slab with a uniform white outline (the v0.7 "cheap dark card" trap).
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
- `brand/glowHi`, `brand/glowLo` — cool tonal companions (sky / indigo) used **only** in the
  brand aurora backdrop (never on controls; not semantic).
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
everything that is "the app itself" (chrome, selection, the aurora, links, icons) uses the
single brand steel-blue + neutral graphite. The aurora backdrop is brand-only — it must never
pull in harness or status hues, or the whole window reads as a rainbow. Severity maps onto
the status scale (blocker→failed, major→blocked, minor→running, nit→neutral), not new hues.

### 2.3 Typography

- UI: **SF Pro** (system) via SwiftUI semantic styles (`.largeTitle … .caption2`).
  Respect **Dynamic Type**; do not hardcode point sizes for body UI.
- Code / diffs / transcript / IDs / budgets: **SF Mono**.
- Numerals in meters/budgets: monospaced digits (`.monospacedDigit()`).
- Section headers use title-style capitalization (Tahoe convention), not ALL CAPS.

### 2.4 Spacing, shape, elevation

- Spacing scale (pt): `2, 4, 8, 12, 16, 24, 32, 48` (`Theme.Spacing.xxs…xxxl`). Default gutter
  16; compact 12. Screen gutter is `xxl` (32). Use tokens — never off-scale literals
  (`1,3,5,6` etc.).
- One **radius ladder** (`Theme.Radius`): `control 8` (chips/segments/small code wells),
  `card 8`, `hero 22` (floating composer). Cards stay compact; controls inherit system
  metrics — do not hardcode control heights. (Concentric radii via `ConcentricRectangle` are
  a tracked beta refinement.)
- Elevation — the ONE card recipe (centralized in `cardSurface`, v0.8):
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
    cutout shadows. Row lists (Home, Tasks) are **individual floating
    row-cards with gaps**, not one slab with hairline dividers.

### 2.5 Density

- **Compact by default** (pro density) with a comfortable option in Settings.
  Density adjusts gutters/row heights/inset via a single environment value; never
  hardcode per-view.

### 2.6 Motion

- **Maximal-but-tasteful**: Liquid Glass morphs (`glassEffectID` + `@Namespace`),
  fluid phase-pipeline transitions, lively interactive controls (`.interactive`),
  and animated SF Symbols for state changes.
- **Non-negotiable guardrails:** honor **Reduce Motion** (disable lensing/morph; cross-fade
  instead) and **Reduce Transparency** (fall back to solid surfaces). The always-on
  monitoring surfaces (dashboard telemetry) use calm, low-frequency motion so a multi-hour
  window never becomes distracting; expressive motion is reserved for interactions/transitions.

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
- **Where frosted materials go (v0.8):** content cards and row-cards — the
  `cardSurface` recipe (`.regularMaterial` + tint veil, top-lit hairline,
  scheme-aware shadow). Materials are NOT `glassEffect`; cards never lens or
  morph.
- **Where neither goes:** behind code, diffs, terminal/transcript output,
  tables, or any dense small text. Those use `surface/code` solids.
- Use standard structure (`NavigationSplitView` + `.inspector`, `Toolbar`, `Sheet`) to
  get the material for free; avoid custom backgrounds behind bars/sheets.
- When a view intentionally uses custom morphing glass, group those elements in a
  `GlassEffectContainer` and share a namespace for morphs. Do not require every
  normal screen/card to opt into custom glass.
- Do not put window-edge material or background-extension effects on full-window
  glow layers or repeated per-screen backgrounds. Custom background effects must
  be local, clipped to their owning surface, and visually QAed in dark/light,
  Reduce Transparency, and compact widths.
- Animated `MeshGradient` background points must stay inside the legal `0...1`
  mesh domain. Boundary points may move along their own edge only; moving them
  outside the window can create hard diagonal black/white cutouts under hidden
  titlebars and split views.
- Do not stack glass on glass; do not "glass everything" — it fights legibility and battery.
- Test every screen with Reduce Transparency, Reduce Motion, Increase Contrast, and the
  system Liquid Glass tint settings.

### 3.1 macOS 26 Liquid Glass APIs (the v0.10 redesign — first-class, not availability-gated)

The app targets macOS 26 (Tahoe), so these are used directly (no `if #available`):

- **`glassEffect(.regular[.tint(...)], in: shape)`** — the floating chrome surface
  (composer panel, floating actions). Use **static `.regular`** — NOT `.interactive()`:
  pointer lensing re-composites the glass on every mouse move AND every re-render,
  which was a measured scroll/idle FPS regression on an M5 Max. Apple reserves
  `.interactive()` for elements that physically move under the cursor, not a static
  composer. Reserve `.tint(...)` for one or two primary accents per surface.
- **`GlassEffectContainer { ... }`** — wrap a cluster of glass elements so they share
  one sampling region (constrains the sample zone — it *helps* perf). Group; don't
  scatter bare `glassEffect`s.
- **Native glass button styles** — `.buttonStyle(.glass)` for chrome actions (intent
  menu, project/primary chips, "⋯"). The one prominent action (Send) does NOT use
  `.glassProminent` — system glass-prominent can render near-white on the light-mode
  glass (invisible). Send uses `AccentButtonStyle`: a SOLID accent capsule with white
  text, legible in BOTH themes (WCAG). See §5.1.
- **Behind-window transparency (the desktop shows faintly through the window, Р5)** —
  three pieces, all required: (1) `GlassBackground` → `NSVisualEffectView`
  (`.behindWindow` / `.underWindowBackground`) as the window backdrop; (2) the window
  made non-opaque in `AppDelegate` (`isOpaque=false`, `backgroundColor=.clear`, set
  reliably once the window exists — a per-frame SwiftUI guard never fired); (3)
  `.containerBackground(.clear, for: .window)` + `.toolbarBackgroundVisibility(.hidden,
  for: .windowToolbar)` on the root so the SwiftUI container and toolbar don't paint an
  opaque panel over it. Miss any one and the window reads as solid gray. Reduce
  Transparency → solid `surfaceBase`.
- **Glass vs `Material`** — Liquid Glass is the FLOATING chrome layer; `Material`
  (`.thinMaterial`/`.regularMaterial`, the `cardSurface` recipe) is the CONTENT
  layer. Dense/input content (the composer text field, the "⋯" option rows, code,
  diffs) sits on a **SOLID inset** (`surfaceRaised`/`surfaceCode`) INSIDE the glass —
  never a second `glassEffect` and never a frosted card inside glass.
- **Reduce Transparency** — every custom glass surface needs a SOLID fallback
  (`surfaceRaised` + hairline). `composerGlass` and `GlassBackground` branch on
  `accessibilityReduceTransparency` already; new glass must do the same.
- **Reduce Motion** — gate state-toggle animations (e.g. the "⋯" expand) on
  `accessibilityReduceMotion`; glass lensing/morph degrade to instant.
- References: developer.apple.com — Adopting Liquid Glass, `glassEffect(_:in:)`,
  `GlassEffectContainer`, `GlassButtonStyle`, Materials (HIG); WWDC25 #219/#323/#356.

---

## 4. App shell & information architecture

- Mental model (v0.10, chat-first): **Thread → Turns → (run) Outcome**. A thread is
  the conversation; each turn is a run; the honest outcome (answer / plan / patch)
  lives on the turn.
- Single window, **three regions**:
  - **Thread list (glass sidebar):** the conversations, with a needs-you marker;
    "New" enters the draft state (the first message materializes the thread).
  - **Conversation (frosted cards; code solid):** the turns — prompt, live
    transcript (reasoning + tool calls), honest outcome (plan badge / diffstat /
    winner adopted), decision/apply actions, and the always-live composer.
  - **Run inspector (`.inspector`, glass):** the selected run's detail — diff,
    timeline, review findings, candidates, diagnostics, budget.
- Budget, Harness Doctor, and preferences live in the Settings scene (⌘,), not in
  the main window. Detachable pop-out windows remain out of scope.

---

## 5. Signature surfaces & components

Each component lists purpose + key tokens. Components are reusable SwiftUI views in a
`DesignSystem` module; screens compose them.

- **Mission-control dashboard (signature screen).** A long run at a glance:
  - **Phase pipeline**: contract → context → risk → budget → envelope → gates → review →
    synthesis → arbitration → final, each a node with `status/*` color+glyph; the active
    node animates (calm).
  - **Candidate cards**: per-harness chips colored by `harness/*`, showing gates, cost
    (with estimated-vs-exact badge), review state.
  - **Budget meter**: spend vs cap, circuit-breaker tier, per-harness split; honest quota.
    Money values are typed currency fields when editable; never use a slider for dollar input.
  - **Timeline feed**: streamed `HarnessEvent` transcript with verbosity Verbose/Normal/
    Summary; thinking/tool/file/message rendered distinctly; compact bubbles are collapsed by
    default, raw native details expand inline, and code/log text sits on `surface/code`.
  - **"What changed since you last looked"** marker + an **attention state** (working /
    blocked / needs-permission / done).
- **Chat composer (v0.10 redesign).** ONE floating Liquid-Glass panel
  (`composerGlass` — **static `.regular`**, solid fallback under Reduce Transparency).
  Two stacked zones, all with SOLID contents (no glass-on-glass):
  - a controls row — the intent `Menu` (5 modes: `ask`/`plan`/`audit`/`agent`/Race),
    the `ProjectChip` (the working directory — MRU recent + Browse…; sets the new
    thread's project, an open thread's repo is bound), the `PrimaryHarnessChip` (which
    harness answers in chat; sticky on the thread), and the "⋯" button (`.buttonStyle(.glass)`)
    that opens the advanced options as a native dismissible **`.popover`** — NOT an
    inline panel (the inline version read as glass-on-glass and was cramped);
  - the input — `GlassField`: a `TextField(axis:.vertical)` on a SOLID `surfaceRaised`
    inset with a real focus ring (scheme-aware — heavier in light mode where a faint
    ring vanishes on white) and 1→6-line growth, with `Send` (`AccentButtonStyle` —
    solid accent + white text, visible in BOTH themes, ⌘↩, dims when empty).
  The "⋯" popover holds the harness pool chips, per-turn budget/access/web, and agent
  repair strategies as clean SOLID `OptionSection`/`OptionRow` rows.
  Default intent is `Agent`; project intents need a project; a **no-project thread is
  `Ask`-only** — the controls row hides the primary/"⋯" affordances and shows an inline
  "Pick a project to use Agent · Plan · Race" hint, the `ProjectChip` highlighted as the
  affordance (no sending into the void). The draft-state first message materializes the
  thread. The composer's intent menu surfaces FOUR canonical modes — `ask` / `agent` /
  `plan` / `audit` — plus **Race** (which is `agent` + the best-of-N strategy flag, not a
  mode). The fifth canonical mode `orchestrate` (and `explore` / `create`) are intentionally
  **CLI-only**: they are power-user / scripted flows, so the composer keeps the everyday
  surface small. race width / until-clean / attempts are engine strategy flags, not modes.
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
- **Read-only report surfaces.** Ask/Explore/Audit primary output appears in
  Outcome as markdown. Technical artifacts (`context/task.yaml`, `events.jsonl`)
  stay in Diagnostics/artifact lists and must not be transformed into Plan rows.
- **Setup job states.** Auth/setup sheets show queued/running/waiting/succeeded/
  failed/cancelled, command preview, risk flags, started time, first output,
  latest output, terminal result, retry count, doctor result, and log path.
  Sheets POLL the job to its terminal state (or consume the job SSE stream) and
  then re-run the harness doctor; a job stuck on "running" forever in the UI is
  a defect, not a state.
- **Race / candidates.** Live lanes per family; the best-of-N "attempts/re-roll" primitive.
- **Cross-family review.** Solid-grid Review Queue: severity, finding, task, reviewer,
  evidence, and state columns. Cards can still appear in task detail, but local accept/rebut
  toggles are forbidden unless backed by a server endpoint.
- **Convergence.** Round timeline; accepted findings fed back; convergence predicate state.
- **Diff + Apply + Review queue.** Git-scoped diff from server artifacts. Apply/check actions
  use `POST /runs/:id/apply/check` and `POST /runs/:id/apply`. Do not present per-file or
  per-hunk apply controls until the backend exposes selected scope.
- **Budget cockpit.** Spend, circuit breaker, portfolio weights, pre-exhaustion warnings.
- **Harness Doctor.** Live `HarnessStatus` (ok/degraded/unavailable), intents, auth.
  Manifest auth modes are source availability only; installed/session/key-present
  must not be rendered as ready unless doctor/smoke checks pass. Rows should
  separate Installed, Auth source, Smoke-ready, and Routable states.
- **Run detail diagnostics.** Every live run detail has explicit `Outcome`, `Timeline`,
  and `Diagnostics` tabs. `Outcome` reads the control API `primaryOutput` first and then
  falls back to `final/answer.md`, `final/explore.md`, `final/report.md`, `final/plan.md`, or
  `final/summary.md`. Active runs default to `Timeline`; completed runs default to
  `Outcome`; failures without output default to `Diagnostics`. `Diagnostics` reads engine
  error, `context/context_error.md`, `events.jsonl`, `arbitration/decision.yaml`,
  `final/work_product.yaml`, and artifact paths. A failed run must never leave the user
  hunting for invisible logs.
- **Honesty badges.** route-proof (verified / unverified / same-model-fallback), estimated $,
  gate status — quiet, always-on, expandable to evidence.
- **Settings.** Native macOS `Settings` scene (`Cmd+,`) with grouped sections: General,
  Appearance, Projects, Agent & Routing, Harness Doctor & Auth, Per-Harness
  Defaults, Secrets, Budget, Review, Delivery, Advanced & About. Settings
  groups are flat, solid, and shadowless. The Per-Harness Defaults editor
  (enable/disable, model override, effort, web policy) saves PARTIAL patches to
  the engine config via `/settings`; quick-launch and Retry honor saved engine
  defaults instead of hardcoded portfolio/cap values.
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
- **Onboarding.** First run is native-first: explain Codex/Claude/Cursor/OpenCode native auth
  and expose setup jobs for official install/login/doctor flows, then offer API-key fallback
  that writes only to the local secret store. Claudexor does not broker SaaS OAuth itself; it
  reuses each CLI's native login/session when available. The wizard may store secret refs, mark
  setup complete, or skip, but it must not invent app-only auth state. Offline or unimplemented
  surfaces show honest empty states; sample data is opt-in from Settings.

### 5.1 Component contracts (SSOT for the smallest details)

These are exact, non-negotiable recipes. Screens MUST compose these shared views rather than
re-implement them, so every screen is pixel-consistent. (Swift: `Components.swift`,
`DesignSystemComponents.swift`, `DesignTokens.swift`.)

- **`GlassField`** — the composer input. `TextField(axis:.vertical)` on `surfaceRaised`
  (solid), `Radius.control`, a focus ring (`@FocusState` → `accent` stroke on focus,
  `separator` otherwise) that is **scheme-aware** (alpha 0.85 / width 1.75 in light;
  0.6 / 1.5 in dark — a faint ring is invisible on a white field), animation scoped to
  the stroke overlay only. `.lineLimit(1...maxLines)`. NEVER the glass or code surface.
- **`AccentButtonStyle`** — the Send button (and any "must be visible in both themes"
  prominent action). SOLID `accent` capsule + white text (NOT system `.glassProminent`,
  which can vanish on light-mode glass); dims to `accent.opacity(0.35)` when disabled.
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

- **Screen header / H1.** Every primary screen shows ONE title via the shared `ScreenHeader`
  (`.title2.weight(.bold)` + optional `.callout` secondary subtitle) — either through
  `ScreenScaffold` (scrolling content), `ListScreen` (title + filter bar + collection), or
  `TaskDetail`'s header. No screen may start straight into content with no title (Home is the
  one deliberate exception: its floating composer *is* the hero). All screen H1s use the same
  recipe — never re-implement the title inline.
- **Screen scaffold.** Standard screens use `ScreenScaffold(title:subtitle:)`. List screens
  (Tasks, Review) use `ListScreen(title:) { filters } content: { … }`. Gutter: horizontal
  `Spacing.xxl` (32), vertical `Spacing.xl` (24). Content column is centered and capped at a
  width token: `Layout.contentMaxWidth` (1040) for dashboards/lists, `Layout.readableMaxWidth`
  (860) for forms/reading (interview, settings). Screen backgrounds use the
  shared solid/glow surface without window-edge extension effects. Do **not**
  hardcode per-screen widths or margins. No screen may force a very wide minimum window;
  dense grids must adapt columns and/or scroll inside their content region instead of
  resizing the whole app window.
- **Segmented tabs.** In-content tab/segment rows use the shared `SegmentedTabs` (one font,
  `Radius.control` indicator via `matchedGeometryEffect`, optional per-tab count badge,
  `.isSelected` trait, Reduce-Motion-aware). Do not hand-roll a tab bar (TaskDetail wraps
  `SegmentedTabs` in a horizontal `ScrollView` so a long tab set never pins a wide minimum).
- **Filter bar + chip.** Every filter row is `FilterBar { FilterChip(...) }`. `FilterChip` is
  the only filter pill: label `.callout` (`.semibold` when active, `.regular` otherwise),
  optional leading SF Symbol `.imageScale(.small)`, optional trailing count `.caption2`
  semibold secondary; padding horizontal `Spacing.md` / vertical `Spacing.sm`; selected fill
  via `selectedChip(active:tint:)`. `tint` defaults to `accent`; pass a status/severity color
  ONLY when the chip *is* that status/severity. `FilterBar` owns the gutter (horizontal
  `Spacing.xxl`, vertical `Spacing.lg`). Never hand-roll a chip with a different font/padding.
- **Toolbar.** There is exactly ONE window toolbar, defined in `RootView`
  (`ToolbarItemGroup(.primaryAction)`): **appearance · inspector · settings · new**, all
  `.labelStyle(.iconOnly)` with a `.help()` tooltip. There is NO Refresh button (the engine
  auto-reconnects on launch + over SSE) and NO global `.searchable` / status capsule (a custom
  capsule overlapped the window edge and read out-of-app). The thread title/subtitle render in
  the system toolbar via `.navigationTitle`/`.navigationSubtitle` — never a second header strip.
  Project + primary harness chips live in the COMPOSER, not the toolbar. Monochrome SF Symbols;
  don't mix text+icon in one group.
- **Sidebar selection.** `List(selection:)` binds `SidebarRoute` (a `Hashable` enum with a
  distinct case per selectable concept). Every row gets a UNIQUE `.tag(SidebarRoute.…)`; the
  detail is a `switch` over the route. NEVER alias two concepts to one tag (e.g. a spec row
  must use `.spec(id)`, not the first run's `.task(id)`) — shared tags make one click select
  multiple rows.
- **List rows.** A row is a full-width `Button(.plain)` whose action sets the route; row
  content uses `TaskRowView`/`FindingCard`. Run lists (Home sections, Tasks) render each
  row as its OWN floating row-card — `cardSurface(hover: true)` with `Spacing.sm` gaps —
  not one slab with inset dividers (v0.8 floating-rows decision).
- **Cards.** One recipe: `cardSurface()` (radius `cardRadius` 8): frosted
  `.regularMaterial` + `surfaceRaised` tint veil, top-lit gradient hairline, one
  scheme-aware separation shadow cast by the shape, optional `hover` lift, and a
  Reduce Transparency solid fallback. `Panel`, `FindingCard` (`clip: true` for its leading
  severity bar), `CandidateCard` (`strokeColor` for the winner emphasis), and
  `InteractionCard` (pending-question emphasis stroke) all call it; do not duplicate
  ad-hoc background+stroke+shadow stacks.

**Known gaps:** colors are a programmatic `Color(dark:light:)` projection rather than an asset
catalog, and there is no Increased-Contrast variant yet (`§2.2`/`§6` aspiration); density is
currently fixed compact; concentric radii (`ConcentricRectangle`, `§2.4`) are not adopted; a few
tiny count/label pills still carry per-call padding pending a shared `CountBadge`.

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
  macOS Tahoe HIG. APIs: `glassEffect(_:in:)`, `GlassEffectContainer`, `glassEffectID`,
  `.interactive`, `NavigationSplitView`, `.inspector`, `ConcentricRectangle`,
  `.backgroundExtensionEffect()`, `ToolbarSpacer`, glass button styles.
- Data shapes the UI renders: `@claudexor/schema` (generated JSON Schema → Swift Codable).
