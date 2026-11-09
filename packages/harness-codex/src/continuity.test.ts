import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { codexContinuity, codexStoreHome } from "./continuity.js";
import { codexRolloutParts } from "./rollout-file.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const TID = "0d6a2b0e-7c7f-4a3f-9d2e-6b1f2c3d4e5f";

function home(name: string): string {
  // Registered CODEX_HOMEs live under the Claudexor-owned root (the test
  // sandbox CLAUDEXOR_CONFIG_DIR), so the canonicalizer admits them.
  const dir = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", `codex-${name}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  // The home canonicalizer resolves symlinks (macOS /var → /private/var).
  return realpathSync(dir);
}

function seed(codexHome: string, parts: string[]): string[] {
  const day = join(codexHome, "sessions", "2026", "10", "06");
  mkdirSync(day, { recursive: true });
  return parts.map((name) => {
    const file = join(day, name);
    writeFileSync(file, `part ${name}\n`);
    return file;
  });
}

describe("codex continuity", () => {
  it("finds every rollout part by filename, .jsonl.zst included, with no DB row", () => {
    const a = home("a");
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
      "rollout-2026-10-06T09-00-00-ffffffff-0000-0000-0000-000000000000.jsonl",
    ]);
    expect(codexRolloutParts(a, TID)).toEqual(
      [main, zst]
        .sort()
        .reverse()
        .map((path) => ({ path, plain: true })),
    );
    expect(codexRolloutParts(join(a, "nope"), TID)).toEqual([]);
    expect(codexStoreHome({ [CONTINUITY_PROFILE_LOCATOR_ENV]: a })).toBe(a);
  });

  it("locates the thread (main .jsonl first, other parts as sidecars) and misses an unknown id", async () => {
    const a = home("a");
    const env = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    expect(await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, env)).toEqual({
      found: false,
    });
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
    ]);
    const located = await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, env);
    expect(located).toMatchObject({ found: true, file: zst, sidecars: [main] });
  });

  it("moves every part to the same relative path under the target home, retires the sources, never auth.json", async () => {
    const a = home("a");
    const b = home("b");
    writeFileSync(join(a, "auth.json"), '{"tokens":"never-copied"}');
    const [main, zst] = seed(a, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
    ]);
    const envA = { [CONTINUITY_PROFILE_LOCATOR_ENV]: a };
    const envB = { [CONTINUITY_PROFILE_LOCATOR_ENV]: b };
    const moved = await codexContinuity.move({ file: main!, sidecars: [zst!] }, envA, envB, "/w");
    expect(moved).toMatchObject({ ok: true, resumeRef: { nativeSessionId: TID } });
    expect(existsSync(main!)).toBe(true);
    expect(existsSync(zst!)).toBe(true);
    if (!moved.ok) throw new Error(moved.reason);
    await moved.retire?.();
    const rel = join("sessions", "2026", "10", "06");
    expect(
      readFileSync(join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl`), "utf8"),
    ).toContain("part ");
    expect(existsSync(join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`))).toBe(true);
    expect(existsSync(main!)).toBe(false);
    expect(existsSync(zst!)).toBe(false);
    expect(existsSync(join(b, "auth.json"))).toBe(false);
    expect(await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, envB)).toMatchObject({
      found: true,
      file: join(b, rel, `rollout-2026-10-06T10-00-00-${TID}.jsonl`),
    });
    // A part outside the sessions dir is refused before anything is copied.
    const stray = join(a, "auth.json");
    expect(
      await codexContinuity.move({ file: stray, sidecars: [] }, envA, envB, "/w"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("types the vendor's own rejection code for carried reasoning, from the rollout code or its error text", () => {
    const reject = codexContinuity.rejectsCarriedState!;
    const base = { session_id: "s", ts: "t" } as const;
    expect(
      reject({
        ...base,
        type: "completed",
        payload: { vendor_failure: { code: "invalid_encrypted_content" } },
      }),
    ).toBe(true);
    // Only the code decides, whichever channel carried it (`source` is display-only);
    // the app-server wire spells its codes in camelCase, never one of these tokens.
    const record = (code: string, source: string) => ({
      ...base,
      type: "completed" as const,
      payload: { vendor_failure: { code, message: "x", source } },
    });
    for (const source of ["codex_rollout", "codex_app_server", "renamed"]) {
      expect(reject(record("invalid_encrypted_content", source))).toBe(true);
      for (const code of ["serverOverloaded", "usageLimitExceeded", "server_overloaded"])
        expect(reject(record(code, source))).toBe(false);
    }
    expect(reject({ ...base, type: "error", error: "turn failed: Request blocked." })).toBe(true);
    expect(reject({ ...base, type: "error", error: "stream disconnected" })).toBe(false);
    expect(reject({ ...base, type: "message", text: "invalid_encrypted_content" })).toBe(false);
  });
});

