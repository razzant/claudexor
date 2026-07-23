/**
 * D-17 Ф4 primary codex login flow: typed device-code auth over the official
 * codex app-server, with NO Terminal handoff.
 *
 * This module is the transport CORE only — a pure JSON-RPC auth driver over an
 * injected connection. It is consumed by the detached setup-login runner worker
 * (setup-login-runner.ts), which hosts the `codex app-server --stdio` child in
 * the SAME detached process group the Terminal flow uses, so every existing
 * evidence semantic (process-group identity, execution permit, restart
 * adoption, result sidecar) is preserved (ARCHITECTURE §Interactive runs).
 *
 * The transport reuses the request/response + notification patterns proven by
 * the codex QUOTA app-server client (codex-quota-source.ts): initialize →
 * initialized notification → typed method calls, with vendor diagnostics never
 * treated as protocol authority.
 *
 * SECRET DISCIPLINE (INV-062, D-17): the one-time `userCode` is a TRANSIENT
 * disclosure. It rides the runner's transient device-code sidecar and a
 * read-time snapshot projection ONLY; it is NEVER journaled, logged, or written
 * to the durable result receipt. The durable authority persists only THAT a
 * code exists (see {@link deviceCodeDurableMarker}), mirroring how the tee'd
 * URL/code disclosure of the Terminal flow keeps the code out of the journal.
 */

/** One incoming/outgoing JSON-RPC frame. Responses carry a numeric `id`;
 * notifications carry a `method` and no `id`. */
export interface JsonRpcFrame {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

/**
 * Minimal duplex JSON-RPC connection the driver runs over. The runner wires
 * this to the `codex app-server --stdio` child's stdio; tests inject a fake
 * that scripts typed frames. Keeping the driver above this seam is what makes
 * the capability-probe and completion logic unit-testable with no real codex.
 */
export interface CodexAppServerConnection {
  /** Write one JSON-RPC frame to the app-server. */
  send(frame: JsonRpcFrame): void;
  /** Register the sole incoming-frame handler (responses + notifications). */
  onFrame(handler: (frame: JsonRpcFrame) => void): void;
  /** Register the transport-fault/close handler (process exit, stdio error). */
  onClose(handler: (error?: Error) => void): void;
  /** Best-effort teardown of the underlying transport. */
  close(): void;
}

/** Transient device-code disclosure. `userCode` MUST NOT be journaled/logged. */
export interface DeviceCodeDisclosure {
  loginId: string;
  verificationUrl: string;
  /** TRANSIENT one-time code — sidecar + read-time projection only. */
  userCode: string;
}

/** Durable, journal-safe marker: proves a code was disclosed WITHOUT the code
 * or its verification URL. This — and only this — is what the runner's result
 * receipt / the daemon journal may carry about the device-code disclosure. */
export interface DeviceCodeDurableMarker {
  disclosed: true;
}

export function deviceCodeDurableMarker(
  _disclosure: DeviceCodeDisclosure,
): DeviceCodeDurableMarker {
  // Deliberately drops loginId, verificationUrl, and userCode: the journal
  // records THAT a code exists, never the code (D-17, INV-062).
  return { disclosed: true };
}

/** Result of attempting to start a device-code login. */
export type DeviceLoginStart =
  | {
      kind: "started";
      disclosure: DeviceCodeDisclosure;
      /** Await the vendor's completion signal; cancels on abort. */
      awaitCompletion(): Promise<DeviceLoginCompletion>;
    }
  | {
      /** Typed capability probe: the installed app-server lacks the auth
       * methods (JSON-RPC method-not-found). The runner maps this to the
       * `device_auth_unsupported` result so the daemon demotes to the legacy
       * Terminal fallback — no stdout regex. */
      kind: "not_supported";
      detail: string;
    };

export type DeviceLoginCompletion =
  { kind: "completed" } | { kind: "cancelled" } | { kind: "failed"; detail: string };

export type CodexDeviceLoginFlow = "chatgptDeviceCode" | "chatgpt";

export interface CodexDeviceLoginOptions {
  /** `chatgptDeviceCode` (primary) or `chatgpt` (secondary browser-callback,
   * surfaces an `authUrl` rather than a one-time code). */
  flow?: CodexDeviceLoginFlow;
  /** Abort awaiting completion (deadline/cancel); triggers account/login/cancel. */
  signal?: AbortSignal;
  /** Per-request timeout for the initialize/start handshake (default 8s). */
  requestTimeoutMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** JSON-RPC "method not found" — the capability-probe signal. */
const METHOD_NOT_FOUND = -32601;

/**
 * Drive the codex app-server through the typed device-code auth handshake.
 *
 * initialize → initialized → account/login/start {type} →
 *   error(method-not-found)  → not_supported   (capability probe fallback)
 *   error(other)             → throws          (runner classifies as failure)
 *   result{loginId,verificationUrl,userCode}   → started + awaitCompletion()
 *
 * awaitCompletion resolves on an `account/login/completed` notification for the
 * disclosed loginId (or an `account/updated` notification reporting an
 * authenticated account), and on abort sends `account/login/cancel {loginId}`.
 */
export async function startCodexDeviceLogin(
  connection: CodexAppServerConnection,
  options: CodexDeviceLoginOptions = {},
): Promise<DeviceLoginStart> {
  const flow: CodexDeviceLoginFlow = options.flow ?? "chatgptDeviceCode";
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const pending = new Map<
    number,
    { resolve: (frame: JsonRpcFrame) => void; reject: (error: Error) => void; timer: unknown }
  >();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  let transportError: Error | null = null;

  const failAll = (error: Error) => {
    transportError ??= error;
    for (const entry of pending.values()) {
      clearTimeoutFn(entry.timer as Parameters<typeof clearTimeout>[0]);
      entry.reject(transportError);
    }
    pending.clear();
  };

  connection.onClose((error) => failAll(error ?? new Error("codex app-server closed")));
  connection.onFrame((frame) => {
    if (typeof frame.id === "number") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      clearTimeoutFn(entry.timer as Parameters<typeof clearTimeout>[0]);
      pending.delete(frame.id);
      entry.resolve(frame);
      return;
    }
    if (typeof frame.method === "string") {
      for (const handler of notificationHandlers) handler(frame.method, frame.params);
    }
  });

