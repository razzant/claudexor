import { describe, expect, it } from "vitest";
import type { spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { readFileSync } from "node:fs";
const nativeError = JSON.parse(
  readFileSync(
    new URL("../fixtures/app-server/input-too-large-0.162.1.jsonl", import.meta.url),
    "utf8",
  ),
);
import {
  CodexRpcError,
  codexRequestRefusal,
  codexAppServerThreadParams,
} from "./app-server-protocol.js";
import { runCodexAppServer } from "./app-server-run.js";
import { codexAppServerInput } from "./attachments.js";
import { createCodexAdapter } from "./index.js";
import { CODEX_TURN_INPUT_LIMIT } from "./capability-profile.js";

describe("native input refusal", () => {
  it("keeps machine data while refusing to classify identical prose without it", () => {
    const error = new CodexRpcError(nativeError.code, nativeError.message, nativeError.data);
    expect(error.data).toBe(nativeError.data);
    expect(codexRequestRefusal(error)).toMatchObject({
      kind: "input_too_large",
      unit: "unicode_scalars",
      scope: "turn_text",
      limit: 1048576,
      actual: 1048577,
      native_code: "input_too_large",
    });
    expect(
      codexRequestRefusal(new CodexRpcError(nativeError.code, nativeError.message)),
    ).toBeNull();
    expect(codexRequestRefusal(new Error(nativeError.message))).toBeNull();
    expect(
      codexRequestRefusal(
        new CodexRpcError(-32602, "irrelevant", { input_error_code: "input_too_large" }),
      ),
    ).toMatchObject({ kind: "input_too_large", actual: null, limit: null });
  });

  it("carries the recorded RPC error through the actual app-server transport", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;
    let starts = 0;
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(text) {
          const request = JSON.parse(text);
          if (!request.id) return;
          const reply =
            request.method === "turn/start"
              ? (starts++, { id: request.id, error: nativeError })
              : {
                  id: request.id,
                  result: request.method === "thread/start" ? { thread: { id: "thread" } } : {},
                };
          replies.push(JSON.stringify(reply));
          wake?.();
        },
        end() {
          stopped = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stopped) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      cwd: "/repo",
      prompt: "a".repeat(1048577),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({ bin: "codex", args: [], spec, env: {}, spawn }))
      events.push(event);
    expect(starts).toBe(1);
    expect(events.find((event) => event.type === "error")?.request_refusal).toMatchObject({
      limit: 1048576,
      actual: 1048577,
    });
    expect(events.at(-1)?.type).toBe("completed");
    expect(stopped).toBe(true);
  });

  it("keeps separate developer instructions outside the native turn-text scope", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      cwd: "/repo",
      prompt: "😀界",
      instructions: "x".repeat(1048577),
    });
    const inputs = codexAppServerInput(spec);
    expect(inputs).toEqual([{ type: "text", text: "😀界" }]);
    expect(Array.from(inputs[0]!["text"] as string)).toHaveLength(2);
    expect(codexAppServerThreadParams(spec)["developerInstructions"]).toBe(spec.instructions);
  });

  it.each(["codex-cli 0.162.1", "codex-cli 0.156.1", "codex-cli 0.999.0"])(
    "publishes only version-bound capacity for %s",
    async (version) => {
      const adapter = createCodexAdapter({
        detectVersion: async () => version,
        probeLogin: async () => ({ authed: false, method: "logged_out", probeError: null }),
        hasApiKey: () => false,
        probeEfforts: async () => null,
      });
      const manifest = await adapter.discover();
      expect(manifest?.capability_profile.input_limits).toEqual(
        version === "codex-cli 0.162.1" ? [CODEX_TURN_INPUT_LIMIT] : undefined,
      );
    },
  );
});
