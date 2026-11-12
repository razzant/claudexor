import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCursorAdapter } from "./index.js";

/**
 * #413: the receipt names the exact access arguments Cursor is launched with, from the
 * same helper that builds them, so it can never drift from the argv. Nothing
 * here changes those arguments (owner decision: facts first, no new limits).
 */
const spec = (access: string, web = "auto", intent = "implement"): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-cursor-native-access",
    intent,
    prompt: "go",
    cwd: "/repo",
    access,
    external_context_policy: web,
    env: { AGENT_CLI_CREDENTIAL_STORE: "file" },
  });

function adapter(captured: string[][]) {
  return createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ kind: "authenticated" }),
    cursorApiKey: () => null,
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      captured.push([...opts.args]);
      yield { type: "completed", session_id: opts.spec.session_id, ts: "2026-01-01T00:00:00.000Z" };
    },
  });
}

describe("cursor native access disclosure", () => {
  it.each([
    ["readonly", "auto", "--force --sandbox enabled --trust --mode ask"],
    ["readonly", "off", "--sandbox enabled --trust --mode ask"],
    ["workspace_write", "auto", "--force --sandbox enabled --trust"],
    ["full", "live", "--force --sandbox disabled --trust"],
    ["inherit_native", "live", "--trust"],
  ])("%s with web %s passes exactly what it discloses", async (access, web, expected) => {
    const captured: string[][] = [];
    const cursor = adapter(captured);
    const s = spec(access, web);
    expect(cursor.nativeAccess?.(s)).toBe(expected);
    for await (const _ of cursor.run(s)) void _;
    const argv = captured[0]!;
    // Every disclosed token is in the argv, in the disclosed order.
    let from = 0;
    for (const token of expected.split(" ")) {
      const at = argv.indexOf(token, from);
      expect(at, `${token} missing from ${argv.join(" ")}`).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it("a pre-spawn refusal launches nothing and emits no native start", async () => {
    const captured: string[][] = [];
    const cursor = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "loggedOut" }),
      cursorApiKey: () => null,
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        captured.push([...opts.args]);
      },
    });
    const s = spec("readonly");
    const events: HarnessEvent[] = [];
    for await (const event of cursor.run(s)) events.push(event);
    expect(captured).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    // The setting it would have passed is still what the gate records as prepared.
    expect(cursor.nativeAccess?.(s)).toBe("--force --sandbox enabled --trust --mode ask");
  });

  it("discloses Ask mode for a plan intent too, because that is what runs", () => {
    expect(createCursorAdapter().nativeAccess?.(spec("workspace_write", "auto", "plan"))).toBe(
      "--force --sandbox enabled --trust --mode ask",
    );
  });
});
