import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
  fetchRunDetail: vi.fn(),
  controlApiFetch: vi.fn(),
}));

vi.mock("./daemon-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-run.js")>();
  return {
    ...actual,
    ensureDaemon: mocks.ensureDaemon,
    enqueueAndAwait: mocks.enqueueAndAwait,
    fetchRunDetail: mocks.fetchRunDetail,
  };
});

vi.mock("./live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live.js")>();
  return { ...actual, controlApiFetch: mocks.controlApiFetch };
});

describe("plan CLI attachment transport", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("uploads the selected bytes, finalizes their digest, and enqueues only the resource ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-plan-attachment-"));
    roots.push(root);
    const attachmentPath = join(root, "brief.txt");
    const bytes = "PLAN_ATTACHMENT_SENTINEL\n";
    writeFileSync(attachmentPath, bytes);

    const addr = { baseUrl: "http://127.0.0.1:1", token: "test-token" };
    let uploadedBytes = "";
    let finalizedBody: Record<string, unknown> | null = null;
    let runBody: Record<string, unknown> | null = null;
    mocks.ensureDaemon.mockResolvedValue({ client: {}, addr });
    mocks.fetchRunDetail.mockResolvedValue(null);
    mocks.enqueueAndAwait.mockImplementation(async (_client, _addr, body) => {
      runBody = body as Record<string, unknown>;
      return {
        runId: "run-plan-attachment",
        runDir: "/tmp/run-plan-attachment",
        status: "succeeded",
        jobId: "job-plan-attachment",
      };
    });
    mocks.controlApiFetch.mockImplementation(
      async (_addr: unknown, path: string, init?: RequestInit) => {
        if (path === "/uploads" && init?.method === "POST") {
          return new Response(JSON.stringify({ uploadId: "upload-plan-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/uploads/upload-plan-1/bytes" && init?.method === "PUT") {
          uploadedBytes = await new Response(init.body ?? null).text();
          return new Response(null, { status: 204 });
        }
        if (path === "/uploads/upload-plan-1/finalize" && init?.method === "POST") {
          finalizedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ resourceId: "res-plan-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected control request: ${init?.method ?? "GET"} ${path}`);
      },
    );

    const priorArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const flushedWrite = (...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
      callback?.();
      return true;
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(flushedWrite as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(flushedWrite as never);
    process.argv = [
      process.execPath,
      "claudexor",
      "plan",
      "Use the attached brief",
      "--attach",
      attachmentPath,
      "--json",
      "--processing",
      "standard",
      "--workspace-kind",
      "directory",
      "--scope-path",
      "assets, originals",
      "--scope-path",
      "brief.txt",
    ];
    try {
      await import("./cli.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_500 });
    } finally {
      process.argv = priorArgv;
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(uploadedBytes).toBe(bytes);
    expect(finalizedBody).toEqual({
      expectedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    expect(runBody).toMatchObject({
      mode: "plan",
      prompt: "Use the attached brief",
      attachments: [{ resourceId: "res-plan-1" }],
      processingPreference: "standard",
      execution: {
        isolation: "envelope",
        workspaceKind: "directory",
        scopePaths: ["assets, originals", "brief.txt"],
      },
    });
    expect(JSON.stringify(runBody)).not.toContain(attachmentPath);
    expect(JSON.stringify(runBody)).not.toContain("PLAN_ATTACHMENT_SENTINEL");
  });
});
