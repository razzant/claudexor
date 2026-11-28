import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stringify, parse } from "yaml";
import {
  DecisionRecord,
  makeOutcomeFacts,
  TaskContract,
  SCHEMA_VERSION,
  type WorkspaceFilesManifest,
} from "@claudexor/schema";
import {
  WorkspaceManager,
  envelopeBaseOf,
  fileCopyHost,
  retainForInspection,
  retainedSourcesOfRun,
} from "@claudexor/workspace";
import { DaemonControlApiServer } from "./daemon-server.js";

/** A test's stand-in for one files delivery at its boundary; null: the real one. */
const delivery = vi.hoisted(() => ({
  stub: null as null | ((targetRoot: string) => Promise<unknown>),
  calls: 0,
}));
vi.mock("@claudexor/delivery", async (original) => {
  const actual = await original<typeof import("@claudexor/delivery")>();
  return {
    ...actual,
    verifyAndDeliverFiles: (async (...args: Parameters<typeof actual.verifyAndDeliverFiles>) => {
      if (!delivery.stub) return actual.verifyAndDeliverFiles(...args);
      delivery.calls++;
      return delivery.stub(args[0]);
    }) as typeof actual.verifyAndDeliverFiles,
  };
});
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const stops: Array<() => Promise<unknown>> = [];
const removals: Array<() => Promise<unknown>> = [];
// Stops first, then the fs/promises removals, each under the hook deadline (#376). A stop that
// fails or settles late keeps this test's root; the removals are taken before the first await.
afterEachClosed(
  async () => {
    const ownedRemovals = removals.splice(0).reverse();
    for (const stop of stops.splice(0).reverse()) await stop();
    return async () => {
      for (const remove of ownedRemovals) await remove();
    };
  },
  undefined,
  "awaited",
);
const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(
  big = false,
  isolation: "envelope" | "live" = "envelope",
  /** The small new file is written before the large document. */
  newFirst = false,
) {
  const root = await mkdtemp(join(tmpdir(), "cx-files-result-"));
  removals.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    run = join(root, "run");
  await mkdir(source);
  await mkdir(join(run, "final/files/content"), { recursive: true });
  await mkdir(join(run, "arbitration"));
  await mkdir(join(run, "context"));
  await writeFile(
    join(run, "context/task.yaml"),
    stringify(
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task-files",
        created_at: "2026-09-13T00:00:00Z",
        repo: { root: source, base_ref: "HEAD" },
        mode: { kind: "agent" },
        user_intent: { raw: "Edit files" },
        review_requested: false,
      }),
    ),
  );
  const old = Buffer.from("baseline\n"),
    output = big ? Buffer.alloc(33 * 1024 * 1024, 0x51) : Buffer.from([0, 255, 12, 99]);
  const file = async (bytes: Buffer) => {
    const sha256 = digest(bytes),
      artifactPath = `final/files/content/${sha256.slice(7)}`;
    await writeFile(join(run, artifactPath), bytes);
    return {
      kind: "file" as const,
      sha256,
      sizeBytes: bytes.length,
      mode: (await stat(join(run, artifactPath))).mode & 0o777,
      artifactPath,
    };
  };
  await writeFile(join(source, "document.bin"), old);
  const manifest: WorkspaceFilesManifest = {
    version: 1,
    sourceRoot: source,
    executionRoot: isolation === "live" ? source : join(root, "execution"),
    isolation,
    scopePaths: ["document.bin"],
    complete: true,
    entries: [
      { path: "document.bin", before: await file(old), after: await file(output) },
      { path: "new.txt", before: null, after: await file(Buffer.from("new")) },
    ].sort((a, b) => (newFirst ? b.path.localeCompare(a.path) : 0)),
  };
  const text = JSON.stringify(manifest) + "\n",
    manifestSha256 = digest(text);
  await writeFile(join(run, "final/files/manifest.json"), text);
  await writeFile(
    join(run, "final/work_product.yaml"),
    stringify({
      id: "wp-files",
      kind: "files",
      source_task_id: "task-files",
      producer_attempt_id: "a01",
      files: { manifest: "final/files/manifest.json" },
      meta: {
        manifest_sha256: manifestSha256,
        result_kind: "files",
        apply_state: isolation === "live" ? "applied" : "not_applied",
        adopted: isolation === "live",
      },
    }),
  );
  await writeFile(
    join(run, "arbitration/decision.yaml"),
    stringify(
      DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", { review: "not_run", review_requested: false }),
      }),
    ),
  );
  const record = {
    id: "run-files",
    runId: "run-files",
    taskId: "task-files",
    runDir: run,
    state: "succeeded",
    params: {
      mode: "agent",
      scope: { kind: "project", root: source },
      execution: { workspaceKind: "directory", isolation },
    },
  };
  const commands = new Map<string, { id: string; state: string; result?: unknown }>();
  /** A durable journal that refuses the receipt's write. */
  const faults = { complete: false };
  const server = new DaemonControlApiServer({
    token: "fixture-token",
    daemon: {
      enqueue: async () => {
        throw new Error("No generation permitted");
      },
      status: async () => record,
      list: async () => [record],
      cancel: async () => ({}),
    },
    services: {
      beginDelivery: async (_params, input) => {
        const key = input.operation + input.key,
          prior = commands.get(key);
        if (prior) return { ...prior, reused: true };
        const item = { id: key, state: "running" };
        commands.set(key, item);
        return { ...item, reused: false };
      },
      // Stored as a durable command journal keeps it: a replay reads it back deserialized.
      completeDelivery: async (id, result) => {
        if (faults.complete) throw new Error("journal unavailable");
        Object.assign(commands.get(id)!, {
          state: "succeeded",
          result: JSON.parse(JSON.stringify(result)),
        });
      },
      operatorDecision: () => fixtureOperator.current,
      failDelivery: async (id) => {
        Object.assign(commands.get(id)!, { state: "failed" });
      },
    },
  });
  const { host, port } = await server.start();
  stops.push(() => server.stop());
  const request = (path: string, body?: unknown, key = "fixture-key") =>
    fetch(`http://${host}:${port}/v2/runs/run-files/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = (path = "") =>
    fetch(`http://${host}:${port}/v2/runs/run-files${path}`, {
      headers: { Authorization: "Bearer fixture-token", "X-Claudexor-Protocol-Major": "3" },
    });
  /** The journaled result of one command, as a replay reads it back. */
  const journaled = (key: string) => commands.get(`run.apply${key}`)?.result;
  return { source, run, manifest, manifestSha256, output, request, read, faults, journaled };
}

