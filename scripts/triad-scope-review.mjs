#!/usr/bin/env node
/**
 * Triad + Scope review devtool (Ouroboros-style, via OpenRouter).
 *
 * Replicates the structure of Ouroboros' pre-commit review gate
 * (ouroboros/tools/review.py + scope_review.py + triad_review.py):
 *   - triad: 3 reviewer models, JSON-array findings contract, quorum >= 2
 *     responsive models, degraded accounting, NO output truncation;
 *   - scope: one large-context reviewer covering the 8 fixed scope items
 *     against a compact repository atlas.
 * The preamble/checklists are Claudexor's own (docs/CHECKLISTS.md +
 * CLAUDEXOR_BIBLE.md); Claudexor does not self-modify — this is an external
 * development gate for contributors, not runtime product behavior.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/triad-scope-review.mjs \
 *     --base <sha>            # diff base (default: HEAD~1)
 *     --round <n>             # round number for the output dir
 *     --out <dir>             # default .adversarial-review/triad
 *     --goal-file <path>      # user intent / goal text file
 *     --skip-scope            # triad only
 *
 * Optional infrastructure fallbacks, off by default:
 *   TRIAD_MAX_OUTPUT_TOKENS=12000
 *   TRIAD_MAX_PACK_BYTES=3000000
 *   TRIAD_DIRECT_OPENAI=1 OPENAI_API_KEY=...
 *   TRIAD_DIRECT_ANTHROPIC=1 ANTHROPIC_API_KEY=...
 *
 * Outputs (per round): raw per-model responses (NEVER truncated), parsed
 * findings JSON, and a markdown summary table. Exit code 1 when quorum is not
 * met or any reviewer infra call fails; 0 otherwise (findings themselves are
 * data for the operator, not an exit signal).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
// Relative dist import: the root package has no workspace dep on util, so the
// bare specifier does not resolve for repo scripts. Requires `pnpm build` first.
import { containsSecretLikeToken, redactSecrets } from "../packages/util/dist/index.js";

// The reviewer panel is LOCKED (owner directive): never downgrade, substitute,
// or "nearest available" these exact models. Overriding via env is a hard error
// unless the operator explicitly acknowledges the violation — a silent
// TRIAD_MODELS swap would let a weaker panel impersonate the release gate.
const LOCKED_TRIAD = "openai/gpt-5.5,google/gemini-3.5-flash,anthropic/claude-opus-4.8";
const LOCKED_SCOPE = "openai/gpt-5.5";
const OVERRIDE_ACK = "I_UNDERSTAND_THIS_VIOLATES_THE_LOCKED_PANEL";
// Order-insensitive: reordering the same three locked models is not a panel
// violation (the panel is a SET; sequence carries no meaning here).
const normalizePanel = (s) => s.split(",").map((m) => m.trim()).sort().join(",");
for (const [envName, locked] of [["TRIAD_MODELS", LOCKED_TRIAD], ["SCOPE_MODEL", LOCKED_SCOPE]]) {
  const v = process.env[envName];
  if (v && normalizePanel(v) !== normalizePanel(locked) && process.env.TRIAD_ALLOW_OVERRIDE !== OVERRIDE_ACK) {
    console.error(
      `${envName} override ('${v}') conflicts with the locked reviewer panel ('${locked}').\n` +
        `The panel is an owner-locked release gate. If this override is a deliberate, disclosed decision,\n` +
        `set TRIAD_ALLOW_OVERRIDE=${OVERRIDE_ACK} — the override will be recorded in the review summary.`,
    );
    process.exit(1);
  }
  if (v && normalizePanel(v) !== normalizePanel(locked)) {
    console.error(`WARNING: ${envName} override active (${v}) — acknowledged panel violation; recording it.`);
  }
}
const TRIAD_MODELS = (process.env.TRIAD_MODELS || LOCKED_TRIAD).split(",");
const SCOPE_MODEL = process.env.SCOPE_MODEL || LOCKED_SCOPE;
const SCOPE_ITEMS = [
  "intent_alignment",
  "forgotten_touchpoints",
  "cross_surface_consistency",
  "regression_surface",
  "prompt_doc_sync",
  "architecture_fit",
  "cross_module_bugs",
  "implicit_contracts",
];
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const MAX_OUTPUT_TOKENS = positiveIntEnv("TRIAD_MAX_OUTPUT_TOKENS", 100_000);
const REQUEST_TIMEOUT_MS = 900_000;
/** Per-file cap inside the touched-file pack; the diff itself is never cut. */
const MAX_FILE_BYTES = 200_000;
const MAX_PACK_BYTES = positiveIntEnv("TRIAD_MAX_PACK_BYTES", 3_000_000);

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : true;
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

