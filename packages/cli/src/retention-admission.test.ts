// Upgrade compatibility: retired ancestors need not erase an intact successor.
// Same file runs on head and base: admission of requests whose sources were
// retired earlier (a tombstone directory, exactly what both retention versions leave).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ControlRunStartRequest, RunResumable, SessionCapsule } from "@claudexor/schema";
import { continuationForRun } from "./continue-from-run.js";
import { ArtifactStore } from "@claudexor/artifact-store";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { admitCommandRequest } from "../../daemon/src/command-rpc.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let repo: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-admission-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  repo = join(root, "checkout");
  mkdirSync(repo);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  await sql.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});
const base = () => ({
  mode: "ask",
  prompt: "investigate",
  scope: { kind: "project", root: repo, ephemeral: true },
});
/** A terminal run with its command record; `retired` leaves only the tombstone. */
function run(
  id: string,
  state: "failed" | "succeeded" | "interrupted",
  extra: Record<string, unknown> = {},
  retired = false,
) {
  const paths = new ArtifactStore(repo).createRun(id);
  if (retired) {
    rmSync(paths.root, { recursive: true, force: true });
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      join(paths.root, "tombstone.yaml"),
      `run_id: ${id}\ndeleted_at: 2026-09-01T00:00:00.000Z\nreason: retention\n`,
    );
  } else writeFileSync(join(paths.finalDir, "answer.md"), `Evidence for ${id}`);
  const params = { ...base(), ...extra };
  const store = sql.graph.commands.current();
  store.accept({ id: `job-${id}`, params, idempotencyKey: `job-${id}`, clientId: "fixture" });
  store.update(`job-${id}`, {
    state,
    runId: id,
    runDir: paths.root,
    finishedAt: "2026-08-01T00:00:00.000Z",
  });
}
function admit(request: Record<string, unknown>) {
  try {
    admitCommandRequest(sql.graph.commands, request, "run.create");
    return "accepted";
  } catch (error) {
    const e = error as { code?: string; status?: number; message?: string };
    return `refused ${e.status ?? ""} ${e.code ?? e.message}`;
  }
}

it("names Run Again when Exact Retry source evidence has expired", () => {
  run("old-failed", "failed", {}, true);
  expect(() =>
    admitCommandRequest(sql.graph.commands, { ...base(), retryOf: "old-failed" }, "run.create"),
  ).toThrow(
    expect.objectContaining({
      code: "run_expired_by_retention",
      requiredActions: expect.arrayContaining([expect.stringContaining("Run Again")]),
    }),
  );
  run("intact", "failed");
  expect(admit({ ...base(), retryOf: "intact" })).toBe("accepted");
});

it.each(["answer", "capsule", "resumable"])(
  "continues from intact %s evidence and discloses an expired ancestor",
  (evidence) => {
    run("ancestor", "interrupted", {}, true);
    run("head", "succeeded", { continueFrom: "ancestor" });
    const dir = join(new ArtifactStore(repo).runsDir(), "head");
    if (evidence !== "answer") rmSync(join(dir, "final", "answer.md"));
    if (evidence === "capsule") {
      mkdirSync(join(dir, "attempts", "a01"), { recursive: true });
      writeFileSync(
        join(dir, "attempts", "a01", "session-capsule.json"),
        JSON.stringify(
          SessionCapsule.parse({
            harness: "codex",
            nativeSessionId: "00000000-0000-0000-0000-000000000001",
            holderProfileId: null,
            file: null,
            mtimeMs: null,
            cwd: repo,
            requestedModel: null,
          }),
        ),
      );
    }
    if (evidence === "resumable")
      writeFileSync(
        join(dir, "final", "resumable.yaml"),
        JSON.stringify(
          RunResumable.parse({
            cause: "cancelled",
            resetsAt: null,
            limitWindow: null,
            limitEvidence: null,
            carriers: [],
            limitCode: null,
            session: null,
            workspace: { kind: "none", root: null },
          }),
        ),
      );
    const request = { ...base(), prompt: "continue", continueFrom: "head" };
    expect(admit(request)).toBe("accepted");
    expect(
      continuationForRun(ControlRunStartRequest.parse(request), sql.graph.commands.queries).from,
    ).toMatchObject({
      runId: "head",
      ancestors: [],
      expiredAncestors: ["ancestor"],
    });
  },
);
it("refuses when the expired ancestor is the only source of continuation evidence", () => {
  run("ancestor", "interrupted", {}, true);
  run("head", "failed", { continueFrom: "ancestor" });
  const dir = join(new ArtifactStore(repo).runsDir(), "head");
  rmSync(join(dir, "final", "answer.md"));
  expect(admit({ ...base(), continueFrom: "head" })).toContain("run_expired_by_retention");
});
