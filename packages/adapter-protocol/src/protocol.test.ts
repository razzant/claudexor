import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport, HarnessManifest } from "@claudex/schema";
import { JsonRpcAdapterClient } from "./client.js";
import { runAdapterServer } from "./server.js";

function demoImpl(): HarnessAdapter {
  return {
    id: "demo",
    async discover() {
      return HarnessManifest.parse({
        id: "demo",
        display_name: "Demo External Adapter",
        kind: "external_adapter",
        provider_family: "local",
        capabilities: { implement: true, structured_events: true, review: true },
      });
    },
    async doctor(_spec: DoctorSpec) {
      return ConformanceReport.parse({
        harness_id: "demo",
        status: "ok",
        enabled_intents: ["implement", "review"],
      });
    },
    async *run(spec: HarnessRunSpec): AsyncGenerator<HarnessEvent> {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: `echo:${spec.prompt}` };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

describe("JSON-RPC adapter protocol", () => {
  it("round-trips discover, doctor, and a streaming run over a line transport", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = runAdapterServer(demoImpl(), { read: c2s, write: s2c });
    const client = new JsonRpcAdapterClient("demo", { write: c2s, read: s2c });

    try {
      const manifest = await client.discover();
      expect(manifest.id).toBe("demo");
      expect(manifest.capabilities.implement).toBe(true);

      const report = await client.doctor({ cwd: "/tmp" });
      expect(report.status).toBe("ok");
      expect(report.enabled_intents).toContain("review");

      const types: string[] = [];
      let text = "";
      for await (const ev of client.run({
        session_id: "s1",
        intent: "implement",
        prompt: "hello",
        cwd: "/tmp",
        model_hint: null,
        max_usd: null,
        max_turns: null,
        env: {},
        extra: {},
      })) {
        types.push(ev.type);
        if (ev.type === "message" && ev.text) text = ev.text;
      }
      expect(types).toEqual(["started", "message", "completed"]);
      expect(text).toBe("echo:hello");
    } finally {
      c2s.end();
      s2c.end();
      await server;
    }
  });
});