function readDoc(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `(${path} not found)`;
  }
}

// ---------------------------------------------------------------------------
// Prompt blocks (ported from ouroboros/tools/review_helpers.py, preamble swapped)
// ---------------------------------------------------------------------------

const PREAMBLE =
  "You are a pre-commit reviewer for Claudexor, a local-first control plane for AI coding harnesses.\n" +
  "Its constitution is CLAUDEXOR_BIBLE.md. Its contributor handbook is docs/DEVELOPMENT.md.\n" +
  "Claudexor does NOT self-modify; you are reviewing a human/agent-authored change to the product.\n";

const CRITICAL_CALIBRATION = `## Critical severity threshold — READ BEFORE MARKING ANY FINDING CRITICAL

Before marking any finding CRITICAL you MUST:
1. Name the **exact file, symbol, function, test, or config path** in this repo
   that makes the problem live RIGHT NOW (not hypothetically in the future).
2. Confirm this artifact actually exists in the repo context you have been given.
3. If the concern depends on a hypothetical plugin, future integration, custom
   environment, fixture, or finalizer that does NOT appear in this repo's
   codebase — mark it **advisory**, not critical.
4. One root cause = one FAIL entry. Do NOT split one problem into multiple FAIL
   items that all require the same fix.
5. If a previous CRITICAL finding was concretely fixed and only a broader
   future-risk variant remains, mark that broader concern **advisory**.
6. Pre-existing gaps that exist entirely outside the touched area are advisory
   unless this diff directly depends on them or introduces a regression.
7. Narrative or descriptive mismatches are advisory unless they affect a real
   contract: release/version metadata, actual runtime behavior, safety guidance,
   or instructions a user/reviewer must rely on.

When in doubt: use "advisory". Reserve "critical" for clear, concrete,
repo-local, reachable defects.`;

const JSON_CONTRACT = `Return ONLY a JSON array. Each element:
{
  "item": "<checklist item name>",
  "verdict": "PASS" | "FAIL",
  "severity": "critical" | "advisory",
  "reason": "<for FAIL: file, line/symbol, what is wrong, how to fix>"
}`;

const ANTI_PATTERN_LOCK = `If your first reading surfaces **exactly one FAIL** across all checklist
items, do a deliberate SECOND pass focused on a DIFFERENT concern class
before returning. Real diffs with exactly one issue are rarer than diffs
with several issues on different dimensions; single-FAIL outputs are the
most common pattern-lock failure mode of single-pass review. Update PASS
entries in-place if your second pass uncovers new FAILs — return only one
JSON array, not two.`;

const THOROUGHNESS = `- Do NOT stop after finding the first issue. Check EVERY item in the checklist.
- Report ALL problems you find. If there are 5 bugs, list all 5 — each as a separate entry.
- Do NOT summarize multiple distinct problems into one finding.
- For PASS: brief reason is fine. For FAIL: cite the specific file, line/symbol, what is wrong,
  and provide a CONCRETE fix suggestion so the developer knows exactly what to change.
- Do NOT call tools, search, browse, or request external context. Use only the
  prompt's file pack, diff, repository atlas, and documentation context.`;

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

// Optional `--paths a,b,c` pathspec to scope a large diff to the risky files
// (the full-tree diff can exceed reviewer context). Empty => whole diff.
const PATHSPEC = (() => {
  const i = process.argv.indexOf("--paths");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
})();
const pathArgs = PATHSPEC.length > 0 ? ["--", ...PATHSPEC] : [];

function changedFiles(base) {
  return git(["diff", "--name-only", `${base}..HEAD`, ...pathArgs]).trim();
}

function diffText(base) {
  return git(["diff", `${base}..HEAD`, ...pathArgs]);
}

