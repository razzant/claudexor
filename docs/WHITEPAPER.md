# Claudexor Whitepaper

Claudexor is a local-first control plane for AI coding harnesses. It does not
try to become another model UI or a SaaS broker. It coordinates native
harnesses — Codex CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters,
and future tools — through one typed engine, and exposes that engine through
the CLI, a daemon/control API, MCP/ACP, and a native macOS app.

This document is the CONCEPT: what Claudexor is, why it is shaped this way,
and which alternatives were considered and rejected. It makes no operational
claims — the current runtime map lives in `docs/ARCHITECTURE.md`, the
enforceable invariants in `CLAUDEXOR_BIBLE.md`, the process gates in
`docs/CHECKLISTS.md`. When this document and an operational doc appear to
disagree about mechanics, the operational doc wins; when they disagree about
intent, this document and the Bible win.

## Why A Control Plane

A developer in 2026 holds several coding-agent subscriptions at once. Each
vendor ships a capable CLI with its own sessions, its own auth, its own quota
window, its own strengths. What no vendor ships is the layer ABOVE: one
conversation that can move between them, one place where their accounts and
limits are visible side by side, one honest record of what was actually done
to a repository and by whom.

That layer must be local-first (the repos, credentials, and evidence are on
the user's machine), engine-owned (facts live in one typed contract, not in
whichever UI rendered them), and CLI-first (everything the app can do, a
script can do). The macOS app, the MCP/ACP bridges, and the editor plugins
are deliberately thin: they decode engine state and send typed requests, and
they are forbidden from inventing semantics of their own.

Claudexor is also not a digital entity. It has no personality, no memory
identity, no self-modification doctrine. It is a tool developed BY external
agents, and its immune system exists to constrain those agents' sessions.

## One Conversation, Many Executors

Continuity is the flagship concept. A Thread is ONE conversation owned by
Claudexor; runs are its turns; a vendor CLI session is a re-hostable cache,
never the source of truth.

The executing pair (harness, account) defines a lane within the thread. The
same lane resumes its own native vendor session — the cheapest, highest-
fidelity continuity there is, and the reason read-only turns keep durable
per-lane sessions instead of disposable ones. Switching lanes — another
harness, another subscription of the same harness — must never silently drop
the conversation: the new lane is hydrated with a bounded continuation packet
(recent turns verbatim, a summarized older prefix, accepted decisions, the
active plan, a workspace anchor), and the turn visibly discloses that
hydration. Returning to a previously used lane resumes it natively and
injects only what it missed.

Rejected alternative: porting raw vendor traces between harnesses. Raw traces
are vendor-specific, schema-unstable, full of tool noise and potentially
sensitive tool output, and no vendor supports importing another's session.
Every vendor's own guidance for context handoff is the same: carry the
semantic conversation — turns, decisions, state — not the wire log. Claudexor
follows that: native resume within a lane, a typed packet across lanes.

Silent conversation loss on any switch is classified as data loss, not a UX
blemish. That classification is constitutional (Bible §14).

## Routing Is Not Strategy

Two axes that must never share a control:

- **Routing** picks WHO executes a unit of work: harness + account
  (credential profile) + model. Manually, or policy-driven — including
  quota-aware selection across multiple subscriptions, which is the practical
  reason multi-account support exists at all.
- **Strategy** picks HOW MANY units run and how their results combine: a
  single attempt, N racing candidates, a planning council, a scout swarm, or
  delegated sub-runs.

Accounts are symmetric citizens: the vendor CLI's own login and every added
profile appear in one list with the same controls; the only asymmetry is
ownership (Claudexor never mutates or deletes the vendor's own store).
Selecting an account never narrows the harness pool; choosing a strategy
never pins an account. Quota is read per account from the vendor's own
surfaces, absence is typed and explained, and unknown never renders as zero.

A routing goal answers to the same line. Quality routing compares declared,
comparable options — a named harness, model, and effort for the intent at
hand — so with none declared there is nothing to rank and the run cannot
proceed. That absence is a configuration the user completes, not a harness
the user waits on: Claudexor classifies it as a configuration fault and
points the user at settings, never at re-authentication or a cooldown, for a
gap only a settings change can close.

Rejected alternative: a privileged "orchestrator harness" role. Harnesses are
tools; intents route to whichever tool is ready and capable. A primary
harness exists only as an ordering bias — who answers in chat — never as a
semantic role.

## Conversation Intents, Not A Mode Zoo

A turn carries an intent: asking about the project, planning work, or
building it. Everything else is a strategy flag on one of those intents —
candidate count, repair attempts, scout width, project creation, delegation.
The canonical intent and strategy enumeration is an operational contract
(schema + `docs/ARCHITECTURE.md`), deliberately small, and old spellings
hard-error rather than alias.

Planning is conversational. Claudexor rides each vendor's native plan mode —
they all converge on the same shape: research read-only, ask clarifying
questions, propose, refine — and surfaces the questions as typed cards the
user can answer; each answer round continues the planner's own lane
natively. A plan that still has open questions is not implementable; a plan
whose questions are resolved freezes on implement into a content-hashed
contract file delivered to the executor as a file it can re-read at any
time, not as prompt text pasted into the conversation.

Multi-harness planning is a council, not a concatenation: members draft in
parallel lanes, the primary merges into one plan and one question list, the
user answers once, and every member critiques the merged plan from its own
lane in the next round. The user always faces one document and one batch of
questions.

Delegation is a capability of building, not a mode: an agent turn may be
granted a typed tool belt to spawn isolated read-only scouts and candidate
sub-runs, with server-enforced isolation, depth, count, and budget limits —
and no self-apply tool: the parent integrates results in its own workspace,
and every mutation of the live tree still passes the single delivery gate.

Rejected alternatives, recorded so they stay rejected: a user-facing
"orchestrate" mode (no leading tool exposes orchestration as a mode; users
understand plan modes and agent autonomy, not conductor abstractions); a
structured YAML spec contract as the executor's input (it empirically
degraded into empty ceremony while the real content lived in prose — the
frozen plan document with required sections replaced it); a separate
"best-of" mode (candidate count is a strategy flag).

