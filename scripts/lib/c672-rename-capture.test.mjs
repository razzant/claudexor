import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(here, "..", "c672", "c672-rename-capture.cjs");

// The preload auto-installs at require time. Isolate that evaluation, then
// immediately restore the caller's environment rather than waiting for hooks.
const savedCaptureDir = process.env.C672_CAPTURE_DIR;
const renameBeforeImport = fs.renameSync;
let capture;
try {
  delete process.env.C672_CAPTURE_DIR;
  capture = require("../c672/c672-rename-capture.cjs");
} finally {
  if (savedCaptureDir === undefined) delete process.env.C672_CAPTURE_DIR;
  else process.env.C672_CAPTURE_DIR = savedCaptureDir;
}

const { matchesCopilotHide, sinceArg, installRenameCapture, loadTools, filesBelow } = capture;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "c672-capture-"));
  roots.push(root);
  return root;
}

test("requiring the preload with no capture dir installs nothing and sets no NODE_OPTIONS", () => {
  expect(process.env.NODE_OPTIONS ?? "").not.toContain("c672");
  expect(fs.renameSync).toBe(renameBeforeImport);
  expect(process.env.C672_CAPTURE_DIR).toBe(savedCaptureDir);
  expect(typeof matchesCopilotHide).toBe("function");
  expect(typeof installRenameCapture).toBe("function");
});

test("the --require preload does not propagate to a child Node process", () => {
  // A real child carrying the preload spawns a grandchild; the grandchild must
  // NOT inherit --require (which would reach vendor processes) and NODE_OPTIONS
  // must not carry the preload.
  const dir = fixture();
  const relay =
    "const {spawnSync}=require('node:child_process');" +
    "const r=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({execArgv:process.execArgv,NODE_OPTIONS:process.env.NODE_OPTIONS??null}))'],{encoding:'utf8'});" +
    "process.stdout.write(r.stdout);";
  const child = spawnSync(process.execPath, ["--require", preloadPath, "-e", relay], {
    env: { ...process.env, C672_CAPTURE_DIR: dir },
    encoding: "utf8",
  });
  const grandchild = JSON.parse(child.stdout);
  expect(grandchild.execArgv.join(" ")).not.toContain("c672-rename-capture");
  expect(grandchild.NODE_OPTIONS ?? "").not.toContain("c672");
});

test("only the exact node_modules/@github/copilot hide matches", () => {
  const base = "C:\\Users\\runneradmin\\.claudexor\\node\\node_modules\\@github\\copilot";
  expect(matchesCopilotHide(base, `${base}.claudexor-converted`)).toBe(true);
  expect(matchesCopilotHide(base.toUpperCase(), `${base}.claudexor-converted`.toUpperCase())).toBe(
    true,
  );
  // POSIX global prefix layout.
  expect(
    matchesCopilotHide(
      "/home/x/.claudexor/node/lib/node_modules/@github/copilot",
      "/home/x/.claudexor/node/lib/node_modules/@github/copilot.claudexor-converted",
    ),
  ).toBe(true);

  // Wrong destination suffix.
  expect(matchesCopilotHide(base, `${base}.bak`)).toBe(false);
  // The scope requires node_modules: a bare @github/copilot suffix is not a product npm copy.
  expect(
    matchesCopilotHide("C:\\x\\@github\\copilot", "C:\\x\\@github\\copilot.claudexor-converted"),
  ).toBe(false);
  // Other product npm packages must never be captured here.
  const claude = "C:\\p\\node_modules\\@anthropic-ai\\claude-code";
  expect(matchesCopilotHide(claude, `${claude}.claudexor-converted`)).toBe(false);
  const codex = "C:\\p\\node_modules\\@openai\\codex";
  expect(matchesCopilotHide(codex, `${codex}.claudexor-converted`)).toBe(false);
  expect(matchesCopilotHide("C:\\tmp\\thing", "C:\\tmp\\thing.claudexor-converted")).toBe(false);
});

