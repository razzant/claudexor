/**
 * #299: the auth capability smoke (max_turns 1) reads errors, not caps. A turn
 * the cap ended after streaming the challenge token as narration must not be
 * certified; the same narration closed by a successful result still passes.
 * The events come from the real Claude parser over native frames.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthCapabilityVerifier, type HarnessAdapter } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { createClaudeParser } from "./parse.js";
import { withClaudeApiFailureParser } from "./vendor-failure.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function token(spec: HarnessRunSpec): string {
  const match = /^Return exactly (\S+) and no other text\./.exec(spec.prompt);
  if (!match?.[1]) throw new Error("unexpected challenge prompt");
  return match[1];
}

/** Claude's frames for a one-turn smoke whose result is `result(token)`. */
function claudeSmoke(result: (token: string) => Record<string, unknown>): HarnessAdapter {
  return {
    id: "claude",
    async discover() {
      throw new Error("not called by the smoke");
    },
    async doctor() {
      throw new Error("not called by the smoke");
    },
    async *run(spec) {
      const parse = withClaudeApiFailureParser(createClaudeParser(), null);
      const frames = [
        { type: "system", subtype: "init", session_id: "native-smoke", model: "claude-fable-5-1" },
        { type: "assistant", message: { content: [{ type: "text", text: token(spec) }] } },
        result(token(spec)),
      ];
      for (const frame of frames)
        for (const event of parse(frame, spec.session_id) ?? [])
          yield event.type === "started"
            ? ({
                ...event,
                credential_route: "vendor_native",
                credential_source: "native_session",
              } as HarnessEvent)
            : event;
      yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
    },
  };
}

async function smoke(adapter: HarnessAdapter) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-turn-limit-smoke-")));
  roots.push(root);
  const subject = new AuthCapabilityVerifier(() => adapter, {
    scratchRoot: join(root, "auth-smokes"),
  });
  const binding = subject.prepare({
    attemptId: "attempt-1",
    harness: "claude",
    requested: "subscription",
    requiredRoute: "vendor_native",
    requiredSource: "native_session",
  }).binding;
  return subject.verify({ binding, startedAt: new Date().toISOString() });
}

describe("#299 a capped turn never passes the auth capability smoke", () => {
  it("the capped turn fails even though its narration was the token", async () => {
    const receipt = await smoke(
      claudeSmoke(() => ({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 1,
        errors: ["Reached maximum number of turns (1)"],
      })),
    );
    expect(receipt.verification).not.toBe("passed");
  });

  it("control: the same narration closed by a successful result passes", async () => {
    const receipt = await smoke(
      claudeSmoke((value) => ({
        type: "result",
        subtype: "success",
        is_error: false,
        result: value,
      })),
    );
    expect(receipt.verification).toBe("passed");
  });
});