## Evidence Beats Summaries

Model prose is context, never proof. Work product is proven by git diffs
captured in the execution tree, deterministic checks, reviewer artifacts,
typed events, and recorded side effects. Diffs round-trip byte-faithfully;
a patch that cannot survive re-application to a clean base does not touch
the live tree.

Status is multi-axis and honest: whether the process finished, whether
deterministic checks passed (or none are configured — a distinct, named
state), whether review approved, and whether anything was delivered are
separate facts with separate vocabularies, projected identically by every
surface from one server-owned mapper. "The model says Implemented" is never
allowed to outrank the engine's delivery record: the banner above the prose
belongs to the server. The agent's own honesty is captured too, as a typed
WorkReport it emits in a schema-constrained channel: a run whose process ran
clean but whose model reported it still needs input or left the work
incomplete is disclosed as exactly that — non-applyable, banner "Needs input"
or "Incomplete", and a non-zero shell exit — without pretending the process
failed. A blocked read-only run that produced no answer can no longer read as
"done"; the deliverable is re-checked, so an empty run exits non-zero.

No regex governance: risk, permissions, winners, web evidence, and
tests-passed come from typed contracts and events, never from string-matching
model output. Unknown cost is unknown — subscription valuation, metered cash,
and absence are three different typed facts.

Run evidence lives in two labeled planes: Claudexor's internal orchestration
record (contracts, events, attempts, reviews), and the project's produced
outputs (user deliverables). Surfaces always say which plane they show.

The machine surface obeys one contract: a run verb emits exactly one success
envelope (`{runId, runDir, status, …}`), and every failure — a daemon that will
not start, an attachment that will not upload, a `--resume` with nothing to
continue, a mid-run transport error — is rendered by a single projector into one
typed problem carrying a stable `message`/`code`/exit code, on stdout for
`--json`, one compact line for `--json-stream`, or one stderr line for text. No
command path emits a partial ad-hoc error, and secret-like tokens are redacted at
that one projection point, so a script never has to parse two shapes for the same
class of failure.

## Secrets, Auth, And Isolation

Subscription-first: most users authenticate with the vendor subscriptions
they already pay for; API keys are an explicitly-labeled fallback route,
never the default. Native login remains a vendor ceremony that Claudexor
observes and verifies — it never brokers callbacks, copies tokens, or
mutates the vendor's own store. Additional accounts are additive isolated
profiles with their own vendor-owned state; readiness is always a live
doctor projection in the exact environment a run will use, never a stored
assertion. Raw secrets never become artifacts — prompts included.

Login is run through Claudexor rather than the bare vendor CLI so the session
lands in the Claudexor-scoped store the runs actually read. Codex login
defaults to device-auth (a URL and one-time code in the Terminal), and the
prompt carries an isolation instruction: complete the link in a private
browser context, because a browser-based OAuth completed alongside another
session of the same vendor can invalidate that sibling session server-side —
vendor backend behavior Claudexor discloses and mitigates (device-auth
default, isolation guidance) but never claims to prevent. An interactive login
survives an ordinary daemon restart; an explicit cancel or the login's own
15-minute deadline (extendable) are what end a pending login.

## Workspace Semantics

Chat write turns run in-place on the live tree (the way local coding agents
work), with snapshots and a fenced revert as the safety net; candidates,
scouts, and delegated sub-runs run in isolated envelopes outside the repo.
Write access needs a git boundary — a non-git folder is initialized loudly,
never mutated silently. Vendor homes and scoped auth state live outside every
worktree so `git add -A` can never capture credentials.

Instruction files stay unified. The recommendation is one `AGENTS.md` at the
project root — the file Codex, Cursor, and OpenCode already read natively. So a
Claude Code executor reads the same guidance, Claudexor bridges it with a thin
`CLAUDE.md` (`@AGENTS.md` plus an ownership marker) whenever the root has an
`AGENTS.md` and no `CLAUDE.md`. The bridge is exclusive-create and no-follow, so
a hand-written `CLAUDE.md` is never touched, and it is written both to the
project root (durable, announced as a run event) and into each disposable
envelope worktree — which materializes only committed files — so a candidate
racing in isolation reads it too. The envelope copy stays out of a candidate's
patch only while it provably remains Claudexor's own writing: the diff excludes
it when Claudexor created it during this run AND its bytes still equal the
bridge content exactly — any candidate edit, even one preserving the marker, is
captured as real work rather than discarded.

## The Immune System

Claudexor's development is agent-driven, so the repository defends its own
concept mechanically: a constitution of numbered, individually verifiable
invariants (`CLAUDEXOR_BIBLE.md`), deterministic gates that regenerate
derived artifacts instead of trusting hand-edits, canary user stories that
pin invariants as executable checks, and a bounded release review protocol
with a typed blocker contract (`docs/CHECKLISTS.md`). Reviewers find defects;
they do not author concept — owner decisions and the Bible outrank reviewer
preference, and a finding without evidence blocks nothing.

Rejected alternative: per-commit blocking review of the repository's own
commits. It was tried and retired — it optimized for ceremony over
convergence; the release-cycle protocol with sealed packets and one
confirmation wave replaced it.

## Non-Goals

Not a SaaS, no accounts of its own, no telemetry beyond public download
counts, no autonomous self-modification, no privileged harness, no second
source of truth beside the engine.