test("a successful watched rename passes through and never observes", () => {
  const onFailure = vi.fn();
  const fs = { renameSync: vi.fn(() => "ok") };
  const hook = installRenameCapture({ fs, onFailure });
  expect(
    fs.renameSync(
      "a\\node_modules\\@github\\copilot",
      "a\\node_modules\\@github\\copilot.claudexor-converted",
    ),
  ).toBe("ok");
  expect(onFailure).not.toHaveBeenCalled();
  hook.uninstall();
});

test("a watched failure observes once then re-throws the exact original error", () => {
  const original = Object.assign(new Error("EPERM: operation not permitted, rename"), {
    code: "EPERM",
    errno: -4048,
    syscall: "rename",
  });
  const real = vi.fn(() => {
    throw original;
  });
  const onFailure = vi.fn();
  const sync = vi.fn();
  const fs = { renameSync: real };
  const hook = installRenameCapture({ fs, onFailure, syncBuiltinESMExports: sync });
  expect(sync).toHaveBeenCalledTimes(1);
  const from = "C:\\p\\node_modules\\@github\\copilot";
  let thrown;
  try {
    fs.renameSync(from, `${from}.claudexor-converted`);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(original);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(onFailure.mock.calls[0][0].error).toBe(original);
  expect(hook.fired).toBe(true);

  try {
    fs.renameSync(from, `${from}.claudexor-converted`);
  } catch {
    /* expected */
  }
  expect(onFailure).toHaveBeenCalledTimes(1);
  hook.uninstall();
  expect(sync).toHaveBeenCalledTimes(2);
});

test("an unwatched rename failure is re-thrown untouched with no observation", () => {
  const original = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const fs = {
    renameSync: () => {
      throw original;
    },
  };
  const onFailure = vi.fn();
  const hook = installRenameCapture({ fs, onFailure });
  expect(() => fs.renameSync("C:\\tmp\\unrelated", "C:\\tmp\\unrelated.tmp")).toThrow(original);
  expect(onFailure).not.toHaveBeenCalled();
  hook.uninstall();
});

test("an observer that throws is recorded and never replaces the product error", () => {
  const original = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const fs = {
    renameSync: () => {
      throw original;
    },
  };
  const recordObserverError = vi.fn();
  const hook = installRenameCapture({
    fs,
    onFailure: () => {
      throw new Error("observer blew up");
    },
    recordObserverError,
  });
  const from = "C:\\p\\node_modules\\@github\\copilot";
  expect(() => fs.renameSync(from, `${from}.claudexor-converted`)).toThrow(original);
  expect(recordObserverError).toHaveBeenCalledTimes(1);
  expect(recordObserverError.mock.calls[0][0].message).toBe("observer blew up");
  hook.uninstall();
});

test("sinceArg builds a Windows FILETIME filter one second before the mark", () => {
  expect(sinceArg(1000)).toBe(`--since=${(11644473600000n * 10000n).toString()}`);
  expect(sinceArg(Number.NaN)).toBe(null);
});

test("loadTools reports a gap instead of throwing on a missing or unreadable manifest", () => {
  expect(loadTools(undefined).gaps.length).toBeGreaterThan(0);
  expect(loadTools(join(fixture(), "missing.json")).gaps[0]).toMatch(/unreadable/);
  const dir = fixture();
  const path = join(dir, "tools.json");
  writeFileSync(
    path,
    JSON.stringify({ helper: { path: "x", sha256: "y" }, handle: null, gaps: ["g"] }),
  );
  const tools = loadTools(path);
  expect(tools.helper).toEqual({ path: "x", sha256: "y" });
  expect(tools.gaps).toEqual(["g"]);
});

test("filesBelow enumerates nested files, bounds output, and keeps read gaps visible", () => {
  const dir = fixture();
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, "sub", "b.txt"), "b");
  const listed = filesBelow(dir);
  expect(listed.files.some((f) => f.endsWith("a.txt"))).toBe(true);
  expect(listed.files.some((f) => f.endsWith("b.txt"))).toBe(true);
  expect(listed.gaps).toEqual([]);

  const bounded = filesBelow(dir, { limit: 1 });
  expect(bounded.files.length).toBe(1);
  expect(bounded.truncated).toBe(true);

  // A listing failure is a visible gap, never silently an empty directory. On
  // POSIX an unreadable directory (mode 000) cannot be read; skip where the
  // runner is root (CI) and the mode is ignored.
  if (process.platform !== "win32" && process.getuid && process.getuid() !== 0) {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "hidden.txt"), "x");
    chmodSync(locked, 0o000);
    try {
      const withGap = filesBelow(locked);
      expect(withGap.files).toEqual([]);
      expect(withGap.gaps.some((g) => /readdir/.test(g.reason))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  }
});

