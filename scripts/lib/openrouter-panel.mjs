/**
 * Shared OpenRouter review-panel client (extracted from triad-scope-review):
 * call a set of models with one prompt, parse fenced-JSON findings, apply a
 * quorum. Used by the per-commit gate's FALLBACK route; the release triad
 * keeps its own locked panel/checklists on top of the same transport.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.PANEL_REQUEST_TIMEOUT_MS || 10 * 60_000);

function isAbortError(err) {
  return typeof err === "object" && err !== null && (err.name === "AbortError" || String(err).includes("AbortError"));
}

export async function callOpenRouterModel(model, prompt, { maxTokens = 60_000, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { model, status: "error", raw: "", error: "OPENROUTER_API_KEY is required" };
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        tools: [],
        tool_choice: "none",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const bodyText = await res.text();
    if (!res.ok) return { model, status: "error", raw: bodyText, error: `HTTP ${res.status}`, ms: Date.now() - started };
    const body = JSON.parse(bodyText);
    const raw = body.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return { model, status: "error", raw: bodyText, error: "empty completion", ms: Date.now() - started };
    return { model, observedModel: body.model ?? model, status: "responded", raw, ms: Date.now() - started };
  } catch (err) {
    return { model, status: isAbortError(err) ? "timed_out" : "error", raw: "", error: String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** A finding-shaped item: severity + non-empty finding/claim text. Quorum
 * must not count an array of junk as a usable reviewer response. */
export function isFindingShaped(item) {
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.severity === "string" &&
    item.severity.trim().length > 0 &&
    (typeof item.finding === "string" ? item.finding : typeof item.claim === "string" ? item.claim : "").trim().length > 0
  );
}

/** Last fenced-JSON block (or bare-JSON body) parsed as an array of findings. */
export function parseFindingsArray(raw) {
  const bare = raw.trim();
  if (bare.startsWith("[") && bare.endsWith("]")) {
    try {
      const arr = JSON.parse(bare);
      if (Array.isArray(arr)) return validateFindings(arr);
    } catch {
      /* fall through to fenced */
    }
  }
  let lastBlock = null;
  // Tolerant fence: standard markdown may omit the newline before the closing fence.
  for (const match of raw.matchAll(/```json\s*([\s\S]*?)```/g)) lastBlock = (match[1] ?? "").trim() || null;
  if (!lastBlock) return { findings: null, error: "no JSON findings array found" };
  try {
    const arr = JSON.parse(lastBlock);
    if (!Array.isArray(arr)) return { findings: null, error: "fenced JSON is not an array" };
    return validateFindings(arr);
  } catch (err) {
    return { findings: null, error: `findings JSON parse failed: ${String(err)}` };
  }
}

/** Empty array = clean PASS; a non-empty array must be finding-shaped
 * THROUGHOUT, or the response is UNUSABLE (fail closed at quorum): a
 * reviewer emitting half-junk is not a trustworthy verdict source. */
function validateFindings(arr) {
  if (arr.length === 0) return { findings: [], error: null };
  if (!arr.every((i) => isFindingShaped(i))) {
    return { findings: null, error: "array contains non-finding-shaped items (severity + finding/claim required)" };
  }
  return { findings: arr, error: null };
}

/**
 * Run a review panel: every model gets the same prompt and must return a JSON
 * array of findings ({severity, finding, evidence}). Quorum = min responders
 * with PARSEABLE findings. Returns typed, fail-loud results.
 */
export async function runOpenRouterPanel(models, prompt, { quorum = 2, maxTokens, timeoutMs } = {}) {
  const results = await Promise.all(models.map((m) => callOpenRouterModel(m, prompt, { maxTokens, timeoutMs })));
  const actors = results.map((r) => {
    if (r.status !== "responded") return { ...r, findings: null, parseError: r.error ?? r.status };
    const parsed = parseFindingsArray(r.raw);
    return { ...r, findings: parsed.findings, parseError: parsed.error };
  });
  const responsive = actors.filter((a) => Array.isArray(a.findings));
  return {
    actors,
    quorumMet: responsive.length >= quorum,
    responsiveCount: responsive.length,
    findings: responsive.flatMap((a) => a.findings.map((f) => ({ ...f, model: a.model }))),
  };
}

/** Blocking severity normalization: reviewers may answer with the gate's
 * requested FAIL/WARN vocabulary OR Claudexor-native severities. Anything
 * block-shaped counts (fail closed). */
export function isBlockingSeverity(severity) {
  const s = String(severity ?? "").toUpperCase();
  return s === "FAIL" || s === "BLOCK" || s === "FIX_FIRST" || s === "NEEDS_HUMAN";
}
