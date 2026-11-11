import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Only the daemon seam is stubbed; parsing, scope checks and rendering are real.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { projectCommand, projectRemovalLines } from "./project-command.js";

const RECEIPT = {
  projectId: "prj-1",
  root: "/repo/a",
  registryRemoved: true,
  journalPartitionArchived: true,
  archivedPartitionPath: "partition:project:prj-1@e1",
  artifactsRetained: true,
  activeRunCheck: "snapshot",
} as const;

function respond(status: number, body: unknown): void {
  mocks.controlApiFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("claudexor project remove (#333 opt-in)", () => {
  let out: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => {
      out.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    mocks.ensureDaemon.mockResolvedValue({ addr: { host: "127.0.0.1", port: 1 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the unchanged default request and prints its unchanged receipt", async () => {
    respond(200, RECEIPT);
    const code = await projectCommand(parseArgs(["project", "remove", "prj-1", "--json"]), true);
    expect(code).toBe(0);
    expect(mocks.controlApiFetch.mock.calls[0]?.[1]).toBe("/projects/prj-1");
    expect(mocks.controlApiFetch.mock.calls[0]?.[2]).toEqual({ method: "DELETE" });
    expect(JSON.parse(out.join(""))).toEqual(RECEIPT);
  });

  it("sends the exact opt-in query and reports purged threads with pending cleanup", async () => {
    respond(200, {
      ...RECEIPT,
      purgedThreads: [
        { threadId: "th-a", cleanup: "completed", cleanupError: null },
        { threadId: "th-b", cleanup: "pending", cleanupError: "EACCES: lanes" },
      ],
    });
    const code = await projectCommand(
      parseArgs(["project", "remove", "prj-1", "--purge-trashed-threads"]),
      false,
    );
    expect(code).toBe(0);
    expect(mocks.controlApiFetch.mock.calls[0]?.[1]).toBe("/projects/prj-1?trashedThreads=purge");
    expect(out.join("")).toContain("Purged 2 trashed thread(s): th-a, th-b.");
    expect(out.join("")).toContain(
      "warning: thread th-b cleanup pending (retried when the daemon next starts): EACCES: lanes",
    );
  });

  it("refuses the flag on every other project verb before contacting the daemon", async () => {
    for (const argv of [
      ["project", "list", "--purge-trashed-threads"],
      ["project", "--purge-trashed-threads"],
      ["project", "register", "/repo/a", "--purge-trashed-threads"],
    ]) {
      out = [];
      const code = await projectCommand(parseArgs([...argv, "--json"]), true);
      expect(code).toBe(2);
      expect(JSON.parse(out.join(""))).toMatchObject({
        ok: false,
        message: expect.stringContaining("--purge-trashed-threads"),
      });
    }
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.controlApiFetch).not.toHaveBeenCalled();
  });

  it("renders a typed refusal of the opt-in as an operational failure", async () => {
    respond(409, {
      code: "project_has_threads",
      message: "project prj-1 still has 1 thread(s) outside the trash; trash them first",
      retryable: false,
    });
    const code = await projectCommand(
      parseArgs(["project", "remove", "prj-1", "--purge-trashed-threads", "--json"]),
      true,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "project_has_threads",
    });
  });
});

describe("project removal lines", () => {
  it("keeps the default receipt lines unchanged", () => {
    expect(projectRemovalLines(RECEIPT)).toEqual([
      "Removed project prj-1 (/repo/a).",
      "  Journal partition archived to partition:project:prj-1@e1.",
      "  Run artifacts left in place for normal garbage collection.",
    ]);
  });

  it("says when the trash was empty", () => {
    expect(projectRemovalLines({ ...RECEIPT, purgedThreads: [] })).toContain(
      "  No threads were in the trash.",
    );
  });
});