test.each(["failed", "healthy"])("real source hide with live preload: %s", (mode) => {
  const root = fixture();
  const source = join(root, "node_modules", "@github", "copilot");
  const hidden = `${source}.claudexor-converted`;
  const evidence = join(root, "capture");
  const receipt = join(root, "child-result.json");
  mkdirSync(dirname(source), { recursive: true });
  if (mode === "healthy") mkdirSync(source);
  // Import the actual source consumer, including its named ESM renameSync.
  // Node's supported TS stripping avoids stale dist or a workspace build.
  const consumer = pathToFileURL(
    join(here, "../../packages/core/src/hidden-program-paths.ts"),
  ).href;
  const code = `
    import { writeFileSync } from 'node:fs';
    const { hideProgramPaths } = await import(process.argv[1]);
    try {
      const result = hideProgramPaths([{path:process.argv[2],hidden:process.argv[3]}]).retire();
      writeFileSync(process.argv[4], JSON.stringify({ok:true,result}));
    } catch (error) {
      const {code,message,errno,syscall,path,dest} = error;
      writeFileSync(process.argv[4], JSON.stringify({ok:false,error:{code,message,errno,syscall,path,dest}}));
    }
  `;
  const env = { ...process.env, C672_CAPTURE_TOOLS: join(root, "absent-tools.json") };
  delete env.C672_CAPTURE_DIR;
  const run = (preload) =>
    spawnSync(
      process.execPath,
      [
        ...(preload ? ["--require", preloadPath] : []),
        "--input-type=module",
        "-e",
        code,
        consumer,
        source,
        hidden,
        receipt,
      ],
      {
        cwd: root,
        env: preload ? { ...env, C672_CAPTURE_DIR: evidence } : env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  let original;
  if (mode === "failed") {
    const baseline = run(false);
    expect(baseline.error).toBeUndefined();
    expect(baseline.status).toBe(0);
    expect(baseline.stdout).toBe("");
    original = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(original.error.code).toBe("ENOENT");
    expect(fs.existsSync(evidence)).toBe(false);
  }
  const child = run(true);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("");
  const observed = JSON.parse(fs.readFileSync(receipt, "utf8"));
  if (mode === "healthy") {
    expect(observed).toEqual({ ok: true, result: { removed: [source], limitations: [] } });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(hidden)).toBe(false);
    expect(fs.existsSync(evidence)).toBe(false);
    expect(child.stderr).not.toContain("C672_RENAME_CAPTURE");
  } else {
    expect(observed).toEqual(original);
    const captures = fs.readdirSync(evidence);
    expect(captures).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(join(evidence, captures[0], "capture.json"), "utf8"));
    expect(record).toMatchObject({
      status: "complete",
      from: source,
      to: hidden,
      error: original.error,
    });
    expect(record.gaps).toContain(
      "Restart Manager and process census unavailable (helper not prepared)",
    );
    expect(record.gaps.some((gap) => gap.includes("handle64 unavailable"))).toBe(true);
    expect(child.stderr).toContain("C672_RENAME_CAPTURE");
  }
});
