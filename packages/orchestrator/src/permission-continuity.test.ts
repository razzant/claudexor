import { describe, expect, it } from "vitest";
import { run } from "./inrun-continuity.test-support.js";

describe("typed permission refusal across real attempt/continuity owner", () => {
  it.each(["ask", "agent"] as const)(
    "does not replay or raise rights after %s permission denial, and retains partial output",
    async (mode) => {
      const outcome = await run({
        mode,
        profiles: ["a", "b"],
        maxRetries: 2,
        script: function* ({ spec, emit }) {
          expect(spec.access).toBe(mode === "ask" ? "readonly" : "workspace_write");
          yield emit({ type: "started", payload: { native_session_id: "fixture-session" } });
          yield emit({ type: "message", text: "Useful partial observation" });
          yield emit({
            type: "error",
            error: "Native read_file permission was auto-denied",
            permission_denial: { permission: "read_file", source: "agy_native_stderr" },
          });
          yield emit({ type: "completed", payload: { exit_code: 0 } });
        },
      });
      expect(outcome.spawns).toHaveLength(1);
      expect(outcome.rotated).toHaveLength(0);
      expect(outcome.resumable).toMatchObject({ cause: "permission_denied" });
      expect(JSON.stringify(outcome.result)).toContain("capability_refused");
    },
  );
});
