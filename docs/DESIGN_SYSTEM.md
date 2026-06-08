# Claudex for macOS — Design System

Status: living document. SSOT for the native macOS app's visual + interaction design.
Target platform: macOS 26 (Tahoe), SwiftUI/AppKit, Liquid Glass. Apple Silicon.

This document is normative. The app implements these tokens and rules; deviations
must be justified here. It pairs with [`../CLAUDEX_BIBLE.md`](../CLAUDEX_BIBLE.md)
(product constitution), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the app talks
to the engine-service), and the build plan.

---

## 1. North star

Claudex is an expressive, native **mission-control** for autonomous AI coding agents:
a structured spec interview turns a vague task into a frozen ТЗ (SpecPack), then
agents run autonomously for hours-to-days across multiple parallel projects, with a
human reviewing and approving the results. The feel is a **Liquid Glass showcase** —
beautiful, alive, and unmistakably native — while staying legible for developers new
to Claudex and instantly familiar to users of Codex App and Claude Code.

Three design commitments:

1. **Content-first, glass on the navigation layer only.** Liquid Glass lives on the
   chrome (sidebar, toolbars, inspector, floating composer/action controls,
   sheets, menus). Ordinary cards, settings groups, code, diffs, transcripts,
   and tables sit on solid, high-contrast surfaces. Never put glass behind code
   text or dense content.
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
  we use layered graphite surfaces and desaturated accents.
- A user-facing **Appearance** control (Light / Dark / System) is required from day one.
  Do not ship a single forced theme with no toggle.

### 2.2 Color tokens (semantic, not raw)

Define colors as semantic tokens in an asset catalog with Light/Dark + Increased
Contrast variants. Never hardcode hex in views.

Surfaces (Dark default shown; Light mirrors with inverted luminance):

- `surface/base` — window background, deep graphite (e.g. ~ `#1A1B1E`), not `#000`.
- `surface/raised` — cards, lists (~ `#212327`).
- `surface/overlay` — popovers/sheets content backing (above glass).
- `surface/code` — editor/diff/transcript background, solid, max legibility (~ `#16171A`).
- `separator` — hairline dividers; respects Increase Contrast.

Text:

- `text/primary`, `text/secondary`, `text/tertiary`, `text/onAccent`.
- Body/code text on `surface/code` must hit **WCAG AA 4.5:1** (verify every theme).

Brand + accent:

