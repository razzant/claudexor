import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlRunListResponse } from "@claudexor/schema";
import { expect, it, vi } from "vitest";
import { projectBulkJob } from "./bulk-worker.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonRunRecord } from "./run-record.js";

const fault = vi.hoisted(() => ({ path: "", code: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === fault.path)
        throw Object.assign(new Error(`${fault.code}: unreadable artifact`), { code: fault.code });
      return fs.lstatSync(...args);
    },
  };
});

it.each(["EACCES", "EIO", "ELOOP"])(
  "degrades a fingerprint %s per row and recovers on the next read",
  async (code) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-summary-error-")));
    const record: DaemonRunRecord = { id: "bad", state: "running", runDir: root };
    try {
      fault.path = join(root, "events.jsonl");
      fault.code = code;
      const failed = await projectBulkJob({ kind: "summary", input: { record } }, async () => null);
      expect(failed).toMatchObject({
        summary: { jobId: "bad", state: "failed", error: expect.stringContaining(code) },
      });
      expect(failed).not.toHaveProperty("fingerprint");
      fault.path = "";
      const healthy = await projectBulkJob(
        { kind: "summary", input: { record } },
        async () => null,
      );
      expect(healthy).toMatchObject({
        summary: { jobId: "bad", state: "running" },
        fingerprint: { value: expect.any(String) },
      });
    } finally {
      fault.path = "";
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "serves an unreadable-final diagnostic beside a healthy run over HTTP and recovers after repair",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-summary-http-error-"));
    const records: DaemonRunRecord[] = ["bad", "healthy"].map((id) => {
      const runDir = join(root, id);
      mkdirSync(join(runDir, "final"), { recursive: true });
      return { id, runId: `run-${id}`, runDir, state: "running", params: { mode: "ask" } };
    });
    const badFinal = join(records[0]!.runDir!, "final");
    const server = new DaemonControlApiServer({
      token: "summary-errors",
      daemon: {
        list: async () => records,
        status: async () => records[0]!,
        enqueue: async () => ({ id: "unused", state: "queued" }),
        cancel: async () => ({}),
      },
    });
    try {
      const { host, port } = await server.start();
      const get = () =>
        fetch(`http://${host}:${port}/v2/runs`, {
          headers: {
            authorization: "Bearer summary-errors",
            "X-Claudexor-Protocol-Major": "3",
          },
        });
      chmodSync(badFinal, 0);
      const response = await get();
      expect(response.status).toBe(200);
      const body = ControlRunListResponse.parse(await response.json());
      expect(body.runs).toEqual([
        expect.objectContaining({ jobId: "healthy", state: "running" }),
        expect.objectContaining({
          jobId: "bad",
          state: "failed",
          error: expect.stringContaining("EACCES"),
        }),
      ]);
      chmodSync(badFinal, 0o700);
      const repaired = await get();
      expect(repaired.status).toBe(200);
      expect(
        ControlRunListResponse.parse(await repaired.json()).runs.map((row) => row.state),
      ).toEqual(["running", "running"]);
    } finally {
      chmodSync(badFinal, 0o700);
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
