import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialProfile, type SelectedHarnessProgram } from "@claudexor/schema";
import { planCursorProfileProgramCleanup } from "./profile-program-cleanup.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-cleanup-")));
  roots.push(root);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  const home = join(root, "profiles/cursor-a"),
    tree = join(home, ".local/share/cursor-agent"),
    bin = join(home, ".local/bin");
  mkdirSync(join(tree, "versions/old"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const old = join(tree, "versions/old/cursor-agent");
  writeFileSync(old, "old copy");
  symlinkSync(old, join(bin, "cursor-agent"));
  symlinkSync(old, join(bin, "agent"));
  writeFileSync(join(bin, "cursor"), "a hand-placed file");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor/credential-fixture"), "unchanged");
  const selected: SelectedHarnessProgram = {
    path: join(root, "real-program"),
    realPath: join(root, "real-program"),
    version: "2026.08.11-e8db854",
    versionOutput: "2026.08.11-e8db854",
    overrideEnv: null,
    overrideValue: null,
  };
  const profile = CredentialProfile.parse({
    profile_id: "a",
    harness_id: "cursor",
    display_name: "A",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  return { root, home, tree, bin, old, selected, profile };
}
it("removes exactly the unused tree and proven launcher links, once, preserving profile state", () => {
  const f = fixture(),
    plan = planCursorProfileProgramCleanup([f.profile], f.selected);
  expect(plan.paths).toEqual([join(f.bin, "agent"), join(f.bin, "cursor-agent"), f.tree]);
  expect(plan.execute(f.selected).removed).toEqual(plan.paths);
  expect(existsSync(f.tree)).toBe(false);
  expect(readFileSync(join(f.bin, "cursor"), "utf8")).toBe("a hand-placed file");
  expect(readFileSync(join(f.home, ".cursor/credential-fixture"), "utf8")).toBe("unchanged");
  expect(planCursorProfileProgramCleanup([f.profile], f.selected).paths).toEqual([]);
});
it("preserves a selected profile copy, including a selection changed after planning", () => {
  const f = fixture(),
    selected = { ...f.selected, path: join(f.bin, "agent"), realPath: f.old };
  expect(planCursorProfileProgramCleanup([f.profile], selected).paths).toEqual([]);
  const plan = planCursorProfileProgramCleanup([f.profile], f.selected);
  expect(plan.execute(selected).removed).toEqual([]);
  expect(existsSync(f.old)).toBe(true);
});
it("does not follow a redirected profile directory or erase a launcher replaced after inspection", () => {
  const f = fixture(),
    plan = planCursorProfileProgramCleanup([f.profile], f.selected);
  rmSync(join(f.bin, "agent"));
  writeFileSync(join(f.bin, "agent"), "replacement");
  expect(plan.execute(f.selected).removed).toEqual([]);
  expect(existsSync(f.old)).toBe(true);
  const share = join(f.home, ".local/share");
  rmSync(share, { recursive: true });
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(join(elsewhere, "cursor-agent"), { recursive: true });
  symlinkSync(elsewhere, share);
  expect(planCursorProfileProgramCleanup([f.profile], f.selected).paths).toEqual([]);
  expect(existsSync(join(elsewhere, "cursor-agent"))).toBe(true);
});
