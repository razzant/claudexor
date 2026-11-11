import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/** Init `apiKeySource` for session auth. The bundled guide (1.0.46–1.0.70,
 * `14-headless-mode.md`) defines `user` for API-key auth and `oauth`
 * otherwise; the recorded 1.0.67 streams carry `oauth`. Only `oauth` confirms
 * session login; it rules out an API key but does not name the session's
 * issuer, so it is not proof of grok.com. The guide defers the init line to
 * the first output, so this check detects a paid route after dispatch rather
 * than preventing it. */
const GROK_SESSION_KEY_SOURCE = "oauth";
export const GROK_STARTUP_REFUSALS = new Set([
  "grok_access_policy_unconfirmed",
  "grok_credential_source_unconfirmed",
]);

type InitFrame = {
  type?: unknown;
  subtype?: unknown;
  tools?: unknown;
  permissionMode?: unknown;
  apiKeySource?: unknown;
};

/**
 * Reads Grok's own init frame. A scoped run must see exactly its allowed tools
 * under `dontAsk`; any run must not report a credential source other than the
 * recorded session value (configured per-model keys outrank the session token
 * in Grok's resolution order). A refusal stops the process before more output
 * is read; a reported source other than session login is also a typed request
 * refusal, so the engine neither retries nor rotates accounts after it. The
 * source is read first, so a frame that also contradicts the tool policy keeps
 * that stop. A tool-policy contradiction alone is an ordinary failure: another
 * account's own profile configuration can differ. An absent source field
 * leaves the source unknown and says so.
 */
export function createGrokStartupCheck(spec: Pick<HarnessRunSpec, "access">) {
  const scoped = spec.access === "readonly" || spec.access === "workspace_write";
  const allowedTools = new Set([
    "read_file",
    "list_dir",
    "grep",
    ...(spec.access === "workspace_write" ? ["search_replace", "write"] : []),
  ]);
  const state = { sawInit: false, sourceConfirmed: false };
  // Neither refusal is a rate limit or a vendor auth verdict.
  const refusal = (code: string, error: string, sessionId: string, extra = {}): HarnessEvent => ({
    type: "error",
    session_id: sessionId,
    ts: nowIso(),
    error,
    payload: { code, ...extra },
  });
  function observe(
    raw: unknown,
    sessionId: string,
  ): { refusal?: HarnessEvent; note?: HarnessEvent } {
    const init = raw as InitFrame | null;
    if (init?.type !== "system" || init.subtype !== "init") return {};
    state.sawInit = true;
    const source = init.apiKeySource;
    if (typeof source === "string" && source !== GROK_SESSION_KEY_SOURCE) {
      const reported = redactSecrets(source).slice(0, 80);
      return {
        refusal: {
          ...refusal(
            "grok_credential_source_unconfirmed",
            `Grok reported credential source "${reported}", not session login ("${GROK_SESSION_KEY_SOURCE}"); a subscription run does not continue on an unverified credential`,
            sessionId,
            { reported_source: reported },
          ),
          // Typed, so the engine stops here: every retried or rotated launch
          // could send a paid request before its own init frame is read.
          request_refusal: {
            kind: "credential_source_unconfirmed",
            native_code: "grok_credential_source_unconfirmed",
            source: "grok_init",
            reported_source: reported,
          },
        },
      };
    }
    if (
      scoped &&
      (!Array.isArray(init.tools) ||
        init.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool)) ||
        init.permissionMode !== "dontAsk")
    )
      return {
        refusal: refusal(
          "grok_access_policy_unconfirmed",
          "Grok did not confirm the requested scoped tool policy",
          sessionId,
        ),
      };
    state.sourceConfirmed = source === GROK_SESSION_KEY_SOURCE;
    if (state.sourceConfirmed) return {};
    return {
      note: {
        type: "status",
        session_id: sessionId,
        ts: nowIso(),
        text: "Grok did not report its credential source; session login is unconfirmed for this run",
        payload: { code: "grok_credential_source_unreported" },
      },
    };
  }
  return {
    observe,
    get sawInit() {
      return state.sawInit;
    },
    get sourceConfirmed() {
      return state.sourceConfirmed;
    },
  };
}

/** No init frame at all: neither the scoped tool policy nor the credential
 * source was confirmed by the vendor. Disclosed once, never inferred. */
export function grokNoInitNote(sessionId: string): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: "Grok emitted no init frame; its tool policy and credential source were not confirmed",
    payload: { code: "grok_init_missing" },
  };
}