function touchedFilePack(paths) {
  let total = 0;
  const out = [];
  const omitted = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      out.push(`### ${p}\n\n(deleted by this diff)`);
      continue;
    }
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      omitted.push(`${p} (unreadable/binary)`);
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      omitted.push(`${p} (${text.length}B > per-file cap; review via diff)`);
      continue;
    }
    if (total + text.length > MAX_PACK_BYTES) {
      omitted.push(`${p} (pack budget reached)`);
      continue;
    }
    total += text.length;
    out.push(`### ${p}\n\n\`\`\`\n${text}\n\`\`\``);
  }
  let pack = out.join("\n\n");
  if (omitted.length > 0) {
    pack += `\n\n⚠️ OMISSION NOTE: ${omitted.length} file(s) omitted from direct context: ${omitted.join(", ")}`;
  }
  return pack || "(no touched files could be read)";
}

/** Compact whole-repo atlas: every tracked path + byte size (scope reviewer's map). */
function repoAtlas() {
  const lines = git(["ls-files"]).trim().split("\n");
  const rows = lines.map((p) => {
    try {
      return `${p} (${readFileSync(p).length}B)`;
    } catch {
      return `${p} (unreadable)`;
    }
  });
  return rows.join("\n");
}

function checklistSection(title) {
  const text = readDoc("docs/CHECKLISTS.md");
  const re = new RegExp(`## ${title}[\\s\\S]*?(?=\\n## |$)`);
  const m = text.match(re);
  return m ? m[0] : `(section "${title}" not found in docs/CHECKLISTS.md)`;
}

function goalSection() {
  const goalFile = arg("goal-file");
  const goal = goalFile ? readDoc(goalFile) : "(no explicit goal file provided)";
  return `## Goal / user intent\n\n${goal}`;
}

function buildTriadPrompt(base) {
  return `${PREAMBLE}
## Review instructions

Read the diff and full current text of every changed file. Review every
checklist item, report every distinct current problem, and make every FAIL
actionable with file/symbol evidence and a concrete fix.

${THOROUGHNESS}

${CRITICAL_CALIBRATION}

${JSON_CONTRACT}

## Anti pattern-lock guard

${ANTI_PATTERN_LOCK}

${checklistSection("Review Protocol")}

${checklistSection("Runtime Behavior Changes")}

${checklistSection("Security And Secrets")}

- Output ONLY a valid JSON array. No markdown fences, no text outside the JSON.

${goalSection()}

## CLAUDEXOR_BIBLE.md

${readDoc("CLAUDEXOR_BIBLE.md")}

## DEVELOPMENT.md

${readDoc("docs/DEVELOPMENT.md")}

## ARCHITECTURE.md

${readDoc("docs/ARCHITECTURE.md")}

## Current touched files (full content)

${touchedFilePack(changedFiles(base).split("\n").filter(Boolean))}

## Diff under review

${diffText(base)}

## Changed files

${changedFiles(base)}
`;
}

function buildScopePrompt(base) {
  return `${PREAMBLE}
## Your role

You are the Atlas-backed whole-repository reviewer. Diff reviewers cover line-level mistakes;
you cover cross-module contracts, forgotten touchpoints, hidden regressions,
prompt/doc sync, architecture fit, and end-to-end intent completeness.

## Your task

For each finding, you MUST name the exact file, symbol, test, prompt, doc,
config, or sibling flow that proves the issue. Vague concerns without a
concrete artifact reference must be marked advisory, not critical.

## Output format

Output ONLY a valid JSON array.

You MUST cover every checklist item below. Skipping an item is not allowed —
a missing entry indicates the item was not actually reviewed.

The eight checklist item identifiers you MUST return (exactly these strings
in the "item" field; no substitutions):

${SCOPE_ITEMS.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}

Each element must follow the shared review JSON contract:
${JSON_CONTRACT}

Additional scope-review requirements:
- "item" must be one of the eight identifiers above — verbatim, case-sensitive.
- "reason":
  - For FAIL: concrete artifact (file/symbol/line/contract) + what is wrong + how to fix.
  - For PASS: 1-2 sentences stating WHY this item passes, naming a concrete
    artifact or code path that you checked.

If one checklist item has multiple distinct concrete problems, return one
FAIL entry per distinct root cause. If an item has no problems, return one
PASS entry. Do not return PASS for an item that also has a FAIL.

## Anti pattern-lock guard

${ANTI_PATTERN_LOCK}

${CRITICAL_CALIBRATION}

${goalSection()}

## Canonical documentation context

${readDoc("CLAUDEXOR_BIBLE.md")}

${readDoc("docs/ARCHITECTURE.md")}

## Repository atlas (every tracked path)

${repoAtlas()}

## Current touched files (post-change)

${touchedFilePack(changedFiles(base).split("\n").filter(Boolean))}

## Diff under review

${diffText(base)}
`;
}

