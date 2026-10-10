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

An embedding application may own runtime lifecycle while reusing the full
control plane. Ownership of generated integration files does not transfer
authority to start another process; the [explicit host binding](INTEGRATIONS.md#externally-owned-host-integrations)
keeps those responsibilities distinct.

Claudexor is also not a digital entity. It has no personality, no memory
identity, no self-modification doctrine. It is a tool developed BY external
agents, and its immune system exists to constrain those agents' sessions.

## Caller-Owned Model Use

An application that already owns its reasoning loop can use a connected account
for a model generation without delegating an agent session. Its system prompt,
conversation and tool execution remain its own; Claudexor translates the model
exchange and reports what happened. This reuses the account and control plane
instead of embedding another relay or importing the person's ordinary CLI login.

The caller can also retain opaque provider transport state for its live reasoning
turn. Claudexor binds this state to the actual account and model, preserves it
through body failures, and leaves turn lifetime with the caller. It does not
create a second conversation store or retry an uncertain generation.

Discovery and admission are separate facts. A vendor catalog can lag a model
that an explicit request already names; the source declares whether that absence
is authoritative or advisory. Permitting the attempt never invents capabilities
or successful execution, and authentication, quota and failed discovery retain
their actual causes. Vendor program maintenance likewise belongs to the engine:
surfaces share the selected installation's update capability and observed result,
while the caller decides when to update and whether to continue its work.

Model content and authorization are distinct responsibilities. The caller's model
payload keeps its supplied content, including examples that resemble credentials;
the adapter's own authorization never enters that payload. Temporary exchange
bytes support result recovery, while compact receipts retain operation identity.
The calling application remains responsible for conversation history. This narrow
content boundary does not change the protections on Agent tasks and attachments.

A caller can retain failed-response source evidence in that same private exchange,
so a lost connection and a local interpretation failure remain reconstructible.
The evidence describes only bytes actually received. Provider completion and the
ability to use its message are separate facts: rejecting a message does not erase
the provider's terminal outcome or reported usage, and it never implies a retry.

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
- **Strategy** picks HOW work is multiplied and combined: one candidate lane
  (repair attempts stay inside that lane), N racing candidates, a planning
  council, a scout swarm, or delegated sub-runs.

An ordinary executor call does not implicitly recruit model reviewers. Review
is a separate, visible intention: an explicit panel or review choice requests
it, and strategies that promise reviewed comparison retain it. Permission to
apply and verification evidence are separate facts. Deliberately unreviewed
work can be delivered under the independent patch and check contracts without
claiming that a reviewer approved it; historical runs retain the intention
under which they were accepted.

Accounts are symmetric citizens — literally one kind: every account is a
named registry row with the same Enabled toggle and the same Remove, and an
existing legacy default-store login is absorbed into that model as an
ordinary row at startup (its credential bytes never move; the vendor's
ordinary host stores are never read or mutated). An unpinned run routes
through the quota-aware pool of enabled ready rows, an unpinned conversation
stays sticky on its account and switches only with a disclosed lane change,
and an explicit pin is strict — that account or a typed refusal. A Cursor
probe timeout may use that store's bounded previous positive for unpinned
selection, disclosed as stale unknown; it never becomes a fresh authentication
claim or relaxes an explicit pin. Managed login invalidates the affected
observations through the existing setup lifecycle.
Catalog visibility and execution eligibility are different facts. Discovery can
show the separate inventories of enabled accounts, including unavailable ones,
without implying that their combined capabilities belong to any single route.
Selecting an account never narrows the harness pool; choosing a strategy
never implicitly pins an account, while an explicit reviewer-slot pin does.
Quota is read per account from the vendor's own
surfaces, model-scoped windows and typed model-family rejections apply only to
their declared aliases, advisory warnings do not become cooldowns, absence is
typed and explained, and unknown never renders as zero. A failed refresh remains
explainable alongside stale last-known data without presenting it as a fresh observation. Older unclassified refusals may yield to a recognized newer
vendor observation, including early quota resets, while separately established
limits remain applicable. The retirement survives replay. Usage-statistics failures
never imply that every subscription is spent; unrelated account polling continues.
Observing Accounts reuses the first acquisition until an explicit or credential-driven
refresh, without a client view continuously spawning vendor checks.
Passive quota consumers may directly request per-window freshness without
requiring operation discovery: a reset in one
window need not stale a sibling whose own observation is still current.
Fully valid legacy responses retain conservative snapshot freshness; missing
metadata never implies a fresh window, and partial explicit metadata is rejected.
This display projection preserves the conservative snapshot used by routing,
the original observation time and usage, and unknown values; it never invents
refill or triggers provider work. An account reset still makes earlier evidence
historical for every window.

Account resources extend that same observation owner with independently aged
balances, spending facts and reset offers. An explicit reset is a durable direct
command outside inference capacity: its original account binding and request key
survive response loss, while provider effect and subsequent readback remain
separate. GUI, CLI and MCP consume the same contract; the existence of a balance
or reset never creates an automatic spending strategy.

A saved login and a vendor accepting that credential are different facts.
Observations from ordinary work should improve the same account view and selection
that admitted the work, even when the account was pinned. Their authority is bound
to the identity and credential generation that produced them, so a late result
cannot rewrite a newer login. This does not require a new login manager or extra
probe work on every completion.

Likewise, one measured window is useful without pretending to be a complete
subscription inventory. Passive native measurements keep independent ages and
scope, while full refreshes retain their separate coverage and failure evidence.
This reuses information already obtained during work without claiming that an
idle account has been checked or that vendor throttling disappeared.

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

Processing is a separate service preference for the selected model. A request,
a submitted native control and observed service are independent evidence;
changing service does not redefine routing or strategy. The advisory rule has
one home in [DEVELOPMENT](DEVELOPMENT.md#processing-preference).

## Conversation Intents, Not A Mode Zoo

A turn carries an intent: asking about the project, planning work, or
building it. Everything else is a strategy flag on one of those intents —
candidate count, repair attempts, scout width, project creation, delegation.
The canonical intent and strategy enumeration is an operational contract
(schema + `docs/ARCHITECTURE.md`), deliberately small, and old spellings
hard-error rather than alias.

Planning is conversational. Claudexor rides each vendor's native read-only
planning surface. Cursor uses its read-only Ask transport because native Plan
terminates through a tool schema that cannot carry the final WorkReport footer
Claudexor asks for; the plan intent still comes from Claudexor's planning prompt. The
lanes converge on the same shape: research read-only, ask clarifying questions,
propose, refine — and surface the questions as typed cards the user can answer;
each answer round continues the planner's own lane natively. Open questions
block implementation by default; an explicit **Implement anyway** choice may
override that readiness check, and the resulting turn records the override.
Otherwise, a plan whose questions are resolved freezes on implement into a
content-hashed contract file delivered to the executor as a file it can re-read
at any time, not as prompt text pasted into the conversation.

Multi-harness planning is a council, not a concatenation: members draft in
parallel lanes, an admitted member merges into one plan and one question list, the
user answers once, and the user always faces one document and one batch of
questions.

A useful idea can survive a contradictory completion report without becoming a
verified claim. Council preserves that draft and its original failure as explicitly
unverified source material for the merger; the final plan remains responsible for
its own completeness. Planning completion concerns the assigned plan itself,
not the future implementation it describes.

Delegation is a capability of building, not a mode: an agent turn may be
granted a typed tool belt to spawn isolated read-only scouts and candidate
sub-runs, with server-enforced isolation, depth, count, and budget limits —
and no self-apply tool: the parent integrates results in its own workspace,
and every mutation of the live tree still passes the single delivery gate.
The grant is permission, not an obligation to create a child. Its absence or
degradation stays visible, and only engine-recorded Claudexor lineage counts as
a delegated child; a vendor's own internal subagent is a different mechanism,
not evidence that the Claudexor tool belt worked. One daemon-lifetime family
authority admits at most eight direct children, shares reservations and
settlements, closes admission before cascade cancellation, and delays the
parent terminal receipt until child spending can no longer arrive late.
Because this belt is an explicitly required capability after injection, an
unrecovered exact belt-operation failure cannot be hidden by a parent
deliverable or native subagent; only a matching operation success recovers it.
Children are pinned by the engine to the original user project rather than the
parent's temporary envelope, so model-supplied paths cannot change that trust
boundary. An envelope result from a failed operation remains diagnostic; an
explicitly in-place run records already-written bytes honestly. Git-backed
changes may retain a fenced revert anchor, while direct directory effects keep
their separate observation limits.

Rejected alternatives, recorded so they stay rejected: a user-facing
"orchestrate" mode (no leading tool exposes orchestration as a mode; users
understand plan modes and agent autonomy, not conductor abstractions); a
structured YAML spec contract as the executor's input (it empirically
degraded into empty ceremony while the real content lived in prose — the
frozen plan document with required sections replaced it); a separate
"best-of" mode (candidate count is a strategy flag).

## Evidence Beats Summaries

Model prose is context, never proof. Work product is proven by Git diffs or
complete file manifests captured in the execution tree, deterministic checks,
reviewer artifacts, typed events, and recorded side effects. Diffs round-trip
byte-faithfully; a patch that cannot survive re-application to a clean base does not touch
the live tree. A copied file result likewise binds the complete selected input
and output bytes, so a preview limit or an empty text diff cannot erase a binary,
large or file-only outcome. Direct effects carry their actual observation limits.

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

Preservation and acceptance are separate promises. Work already observed remains
useful after a failure or cancellation, even when it is not a completed answer.
A readable projection of that evidence keeps its attempts distinct and presents
the original cause before the text. It does not infer completion, regenerate the
answer, or turn Stop into rollback. Recorded file effects can offer the existing
explicit Revert only when their exact execution-tree evidence supports it.

Every terminal run seals these axes into one immutable RunFacts receipt. The
orchestrator builds it once from canonical artifacts, validates its
cross-axis invariants, embeds the exact object in the terminal journal event,
and persists it as `final/run_facts.yaml`; CLI, control API, and machine
surfaces serve that exact validated object through one shared validation
owner. A receipt that is present but invalid is a typed, loud failure on
every surface — never a silent "no facts" — and a corrupted canonical
artifact fails the terminal instead of projecting as "not configured".
Deterministic checks mean all of them: configured contract gates, the final
fresh-tree verify, and the protected live apply — a refused delivery rides
the checks axis even when the task configured no gates — and a zero-byte
deliverable is never a deliverable.

External web context follows the same proportionality rule. `off` is a strict
request that must be enforceable by the selected harness. `auto`, `cached`, and
`live` are optional preferences: successful, failed, denied, and unused web are
typed observations, but absence of web never blocks an otherwise useful result.
This keeps evidence honest without making an optional retrieval aid a hidden
completion gate.

No regex governance: risk, permissions, winners, web evidence, and
tests-passed come from typed contracts and events, never from string-matching
model output. Unknown cost is unknown. Ordinary included service, prospective
premium billing, observed cash, list-price valuation and missing amount evidence
are different facts. A paid-credit tariff is not a receipt for credit consumption, and native
authentication cannot make premium service free. A route fallback announced before
the vendor process starts is selection evidence, not a fabricated paid attempt;
receipt certainty is judged only across real started intervals.

Token measurement follows the same rule. Normalized input totals and separate
cache reads/writes retain unknown fields across missing contributions; older
harness-specific counters keep their original meanings. A cache-read percentage
therefore requires a measured numerator and denominator from the same scope.

Run evidence lives in two labeled planes: Claudexor's internal orchestration
record (contracts, events, attempts, reviews), and the project's produced
outputs (user deliverables). Surfaces always say which plane they show.

The canonical run machine surface obeys one contract: a run verb emits exactly
one success envelope (`{runId, runDir, status, …}`), while shared
usage/bootstrap/preflight/transport failures are rendered by one projector into
a typed problem carrying stable `message`/`code`/exit fields. `--json-stream`
keeps one compact event per line and text mode keeps one stderr line. Some
subcommands and pre/post-run paths retain purpose-built one-object schemas; the
exact bounded residue is tracked explicitly as D-7 in the backlog rather than
hidden behind a generic wrapper. Secret-like tokens are redacted before any
bounded error context is emitted.

## Secrets, Auth, And Isolation

Subscription-first: most users authenticate with the vendor subscriptions
they already pay for; API keys are an explicitly-labeled fallback route,
never the default. Native login remains a vendor ceremony that Claudexor
observes and verifies — it never brokers callbacks, copies tokens, or
mutates the vendor's own store. Additional accounts are additive isolated
profiles where the vendor's platform transport actually provides independent
credential custody. The effective profile policy says when a row is
config-directory-scoped versus OS-user-scoped; Windows Antigravity therefore
allows one enabled binding instead of presenting several labels for one vendor
Keychain identity. Readiness is always a live
doctor projection in the exact environment a run will use, never a stored
assertion. Antigravity account checks use non-interactive input so they cannot
start a sign-in ceremony; explicit login retains its terminal. Raw secrets never
become artifacts — prompts included.

Login is run through Claudexor rather than the bare vendor CLI so the session
lands in the Claudexor-scoped store the runs actually read. Codex login
defaults to a typed device-code flow driven over the official codex app-server
with no Terminal: the one-time code and verification URL appear directly in the
app (and the CLI), and Claudexor waits for the app-server to report completion.
The disclosure carries an isolation instruction — complete the link in a
private browser context — because a browser-based OAuth completed alongside
another session of the same vendor can invalidate that sibling session
server-side, vendor backend behavior Claudexor discloses and mitigates
(device-code default, ephemeral-session request, isolation guidance) but never
claims to prevent. Only the official app-server touches OAuth; Claudexor never
brokers callbacks or reads the one-time code into anything durable. An
effective per-harness capability tells clients whether the current host can run
setup in-app or needs the existing external-terminal attach; it is derived
from the same bounded terminal resolver used at launch, not from a global
"login exists" switch. CLI and local or remote app views follow the same server-owned login: a link,
an outbound device code or a pasted completion value are distinct declared
flows. Closing a view detaches observation; it does not cancel the login.
An interactive login survives an ordinary daemon restart; an explicit cancel or
the login's own deadline are what end a pending login (the engine's normal
15-minute window is extendable; a shorter vendor-owned window is not).