/** The operator decision the fixture's journal answers (null: none recorded). */
const fixtureOperator: {
  current: {
    action: "accept_risk";
    findingIds: string[];
    acceptedRisks: string[];
    patchSha256: string;
    decidedAt: string;
  } | null;
} = { current: null };

const audits = async (run: string) =>
  (await readFile(join(run, "events.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => /"type":"control\.(applied|rejected)"/.test(line)).length;

describe("complete files result through the ordinary control API", () => {
  it("streams exact retained binary bytes above the preview cap", async () => {
    const f = await fixture(true);
    const result = await f.request(
      `artifacts/${f.manifest.entries[0]!.after!.kind === "file" ? f.manifest.entries[0]!.after!.artifactPath : ""}`,
    );
    expect(result.status).toBe(200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes.length).toBe(f.output.length);
    expect(digest(bytes)).toBe(digest(f.output));
  });
  it("delivers selected changes, retains pending custody, and replays the same receipt", async () => {
    const f = await fixture();
    const body = { mode: "apply", target: { kind: "original_project" }, paths: ["new.txt"] };
    const res = await f.request("apply", body);
    expect(res.status).toBe(200);
    const receipt = await res.json();
    expect(receipt).toMatchObject({ applied: true, appliedPaths: ["new.txt"] });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "not_applied",
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
    expect(await (await f.request("apply", body)).json()).toEqual(receipt);
    const rest = await f.request("apply", { mode: "apply", paths: ["document.bin"] }, "second");
    expect(await rest.json()).toMatchObject({ applied: true });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
  });
  it("refuses a concurrent target edit without overwriting it", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "document.bin"), "owner edit");
    const response = await f.request("apply", { mode: "apply" });
    expect(await response.json()).toMatchObject({ applied: false, treeMutated: false });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("owner edit");
  });
  it("discards pending copies without applying and refuses subsequent application", async () => {
    const f = await fixture();
    expect(await (await f.request("decision", { action: "discard" })).json()).toMatchObject({
      accepted: true,
      status: "discarded",
    });
    expect((await f.request("apply", { mode: "apply" }, "after-discard")).status).toBe(409);
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
    });
  });
  // #563: a best-of directory run can hold a refused candidate's kept copy
  // beside its winner's pending files; one discard gives up both.
  async function keptCopy(f: Awaited<ReturnType<typeof fixture>>) {
    const env = await new WorkspaceManager(f.source).create({
      taskId: "task-files",
      attemptId: "a02",
      workspaceKind: "directory",
      scopePaths: ["document.bin"],
    });
    await writeFile(join(env.worktree_path, "authored.txt"), "refused candidate output\n");
    retainForInspection(env, { runId: "run-files", runDir: f.run });
    return env;
  }
  it("discards a kept refused copy and the pending winner together", async () => {
    const f = await fixture();
    const env = await keptCopy(f);
    expect(await (await f.request("decision", { action: "discard" })).json()).toMatchObject({
      accepted: true,
      status: "discarded",
      message:
        "Custody of the kept source copies for inspection was released (file cleanup is best-effort); nothing was applied or reverted." +
        " Pending file application discarded; retained result follows normal retention.",
    });
    expect(retainedSourcesOfRun(f.run, "run-files")).toEqual([]);
    await expect(stat(envelopeBaseOf(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
    });
    expect((await f.request("apply", { mode: "apply" }, "after-discard")).status).toBe(409);
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });
  it("releases a kept copy beside an applied winner without touching its applied state", async () => {
    const f = await fixture();
    expect(await (await f.request("apply", { mode: "apply" }, "all")).json()).toMatchObject({
      applied: true,
    });
    const env = await keptCopy(f);
    const answer = (await (await f.request("decision", { action: "discard" }, "d")).json()) as {
      message: string;
    };
    expect(answer).toMatchObject({
      status: "discarded",
      message:
        "Custody of the kept source copies for inspection was released (file cleanup is best-effort); nothing was applied or reverted.",
    });
    // An inspection-only copy has no continuation to speak of.
    expect(answer.message).not.toContain("continuation");
    await expect(stat(envelopeBaseOf(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
  });
  it("refuses discarding direct effects", async () => {
    const f = await fixture(false, "live");
    expect((await f.request("decision", { action: "discard" })).status).toBe(409);
  });
  it("replaying a partial delivery receipt cannot resurrect a discarded remainder", async () => {
    const f = await fixture();
    const body = { mode: "apply", paths: ["new.txt"] };
    const first = await (await f.request("apply", body, "subset")).json();
    expect(first).toMatchObject({ applied: true, appliedPaths: ["new.txt"] });
    expect(
      await (await f.request("decision", { action: "discard" }, "discard-rest")).json(),
    ).toMatchObject({ accepted: true, status: "discarded" });
    expect(await (await f.request("apply", body, "subset")).json()).toEqual(first);
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });

  describe("out of room", () => {
    const withholdRoom = (where: (dir: string) => boolean) => {
      vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
      const real = fileCopyHost.availableBytes;
      vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
        where(dir) ? 0 : real(dir),
      );
    };
    const verifyCopy = (dir: string) => dir.includes("claudexor-verify-files-");

    it("answers a verification copy without room with a typed refusal, and replays it", async () => {
      const f = await fixture(true);
      withholdRoom(verifyCopy);
      try {
        const res = await f.request("apply", { mode: "apply" }, "full-verify");
        expect(res.status).toBe(200);
        const receipt = await res.json();
        expect(receipt).toMatchObject({
          applied: false,
          refused: true,
          appliedPaths: [],
          refusal: { code: "space_insufficient", paths: [] },
        });
        expect(receipt).not.toHaveProperty("captureFailure");
        expect(await (await f.request("apply", { mode: "apply" }, "full-verify")).json()).toEqual(
          receipt,
        );
        const check = await (await f.request("apply/check", { target: undefined })).json();
        expect(check).toMatchObject({ ok: false, refusal: { code: "space_insufficient" } });
        expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("rejects accept_clean_patch out of room with the cause, not a request error", async () => {
      const f = await fixture(true);
      withholdRoom(verifyCopy);
      try {
        const res = await f.request("decision", { action: "accept_clean_patch" }, "accept-full");
        expect(res.status).toBe(200);
        const answer = (await res.json()) as { message?: string };
        expect(answer).toMatchObject({ accepted: false, status: "rejected" });
        expect(answer.message).toContain("full length");
        expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("states accept_clean_patch's partial effects in its message, the same on replay", async () => {
      const f = await fixture(true, "envelope", true);
      withholdRoom((dir) => dir.startsWith(f.source));
      try {
        const answer = async () =>
          (await (
            await f.request("decision", { action: "accept_clean_patch" }, "accept-part")
          ).json()) as { accepted: boolean; status: string; message?: string };
        const first = await answer();
        expect(first).toMatchObject({ accepted: false, status: "rejected" });
        expect(first.message).toContain("Refusal: space_insufficient at document.bin.");
        expect(first.message).toContain("Completed before it stopped: new.txt.");
        expect(await answer()).toEqual(first);
        expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("new");
      } finally {
        vi.restoreAllMocks();
      }
      // With room again, Apply writes the rest and the result reads applied.
      const done = await (await f.request("apply", { mode: "apply" }, "after-room")).json();
      expect(done).toMatchObject({ applied: true, appliedPaths: ["document.bin"] });
      expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject(
        {
          applyState: "applied",
        },
      );
    });

    it("counts an earlier delivery's file the target holds once Apply writes the rest", async () => {
      const f = await fixture(true, "envelope", true);
      // An automatic delivery wrote new.txt and stopped; its receipt is not this overlay's.
      await writeFile(join(f.source, "new.txt"), "new");
      const done = await (await f.request("apply", { mode: "apply" }, "rest")).json();
      // The receipt names only its own writes; the overlay counts the held file too.
      expect(done).toMatchObject({ applied: true, appliedPaths: ["document.bin"] });
      const state = parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"));
      expect(state.applyState).toBe("applied");
      expect([...state.appliedPaths].sort()).toEqual(["document.bin", "new.txt"]);
    });

    it("states a partial delivery's own facts beside a state it could not record, and the same key keeps them", async () => {
      const f = await fixture();
      await mkdir(join(f.run, "final/delivery_state.yaml"));
      // The delivery writes the tiny new.txt and stops at document.bin for want of room.
      delivery.calls = 0;
      delivery.stub = async (target) => {
        await writeFile(join(target, "new.txt"), "new");
        return {
          mode: "apply",
          applied: false,
          alreadyApplied: false,
          treeMutated: true,
          appliedPaths: ["new.txt"],
          refused: true,
          detail: "file apply ran out of space",
          finalVerify: {
            attempted: true,
            duration_ms: 0,
            applied_cleanly: true,
            gates_passed: null,
          },
          targetPreimageSha: "fixture-preimage",
          refusal: {
            code: "space_insufficient",
            message: "no room for document.bin",
            paths: ["document.bin"],
            pathCount: 1,
          },
        };
      };
      const problem = async () => {
        const res = await f.request("apply", { mode: "apply" }, "partial-state");
        expect(res.status).toBe(500);
        return (await res.json()) as {
          code: string;
          message: string;
          context: Record<string, unknown>;
        };
      };
      let first: Awaited<ReturnType<typeof problem>>;
      try {
        first = await problem();
        expect(delivery.calls).toBe(1);
        // First, apart from the state failure: what it wrote, where and why it stopped.
        expect(first.code).toBe("delivery_state_unavailable");
        expect(first.message).toMatch(/^Files delivery: Not applied\. /);
        expect(first.message).toContain("Refusal: space_insufficient at document.bin.");
        expect(first.message).toContain("Completed before it stopped: new.txt.");
        expect(first.message).toContain("Where it stopped, the target may already be changed.");
        expect(first.message).toContain("Separately, the run's result state could not be updated");
        expect(first.context).toMatchObject({
          applied: false,
          treeMutated: true,
          refused: true,
          refusal: { code: "space_insufficient", paths: ["document.bin"], pathCount: 1 },
          appliedPaths: ["new.txt"],
        });
        expect(first.context["detail"]).toBe("file apply ran out of space");
        // The journal holds the whole receipt and its coverage of this manifest.
        expect(f.journaled("partial-state")).toMatchObject({
          applied: false,
          refused: true,
          appliedPaths: ["new.txt"],
          refusal: { code: "space_insufficient", paths: ["document.bin"] },
          filesCoverage: { manifestSha256: f.manifestSha256, paths: ["new.txt"] },
        });
        expect(await audits(f.run)).toBe(1);
        const written = (await stat(join(f.source, "new.txt"))).mtimeMs;
        // While the state still cannot be recorded, the same key answers the same facts.
        expect(await problem()).toEqual(first);
        await rm(join(f.run, "final/delivery_state.yaml"), { recursive: true });
        // Then it answers the journaled receipt and records the partial coverage.
        const replay = await f.request("apply", { mode: "apply" }, "partial-state");
        expect(replay.status).toBe(200);
        const receipt = await replay.json();
        expect(receipt).toMatchObject({
          applied: false,
          refused: true,
          treeMutated: true,
          appliedPaths: ["new.txt"],
          refusal: { code: "space_insufficient", paths: ["document.bin"] },
          detail: first.context["detail"],
        });
        expect(receipt).not.toHaveProperty("filesCoverage");
        expect(
          parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8")),
        ).toMatchObject({
          applyState: "not_applied",
          appliedPaths: ["new.txt"],
        });
        expect((await stat(join(f.source, "new.txt"))).mtimeMs).toBe(written);
        expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
        expect(await audits(f.run)).toBe(1);
        // Neither replay delivered again.
        expect(delivery.calls).toBe(1);
      } finally {
        delivery.stub = null;
      }
    });

    it("journals a held change beside the delivery's own writes and records both on repair", async () => {
      const f = await fixture();
      await writeFile(join(f.source, "new.txt"), "new");
      await mkdir(join(f.run, "final/delivery_state.yaml"));
      expect((await f.request("apply", { mode: "apply" }, "held-state")).status).toBe(500);
      expect(f.journaled("held-state")).toMatchObject({
        applied: true,
        appliedPaths: ["document.bin"],
        filesCoverage: { paths: ["document.bin", "new.txt"] },
      });
      await rm(join(f.run, "final/delivery_state.yaml"), { recursive: true });
      expect(
        await (await f.request("apply", { mode: "apply" }, "held-state")).json(),
      ).toMatchObject({ applied: true, appliedPaths: ["document.bin"] });
      const state = parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"));
      expect(state.applyState).toBe("applied");
      expect([...state.appliedPaths].sort()).toEqual(["document.bin", "new.txt"]);
      expect(await audits(f.run)).toBe(1);
    });

    it("answers a target without room with a typed refusal naming where it stopped", async () => {
      const f = await fixture(true);
      withholdRoom((dir) => dir.startsWith(f.source));
      try {
        const res = await f.request("apply", { mode: "apply" }, "full-target");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          applied: false,
          refused: true,
          appliedPaths: [],
          refusal: { code: "space_insufficient", paths: ["document.bin"], pathCount: 1 },
        });
        expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});

describe("one fact about a files delivery's effects", () => {
  it("records the overlay and audit with the delivery; a same-key replay changes nothing", async () => {
    const f = await fixture();
    const first = await (await f.request("apply", { mode: "apply" }, "once")).json();
    expect(first).toMatchObject({ applied: true });
    const state = await readFile(join(f.run, "final/delivery_state.yaml"), "utf8");
    const audited = await audits(f.run);
    expect(audited).toBe(1);
    // The replay answers the journaled receipt, read back deserialized.
    expect(await (await f.request("apply", { mode: "apply" }, "once")).json()).toEqual(first);
    expect(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8")).toBe(state);
    expect(await audits(f.run)).toBe(audited);
  });

  it("keeps the journaled receipt when the run's state cannot be recorded; the same key repairs it", async () => {
    const f = await fixture();
    // The overlay's path is a directory: recording the run's state fails after the writes.
    await mkdir(join(f.run, "final/delivery_state.yaml"));
    const failed = await f.request("apply", { mode: "apply" }, "state-fails");
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).toContain("delivery_state_unavailable");
    expect((await readFile(join(f.source, "document.bin"))).equals(f.output)).toBe(true);
    expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("new");
    expect(await audits(f.run)).toBe(1);
    const written = await Promise.all(
      ["document.bin", "new.txt"].map(async (path) => (await stat(join(f.source, path))).mtimeMs),
    );
    await rm(join(f.run, "final/delivery_state.yaml"), { recursive: true });
    // The replay answers the delivery's own receipt and records the state it could not.
    const replay = await f.request("apply", { mode: "apply" }, "state-fails");
    expect(replay.status).toBe(200);
    const receipt = (await replay.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({ applied: true, alreadyApplied: false });
    expect([...(receipt["appliedPaths"] as string[])].sort()).toEqual(["document.bin", "new.txt"]);
    expect(receipt).not.toHaveProperty("filesCoverage");
    const state = await readFile(join(f.run, "final/delivery_state.yaml"), "utf8");
    expect(parse(state)).toMatchObject({ applyState: "applied" });
    expect([...parse(state).appliedPaths].sort()).toEqual(["document.bin", "new.txt"]);
    expect(
      await Promise.all(
        ["document.bin", "new.txt"].map(async (path) => (await stat(join(f.source, path))).mtimeMs),
      ),
    ).toEqual(written);
    // Neither replay audits again or rewrites the recorded state (its delivery time stays).
    expect(await (await f.request("apply", { mode: "apply" }, "state-fails")).json()).toEqual(
      receipt,
    );
    expect(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8")).toBe(state);
    expect(await audits(f.run)).toBe(1);
  });

  it("repairs a subset delivery's coverage without calling the result applied", async () => {
    const f = await fixture();
    await mkdir(join(f.run, "final/delivery_state.yaml"));
    const body = { mode: "apply", paths: ["new.txt"] };
    expect((await f.request("apply", body, "subset-fails")).status).toBe(500);
    await rm(join(f.run, "final/delivery_state.yaml"), { recursive: true });
    expect(await (await f.request("apply", body, "subset-fails")).json()).toMatchObject({
      applied: true,
      appliedPaths: ["new.txt"],
    });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "not_applied",
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });

  it("answers an unsaved receipt as uncertain and still records what the delivery wrote", async () => {
    const f = await fixture();
    f.faults.complete = true;
    const failed = await f.request("apply", { mode: "apply" }, "journal-fails");
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).toContain("delivery_receipt_unavailable");
    expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("new");
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
    expect(await audits(f.run)).toBe(1);
    // The command stays open: a same-key retry is never answered as done or run again.
    f.faults.complete = false;
    const retry = await f.request("apply", { mode: "apply" }, "journal-fails");
    expect(retry.status).toBe(409);
    expect(JSON.stringify(await retry.json())).toContain("delivery_in_progress");
    expect(await audits(f.run)).toBe(1);
  });

  it("marks nothing for a refusal that wrote nothing, even where the target holds a change", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "new.txt"), "new");
    await writeFile(join(f.source, "document.bin"), "someone else's edit\n");
    const receipt = await (await f.request("apply", { mode: "apply" }, "refused")).json();
    expect(receipt).toMatchObject({ applied: false, appliedPaths: [], treeMutated: false });
    await expect(stat(join(f.run, "final/delivery_state.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("combines an automatic delivery of this manifest with a later selected Apply", async () => {
    const f = await fixture(true, "envelope", true);
    // The run's automatic delivery wrote new.txt, then stopped on the document.
    await writeFile(join(f.source, "new.txt"), "new");
    const product = parse(await readFile(join(f.run, "final/work_product.yaml"), "utf8"));
    product.meta.applied_paths = ["new.txt"];
    await writeFile(join(f.run, "final/work_product.yaml"), stringify(product));
    const done = await (
      await f.request("apply", { mode: "apply", paths: ["document.bin"] }, "rest")
    ).json();
    expect(done).toMatchObject({ applied: true, appliedPaths: ["document.bin"] });
    const state = parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"));
    expect(state.applyState).toBe("applied");
    expect([...state.appliedPaths].sort()).toEqual(["document.bin", "new.txt"]);
  });

  it("reads a run whose automatic delivery applied but whose result was not published", async () => {
    const f = await fixture();
    await rm(join(f.run, "final/work_product.yaml"));
    const saved = (complete?: boolean) =>
      writeFile(
        join(f.run, "final/delivery_receipt.yaml"),
        stringify({
          mode: "apply",
          applied: true,
          appliedPaths: ["document.bin", "new.txt"],
          ...(complete === undefined
            ? {}
            : { manifestCoverage: { manifestSha256: f.manifestSha256, complete } }),
        }),
      );
    const applyState = async () =>
      /"applyState":"([a-z_]+)"/.exec(JSON.stringify(await (await f.read()).json()))?.[1];
    await saved(true);
    expect(await applyState()).toBe("applied");
    // Applied, but a change with an unknown preimage stayed in custody: not the whole result.
    await saved(false);
    expect(await applyState()).toBe("not_applied");
    // A receipt without manifest coverage proves no applied result.
    await saved();
    expect(await applyState()).toBe("not_applied");
  });

  it("shows an accepted risk on a files result in the run's own view", async () => {
    const f = await fixture();
    fixtureOperator.current = {
      action: "accept_risk",
      findingIds: [],
      acceptedRisks: [],
      patchSha256: f.manifestSha256,
      decidedAt: "2026-11-28T00:00:00Z",
    };
    try {
      const detail = (await (await f.read()).json()) as Record<string, unknown>;
      expect(detail["operatorDecision"]).toMatchObject({ action: "accept_risk" });
      fixtureOperator.current = { ...fixtureOperator.current, patchSha256: "sha256:other" };
      const other = (await (await f.read()).json()) as Record<string, unknown>;
      expect(other["operatorDecision"] ?? null).toBeNull();
    } finally {
      fixtureOperator.current = null;
    }
  });
});

describe("a files result blocked by its final check", () => {
  /** The run's saved decision: its checks failed through this final check. */
  async function blocked(
    f: Awaited<ReturnType<typeof fixture>>,
    finalVerify: Record<string, unknown>,
  ) {
    await writeFile(
      join(f.run, "arbitration/decision.yaml"),
      stringify(
        DecisionRecord.parse({
          winner: "a01",
          facts: makeOutcomeFacts("succeeded", {
            review: "not_run",
            review_requested: false,
            checks: "failed",
            reason: "checks_failed",
          }),
          final_verify: { attempted: true, duration_ms: 1, ...finalVerify },
        }),
      ),
    );
  }
  const accepted = (f: { manifestSha256: string }) => ({
    action: "accept_risk" as const,
    findingIds: [],
    acceptedRisks: [],
    patchSha256: f.manifestSha256,
    decidedAt: "2026-11-28T00:00:00Z",
  });
  const verifyCopy = (dir: string) => dir.includes("claudexor-verify-files-");

  it("after a verification copy lacked room: the advice is what Apply then does", async () => {
    const f = await fixture(true);
    await blocked(f, {
      applied_cleanly: null,
      reason: "final verification ran out of space: ENOSPC",
    });
    // Room is back. The block stands: an ordinary check and Apply refuse, and say how.
    const detail = (await (await f.read()).json()) as {
      applyEligibility?: { requiredAction?: string | null };
    };
    expect(detail.applyEligibility?.requiredAction).toContain(
      "Remove the final check's cause first",
    );
    const check = (await (await f.request("apply/check", { target: undefined })).json()) as {
      stderr?: string;
    };
    expect(check).toMatchObject({ ok: false });
    expect(check.stderr).toContain("Remove the final check's cause first");
    const refused = (await (await f.request("apply", { mode: "apply" }, "plain")).json()) as {
      detail?: string;
    };
    expect(refused).toMatchObject({ applied: false, appliedPaths: [], treeMutated: false });
    expect(refused.detail).toContain("then accept the risk for this exact result and apply");
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
    fixtureOperator.current = accepted(f);
    try {
      // The saved check proved nothing: with the risk accepted, a fresh one is still due.
      const pending = (await (await f.read()).json()) as {
        applyEligibility?: { eligible?: boolean; state?: string };
      };
      expect(pending.applyEligibility).toMatchObject({ eligible: true, state: "verify_pending" });
      // Accepted while the copy still cannot be made: the same typed refusal, nothing written.
      vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
      const real = fileCopyHost.availableBytes;
      vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
        verifyCopy(dir) ? 0 : real(dir),
      );
      expect(
        await (await f.request("apply", { mode: "apply" }, "still-full")).json(),
      ).toMatchObject({ applied: false, refusal: { code: "space_insufficient" } });
      vi.restoreAllMocks();
      // With room: the check passes and an ordinary Apply rebuilds, rechecks and writes.
      expect(await (await f.request("apply/check", { target: undefined })).json()).toMatchObject({
        ok: true,
      });
      expect(await (await f.request("apply", { mode: "apply" }, "room")).json()).toMatchObject({
        applied: true,
      });
      expect((await readFile(join(f.source, "document.bin"))).equals(f.output)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      fixtureOperator.current = null;
    }
  });

  it("after checks that really failed: an accepted risk stays the remedy, nothing applies without it", async () => {
    const f = await fixture();
    await blocked(f, { applied_cleanly: true, gates_passed: false });
    const detail = (await (await f.read()).json()) as {
      applyEligibility?: { requiredAction?: string | null };
    };
    expect(detail.applyEligibility?.requiredAction).toContain("Accept the risk");
    expect(
      await (await f.request("apply", { mode: "apply" }, "failed-gates")).json(),
    ).toMatchObject({ applied: false, appliedPaths: [] });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });
});
