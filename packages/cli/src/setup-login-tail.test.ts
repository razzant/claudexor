import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { terminateAppServerChild } from "./setup-login-runner.js";
import { boundedTail, createTailBuffer } from "./setup-login-io.js";

describe("device-login output tail redaction (X224 ring path)", () => {
  it("a secret split by the 4096-byte ring boundary does not survive as a prefix-less fragment", () => {
    const buf = createTailBuffer();
    // Fill the ring, then push a secret whose head is cut by the boundary.
    buf.push(Buffer.from("A".repeat(4090)));
    const secret = ["sk", "ant", "DEADBEEFCAFEBABE0123456789"].join("-"); // runtime-assembled: never a literal token at rest
    buf.push(Buffer.from(secret + " trailing\n"));
    const out = buf.text();
    // The full token is redacted; the boundary fragment must not leak either.
    expect(out).not.toContain("DEADBEEFCAFEBABE0123456789");
    expect(out).toContain("trailing");
  });

  it("untruncated short output keeps its first token whole", () => {
    const buf = createTailBuffer();
    buf.push(Buffer.from("device code rejected by server\n"));
    expect(buf.text()).toBe("device code rejected by server");
  });

  it("boundedTail leaves a whole non-truncated string's leading word intact", () => {
    expect(boundedTail("firstword then rest", false)).toBe("firstword then rest");
  });

  it("redacts before selecting a direct-string tail boundary", () => {
    const secret = ["sk", "or", "v1", "BOUNDARYSECRETVALUE1234567890"].join("-");
    const output = boundedTail(`${"x".repeat(4090)} ${secret} trailing`);
    expect(output).not.toContain("BOUNDARYSECRETVALUE1234567890");
    expect(output).toContain("trailing");
  });

  it.each([4096, 4097])("clamps %i-byte multibyte input on a UTF-8 boundary", (size) => {
    const text = `${"a".repeat(size - 3)}€`;
    const output = boundedTail(text);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4096);
    expect(output).not.toContain("�");
  });

  it("an OAuth authorization URL's query never enters a durable tail (transient-only contract)", () => {
    const out = boundedTail(
      "Visit https://auth.openai.com/oauth/authorize?client_id=app_x&state=Zx9kQ2mP41Ns&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM and approve.",
    );
    expect(out).not.toContain("state=");
    expect(out).not.toContain("code_challenge");
    expect(out).toContain("https://auth.openai.com/oauth/authorize?[redacted]");
    expect(out).toContain("and approve.");
  });

  it("a device verification URL keeps host+path for diagnosis but drops its query", () => {
    const out = boundedTail(
      "First, visit https://github.com/login/device?user_code=ABCD-EFGH to continue.",
    );
    expect(out).toContain("https://github.com/login/device?[redacted]");
    expect(out).not.toContain("ABCD-EFGH");
  });

  it("a query-less URL survives whole", () => {
    expect(boundedTail("see https://example.com/docs/errors for details")).toBe(
      "see https://example.com/docs/errors for details",
    );
  });
});

describe("device-login app-server termination", () => {
  function childThatClosesOn(signalToClose: NodeJS.Signals, delayMs: number) {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === signalToClose) {
          setTimeout(() => {
            Object.assign(child, { signalCode: signal });
            child.emit("close", null, signal);
          }, delayMs);
        }
        return true;
      }),
    });
    return child;
  }

  it("waits for a slow cooperative TERM before returning", async () => {
    const child = childThatClosesOn("SIGTERM", 10);
    const close = vi.fn();
    await terminateAppServerChild(child, { close }, { termGraceMs: 100, killGraceMs: 10 });
    expect(close).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates a TERM-ignoring child and waits for confirmed SIGKILL close", async () => {
    const child = childThatClosesOn("SIGKILL", 5);
    await terminateAppServerChild(child, { close: vi.fn() }, { termGraceMs: 1, killGraceMs: 100 });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("does not mistake a kill error event for process death", async () => {
    const child = childThatClosesOn("SIGKILL", 5);
    child.on("error", () => undefined);
    const kill = child.kill as ReturnType<typeof vi.fn>;
    kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") child.emit("error", new Error("TERM delivery failed"));
      if (signal === "SIGKILL") {
        setTimeout(() => {
          Object.assign(child, { signalCode: signal });
          child.emit("close", null, signal);
        }, 5);
      }
      return true;
    });

    await terminateAppServerChild(child, { close: vi.fn() }, { termGraceMs: 1, killGraceMs: 100 });

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});

/**
 * A tty-backed login ECHOES what the runner writes, so the pasted sign-in code
 * comes straight back out on the tee'd output and would otherwise ride a
 * failure receipt to disk (INV-146). The tail is told to forget the delivered
 * value — and must forget it in the shapes a terminal actually produces.
 */
describe("createTailBuffer().forget (tty echo of a delivered sign-in code)", () => {
  const echoed = (code: string): string => {
    const tail = createTailBuffer();
    tail.forget(code);
    // The line discipline turns a CR into a line break, so the code comes back
    // as the runner wrote it OR split across lines.
    tail.push(
      Buffer.from(`Sign in: https://vendor/auth\n${code.replaceAll("\r", "\n")}\nrejected`),
    );
    return tail.text();
  };

  it("forgets a short code, a padded one, and one a terminal split across lines", () => {
    for (const code of ["x", "a9x", "  spaced-code  ", "abcd1234\refgh5678", "AB\r\nCD"]) {
      const out = echoed(code);
      for (const part of code.split(/[\r\n]+/)) {
        if (part.trim()) expect(out).not.toContain(part.trim());
      }
    }
  });

  it("keeps the surrounding diagnostic that makes a failure readable", () => {
    expect(echoed("code-123456")).toContain("rejected");
  });

  it("forgets a code the vendor re-prints IN COLOUR", () => {
    // Escapes inside the value defeat an exact-string match; stripping them
    // afterwards then reassembles the plaintext into a durable receipt.
    const code = "4/0AY0e-PASTEDCODE-xyz";
    const tail = createTailBuffer();
    tail.forget(code);
    tail.push(Buffer.from("rejected: \u001b[32m4/0AY0e-\u001b[0mPASTEDCODE-xyz\n"));
    const out = tail.text();
    expect(out).not.toContain("PASTEDCODE");
    expect(out).toContain("rejected");
  });
});
