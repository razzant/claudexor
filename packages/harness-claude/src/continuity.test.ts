import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { HarnessEvent } from "@claudexor/schema";
import { claudeContinuity, claudeProjectDirName, claudeStoreDir } from "./continuity.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function store(root: string, name: string): string {
  // Registered profile stores live under the Claudexor-owned root (the test
  // sandbox CLAUDEXOR_CONFIG_DIR), so the canonicalizer admits them.
  const dir = join(root, "profiles", `claude-${name}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  // The store canonicalizer resolves symlinks (macOS /var → /private/var).
  return realpathSync(dir);
}

function seed(storeDir: string, cwd: string, sid: string, withSidecar: boolean): string {
  const projectDir = join(storeDir, "projects", claudeProjectDirName(cwd));
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sid}.jsonl`);
  writeFileSync(file, `{"type":"user","session_id":"${sid}"}\n`);
  if (withSidecar) {
    mkdirSync(join(projectDir, sid, "tool-results"), { recursive: true });
    writeFileSync(join(projectDir, sid, "tool-results", "big.txt"), "spilled output\n");
  }
  return file;
}

describe("claude continuity", () => {
  it("encodes the cwd like Claude Code and resolves the store from the engine's locator key", () => {
    expect(claudeProjectDirName("/Users/anton/work.dir/x_y")).toBe("-Users-anton-work-dir-x-y");
    const root = process.env.CLAUDEXOR_CONFIG_DIR!;
    const a = store(root, "a");
    expect(claudeStoreDir({ [CONTINUITY_PROFILE_LOCATOR_ENV]: a })).toBe(a);
  });

  it("locates the transcript under the cwd's project dir, with its tool-results sidecar; newest wins elsewhere", async () => {
    const root = process.env.CLAUDEXOR_CONFIG_DIR!;
    const a = store(root, "a");
    const env = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    expect(await claudeContinuity.locate({ nativeSessionId: "sid-1", cwd: "/w" }, env)).toEqual({
      found: false,
    });
    const file = seed(a, "/w", "sid-1", true);
    const located = await claudeContinuity.locate({ nativeSessionId: "sid-1", cwd: "/w" }, env);
    expect(located).toMatchObject({
      found: true,
      file,
      sidecars: [join(a, "projects", claudeProjectDirName("/w"), "sid-1")],
    });
    // The same session resumed under ANOTHER cwd: found by scanning project dirs.
    const other = await claudeContinuity.locate(
      { nativeSessionId: "sid-1", cwd: "/elsewhere" },
      env,
    );
    expect(other).toMatchObject({ found: true, file });
  });

  it("moves the transcript and its sidecar into the target store at the target cwd, then retires the source", async () => {
    const root = process.env.CLAUDEXOR_CONFIG_DIR!;
    const a = store(root, "a");
    const b = store(root, "b");
    const file = seed(a, "/w", "sid-2", true);
    writeFileSync(join(a, ".claude.json"), '{"oauthAccount":"never-copied"}');
    const envA = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    const envB = { [CONTINUITY_PROFILE_LOCATOR_ENV]: b };
    const located = await claudeContinuity.locate({ nativeSessionId: "sid-2", cwd: "/w" }, envA);
    if (!located.found) throw new Error("fixture not located");
    const moved = await claudeContinuity.move(
      { file: located.file, sidecars: located.sidecars, nativeSessionId: "sid-2" },
      envA,
      envB,
      "/w2",
    );
    expect(moved).toMatchObject({ ok: true, resumeRef: { nativeSessionId: "sid-2" } });
    expect(existsSync(file)).toBe(true);
    if (!moved.ok) throw new Error(moved.reason);
    await moved.retire?.();
    const targetDir = join(b, "projects", claudeProjectDirName("/w2"));
    expect(readFileSync(join(targetDir, "sid-2.jsonl"), "utf8")).toContain("sid-2");
    expect(readFileSync(join(targetDir, "sid-2", "tool-results", "big.txt"), "utf8")).toBe(
      "spilled output\n",
    );
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(a, "projects", claudeProjectDirName("/w"), "sid-2"))).toBe(false);
    // Credentials never move.
    expect(existsSync(join(b, ".claude.json"))).toBe(false);
    // The target resume now locates it; a → b → a would move it back the same way.
    expect(
      await claudeContinuity.locate({ nativeSessionId: "sid-2", cwd: "/w2" }, envB),
    ).toMatchObject({
      found: true,
      file: join(targetDir, "sid-2.jsonl"),
    });
  });

  it("types the vendor's rejection of carried state as an API 400 on the resumed request", () => {
    const reject = claudeContinuity.rejectsCarriedState!;
    const base = { session_id: "s", ts: "t" } as const;
    expect(reject({ ...base, type: "error", error: "x", payload: { api_error_status: 400 } })).toBe(
      true,
    );
    expect(reject({ ...base, type: "error", error: "x", payload: { api_error_status: 529 } })).toBe(
      false,
    );
    expect(reject({ ...base, type: "message", text: "400" })).toBe(false);
  });

  it("recognizes the missing-session diagnostic on the failed native exit, not the generic error", () => {
    const events = readFileSync(
      new URL("../fixtures/signals/missing-resume-session.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => HarnessEvent.parse(JSON.parse(line)));
    expect(events.map((event) => claudeContinuity.rejectsCarriedState!(event))).toEqual([
      false,
      true,
    ]);
  });

  it.each([
    {
      type: "message",
      text: "No conversation found with session ID: 00000000-0000-4000-8000-000000000001",
    },
    { type: "error", error: "result subtype: error_during_execution" },
    { type: "completed", payload: { exit_code: 1, stderr_tail: "connection reset" } },
    {
      type: "completed",
      payload: {
        exit_code: 0,
        stderr_tail: "No conversation found with session ID: 00000000-0000-4000-8000-000000000001",
      },
    },
    {
      type: "completed",
      payload: {
        exit_code: 1,
        stderr_tail:
          "Example: No conversation found with session ID: 00000000-0000-4000-8000-000000000001",
      },
    },
  ])("does not abandon usable native history for unrelated output ($type)", (event) => {
    expect(
      claudeContinuity.rejectsCarriedState!(
        HarnessEvent.parse({ session_id: "s", ts: "t", ...event }),
      ),
    ).toBe(false);
  });
});

it("a failed sidecar copy removes the copied destination transcript and keeps the source", async () => {
  const a = store(process.env.CLAUDEXOR_CONFIG_DIR!, "failed-a");
  const b = store(process.env.CLAUDEXOR_CONFIG_DIR!, "failed-b");
  const file = seed(a, "/w", "sid-failed", true);
  const moved = await claudeContinuity.move(
    { file, sidecars: [join(a, "missing-sidecar")] },
    { CLAUDEXOR_PROFILE_LOCATOR: a },
    { CLAUDEXOR_PROFILE_LOCATOR: b },
    "/w",
  );
  expect(moved.ok).toBe(false);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(b, "projects", claudeProjectDirName("/w"), "sid-failed.jsonl"))).toBe(
    false,
  );
});
