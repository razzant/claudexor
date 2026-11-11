import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSelectedProgram } from "@claudexor/core";
import { CredentialProfile } from "@claudexor/schema";
import { CURSOR_PROGRAM } from "./program.js";
import { planCursorProfileProgramCleanup } from "./profile-program-cleanup.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
function vendor(home: string) {
  const dir = join(home, ".local/share/cursor-agent/versions/current"),
    link = join(home, ".local/bin/cursor-agent");
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  // Real vendor shape: link -> bash launcher -> bundled node beside its real path.
  writeFileSync(
    join(dir, "cursor-agent"),
    '#!/usr/bin/env bash\nset -euo pipefail\nSCRIPT_DIR="$(dirname "$(realpath "$0")")"\nexec "$SCRIPT_DIR/node" "$SCRIPT_DIR/index.js" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "node"), '#!/bin/sh\nprintf "2026.11.10-731fb78\\n"\n', { mode: 0o755 });
  writeFileSync(join(dir, "index.js"), "fixture sibling");
  symlinkSync(join(dir, "cursor-agent"), link);
  return link;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-cleanup-")));
  roots.push(root);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  const home = join(root, "profiles/cursor-a"),
    tree = join(home, ".local/share/cursor-agent"),
    bin = join(home, ".local/bin");
  const old = vendor(home),
    selected = vendor(root);
  symlinkSync(realpathSync(old), join(bin, "agent"));
  writeFileSync(join(bin, "cursor"), "a hand-placed file");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor/credential-fixture"), "unchanged");
  const sourceEnv: NodeJS.ProcessEnv = { HOME: root, PATH: "/usr/bin:/bin" };
  const observe = () =>
    resolveSelectedProgram(CURSOR_PROGRAM, { sourceEnv, nodePath: "/absent/node" });
  const profile = CredentialProfile.parse({
    profile_id: "a",
    harness_id: "cursor",
    display_name: "A",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  return {
    root,
    home,
    tree,
    bin,
    old,
    selected,
    profile,
    sourceEnv,
    observe,
    hidden: join(dirname(tree), ".cursor-agent.claudexor-hidden"),
  };
}
it("removes an independent vendor-shaped program copy and its links, preserving the selected program and profile state", () => {
  const f = fixture(),
    before = f.observe(),
    plan = planCursorProfileProgramCleanup([f.profile], before);
  expect(plan.paths).toEqual([join(f.bin, "agent"), join(f.bin, "cursor-agent"), f.tree]);
  expect(plan.execute(f.observe).removed).toEqual(plan.paths);
  expect(f.observe()).toEqual(before);
  expect(existsSync(f.tree)).toBe(false);
  expect(existsSync(f.hidden)).toBe(false);
  expect(readFileSync(join(f.bin, "cursor"), "utf8")).toBe("a hand-placed file");
  expect(readFileSync(join(f.home, ".cursor/credential-fixture"), "utf8")).toBe("unchanged");
  expect(planCursorProfileProgramCleanup([f.profile], f.observe()).paths).toEqual([]);
});
it("preserves the selected profile copy, including a selection changed after planning", () => {
  const f = fixture(),
    plan = planCursorProfileProgramCleanup([f.profile], f.observe());
  f.sourceEnv.CLAUDEXOR_CURSOR_BIN = f.old;
  expect(planCursorProfileProgramCleanup([f.profile], f.observe()).paths).toEqual([]);
  expect(plan.execute(f.observe).removed).toEqual([]);
  expect(existsSync(f.old)).toBe(true);
});
it("does not follow redirected parents or remove paths replaced after planning", () => {
  const f = fixture(),
    plan = planCursorProfileProgramCleanup([f.profile], f.observe());
  rmSync(join(f.bin, "agent"));
  writeFileSync(join(f.bin, "agent"), "replacement");
  expect(plan.execute(f.observe).removed).toEqual([]);
  expect(existsSync(f.old)).toBe(true);
  const share = dirname(f.tree),
    elsewhere = join(f.root, "elsewhere");
  rmSync(share, { recursive: true });
  mkdirSync(join(elsewhere, "cursor-agent"), { recursive: true });
  symlinkSync(elsewhere, share);
  expect(planCursorProfileProgramCleanup([f.profile], f.observe()).paths).toEqual([]);
  expect(existsSync(join(elsewhere, "cursor-agent"))).toBe(true);
});
it.each([false, true])(
  "restores a dependency behind a wrapper selected through PATH or override (%s)",
  (override) => {
    const f = fixture();
    writeFileSync(realpathSync(f.selected), `#!/bin/sh\nexec '${f.old}' "$@"\n`);
    if (override) f.sourceEnv.CLAUDEXOR_CURSOR_BIN = f.selected;
    const before = f.observe(),
      plan = planCursorProfileProgramCleanup([f.profile], before);
    const result = plan.execute(f.observe);
    expect(result.removed).toEqual([]);
    expect(result.limitations.join(" ")).toContain("in use");
    expect(f.observe()).toEqual(before);
    expect(existsSync(f.old)).toBe(true);
    expect(existsSync(f.hidden)).toBe(false);
  },
);
it.each([false, true])(
  "resolves an interrupted hide on the next explicit maintenance (dependency: %s)",
  (dependent) => {
    const f = fixture();
    if (dependent) writeFileSync(realpathSync(f.selected), `#!/bin/sh\nexec '${f.old}' "$@"\n`);
    const before = f.observe();
    renameSync(f.tree, f.hidden); // process died after hiding
    expect(f.observe().version).toBe(dependent ? null : before.version);
    const plan = planCursorProfileProgramCleanup([f.profile], f.observe(), { recoverOnly: true });
    const result = plan.execute(f.observe);
    expect(existsSync(f.hidden)).toBe(false);
    expect(existsSync(f.tree)).toBe(dependent);
    expect(f.observe()).toEqual(before);
    if (dependent) {
      expect(result.removed).toEqual([]);
      expect(result.limitations.join(" ")).toContain("in use");
    } else expect(result.removed).toContain(f.hidden);
  },
);