// ---------------------------------------------------------------------------
// OpenRouter + parsing (ported from triad_review.extract_json_array)
// ---------------------------------------------------------------------------

async function callModel(model, prompt) {
  if (process.env.TRIAD_DIRECT_OPENAI === "1" && model.startsWith("openai/")) {
    return callOpenAI(model, prompt);
  }
  if (process.env.TRIAD_DIRECT_ANTHROPIC === "1" && model.startsWith("anthropic/")) {
    return callAnthropic(model, prompt);
  }
  return callOpenRouter(model, prompt);
}

function isAbortError(err) {
  return typeof err === "object" && err !== null && (err.name === "AbortError" || String(err).includes("AbortError"));
}

async function callOpenRouter(model, prompt) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const route = { transport: "openrouter", source: "openrouter", routeProof: "openrouter:/api/v1/chat/completions" };
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { model, ...route, status: "error", raw: "", error: "OPENROUTER_API_KEY is required for OpenRouter-routed reviewer", ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
    }
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: [],
        tool_choice: "none",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const firstEventAt = new Date().toISOString();
    const bodyText = await res.text();
    if (!res.ok) {
      return { model, ...route, status: "error", raw: bodyText, error: `HTTP ${res.status}`, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    }
    const body = JSON.parse(bodyText);
    const raw = body.choices?.[0]?.message?.content ?? "";
    const usage = body.usage ?? {};
    const observedModel = body.model ?? model;
    if (!raw.trim()) return { model, ...route, observedModel, responseId: body.id ?? null, status: "error", raw: bodyText, error: "empty completion", ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    return { model, ...route, observedModel, responseId: body.id ?? null, status: "responded", raw, usage, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
  } catch (err) {
    const timedOut = isAbortError(err);
    return { model, ...route, status: timedOut ? "timed_out" : "error", timedOut, raw: "", error: String(err), ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function openAiText(body) {
  if (typeof body.output_text === "string") return body.output_text;
  const chunks = [];
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") chunks.push(part.text);
      else if (typeof part.output_text === "string") chunks.push(part.output_text);
    }
  }
  return chunks.join("");
}

async function callOpenAI(model, prompt) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const route = { transport: "openai-responses", source: "direct-openai", routeProof: "openai:/v1/responses" };
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { model, ...route, status: "error", raw: "", error: "OPENAI_API_KEY is required for TRIAD_DIRECT_OPENAI", ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
    const directModel = model.replace(/^openai\//, "");
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: directModel,
        input: prompt,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
    const firstEventAt = new Date().toISOString();
    const bodyText = await res.text();
    if (!res.ok) {
      return { model, ...route, status: "error", raw: bodyText, error: `HTTP ${res.status}`, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    }
    const body = JSON.parse(bodyText);
    const raw = openAiText(body);
    const observedModel = body.model ?? directModel;
    if (!raw.trim()) return { model, ...route, observedModel, responseId: body.id ?? null, status: "error", raw: bodyText, error: "empty completion", ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    return { model, ...route, observedModel, responseId: body.id ?? null, status: "responded", raw, usage: body.usage ?? {}, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
  } catch (err) {
    const timedOut = isAbortError(err);
    return { model, ...route, status: timedOut ? "timed_out" : "error", timedOut, raw: "", error: String(err), ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function anthropicModelId(model) {
  const direct = model.replace(/^anthropic\//, "");
  if (direct === "claude-opus-4.8") return "claude-opus-4-8";
  return direct;
}

async function callAnthropic(model, prompt) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const route = { transport: "anthropic-messages", source: "direct-anthropic", routeProof: "anthropic:/v1/messages" };
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { model, ...route, status: "error", raw: "", error: "ANTHROPIC_API_KEY is required for TRIAD_DIRECT_ANTHROPIC", ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
    const directModel = anthropicModelId(model);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: directModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const firstEventAt = new Date().toISOString();
    const bodyText = await res.text();
    if (!res.ok) {
      return { model, ...route, status: "error", raw: bodyText, error: `HTTP ${res.status}`, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    }
    const body = JSON.parse(bodyText);
    const raw = (body.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
    const observedModel = body.model ?? directModel;
    if (!raw.trim()) return { model, ...route, observedModel, responseId: body.id ?? null, status: "error", raw: bodyText, error: "empty completion", ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
    return { model, ...route, observedModel, responseId: body.id ?? null, status: "responded", raw, usage: body.usage ?? {}, ms: Date.now() - started, startedAt, firstEventAt, completedAt: new Date().toISOString() };
  } catch (err) {
    const timedOut = isAbortError(err);
    return { model, ...route, status: timedOut ? "timed_out" : "error", timedOut, raw: "", error: String(err), ms: Date.now() - started, startedAt, firstEventAt: null, completedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonArray(raw) {
  const text = String(raw ?? "").trim();
  const candidates = [text];
  if (text.includes("```")) {
    for (let chunk of text.split("```")) {
      chunk = chunk.trim();
      if (chunk.startsWith("json")) chunk = chunk.slice(4).trim();
      if (chunk) candidates.push(chunk);
    }
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj)) return obj;
    } catch {
      /* fall through to bracket scan */
    }
    const ends = [];
    for (let pos = candidate.indexOf("]"); pos !== -1; pos = candidate.indexOf("]", pos + 1)) ends.push(pos);
    for (const end of ends.reverse()) {
      const starts = [];
      for (let pos = candidate.indexOf("["); pos !== -1 && pos <= end; pos = candidate.indexOf("[", pos + 1)) starts.push(pos);
      for (const start of starts.reverse()) {
        try {
          const obj = JSON.parse(candidate.slice(start, end + 1));
          if (Array.isArray(obj)) return obj;
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  return null;
}

function normalizeFindings(items, model) {
  const out = [];
  for (const entry of items ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const item = String(entry.item ?? "");
    const verdict = String(entry.verdict ?? "").toUpperCase();
    if (!item || (verdict !== "PASS" && verdict !== "FAIL")) continue;
    out.push({
      item,
      verdict,
      severity: String(entry.severity ?? "advisory").toLowerCase(),
      reason: String(entry.reason ?? "").trim(),
      model,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const base = arg("base", "HEAD~1");
  const round = arg("round", "1");
  const outDir = resolve(arg("out", ".adversarial-review/triad"), `round-${round}`);
  mkdirSync(outDir, { recursive: true });

  const triadPrompt = buildTriadPrompt(base);
  // Fail BEFORE remote submission if the evidence contains a token-like value:
  // a leaked secret must not reach OpenRouter or the persisted artifacts.
  if (containsSecretLikeToken(triadPrompt)) {
    console.error("ABORT: review evidence contains a secret-like token; scrub the diff/files first.");
    process.exit(1);
  }
  writeFileSync(join(outDir, "triad-prompt.md"), redactSecrets(triadPrompt));
  console.error(`triad prompt: ${triadPrompt.length} chars; models: ${TRIAD_MODELS.join(", ")}`);

  // Reviewer progress telemetry (CHECKLISTS Review Protocol): a sequential or
  // hung panel must be diagnosable from disk, not indistinguishable from a hang.
  const progressPath = join(outDir, "reviewer-progress.jsonl");
  const progress = (entry) => appendFileSync(progressPath, JSON.stringify(entry) + "\n");
  for (const model of TRIAD_MODELS) progress({ ts: new Date().toISOString(), type: "reviewer.started", model });
  const triadResults = await Promise.all(TRIAD_MODELS.map((m) => callModel(m, triadPrompt)));

  const actorRecords = [];
  const findings = [];
  for (const [idx, result] of triadResults.entries()) {
    const slug = result.model.replace(/[^a-z0-9.-]+/gi, "_");
    writeFileSync(join(outDir, `triad-${slug}.raw.txt`), redactSecrets(result.raw ?? ""));
    let status = result.status;
    let parsed = [];
    if (status === "responded") {
      const arr = extractJsonArray(result.raw);
      if (arr === null) {
        status = "parse_failure";
        writeFileSync(join(outDir, `triad-${slug}.parse-error.json`), JSON.stringify({ error: "no_parseable_json_array", raw_file: `triad-${slug}.raw.txt` }, null, 2) + "\n");
      } else {
        parsed = normalizeFindings(arr, result.model);
        writeFileSync(join(outDir, `triad-${slug}.parsed-json-blocks.json`), redactSecrets(JSON.stringify(arr, null, 2)) + "\n");
      }
    }
    const record = {
      model_id: result.model,
      observed_model: result.observedModel ?? null,
      requested_effort: null,
      transport: result.transport ?? null,
      source: result.source ?? null,
      route_proof: result.routeProof ?? null,
      response_id: result.responseId ?? null,
      status,
      slot: idx + 1,
      parsed_count: parsed.length,
      usage: result.usage ?? null,
      started_at: result.startedAt ?? null,
      // Non-streaming transport: there is no separate first-event timestamp;
      // use the first HTTP response timestamp rather than faking completion.
      first_event_at: result.firstEventAt ?? null,
      completed_at: result.completedAt ?? null,
      duration_ms: result.ms,
      error: result.error ?? null,
      raw_file: `triad-${slug}.raw.txt`,
    };
    actorRecords.push(record);
    writeFileSync(join(outDir, `triad-${slug}.metadata.json`), JSON.stringify(record, null, 2) + "\n");
    if (record.first_event_at) {
      progress({
        ts: record.first_event_at,
        type: "reviewer.first_event",
        model: result.model,
        observed_model: record.observed_model,
        source: record.source,
        transport: record.transport,
      });
    }
    progress({
      ts: record.completed_at ?? new Date().toISOString(),
      type: status === "responded" ? "reviewer.completed" : result.timedOut || status === "timed_out" ? "reviewer.timed_out" : "reviewer.failed",
      model: result.model,
      observed_model: record.observed_model,
      source: record.source,
      transport: record.transport,
      status,
      duration_ms: result.ms,
    });
    findings.push(...parsed);
  }
  const responsive = actorRecords.filter((r) => r.status === "responded");
  const quorumMet = responsive.length >= 2;
  const degraded = actorRecords.filter((r) => r.status !== "responded").map((r) => `${r.model_id}=${r.status}`);

  let scope = null;
  if (!arg("skip-scope")) {
    const scopePrompt = buildScopePrompt(base);
    if (containsSecretLikeToken(scopePrompt)) {
      console.error("ABORT: scope evidence contains a secret-like token; scrub the diff/atlas first.");
      process.exit(1);
    }
    writeFileSync(join(outDir, "scope-prompt.md"), redactSecrets(scopePrompt));
    console.error(`scope prompt: ${scopePrompt.length} chars; model: ${SCOPE_MODEL}`);
    progress({ ts: new Date().toISOString(), type: "reviewer.started", model: SCOPE_MODEL, role: "scope" });
    const scopeResult = await callModel(SCOPE_MODEL, scopePrompt);
    if (scopeResult.firstEventAt) {
      progress({
        ts: scopeResult.firstEventAt,
        type: "reviewer.first_event",
        model: SCOPE_MODEL,
        observed_model: scopeResult.observedModel ?? null,
        source: scopeResult.source ?? null,
        transport: scopeResult.transport ?? null,
        role: "scope",
      });
    }
    progress({
      ts: scopeResult.completedAt ?? new Date().toISOString(),
      type: scopeResult.status === "responded" ? "reviewer.completed" : scopeResult.timedOut || scopeResult.status === "timed_out" ? "reviewer.timed_out" : "reviewer.failed",
      model: SCOPE_MODEL,
      observed_model: scopeResult.observedModel ?? null,
      source: scopeResult.source ?? null,
      transport: scopeResult.transport ?? null,
      role: "scope",
      duration_ms: scopeResult.ms,
    });
    writeFileSync(join(outDir, "scope.raw.txt"), redactSecrets(scopeResult.raw ?? ""));
    let scopeStatus = scopeResult.status;
    let scopeFindings = [];
    const scopeMeta = {
      model_id: SCOPE_MODEL,
      observed_model: scopeResult.observedModel ?? null,
      requested_effort: null,
      transport: scopeResult.transport ?? null,
      source: scopeResult.source ?? null,
      route_proof: scopeResult.routeProof ?? null,
      response_id: scopeResult.responseId ?? null,
      status: scopeStatus,
      usage: scopeResult.usage ?? null,
      started_at: scopeResult.startedAt ?? null,
      first_event_at: scopeResult.firstEventAt ?? null,
      completed_at: scopeResult.completedAt ?? null,
      duration_ms: scopeResult.ms,
      error: scopeResult.error ?? null,
      raw_file: "scope.raw.txt",
    };
    if (scopeStatus === "responded") {
      const arr = extractJsonArray(scopeResult.raw);
      if (arr === null) {
        scopeStatus = "parse_failure";
        writeFileSync(join(outDir, "scope.parse-error.json"), JSON.stringify({ error: "no_parseable_json_array", raw_file: "scope.raw.txt" }, null, 2) + "\n");
      }
      else {
        scopeFindings = normalizeFindings(arr, SCOPE_MODEL);
        writeFileSync(join(outDir, "scope.parsed-json-blocks.json"), redactSecrets(JSON.stringify(arr, null, 2)) + "\n");
        const covered = new Set(scopeFindings.map((f) => f.item));
        const missing = SCOPE_ITEMS.filter((i) => !covered.has(i));
        if (missing.length > 0) scopeStatus = "partial";
        scopeMeta.status = scopeStatus;
        scope = { status: scopeStatus, findings: scopeFindings, missing_items: missing, usage: scopeResult.usage ?? null, metadata: scopeMeta };
      }
    }
    if (!scope) {
      scopeMeta.status = scopeStatus;
      scope = { status: scopeStatus, findings: scopeFindings, missing_items: SCOPE_ITEMS, error: scopeResult.error ?? null, metadata: scopeMeta };
    }
    writeFileSync(join(outDir, "scope.metadata.json"), JSON.stringify(scopeMeta, null, 2) + "\n");
  }

  const summary = {
    round: Number(round),
    base,
    generated_at: new Date().toISOString(),
    // Explicit audit markers. `panel_override_active` is the truth signal: the
    // panel actually ran with non-locked models (an unacknowledged override is
    // impossible — the guard at the top hard-errors first). The ack alone with
    // a locked panel is a no-op and must not read as a violation.
    panel_override_active:
      normalizePanel(TRIAD_MODELS.join(",")) !== normalizePanel(LOCKED_TRIAD) ||
      SCOPE_MODEL !== LOCKED_SCOPE,
    panel_override_acknowledged: process.env.TRIAD_ALLOW_OVERRIDE === OVERRIDE_ACK,
    triad: { models: TRIAD_MODELS, quorum_met: quorumMet, degraded, actors: actorRecords, findings },
    scope,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  // Markdown table (FAILs first).
  const rows = [...findings, ...(scope?.findings ?? [])]
    .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "FAIL" ? -1 : 1))
    .map((f) => `| ${f.model} | ${f.item} | ${f.verdict} | ${f.severity} | ${f.reason.replaceAll("|", "\\|").replaceAll("\n", " ")} |`);
  const table = [
    `# Triad + Scope review — round ${round}`,
    "",
    `- base: ${base}`,
    `- quorum: ${quorumMet ? "met" : "NOT MET"} (${responsive.length}/${TRIAD_MODELS.length} responded${degraded.length ? `; degraded: ${degraded.join(", ")}` : ""})`,
    `- scope: ${scope ? scope.status : "skipped"}`,
    "",
    "| model | item | verdict | severity | reason |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.md"), redactSecrets(table));
  console.log(table);

  if (!quorumMet) {
    console.error(`REVIEW_BLOCKED: only ${responsive.length} of ${TRIAD_MODELS.length} review models responded successfully (minimum 2 required).`);
    process.exit(1);
  }
  // The scope reviewer is part of the release gate: an erroring, unparseable,
  // or item-incomplete scope review blocks too (not ceremonial).
  if (scope && (scope.status !== "responded" || (scope.missing_items?.length ?? 0) > 0)) {
    console.error(`REVIEW_BLOCKED: scope review ${scope.status}${scope.missing_items?.length ? ` (missing items: ${scope.missing_items.join(", ")})` : ""}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