it("a refused later part removes every destination written by the move", async () => {
  const a = home("failed-a"),
    b = home("failed-b");
  const [file] = seed(a, [`rollout-fixture-${TID}.jsonl`]);
  const stray = join(a, "outside.txt");
  writeFileSync(stray, "fixture");
  const moved = await codexContinuity.move(
    { file: file!, sidecars: [stray] },
    { CLAUDEXOR_PROFILE_LOCATOR: a },
    { CLAUDEXOR_PROFILE_LOCATOR: b },
    "/w",
  );
  expect(moved.ok).toBe(false);
  expect(existsSync(file!)).toBe(true);
  expect(existsSync(stray)).toBe(true);
  expect(existsSync(join(b, "sessions", "2026", "10", "06", `rollout-fixture-${TID}.jsonl`))).toBe(
    false,
  );
});

// #336: location and copy share the transcript readers' boundary. A detected
// link stays located (the vendor resumes its own files by id), while a move,
// which copies bytes, refuses it typed; the existing realpath guard stays.
describe.runIf(process.platform !== "win32")("codex continuity across links (#336)", () => {
  const OTHER = "0d6a2b0e-7c7f-4a3f-9d2e-000000000999";
  const day = (codexHome: string) => join(codexHome, "sessions", "2026", "10", "06");
  const env = (codexHome: string) => ({ [CONTINUITY_PROFILE_LOCATOR_ENV]: codexHome });

  it("locates a linked part and refuses to move it, leaving both homes as they were", async () => {
    const a = home("link-a");
    const b = home("link-b");
    const [other] = seed(a, [`rollout-2026-10-06T09-00-00-${OTHER}.jsonl`]);
    const link = join(day(a), `rollout-2026-10-06T10-00-00-${TID}.jsonl`);
    symlinkSync(other!, link);
    const located = await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, env(a));
    expect(located).toMatchObject({ found: true, file: link, sidecars: [] });
    const moved = await codexContinuity.move({ file: link, sidecars: [] }, env(a), env(b), "/w");
    expect(moved).toMatchObject({ ok: false, reason: expect.stringMatching(/not a plain file/) });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(other!, "utf8")).toContain(OTHER);
    expect(existsSync(day(b)) ? readdirSync(day(b)) : []).toEqual([]);
  });

  it("keeps refusing a part whose real path leaves the source sessions dir", async () => {
    const a = home("escape-a");
    const b = home("escape-b");
    mkdirSync(day(a), { recursive: true });
    writeFileSync(join(a, "auth.json"), '{"tokens":"never-copied"}');
    const link = join(day(a), `rollout-2026-10-06T10-00-00-${TID}.jsonl`);
    symlinkSync(join(a, "auth.json"), link);
    const moved = await codexContinuity.move({ file: link, sidecars: [] }, env(a), env(b), "/w");
    expect(moved).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/outside the source sessions dir/),
    });
    expect(existsSync(join(b, "auth.json"))).toBe(false);
  });

  it("moves every part out of a default native home reached through a linked ancestor", async () => {
    const root = join(process.env.CLAUDEXOR_CONFIG_DIR!, "native-link-test");
    mkdirSync(join(root, "real"), { recursive: true });
    roots.push(root);
    symlinkSync(join(root, "real"), join(root, "alias"));
    const nativeHome = join(root, "alias", "codex");
    const [main, zst] = seed(nativeHome, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
    ]);
    const fromEnv = { CLAUDEXOR_CODEX_NATIVE_HOME: nativeHome };
    const located = await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, fromEnv);
    if (!located.found) throw new Error("not located");
    const b = home("native-target");
    const moved = await codexContinuity.move(
      { file: located.file, sidecars: located.sidecars, nativeSessionId: TID },
      fromEnv,
      env(b),
      "/w",
    );
    if (!moved.ok) throw new Error(moved.reason);
    for (const part of [main!, zst!])
      expect(readFileSync(join(day(b), part.split("/").at(-1)!), "utf8")).toBe(
        readFileSync(part, "utf8"),
      );
    await moved.retire?.();
    expect(existsSync(main!)).toBe(false);
    expect(existsSync(zst!)).toBe(false);
  });

  // Review finding: the default native home spelled through a link and the
  // profile row the accounts migration registers for it (canonicalized) are
  // one store. Comparing the spellings copied every part onto itself.
  it("treats two spellings of one store as the same home and keeps its history", async () => {
    const root = join(process.env.CLAUDEXOR_CONFIG_DIR!, "same-store-test");
    mkdirSync(join(root, "real"), { recursive: true });
    roots.push(root);
    symlinkSync(join(root, "real"), join(root, "alias"));
    const nativeHome = join(root, "alias", "codex");
    const [main, zst] = seed(nativeHome, [
      `rollout-2026-10-06T10-00-00-${TID}.jsonl`,
      `rollout-2026-10-06T10-00-00-${TID}.jsonl.zst`,
    ]);
    const fromEnv = { CLAUDEXOR_CODEX_NATIVE_HOME: nativeHome };
    const toEnv = env(nativeHome);
    expect(codexStoreHome(toEnv)).not.toBe(codexStoreHome(fromEnv)); // two spellings
    const located = await codexContinuity.locate({ nativeSessionId: TID, cwd: "/w" }, fromEnv);
    if (!located.found) throw new Error("not located");
    const moved = await codexContinuity.move(
      { file: located.file, sidecars: located.sidecars, nativeSessionId: TID },
      fromEnv,
      toEnv,
      "/w",
    );
    expect(moved).toEqual({ ok: true, resumeRef: { nativeSessionId: TID } });
    expect(readFileSync(main!, "utf8")).toContain(TID);
    expect(readFileSync(zst!, "utf8")).toContain(TID);
  });

  it("still creates a destination home that does not exist yet", async () => {
    const a = home("absent-source");
    const [main] = seed(a, [`rollout-2026-10-06T10-00-00-${TID}.jsonl`]);
    const absent = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "codex-absent-target");
    roots.push(absent);
    expect(existsSync(absent)).toBe(false);
    const moved = await codexContinuity.move(
      { file: main!, sidecars: [] },
      env(a),
      env(absent),
      "/w",
    );
    if (!moved.ok) throw new Error(moved.reason);
    const copy = join(day(codexStoreHome(env(absent))), main!.split("/").at(-1)!);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(main!, "utf8"));
  });

  it("never writes through a link already sitting at the destination", async () => {
    const a = home("dest-a");
    const b = home("dest-b");
    const [main] = seed(a, [`rollout-2026-10-06T10-00-00-${TID}.jsonl`]);
    const victim = join(b, "victim.txt");
    writeFileSync(victim, "untouched\n");
    mkdirSync(day(b), { recursive: true });
    symlinkSync(victim, join(day(b), `rollout-2026-10-06T10-00-00-${TID}.jsonl`));
    const moved = await codexContinuity.move({ file: main!, sidecars: [] }, env(a), env(b), "/w");
    expect(moved.ok).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(existsSync(main!)).toBe(true);
  });
});
