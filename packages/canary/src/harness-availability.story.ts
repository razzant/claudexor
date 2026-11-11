/** Harness availability over the public CLI, kept apart from the general
 * golden story so that file stays below the complexity ratchet. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readEvents } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function startedHarnesses(runDir: string): unknown[] {
  return readEvents(runDir)
    .filter((event) => event["type"] === "harness.started")
    .map((event) => (event["payload"] as Record<string, unknown>)["harness_id"]);
}

describe("harness availability canary", () => {
  it("[INV-012:explicit-unavailable-refused] an explicitly selected missing harness fails loudly with its doctor reason and never starts the available alternative", () => {
    // CLAUDEXOR_CURSOR_BIN wins verbatim, so Cursor is missing on every host,
    // including the auto-started daemon that owns doctor and routing.
    sb.env.CLAUDEXOR_CURSOR_BIN = join(sb.home, "no-cursor-agent");

    // Control: the alternative is genuinely available and starts on its own.
    const alone = cli(sb, ["ask", "what is 2+2?", "--harness", "fake-success", "--json"]);
    expect(alone.code, alone.stdout + alone.stderr).toBe(0);
    const aloneRunDir = (alone.json() as { runDir: string }).runDir;
    expect(startedHarnesses(aloneRunDir)).toEqual(["fake-success"]);
    expect(readdirSync(join(aloneRunDir, "attempts")).length).toBeGreaterThan(0);

    const doctor = cli(sb, ["doctor", "--harness", "cursor", "--all", "--json"]);
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    const [cursor] = (doctor.json() as { harnesses: Array<{ status: string; reasons: string[] }> })
      .harnesses;
    expect(cursor?.status).toBe("unavailable");
    expect(cursor?.reasons.length).toBeGreaterThan(0);

    const r = cli(sb, ["ask", "what is 2+2?", "--harness", "cursor,fake-success", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    const out = r.json() as {
      runDir: string;
      status: string;
      summary: string;
      failure: { phase: string; category: string };
    };
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ phase: "routing", category: "harness_unavailable" });
    expect(out.summary).toContain("cursor is unavailable");
    for (const reason of cursor!.reasons) expect(out.summary).toContain(reason);
    // Refused at routing: neither the missing lane nor the ready one started.
    expect(startedHarnesses(out.runDir)).toEqual([]);
    expect(readdirSync(join(out.runDir, "attempts"))).toEqual([]);
  });
});