Remote execution extends the same local-first boundary rather than turning
Claudexor into a credential broker. The user's system OpenSSH owns transport,
host verification, and authentication; Claudexor installs only a signed,
version-pinned runtime, reaches its loopback-only daemon through an SSH tunnel,
and keeps harness credentials on that remote host. The local app receives typed
control-plane results, not copies of the remote vendor stores. A remote target
therefore has its own explicit trust decision and execution location, while the
signed runtime and tunnel preserve the same engine-owned contract as a local
run.

An installed harness has one logical entrypoint. Native executables and standard
npm Node entrypoints share the same launch description, preserving the vendor
launcher instead of duplicating its private platform layout. A usable fallback
remains usable, with the broken preferred entry and actual selection disclosed.
A machine-attested executable-version refusal stops account failover; an older
CLI that supplies only a message keeps that message as evidence without turning
its prose into a credential or routing verdict.

## Workspace Semantics

Workspace geometry must match the work. Git-backed execution provides branches,
patches and source-control delivery. Explicit directory execution lets an ordinary
folder remain an ordinary folder, whether work happens directly there or in a
copy of the selected inputs. Isolation therefore does not itself authorize Git
initialization or force a different execution strategy.

Stable project identity remains separate from the folder where the harness runs.
The caller selects the input footprint; a copy retains that complete footprint
and its outputs for inspection and later delivery. Applying a copied result is a
separate decision against the original files. Partial application keeps custody
of the rest, while discard ends pending delivery without undoing work.

