import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { appendHarnessEvent, maskHarnessEventDiagnostics } from "./event-diagnostics.js";

// Synthetic token-shaped values, assembled at runtime.
const SECRET = ["sk-proj", "Diag", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("-");
const WORK = ["ghp", "W0rk7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae"].join("_");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("harness event diagnostics seam (INV-146)", () => {
  it("masks an error event's text, error and whole native payload", () => {
    const ev: HarnessEvent = {
      type: "error",
      session_id: "s",
      ts: "t",
      error: `rejected ${SECRET}`,
      text: `rejected ${SECRET}`,
      payload: { type: "turn.failed", error: { message: `rejected ${SECRET}` }, code: "x" },
    };
    const masked = maskHarnessEventDiagnostics(ev);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.payload).toMatchObject({ type: "turn.failed", code: "x" });
    expect(JSON.stringify(ev)).toContain(SECRET); // the caller's event is not mutated
  });

  it("masks diagnostic payload keys on any event and keeps working content exact", () => {
    const ev: HarnessEvent = {
      type: "completed",
      session_id: "s",
      ts: "t",
      text: `answer ${WORK}`,
      tool: { name: "Bash", kind: "command", target: `export KEY=${WORK}` },
      payload: {
        vendor_failure: { message: `key ${SECRET}` },
        stderr_tail: `boom ${SECRET}`,
        launch_advisory: `adv ${SECRET}`,
        provider_error: { message: `p ${SECRET}` },
        error: { message: `e ${SECRET}` },
        stderr: `s ${SECRET}`,
        final_source: `work ${WORK}`,
      },
    };
    const masked = maskHarnessEventDiagnostics(ev);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.text).toBe(`answer ${WORK}`);
    expect(masked.tool?.target).toBe(`export KEY=${WORK}`);
    expect(masked.payload?.["final_source"]).toBe(`work ${WORK}`);
  });

  it("keeps a failed completion's partial output exact and masks the rest of its error payload", () => {
    const ev: HarnessEvent = {
      type: "error",
      session_id: "s",
      ts: "t",
      error: "raw-api provider completion failed",
      payload: {
        finish_reason: "error",
        provider_error: { code: 502, message: `upstream ${SECRET}` },
        partial_output: `const key = "${WORK}";`,
        partial_output_truncated: false,
      },
    };
    const masked = maskHarnessEventDiagnostics(ev);
    expect(masked.payload?.["partial_output"]).toBe(`const key = "${WORK}";`);
    expect(masked.payload?.["partial_output_truncated"]).toBe(false);
    expect(masked.payload?.["provider_error"]).toEqual({
      code: 502,
      message: "upstream [redacted]",
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it("masks credential-shaped keys of an error payload as well as nested values", () => {
    const ev: HarnessEvent = {
      type: "error",
      session_id: "s",
      ts: "t",
      error: "failed",
      payload: {
        [`x-${SECRET}`]: "extension",
        native: { [SECRET]: `nested ${SECRET}` },
        code: 7,
        partial_output: `const key = "${WORK}";`,
      },
    };
    const masked = maskHarnessEventDiagnostics(ev);
    expect(JSON.stringify(masked).includes(SECRET), "a key or value keeps the value").toBe(false);
    expect(masked.payload?.["x-[redacted]"]).toBe("extension");
    expect(masked.payload?.["native"]).toEqual({ "[redacted]": "nested [redacted]" });
    expect(masked.payload?.["code"]).toBe(7);
    expect(masked.payload?.["partial_output"]).toBe(`const key = "${WORK}";`);
  });

  it("appends the masked view as one JSON line", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-event-diagnostics-"));
    dirs.push(dir);
    const path = join(dir, "events.jsonl");
    appendHarnessEvent(path, { type: "error", session_id: "s", ts: "t", error: SECRET });
    appendHarnessEvent(path, { type: "message", session_id: "s", ts: "t", text: WORK });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain(SECRET);
    expect(JSON.parse(lines[1]!).text).toBe(WORK);
  });

  it("never returns an unmasked diagnostic it cannot serialize", () => {
    const cyclic: Record<string, unknown> = { message: `rejected ${SECRET}` };
    cyclic["self"] = cyclic;
    const masked = maskHarnessEventDiagnostics({
      type: "completed",
      session_id: "s",
      ts: "t",
      payload: { provider_error: cyclic },
    });
    expect(masked.payload?.["provider_error"]).toBe("[unserializable diagnostic]");
  });

  it("keeps an error payload a record when part of it cannot be serialized", () => {
    const cyclic: Record<string, unknown> = { message: `rejected ${SECRET}` };
    cyclic["self"] = cyclic;
    const masked = maskHarnessEventDiagnostics({
      type: "error",
      session_id: "s",
      ts: "t",
      error: "failed",
      payload: { [`k-${SECRET}`]: cyclic, code: 7, partial_output: WORK },
    });
    expect(masked.payload).toEqual({
      "k-[redacted]": "[unserializable diagnostic]",
      code: 7,
      partial_output: WORK,
    });
  });
});

/** Proof that no writer bypasses the seam: every production source that
 * persists harness events either emits `harness.event` through
 * `harnessEventPayload` (which masks with this seam) or appends through
 * `appendHarnessEvent`. */
describe("no harness-event journal writer bypasses the seam", () => {
  const packagesDir = fileURLToPath(new URL("../../", import.meta.url));
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "dist" && name !== "test-support") walk(path);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
        sources.push(path);
    }
  };
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, "src");
    try {
      if (statSync(src).isDirectory() && pkg !== "canary") walk(src);
    } catch {
      /* not a package with sources */
    }
  }

  // Engine-authored status lines, not adapter events: a capped-preview notice
  // and a retained-output save failure (its text is masked where it is built).
  const ENGINE_STATUS = new Set([
    "orchestrator/src/laneStreamEvents.ts",
    "orchestrator/src/retainedOutput.ts",
  ]);
  // The EventLog itself appends run envelopes; their harness payloads are the
  // `harnessEventPayload` projections the emit check above covers.
  const RUN_ENVELOPE_WRITER = "event-log/src/index.ts";

  it("emits harness.event only through harnessEventPayload (or an engine-authored status)", () => {
    const offenders: string[] = [];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/emit\(\s*"harness\.event",\s*([^\n]*)/g)) {
        const argument = match[1] ?? "";
        const engineStatus = ENGINE_STATUS.has(relative(packagesDir, path));
        if (!argument.startsWith("harnessEventPayload(") && !engineStatus)
          offenders.push(`${relative(packagesDir, path)}: ${argument.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never appends a raw harness event to a journal", () => {
    const offenders: string[] = [];
    for (const path of sources) {
      if (relative(packagesDir, path) === RUN_ENVELOPE_WRITER) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/appendLine\([^)]*JSON\.stringify\((ev|event|raw|persistedEvent)\)/.test(line))
          offenders.push(`${relative(packagesDir, path)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
