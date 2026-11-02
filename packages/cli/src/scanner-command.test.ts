import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionedScannerPath, type ScannerRelease } from "@claudexor/delivery";
import { parseArgs } from "./args.js";
import {
  BOOLEAN_FLAGS,
  CLI_COMMANDS,
  VALUE_FLAGS,
  helpJson,
  renderHelp,
} from "./command-registry.js";
import { commandFlagScopeError, commandPositionalError } from "./command-scope.js";
import { dispatchOpsCommand } from "./ops-commands.js";
import { scannerCommand, type ScannerCommandOptions } from "./scanner-command.js";

const HOST_KEY = `${process.platform}-${process.arch}`;
const SCANNER = "#!/bin/sh\necho 1.9.0\n";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
let stdout = "";
let stderr = "";
beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // Synchronous removal: successful completion has no elapsed-time requirement (#376).

/** A synthetic archive pinned by a synthetic release, under a private config root. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scanner-command-")));
  roots.push(root);
  const content = join(root, "content");
  mkdirSync(content);
  writeFileSync(join(content, "betterleaks"), SCANNER, { mode: 0o755 });
  writeFileSync(join(content, "LICENSE"), "MIT License\n");
  const archive = join(root, "official.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", content, "betterleaks", "LICENSE"]);
  const release: ScannerRelease = {
    asset: "betterleaks_test.tar.gz",
    archiveSha256: sha(readFileSync(archive)),
    binarySha256: sha(SCANNER),
    binary: "betterleaks",
  };
  const configRoot = join(root, "config");
  process.env.CLAUDEXOR_CONFIG_DIR = configRoot;
  const binary = provisionedScannerPath(configRoot, release) as string;
  const options: ScannerCommandOptions = { release, key: HOST_KEY, env: {} };
  const prepare = (json: boolean, extra: ScannerCommandOptions = {}, from = archive) =>
    scannerCommand(parseArgs(["scanner", "prepare", "--from-archive", from]), json, {
      ...options,
      ...extra,
    });
  return { root, archive, release, configRoot, binary, options, prepare };
}

const received = () => JSON.parse(stdout) as Record<string, unknown>;

describe.skipIf(process.platform === "win32")("claudexor scanner prepare", () => {
  it("answers one JSON receipt for a real preparation, with nothing else on stdout", async () => {
    const f = fixture();
    expect(await f.prepare(true)).toBe(0);
    expect(received()).toEqual({
      ok: true,
      status: "prepared",
      concurrent: false,
      version: "1.9.0",
      platform: HOST_KEY,
      configRoot: f.configRoot,
      path: f.binary,
      license: join(dirname(f.binary), "LICENSE"),
      source: { kind: "file", path: f.archive },
      binarySha256: f.release.binarySha256,
      archiveSha256: f.release.archiveSha256,
      resolution: { ok: true, path: f.binary, usesThisCopy: true },
      stagingLeft: null,
    });
    expect(stderr).toBe("");
    expect(sha(readFileSync(f.binary))).toBe(f.release.binarySha256);
  });

  it("reports progress on stderr and the result on stdout in text mode", async () => {
    const f = fixture();
    expect(await f.prepare(false)).toBe(0);
    expect(stderr).toContain(`Reading ${f.archive}`);
    expect(stdout).toContain(`Prepared Betterleaks 1.9.0 (${HOST_KEY}) at ${f.binary}`);
    expect(stdout).toContain("no restart is needed");
  });

  it("names the download URL it uses, and only then uses the network", async () => {
    const f = fixture();
    const urls: string[] = [];
    const code = await scannerCommand(parseArgs(["scanner", "prepare"]), false, {
      ...f.options,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(new Uint8Array(readFileSync(f.archive)));
      },
    });
    expect(code).toBe(0);
    expect(urls).toEqual([
      `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${f.release.asset}`,
    ]);
    expect(stderr).toContain(`Downloading ${urls[0]}`);
  });

  it("reuses a prepared copy and says nothing changed", async () => {
    const f = fixture();
    await f.prepare(true);
    const inode = statSync(f.binary).ino;
    stdout = "";
    expect(await f.prepare(false, {}, join(f.root, "absent"))).toBe(0);
    expect(stdout).toContain("already prepared");
    expect(stdout).toContain("nothing was changed");
    expect(statSync(f.binary).ino).toBe(inode);
    stdout = "";
    expect(await f.prepare(true)).toBe(0);
    expect(received()).toMatchObject({ status: "already_prepared", archiveSha256: null });
  });

  it("discloses when this environment's lookup order would not use the prepared copy", async () => {
    const f = fixture();
    const override = { CLAUDEXOR_BETTERLEAKS_PATH: join(f.root, "absent") };
    expect(await f.prepare(true, { env: override })).toBe(0);
    expect(received()).toMatchObject({
      status: "prepared",
      resolution: {
        ok: false,
        usesThisCopy: false,
        reason: expect.stringContaining("CLAUDEXOR_BETTERLEAKS_PATH"),
      },
    });
    stdout = "";
    expect(await f.prepare(false, { env: override })).toBe(0);
    expect(stdout).toContain("warning: `pr` in this environment still refuses");
  });

  it("reports a conflict typed, with the remedy, and leaves the bytes", async () => {
    const f = fixture();
    mkdirSync(dirname(f.binary), { recursive: true });
    writeFileSync(f.binary, "someone else's tool\n", { mode: 0o755 });
    expect(await f.prepare(true)).toBe(1);
    expect(received()).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "scanner_install_conflict",
      requiredActions: [expect.stringContaining(dirname(f.binary))],
    });
    expect(readFileSync(f.binary, "utf8")).toBe("someone else's tool\n");
  });

  it("points a failed download at the offline route", async () => {
    const f = fixture();
    const code = await scannerCommand(parseArgs(["scanner", "prepare"]), true, {
      ...f.options,
      fetchImpl: async () => new Response("", { status: 503 }),
    });
    expect(code).toBe(1);
    expect(received()).toMatchObject({
      code: "scanner_download_failed",
      requiredActions: [expect.stringContaining("--from-archive")],
    });
    expect(existsSync(dirname(f.binary))).toBe(false);
  });

  it("refuses an archive that is not the pinned one", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "other.tar.gz"), "not the archive");
    expect(await f.prepare(true, {}, join(f.root, "other.tar.gz"))).toBe(1);
    expect(received()).toMatchObject({ code: "scanner_archive_mismatch" });
    expect(existsSync(dirname(f.binary))).toBe(false);
  });

  it("names a platform with no pinned build", async () => {
    const f = fixture();
    expect(await f.prepare(true, { release: null, key: "plan9-mips" })).toBe(1);
    expect(received()).toMatchObject({
      code: "scanner_platform_unsupported",
      message: expect.stringContaining("plan9-mips"),
    });
  });

  it("an interrupt ends the extraction child, activates nothing and stops listening", async () => {
    const f = fixture();
    const pidFile = join(f.root, "tar.pid");
    const tarCommand = join(f.root, "slow-tar");
    writeFileSync(tarCommand, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, {
      mode: 0o755,
    });
    const before = process.listenerCount("SIGINT");
    const run = f.prepare(true, { tarCommand });
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "")
      await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit("SIGINT");
    expect(await run).toBe(1);
    expect(received()).toMatchObject({ ok: false, code: "scanner_prepare_cancelled" });
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(existsSync(dirname(f.binary))).toBe(false);
    expect(readdirSync(dirname(dirname(f.binary))).filter((n) => n.includes("staging"))).toEqual(
      [],
    );
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("is reached through the ops dispatcher and refuses another verb", async () => {
    const ran = dispatchOpsCommand("scanner", parseArgs(["scanner", "status"]), true);
    expect(await ran).toBe(2);
    expect(received()).toMatchObject({ ok: false, code: "invalid_argument" });
  });
});

describe("the scanner command in the registry", () => {
  it("declares one verb and scopes its flag", () => {
    const spec = CLI_COMMANDS.find((command) => command.id === "scanner");
    expect(spec).toMatchObject({ mutability: "ops", flags: ["from-archive", "json"] });
    expect(commandPositionalError("scanner", ["prepare"])).toBeNull();
    expect(commandPositionalError("scanner", [])).toContain("usage:");
    expect(commandPositionalError("scanner", ["prepare", "extra"])).toContain("usage:");
    expect(commandPositionalError("scanner", ["install"])).toContain("usage:");
    expect(commandFlagScopeError("scanner", ["from-archive"])).toBeNull();
    expect(commandFlagScopeError("scanner", ["dry-run"])).toContain("--dry-run");
    expect(commandFlagScopeError("gc", ["from-archive"])).toContain("--from-archive");
    expect(VALUE_FLAGS).toContain("from-archive");
    expect(BOOLEAN_FLAGS.has("from-archive")).toBe(false);
  });

  it("appears in both help projections", () => {
    expect(renderHelp("0.0.0")).toContain("claudexor scanner prepare [--from-archive <file>]");
    const help = helpJson("0.0.0");
    expect(help.commands.find((command) => command.id === "scanner")?.usage).toBe(
      "claudexor scanner prepare [--from-archive <file>]",
    );
    expect(help.flags.find((flag) => flag.name === "from-archive")).toMatchObject({
      kind: "value",
      value_hint: "<file>",
    });
  });
});