Direct execution records effects already made in the selected folder. Observed
bytes and known preimages are useful evidence, but they cannot establish an
unobserved whole-tree state or promise a complete rollback. Filesystem portability
and native harness support remain separate claims, each requiring its own proof.
The operational boundaries live in [ARCHITECTURE](ARCHITECTURE.md#directory-execution).

Instruction files stay unified. The recommendation is one `AGENTS.md` at the
project root — the file Codex, Cursor, and OpenCode already read natively. So a
Claude Code executor reads the same guidance, Claudexor bridges it with a thin
`CLAUDE.md` (`@AGENTS.md` plus an ownership marker) whenever the root has an
`AGENTS.md` and no `CLAUDE.md` on its Git-backed preparation path. The bridge is
exclusive-create and no-follow, so
a hand-written `CLAUDE.md` is never touched, and it is written both to the
project root (durable, announced as a run event) and into each disposable
envelope checkout — which materializes only committed files — so a candidate
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

Reviewer access is also evidence-scoped. The candidate workspace is projected
from version-control-visible files plus the reviewed diff, or from the complete
selected postimage manifest for directory work, while the review
packet crosses through a separate sealed or redacted channel. Ignored local
operator state is therefore not silently promoted into reviewer context.

Rejected alternative: per-commit blocking review of the repository's own
commits. It was tried and retired — it optimized for ceremony over
convergence; a complete independent review with evidence-backed dispositions and a
responsible maintainer's confirmation replaced it. Model brands, signatures over
operator-authored review metadata, and execution timing do not establish review
quality. Platform checks are automated in CI without requiring contributors to
own every supported platform; the integrity of shipped artifacts remains a
separate, mechanically verified contract.

## Non-Goals

Not a SaaS, no accounts of its own, no telemetry beyond public download
counts, no autonomous self-modification, no privileged harness, no second
source of truth beside the engine.

Operator capacity and strategy width are independent: a daemon-wide job pool
limits simultaneously admitted work, while per-run candidate, scout and Council
limits govern fan-out within a job. These capacities are user-configurable and
fixed for the daemon lifetime. Settings distinguish configured values from
currently effective capacity, so pending changes never look already applied.
