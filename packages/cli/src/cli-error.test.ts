import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliError,
  boundContext,
  controlProblemError,
  minIntError,
  normalizeThrowable,
  renderCliFailure,
  usageError,
  zodFieldErrors,
} from "./cli-error.js";

/** Capture the single JSON object the projector writes to stdout. */
function captureJson(fn: () => void): Record<string, unknown> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  // Exactly ONE object on stdout is the contract.
  expect(chunks).toHaveLength(1);
  return JSON.parse(chunks[0] as string) as Record<string, unknown>;
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return chunks.join("");
}

describe("CLI projector (D-7 / GH #28): one envelope, one exit-code table", () => {
  afterEach(() => vi.restoreAllMocks());

  it("usage/validation failures exit 2, operational failures exit 1", () => {
    let code = 0;
    captureJson(() => {
      code = renderCliFailure(true, usageError("bad flag"));
    });
    expect(code).toBe(2);
    captureJson(() => {
      code = renderCliFailure(true, new CliError("operational", "daemon fell over"));
    });
    expect(code).toBe(1);
  });

  it("PARSER/usage: --n 0 becomes a structured field error (exit 2), no Zod dump", () => {
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, minIntError("n", 1), { defaultCategory: "usage" });
    });
    expect(code).toBe(2);
    expect(env).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
      message: "--n must be at least 1",
      fieldErrors: { n: ["--n must be at least 1"] },
      details: { field: "n", minimum: 1 },
    });
  });

  it("BOOTSTRAP: a Node EPERM/fchmod error projects a parseable JSON with a stable code", () => {
    const eperm = Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
      code: "EPERM",
      syscall: "fchmod",
      errno: -1,
    });
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, eperm);
    });
    expect(code).toBe(1);
    expect(env).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "EPERM",
      details: { syscall: "fchmod", errno: -1 },
    });
    expect(String(env["message"])).toContain("fchmod");
  });

  it("TYPED PROBLEM: a ControlProblem preserves code/retryable/fieldErrors/requiredActions", () => {
    const problem = {
      code: "revert_refused",
      message: "cannot revert: working tree diverged",
      retryable: false,
      fieldErrors: { runId: ["already applied"] },
      requiredActions: ["reconcile the tree, then retry"],
      evidenceRefs: ["run/abc/patch.diff"],
      context: { gitStderr: "error: Your local changes would be overwritten" },
    };
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, controlProblemError(409, problem, "decision failed"), {
        messagePrefix: "claudexor decision:",
      });
    });
    // A 409 conflict is an operational failure, not a validation error.
    expect(code).toBe(1);
    expect(env).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "revert_refused",
      retryable: false,
      fieldErrors: { runId: ["already applied"] },
      requiredActions: ["reconcile the tree, then retry"],
      details: { evidenceRefs: ["run/abc/patch.diff"] },
      context: { gitStderr: "error: Your local changes would be overwritten" },
    });
    expect(String(env["message"])).toContain("claudexor decision:");
  });

  it("TYPED PROBLEM: a 400 ControlProblem is a validation failure (exit 2)", () => {
    let code = -1;
    captureJson(() => {
      code = renderCliFailure(
        true,
        controlProblemError(400, { code: "bad_input", message: "x", retryable: false }, "fallback"),
      );
    });
    expect(code).toBe(2);
  });

  it("INLINE SECRET: the typed code survives and the token is never echoed", () => {
    // Assembled at runtime so the source (and any sealed review diff of it)
    // never contains a contiguous secret-like token at rest.
    const token = ["sk", "THISLOOKSLIKEASECRET1234567890"].join("-");
    const secretErr = Object.assign(
      new Error("secret-like value is not accepted in CLI run params ($.prompt); remove it"),
      { status: 400, code: "inline_secret_rejected" },
    );
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, secretErr, { defaultCategory: "usage" });
    });
    expect(code).toBe(2);
    expect(env["code"]).toBe("inline_secret_rejected");
    expect(JSON.stringify(env)).not.toContain(token);
  });

  it("UNEXPECTED THROW: a bare Error defaults to operational (exit 1)", () => {
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, new Error("kaboom"));
    });
    expect(code).toBe(1);
    expect(env).toMatchObject({ ok: false, exitCode: 1, message: "kaboom" });
    // Legacy `error` alias stays populated for older consumers.
    expect(env["error"]).toBe("kaboom");
  });

  it("ZOD: a ZodError-shaped throwable becomes structured field errors, no serialized dump", () => {
    const zodLike = Object.assign(new Error("Invalid input"), {
      name: "ZodError",
      issues: [
        { path: ["n"], message: "Number must be greater than or equal to 1" },
        { path: ["scope", "root"], message: "Required" },
      ],
    });
    const normalized = normalizeThrowable(zodLike, "operational");
    expect(normalized.category).toBe("usage");
    expect(normalized.code).toBe("invalid_argument");
    expect(normalized.fieldErrors).toEqual({
      n: ["Number must be greater than or equal to 1"],
      "scope.root": ["Required"],
    });
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, zodLike);
    });
    expect(code).toBe(2);
    expect(JSON.stringify(env)).not.toContain("ZodError");
  });

  it("zodFieldErrors keys the root issue as _ when the path is empty", () => {
    expect(zodFieldErrors([{ path: [], message: "root broke" }])).toEqual({ _: ["root broke"] });
  });

  it("boundContext truncates a long stderr string to bounded evidence", () => {
    const long = "x".repeat(5000);
    const bounded = boundContext({ gitStderr: long, small: "ok" });
    expect(String(bounded?.["gitStderr"]).length).toBeLessThan(long.length);
    expect(String(bounded?.["gitStderr"])).toContain("truncated");
    expect(bounded?.["small"]).toBe("ok");
    expect(boundContext(undefined)).toBeUndefined();
    expect(boundContext({})).toBeUndefined();
  });

  it("text mode: the human line goes to stderr, generated from the SAME problem", () => {
    let code = -1;
    const text = captureStderr(() => {
      code = renderCliFailure(false, usageError("bad flag"), { messagePrefix: "claudexor:" });
    });
    expect(code).toBe(2);
    expect(text).toBe("claudexor: bad flag\n");
  });

  it("STREAM (--json-stream): the failure envelope is ONE COMPACT NDJSON line", () => {
    // The run-surface failure branches (ensureDaemon / attachment upload /
    // --resume / terminal catch) route through here with stream:true; a pretty
    // multi-line object would break `for line in stream: json.loads(line)`.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      chunks.push(String(s));
      return true;
    });
    let code = -1;
    try {
      code = renderCliFailure(true, new Error("daemon unreachable"), {
        messagePrefix: "claudexor:",
        stream: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(chunks).toHaveLength(1);
    const line = chunks[0] as string;
    // Exactly one trailing newline, none inside the object (compact).
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    const env = JSON.parse(line) as Record<string, unknown>;
    expect(env).toMatchObject({
      ok: false,
      exitCode: 1,
      message: "claudexor: daemon unreachable",
      error: "claudexor: daemon unreachable",
    });
  });

  it("REDACTION: secret-like tokens are masked in message, context, details, fieldErrors, requiredActions", () => {
    // Runtime-assembled so this test's own source never holds a contiguous token.
    const token = ["sk", "REDACTLEAKPROBE1234567890ABCD"].join("-");
    const problem = {
      code: "revert_refused",
      message: `git failed leaking ${token}`,
      retryable: false,
      fieldErrors: { runId: [`bad token ${token}`] },
      requiredActions: [`rotate ${token}`],
      evidenceRefs: [`run/${token}/patch.diff`],
      context: { gitStderr: `error: auth ${token}` },
    };
    const env = captureJson(() => {
      renderCliFailure(true, controlProblemError(409, problem, "decision failed"));
    });
    // The token appears nowhere in the rendered envelope.
    expect(JSON.stringify(env)).not.toContain(token);
    // ...but the structure survives, masked.
    expect(String(env["message"])).toContain("[redacted]");
    expect(JSON.stringify(env["context"])).toContain("[redacted]");
    expect(JSON.stringify(env["fieldErrors"])).toContain("[redacted]");
    expect(JSON.stringify(env["requiredActions"])).toContain("[redacted]");
    expect(JSON.stringify(env["details"])).toContain("[redacted]");
  });

  it("EXTRAS: a per-command field (runId) rides alongside the canonical envelope, and canonical fields win", () => {
    // The projector-routed stragglers (inspect no-such-run, apply unsupported
    // mode, daemon stop-failed) attach identifying extras. The envelope stays
    // the canonical {ok,exitCode,message,error,...} shape — never a bare
    // {runId,error} — and an extra can never forge a reserved field.
    let code = -1;
    const env = captureJson(() => {
      code = renderCliFailure(true, new Error("no such run r-123"), {
        extras: { runId: "r-123", ok: true, exitCode: 0, message: "forged" },
      });
    });
    expect(code).toBe(1);
    expect(env["runId"]).toBe("r-123");
    // Canonical fields are projector-owned and override the forged extras.
    expect(env["ok"]).toBe(false);
    expect(env["exitCode"]).toBe(1);
    expect(env["message"]).toBe("no such run r-123");
    expect(env["error"]).toBe("no such run r-123");
  });

  it("EXTRAS are secret-redacted like the rest of the envelope", () => {
    const token = ["ghp", "A".repeat(36)].join("_");
    const env = captureJson(() => {
      renderCliFailure(true, new Error("login job failed"), {
        extras: { harness: "codex", detail: `server said ${token}` },
      });
    });
    expect(JSON.stringify(env)).not.toContain(token);
    expect(env["harness"]).toBe("codex");
  });

  it("FINDING 6: a secret token straddling the 2000-char truncation boundary is redacted, not leaked", () => {
    // Runtime-assembled so this source never holds a contiguous token. A
    // ghp_ token matches \bghp_[A-Za-z0-9]{20,}\b.
    const token = ["ghp", "A".repeat(36)].join("_");
    // Place the token so it straddles the MAX_CONTEXT_STRING (2000) boundary:
    // it begins a few chars before 2000 and ends after it. If truncation ran
    // BEFORE redaction, the head half would survive un-masked in the envelope.
    // The prefix ends with a NON-word char so the token has a real word
    // boundary the detector needs (`\bghp_…`); it still starts before index 2000.
    const prefix = `${"x".repeat(1995)} `;
    const stderr = `${prefix}${token}${"y".repeat(500)}`;
    expect(prefix.length).toBe(1996);
    expect(prefix.length).toBeLessThan(2000); // token starts before the boundary
    expect(prefix.length + token.length).toBeGreaterThan(2000); // and ends after it
    const problem = {
      code: "revert_refused",
      message: "git failed",
      retryable: false,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
      context: { gitStderr: stderr },
    };
    const env = captureJson(() => {
      renderCliFailure(true, controlProblemError(409, problem, "decision failed"));
    });
    const serialized = JSON.stringify(env);
    // Neither the whole token nor even its `ghp_` head half survives. If
    // truncation ran BEFORE redaction, the head `ghp_` (which alone is too short
    // to match the detector) would leak in the bounded evidence; redact-first
    // removes the whole token before the string is ever cut.
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("ghp_");
    // Truncation still happened (the context is bounded evidence).
    expect(JSON.stringify(env["context"])).toContain("truncated");
  });
});