- `brand/accent` — single Claudex identity accent (a cool, slightly desaturated
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
- Elevation: glass + material layering for chrome; a solid content card may carry **one**
  soft separation shadow (`black 8%, radius 6, y 2`, centralized in `cardSurface`) for
  dark-mode contrast against the glow. Settings groups are flat and use no shadow. No heavy,
  stacked, or black cutout shadows.

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
- A small set of custom marks: the Claudex app icon (Icon Composer, layered,
  Light/Dark/Clear/Tinted) and harness-family glyphs.

---

## 3. Liquid Glass rules

- **Where glass goes:** sidebar, toolbars, the inspector/review panel, the
  floating composer, action controls, sheets, popovers, and menus.
- **Where glass NEVER goes:** behind code, diffs, terminal/transcript output, tables,
  or any dense small text. Those use `surface/code` / `surface/raised` solids.
- Use standard structure (`NavigationSplitView` + `.inspector`, `Toolbar`, `Sheet`) to
  get the material for free; avoid custom backgrounds behind bars/sheets.
- When a view intentionally uses custom morphing glass, group those elements in a
  `GlassEffectContainer` and share a namespace for morphs. Do not require every
  normal screen/card to opt into custom glass.
- Do not put `.backgroundExtensionEffect()` on the full-window glow or repeated
  per-screen backgrounds. It can create hard black/white rounded-window side
  cutouts. If a future hero uses background extension, it must be local,
  visually QAed in dark/light, Reduce Transparency, and compact widths.
- Animated `MeshGradient` background points must stay inside the legal `0...1`
  mesh domain. Boundary points may move along their own edge only; moving them
  outside the window can create hard diagonal black/white cutouts under hidden
  titlebars and split views.
- Do not stack glass on glass; do not "glass everything" — it fights legibility and battery.
- Test every screen with Reduce Transparency, Reduce Motion, Increase Contrast, and the
  system Liquid Glass tint settings.

---

## 4. App shell & information architecture

- Mental model: **Project → Spec (ТЗ) → Run → Candidates**.
- Single window, **`NavigationSplitView`** three-region (Codex-style):
  - **Sidebar (glass):** Projects, each expanding to its Specs/Runs; a top-level
    **Portfolio** item (cross-project mission control) and status filter (running /
    needs-review / blocked / done).
  - **Content (solid):** the active surface — spec interview, run composer, the
    mission-control dashboard, diff/review, etc.
  - **Inspector (`.inspector`, glass):** context for the selection — findings, route
    proof, evidence, budget, run metadata.
- Detachable pop-out windows are out of scope for v1 (single-window decision).

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
  - **Activity feed**: streamed `HarnessEvent` transcript with verbosity Verbose/Normal/
    Summary; thinking/tool/file/message rendered distinctly; code on `surface/code`.
  - **"What changed since you last looked"** marker + an **attention state** (working /
    blocked / needs-permission / done).
- **Spec interview (quiz cards).** Hierarchical, AI-generated question cards: single/multi
  choice + free text, tier progress, `NEEDS_CLARIFICATION` chips, deep-link citations into
  code. It is Plan/draft-owned, not a permanent top-level sidebar item.
- **Run composer.** Mode (`Ask`, `Explore`, `Agent`, `Best-of-N`, `Max Attempts`,
  `Until Clean`, `Plan`, `Create`, `Read-only Audit`, `Benchmark`), Current Project,
  Project Context (`Auto`/`Deep` when a project is selected; internal `Off` only for
  no-project Ask), harness multiselect as eligible pool
  (family-colored), Primary harness, Portfolio, model hint, N, budget cap, access profile,
  gates/tests. Default mode is `Ask`. Project-aware modes are disabled until Current
  Project is selected; Ask can run without a project.
- **Race / candidates.** Live lanes per family; the best-of-N "attempts/re-roll" primitive.
- **Cross-family review.** Table-first Review Queue: severity, finding, task, reviewer,
  evidence, and state columns. Cards can still appear in task detail, but local accept/rebut
  toggles are forbidden unless backed by a server endpoint.
- **Convergence.** Round timeline; accepted findings fed back; convergence predicate state.
- **Diff + Apply + Review queue.** Git-scoped diff from server artifacts. Apply/check actions
  use `POST /runs/:id/apply/check` and `POST /runs/:id/apply`. Do not present per-file or
  per-hunk apply controls until the backend exposes selected scope.
- **Budget cockpit.** Spend, circuit breaker, portfolio weights, pre-exhaustion warnings.
- **Harness Doctor.** Live `HarnessStatus` (ok/degraded/unavailable), intents, auth.
- **Run detail diagnostics.** Every live run detail has explicit `Answer` and
  `Diagnostics` tabs. `Answer` reads `final/answer.md`, `final/report.md`, or
  `final/summary.md`. `Diagnostics` reads engine error, `context/context_error.md`,
  `events.jsonl`, `arbitration/decision.yaml`, `final/work_product.yaml`, and
  artifact paths. A failed run must never leave the user hunting for invisible logs.
- **Honesty badges.** route-proof (verified / unverified / same-model-fallback), estimated $,
  gate status — quiet, always-on, expandable to evidence.
- **Settings.** Native macOS `Settings` scene (`Cmd+,`) with grouped sections: General,
  Appearance, Projects, Agent & Routing, Harness Doctor & Auth, Secrets, Budget, Review, Delivery,
  Advanced & About. Settings groups are flat, solid, and shadowless.
- **Help and tooltips.** Every compact/non-obvious control gets `.help(...)` hover help.
  Mode menus and harness chips expose descriptions on hover directly; do not add a
  separate adjacent info button just to explain a normal mode. Use a richer click popover
  only for risky controls where explanation affects cost, access, auth, routing, or data
  deletion. Future controls must document their consequence at the control, not only in docs.
- **Harness chips.** Chips reflect Gateway status for the active mode intent. A
  harness that is not installed, not authenticated, degraded without the required
  intent, or unable to enforce read-only is visible but disabled, with a hover
  reason and a path to Harness Doctor/Auth setup.
- **Onboarding.** First run is native-first: explain Codex/Claude/Cursor/OpenCode native auth
  and guided official install/login flows, then offer API-key fallback that writes only to the
  local secret store. Claudex does not broker SaaS OAuth itself; it reuses each CLI's native
  login/session when available. The wizard may store secret refs, mark setup complete, or skip,
  but it must not invent app-only auth state. Offline or unimplemented surfaces show honest
  empty states; sample data is opt-in from Settings.

### 5.1 Component contracts (SSOT for the smallest details)

These are exact, non-negotiable recipes. Screens MUST compose these shared views rather than
re-implement them, so every screen is pixel-consistent. (Swift: `Components.swift`,
`DesignTokens.swift`.)

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
  hardcode per-screen widths or margins.
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
- **Toolbar + search.** There is exactly ONE window toolbar, defined in `RootView`
  (`ToolbarItemGroup(.primaryAction)`): refresh · appearance · inspector · new-task. Search is
  declared ONCE via `.searchable` on the `NavigationSplitView` (WWDC25 "Build a SwiftUI app
  with the new design") so the affordance is identical on every screen; bind it to
  `AppModel.searchQuery` and have list screens filter by it; the query is **cleared on every
  route change** so one screen's search never leaks into the next. Screens MUST NOT add their
  own `.searchable` or toolbar items (that reflows the glass toolbar and breaks consistency).
  Prefer `ToolbarSpacer` for grouping; monochrome SF Symbols; don't mix text+icon in one group.
- **Sidebar selection.** `List(selection:)` binds `SidebarRoute` (a `Hashable` enum with a
  distinct case per selectable concept). Every row gets a UNIQUE `.tag(SidebarRoute.…)`; the
  detail is a `switch` over the route. NEVER alias two concepts to one tag (e.g. a spec row
  must use `.spec(id)`, not the first run's `.task(id)`) — shared tags make one click select
  multiple rows.
- **List rows.** A row is a full-width `Button(.plain)` whose action sets the route; row
  content uses `TaskRowView`/`FindingCard`. Inter-row dividers inset `.leading 56` (icon
  column). Rows live inside a `Panel(padding: 0)`.
- **Cards.** One recipe: `cardSurface()` (radius `cardRadius` 8, `cardStroke`, one soft
  shadow) on a solid `surfaceRaised`. `Panel`, `FindingCard` (`clip: true` for its leading
  severity bar), and `CandidateCard` (`strokeColor`/`lineWidth` for the winner emphasis) all
  call it; do not duplicate ad-hoc background+stroke+shadow stacks.

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

- Do: use system structure for free Liquid Glass; color = meaning; solid surfaces for code.
- Do: keep core actions one-click; persist layout/density; ship a theme toggle.
- Don't: pure-black dark mode; saturated text on dark; glass behind code; color-only status;
  per-command permission nags (use pre-authorized scopes); silent quota lockouts.

---

## 8. References

- Apple: Adopting Liquid Glass; "Build a SwiftUI app with the new design" (WWDC25);
  macOS Tahoe HIG. APIs: `glassEffect(_:in:)`, `GlassEffectContainer`, `glassEffectID`,
  `.interactive`, `NavigationSplitView`, `.inspector`, `ConcentricRectangle`,
  `.backgroundExtensionEffect()`, `ToolbarSpacer`, glass button styles.
- Data shapes the UI renders: `@claudex/schema` (generated JSON Schema → Swift Codable).
