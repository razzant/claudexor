/**
 * [INV-034:thread-retire-after-exact-export] A finished delegated thread, driven
 * like an external host drives it: export its exact closure through the built
 * CLI, retire it against that export, and read everything back offline after the
 * sources are gone. Refusals change nothing, a repeated operation joins its one
 * outcome, and the caller-owned workspace is never touched. The fake session
 * format proves this lifecycle; it qualifies no vendor's format.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadExportManifest, ThreadExportReceipt } from "@claudexor/schema";
import { controlApi } from "./project-trash-api.js";
import { type Sandbox, cli, makeSandbox } from "./support.js";

let sandbox: Sandbox;
let fakeStore: string;
beforeEach(() => {
  sandbox = makeSandbox();
  fakeStore = join(sandbox.home, "fake-store");
  mkdirSync(fakeStore);
  sandbox.env["CLAUDEXOR_FAKE_NATIVE_STORE"] = fakeStore;
});
afterEach(() => sandbox.dispose(), 0); // synchronous cleanup; its owned stop retains the process deadline

const projectRuntime = (): string =>
  join(
    sandbox.configDir,
    "projects",
    createHash("sha256").update(realpathSync(sandbox.repo)).digest("hex"),
  );
const sha = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function finishedThread(prompts: string[]) {
  const copy = join(sandbox.home, "checking-copy");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", sandbox.repo, copy]);
  expect(cli(sandbox, ["daemon", "start", "--json"]).code).toBe(0);
  const api = controlApi(sandbox);
  await api.connect();
  const created = await api.call(
    "POST",
    "/threads",
    {
      scope: { kind: "project", root: sandbox.repo },
      workspace: "delegated",
      workspaceRoot: copy,
      mode: "ask",
      primaryHarness: "fake-session",
      eligibleHarnesses: ["fake-session", "fake-document"],
    },
    "retire-thread",
  );
  expect(created.status).toBe(200);
  const threadId = created.body.id as string;
  const runIds: string[] = [];
  for (const [index, prompt] of prompts.entries()) {
    const turn = await api.call("POST", `/threads/${threadId}/turns`, { prompt }, `turn-${index}`);
    expect(turn.status, turn.text).toBe(200);
    const detail = await api.terminal(turn.body.runId);
    expect(detail.summary.state).toBe("succeeded");
    runIds.push(turn.body.runId);
  }
  return { api, threadId, copy, runIds };
}

const exportOf = (threadId: string, out: string) => {
  const result = cli(sandbox, ["thread", "export", threadId, "--out", out, "--json"]);
  return { result, summary: result.json() as any };
};
const receiptOf = (out: string) =>
  ThreadExportReceipt.parse(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")));
const manifestOf = (out: string) =>
  ThreadExportManifest.parse(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")));

describe("[INV-034:thread-retire-after-exact-export] conditional thread retirement", () => {
  it("exports, retires, and stays readable offline after every source is gone", async () => {
    const { threadId, copy, runIds } = await finishedThread(["first question", "second one"]);
    const lanes = join(projectRuntime(), "lanes", threadId);
    expect(existsSync(lanes)).toBe(true);
    const copyBefore = readdirSync(copy).sort();

    const out = join(sandbox.home, "bundle");
    const { result, summary } = exportOf(threadId, out);
    expect(result.code).toBe(0);
    expect(summary).toMatchObject({ coverage: "complete", retirable: true, gaps: [] });
    const manifest = manifestOf(out);
    const receipt = receiptOf(out);
    expect(manifest.closure.turns).toHaveLength(2);
    expect(manifest.closure.runs.map((run) => run.runId).sort()).toEqual([...runIds].sort());
    const session = manifest.sessions[0]!;
    expect(session).toMatchObject({ harness: "fake-session", status: "exported" });
    expect(session.provenance.map((p) => p.source)).toEqual(
      expect.arrayContaining(["attempt_event", "run_event", "thread_session"]),
    );

    // Every byte verifies against the digests, and the compressed part's decoded
    // projection sits beside its exact original.
    for (const entry of receipt.transferred)
      expect(sha(readFileSync(join(out, entry.path)))).toBe(entry.sha256);
    const part = manifest.items.find((item) => item.path.endsWith(".jsonl.zst"))!;
    const projection = manifest.items.find((item) => item.projectionOf === part.itemId)!;
    expect(projection.plane).toBe("projection");
    expect(zstdDecompressSync(readFileSync(join(out, part.path))).toString()).toBe(
      readFileSync(join(out, projection.path), "utf8"),
    );

    const retired = cli(sandbox, [
      "thread-retire",
      threadId,
      "--export",
      out,
      "--operation-id",
      "op-first",
      "--json",
    ]);
    expect(retired.code, retired.stderr).toBe(0);
    const accepted = retired.json() as any;
    expect(accepted.threadState).toBe("purged");
    expect(accepted.acceptance).toMatchObject({
      operationId: "op-first",
      contentDigest: receipt.contentDigest,
      laneDigest: receipt.laneDigest,
    });
    // Removal is reported only once the cleanup obligation cleared its barrier.
    expect(existsSync(lanes)).toBe(false);
    await vi.waitFor(
      () =>
        expect(
          (cli(sandbox, ["thread", "retirement", threadId, "--json"]).json() as any).status,
        ).toBe("removed"),
      { timeout: 30_000, interval: 200 },
    );
    // A delegated workspace is the caller's: purge never deletes it.
    expect(readdirSync(copy).sort()).toEqual(copyBefore);

    // The same operation joins its one outcome; another is refused and changes nothing.
    const replay = cli(sandbox, [
      "thread-retire",
      threadId,
      "--export",
      out,
      "--operation-id",
      "op-first",
      "--json",
    ]);
    expect(replay.code).toBe(0);
    expect((replay.json() as any).acceptance.acceptedAt).toBe(accepted.acceptance.acceptedAt);
    const other = cli(sandbox, [
      "thread-retire",
      threadId,
      "--export",
      out,
      "--operation-id",
      "op-other",
      "--json",
    ]);
    expect(other.code).toBe(1);
    expect((other.json() as any).code).toBe("thread_retirement_conflict");
    const readback = cli(sandbox, [
      "thread",
      "retirement",
      threadId,
      "--operation-id",
      "op-first",
      "--json",
    ]).json() as any;
    expect(readback.operation).toMatchObject({ operationId: "op-first", outcome: "accepted" });
    expect(readback.status).toBe("removed");

    // Offline: the engine and every original are gone, and the trace reads.
    expect(cli(sandbox, ["daemon", "stop", "--json"]).code).toBe(0);
    rmSync(fakeStore, { recursive: true, force: true });
    rmSync(projectRuntime(), { recursive: true, force: true });
    const turn0 = JSON.parse(
      readFileSync(
        join(out, manifest.items.find((i) => i.path.startsWith("sql/turns/000000-"))!.path),
        "utf8",
      ),
    );
    expect(turn0.prompt).toBe("first question");
    const transcript = manifest.items.find(
      (i) => i.plane === "native" && i.path.endsWith(`${session.nativeSessionId}.jsonl`),
    )!;
    expect(readFileSync(join(out, transcript.path), "utf8")).toContain("second one");
    expect(
      readFileSync(
        join(out, manifest.items.find((i) => /^runs\/[^/]+\/events\.jsonl$/.test(i.path))!.path),
        "utf8",
      ),
    ).toContain("harness.event");
  });

  it("exports and retires names its volume cannot hold, in every plane, through the built CLI", async () => {
    const { api, threadId, runIds } = await finishedThread(["a question"]);
    // Long display names are ordinary uploads: each is real attached bytes of a real turn.
    const names = [
      "Презентация для инвесторов финал версия.pdf",
      `${"Презентация для инвесторов ".repeat(12)}финал.pdf`,
      `${"投資家向けプレゼンテーション資料".repeat(12)}.pdf`,
      `${"a".repeat(300)}.pdf`,
    ];
    const { host, port } = JSON.parse(
      readFileSync(join(sandbox.configDir, "daemon", "control-api.json"), "utf8"),
    ) as { host: string; port: number };
    const token = readFileSync(join(sandbox.configDir, "daemon", "token"), "utf8").trim();
    const attachments = [];
    for (const name of names) {
      const bytes = Buffer.from(`bytes of ${name}`);
      const upload = await api.call(
        "POST",
        "/uploads",
        { kind: "file", mime: "text/plain", name, sizeBytes: bytes.length },
        `upload-${sha(name)}`,
      );
      expect(upload.status, upload.text).toBe(201);
      const put = await fetch(`http://${host}:${port}/v2/uploads/${upload.body.uploadId}/bytes`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "x-claudexor-protocol-major": "3",
          "content-type": "application/octet-stream",
        },
        body: bytes,
      });
      expect(put.status).toBe(200);
      const resource = await api.call(
        "POST",
        `/uploads/${upload.body.uploadId}/finalize`,
        { expectedSha256: sha(bytes) },
        `finalize-${sha(name)}`,
      );
      expect(resource.status, resource.text).toBe(201);
      attachments.push({ resourceId: resource.body.resourceId as string });
    }
    const turn = await api.call(
      "POST",
      `/threads/${threadId}/turns`,
      { prompt: "read these", harnesses: ["fake-document"], attachments },
      "turn-attached",
    );
    expect(turn.status, turn.text).toBe(200);
    expect((await api.terminal(turn.body.runId)).summary.state).toBe("succeeded");

    // Long on-disk names of every other plane, at the limit this volume allows.
    const atLimit = (stem: string, extension: string) =>
      `${stem}${"n".repeat(255 - Buffer.byteLength(stem) - extension.length)}${extension}`;
    const manifestBefore = (await api.call("GET", `/threads/${threadId}/export`)).body;
    const sessionId = manifestBefore.sessions[0].nativeSessionId as string;
    const zst = zstdCompressSync(Buffer.from('{"decoded":"text"}\n'));
    writeFileSync(join(fakeStore, "sessions", atLimit(`${sessionId}-`, ".jsonl.zst")), zst);
    const lanes = join(projectRuntime(), "lanes", threadId);
    mkdirSync(join(lanes, "summaries"), { recursive: true });
    writeFileSync(join(lanes, "summaries", atLimit("lane-", ".md")), "lane bytes\n");
    const run = await api.call("GET", `/runs/${runIds[0]}`);
    writeFileSync(
      join(run.body.summary.runDir ?? run.body.runDir, atLimit("run-", ".txt")),
      "run\n",
    );

    // An ordinary --out whose parents do not exist yet: the export's own create makes them.
    const out = join(sandbox.home, "new-parent", "new-child", "bundle");
    const { result, summary } = exportOf(threadId, out);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(summary).toMatchObject({ coverage: "complete", gaps: [] });
    const manifest = manifestOf(out);
    const receipt = receiptOf(out);
    expect(summary.relocatedItems).toBe(
      receipt.transferred.filter((entry) => entry.placedAt).length,
    );
    expect(summary.relocatedItems).toBeGreaterThanOrEqual(4);
    // Every byte verifies where it is; the complete names stay in the manifest.
    for (const entry of receipt.transferred)
      expect(sha(readFileSync(join(out, entry.placedAt ?? entry.path))), entry.path).toBe(
        entry.sha256,
      );
    expect(
      manifest.items
        .filter((item) => item.plane === "resource")
        .map((item) => decodeURIComponent(item.path.split("/").at(-1)!))
        .sort(),
    ).toEqual([...names].sort());
    const projection = manifest.items.find(
      (item) => item.plane === "projection" && item.path.includes(`${sessionId}-`),
    )!;
    expect(receipt.transferred.find((entry) => entry.itemId === projection.itemId)!.placedAt).toBe(
      `relocated/${projection.itemId}.jsonl`,
    );

    const retired = cli(sandbox, ["thread-retire", threadId, "--export", out, "--json"]);
    expect(retired.code, retired.stdout + retired.stderr).toBe(0);
    expect((retired.json() as any).operation).toMatchObject({ outcome: "accepted" });
    expect(existsSync(lanes)).toBe(false);
    expect(existsSync(join(out, "retire-request.json"))).toBe(false);
  });

  it("joins two concurrent requests of one operation into its one acceptance", async () => {
    const { api, threadId } = await finishedThread(["a question"]);
    const out = join(sandbox.home, "bundle");
    expect(exportOf(threadId, out).result.code).toBe(0);
    const receipt = receiptOf(out);
    const body = {
      operationId: "op-race",
      exportId: receipt.exportId,
      closureDigest: receipt.closureDigest,
      contentDigest: receipt.contentDigest,
      laneDigest: receipt.laneDigest,
    };
    const [first, second] = await Promise.all([
      api.call("POST", `/threads/${threadId}/retire`, body),
      api.call("POST", `/threads/${threadId}/retire`, body),
    ]);
    expect([first!.status, second!.status]).toEqual([200, 200]);
    expect(first!.body.acceptance.acceptedAt).toBe(second!.body.acceptance.acceptedAt);
    expect(first!.body.operation.outcome).toBe("accepted");
    // A purged thread no longer produces an export, and answers its retirement.
    expect((await api.call("GET", `/threads/${threadId}/export`)).status).toBe(410);
    const read = await api.call("GET", `/threads/${threadId}/retirement?operationId=op-race`);
    expect(read.body).toMatchObject({ threadState: "purged", operation: { outcome: "accepted" } });
  });

  it("refuses stale and changed bytes, binds that refusal, and leaves the thread alone", async () => {
    const { api, threadId } = await finishedThread(["a question"]);
    const lanes = join(projectRuntime(), "lanes", threadId);
    const out = join(sandbox.home, "bundle");
    expect(exportOf(threadId, out).result.code).toBe(0);

    // A changed transcript with the store's other evidence untouched.
    const session = manifestOf(out).sessions[0]!;
    const transcript = join(fakeStore, "sessions", `${session.nativeSessionId}.jsonl`);
    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}{"late":"write"}\n`);
    const stale = cli(sandbox, [
      "thread-retire",
      threadId,
      "--export",
      out,
      "--operation-id",
      "op-stale",
      "--json",
    ]);
    expect(stale.code).toBe(1);
    expect((stale.json() as any).code).toBe("thread_export_stale");
    expect(existsSync(lanes)).toBe(true);
    expect((await api.call("GET", `/threads/${threadId}/history`)).status).toBe(200);

    // The refusal is that operation's one outcome, even once its bytes match again.
    const fresh = join(sandbox.home, "bundle-fresh");
    expect(exportOf(threadId, fresh).result.code).toBe(0);
    const replayed = await api.call("POST", `/threads/${threadId}/retire`, {
      operationId: "op-stale",
      exportId: receiptOf(fresh).exportId,
      closureDigest: receiptOf(fresh).closureDigest,
      contentDigest: receiptOf(fresh).contentDigest,
      laneDigest: receiptOf(fresh).laneDigest,
    });
    expect(replayed.status).toBe(409);
    expect(replayed.body).toMatchObject({
      code: "thread_export_stale",
      context: { settled: true },
    });

    // An abandoned operation can never accept.
    expect(
      (await api.call("POST", `/threads/${threadId}/retire/abandon`, { operationId: "op-kept" }))
        .status,
    ).toBe(200);
    const abandoned = await api.call("POST", `/threads/${threadId}/retire`, {
      operationId: "op-kept",
      exportId: receiptOf(fresh).exportId,
      closureDigest: receiptOf(fresh).closureDigest,
      contentDigest: receiptOf(fresh).contentDigest,
      laneDigest: receiptOf(fresh).laneDigest,
    });
    expect(abandoned.status).toBe(409);
    expect(abandoned.body.code).toBe("thread_retirement_abandoned");
    expect(existsSync(lanes)).toBe(true);

    // A digest the engine cannot reproduce from disk is not accepted.
    const forged = await api.call("POST", `/threads/${threadId}/retire`, {
      operationId: "op-forged",
      exportId: receiptOf(fresh).exportId,
      closureDigest: receiptOf(fresh).closureDigest,
      contentDigest: `sha256:${"0".repeat(64)}`,
      laneDigest: receiptOf(fresh).laneDigest,
    });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe("thread_export_stale");
    expect(existsSync(lanes)).toBe(true);

    // A new turn changes the closure: the older export can no longer retire it.
    const turn = await api.call(
      "POST",
      `/threads/${threadId}/turns`,
      { prompt: "another one" },
      "turn-late",
    );
    expect(turn.status, turn.text).toBe(200);
    await api.terminal(turn.body.runId);
    const moved = await api.call("POST", `/threads/${threadId}/retire`, {
      operationId: "op-moved",
      exportId: receiptOf(fresh).exportId,
      closureDigest: receiptOf(fresh).closureDigest,
      contentDigest: receiptOf(fresh).contentDigest,
      laneDigest: receiptOf(fresh).laneDigest,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("thread_export_stale");
    expect((await api.call("GET", `/threads/${threadId}/history`)).status).toBe(200);
  });
});
