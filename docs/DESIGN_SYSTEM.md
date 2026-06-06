# Claudex for macOS — Design System

Status: living document. SSOT for the native macOS app's visual + interaction design.
Target platform: macOS 26 (Tahoe), SwiftUI/AppKit, Liquid Glass. Apple Silicon.

This document is normative. The app implements these tokens and rules; deviations
must be justified here. It pairs with [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the
app talks to the engine-service) and the build plan.

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
   chrome (sidebar, toolbars, inspector, floating cards, sheets, menus). Code, diffs,
   transcripts, and tables sit on solid, high-contrast surfaces. Never put glass
   behind code text.
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

- `brand/accent` — single Claudex identity accent (a warm, slightly desaturated clay —
  a nod to "Claude × Codex"). Used sparingly for primary actions and selection.
- Accent/tint conveys **meaning**, never decoration (Apple's Tahoe guidance).

Harness-family palette (functional color-coding of candidates/findings/routes):

- `harness/codex`, `harness/claude`, `harness/cursor`, `harness/opencode`, `harness/raw-api`,
  `harness/fake` — each a distinct, AA-legible hue used for candidate chips, race lanes,
  route-proof, and per-harness budget. These are the ONLY place we use multiple strong hues.

Status semantics (shared across badges, pipeline, lists):

- `status/running` (active blue/teal), `status/success` (green), `status/blocked` (amber),
  `status/failed` (red), `status/cancelled` (neutral/gray), `status/interrupted` (muted amber),
  `status/queued` (tertiary).
- Always pair color with a glyph + label (never color alone — accessibility).

### 2.3 Typography

- UI: **SF Pro** (system) via SwiftUI semantic styles (`.largeTitle … .caption2`).
  Respect **Dynamic Type**; do not hardcode point sizes for body UI.
- Code / diffs / transcript / IDs / budgets: **SF Mono**.
- Numerals in meters/budgets: monospaced digits (`.monospacedDigit()`).
- Section headers use title-style capitalization (Tahoe convention), not ALL CAPS.

### 2.4 Spacing, shape, elevation

- Spacing scale (pt): `2, 4, 8, 12, 16, 24, 32, 48`. Default gutter 16; compact 12.
- Corner radii follow **concentricity** (`ConcentricRectangle` / `containerConcentric`)
  so nested controls share corner centers with their container.
- Card radius ~12–16; controls inherit system metrics — do not hardcode control heights.
- Elevation is expressed by Liquid Glass + material layering, not heavy drop shadows.

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

- **Where glass goes:** sidebar, toolbars, the inspector/review panel, floating
  command cards, sheets, popovers, menus, the run composer overlay.
- **Where glass NEVER goes:** behind code, diffs, terminal/transcript output, tables,
  or any dense small text. Those use `surface/code` / `surface/raised` solids.
- Use standard structure (`NavigationSplitView` + `.inspector`, `Toolbar`, `Sheet`) to
  get the material for free; avoid custom backgrounds behind bars/sheets.
- Group custom glass elements in a `GlassEffectContainer`; share a namespace for morphs.
- Use `.backgroundExtensionEffect()` for hero/empty-state imagery under the sidebar.
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
  code. Freeze → versioned, diffable SpecPack. The hero differentiator.
- **Run composer.** Mode (daily/race/until-convergence/max-attempts/plan/create/audit/
  benchmark), harness multiselect (family-colored), n, budget cap, access profile, gates/tests,
  reviewer models.
- **Race / candidates.** Live lanes per family; the best-of-N "attempts/re-roll" primitive.
- **Cross-family review "debates".** `ReviewFinding` cards: severity + category + evidence
  (file:line, diff hunks, commands, logs), reviewer + route-proof status, accept/rebut.
- **Convergence.** Round timeline; accepted findings fed back; convergence predicate state.
- **Diff + Apply + Review queue.** Git-scoped diff (uncommitted / vs base), per-file & per-hunk
  accept/revert, comment-to-steer, open-in-real-editor at line, apply/commit/branch/PR,
  configurable `apply_policy`; a cross-project, risk-sorted review queue.
- **Budget cockpit.** Spend, circuit breaker, portfolio weights, pre-exhaustion warnings.
- **Doctor / Harnesses.** Live `HarnessStatus` (ok/degraded/unavailable), intents, auth.
- **Honesty badges.** route-proof (verified / unverified / same-model-fallback), estimated $,
  gate status — quiet, always-on, expandable to evidence.

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