  const request = (id: number, method: string, params: unknown): Promise<JsonRpcFrame> =>
    new Promise<JsonRpcFrame>((resolve, reject) => {
      if (transportError) {
        reject(transportError);
        return;
      }
      const timer = setTimeoutFn(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      connection.send({ id, method, params });
    });

  await request(1, "initialize", {
    clientInfo: { name: "claudexor", version: "2" },
    capabilities: {},
  });
  connection.send({ method: "initialized", params: null });

  const startFrame = await request(2, "account/login/start", { type: flow });
  if (startFrame.error) {
    if (startFrame.error.code === METHOD_NOT_FOUND) {
      return {
        kind: "not_supported",
        detail:
          startFrame.error.message ??
          "codex app-server does not expose account/login/start (typed device-code auth)",
      };
    }
    throw new Error(
      `codex app-server refused account/login/start: ${startFrame.error.message ?? "unknown error"}`,
    );
  }

  const disclosure = parseDisclosure(startFrame.result);
  if (!disclosure) {
    throw new Error("codex app-server login/start result is missing loginId/verificationUrl");
  }
  const loginId = disclosure.loginId;
  const readTransportError = (): Error | null => transportError;

  // Listen for completion EAGERLY (before awaitCompletion is called) so a
  // `completed`/`updated` notification that races the caller is never lost.
  let settledOutcome: DeviceLoginCompletion | null = null;
  let deliver: ((outcome: DeviceLoginCompletion) => void) | null = null;
  const onAbort = () => {
    // Cancel the pending login so the vendor releases the device code, then
    // report the honest cancellation to the runner.
    try {
      connection.send({ method: "account/login/cancel", params: { loginId } });
    } catch {
      /* transport already gone */
    }
    settle({ kind: "cancelled" });
  };
  const settle = (outcome: DeviceLoginCompletion) => {
    if (settledOutcome) return;
    settledOutcome = outcome;
    options.signal?.removeEventListener("abort", onAbort);
    deliver?.(outcome);
  };
  connection.onClose((error) =>
    settle({ kind: "failed", detail: (error ?? new Error("codex app-server closed")).message }),
  );
  notificationHandlers.add((method, params) => {
    const outcome = classifyCompletion(method, params, loginId);
    if (outcome) settle(outcome);
  });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const pendingError = readTransportError();
  if (pendingError && !settledOutcome) settle({ kind: "failed", detail: pendingError.message });

  const awaitCompletion = (): Promise<DeviceLoginCompletion> =>
    new Promise<DeviceLoginCompletion>((resolve) => {
      if (settledOutcome) resolve(settledOutcome);
      else deliver = resolve;
    });

  return { kind: "started", disclosure, awaitCompletion };
}

/** Map a notification to a completion outcome, or null if it is not terminal
 * for THIS login. Vendor prose is never classified — only typed fields. */
export function classifyCompletion(
  method: string,
  params: unknown,
  loginId: string,
): DeviceLoginCompletion | null {
  const record = asRecord(params);
  if (method === "account/login/completed") {
    // Match the disclosed login when the vendor echoes an id; a bare completion
    // is accepted (single in-flight login per app-server).
    const frameLoginId = record ? asString(record["loginId"]) : null;
    if (frameLoginId !== null && frameLoginId !== loginId) return null;
    const success = record ? record["success"] : undefined;
    if (success === false) {
      return { kind: "failed", detail: "codex reported the device-code login did not succeed" };
    }
    return { kind: "completed" };
  }
  if (method === "account/updated") {
    // An authenticated account transition is a positive completion signal for a
    // login that never emits a dedicated completed notification.
    const authenticated =
      record !== null &&
      (record["authenticated"] === true ||
        asString(record["authMethod"]) !== null ||
        asRecord(record["account"]) !== null);
    return authenticated ? { kind: "completed" } : null;
  }
  return null;
}

function parseDisclosure(result: unknown): DeviceCodeDisclosure | null {
  const record = asRecord(result);
  if (!record) return null;
  const loginId = asString(record["loginId"]);
  const verificationUrl =
    asString(record["verificationUrl"]) ?? asString(record["authUrl"]) ?? asString(record["url"]);
  if (!loginId || !verificationUrl) return null;
  // `userCode` is absent for the browser-callback (`chatgpt`) flow; keep an
  // empty string so the AuthSheet can render the URL-only card.
  const userCode = asString(record["userCode"]) ?? "";
  return { loginId, verificationUrl, userCode };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
