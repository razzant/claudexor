import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  describeFindings,
  scanPublication,
  verifyGitStreamTrace,
  verifyMaterializedTree,
} from "./publication-scan.js";
import {
  BETTERLEAKS_RELEASES,
  bundledScannerLayout,
  locateScanner,
  provisionedScannerPath,
  scannerRelease,
} from "./publication-scanner-pin.js";
import { gatePublication } from "./publication-gate.js";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
// Many small repositories; removing them can exceed the default hook timeout
// on a busy file system.
afterAll(
  () => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  60_000,
);

function repo(): string {
  const root = temp("claudexor-scan-repo-");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "a",
  ]);
  return root;
}

/** A stand-in executable: in git mode it reads the history the way the real
 * scanner does (`git log -p`, so Git's completion trace is written), then
 * writes `report` to the --report-path it is given and exits with `code`. The
 * adapter must judge exit code, report shape and the stream's completion. */
function fakeScanner(report: string | null, code = 0, delayMs = 0): string {
  const path = join(temp("claudexor-fake-scanner-"), "betterleaks");
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      `const a=process.argv;const r=a[a.indexOf("--report-path")+1];` +
      `if(a[2]==="git")require("child_process").execFileSync("git",["-C",a[3],"log","-p","-U0",...a[a.indexOf("--log-opts")+1].split(" ")],{stdio:"ignore"});` +
      `setTimeout(()=>{${report === null ? "" : `require("fs").writeFileSync(r,${JSON.stringify(report)});`}process.exit(${code});},${delayMs});\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const scan = (scanner: string, timeoutMs?: number) =>
  scanPublication({
    scanner,
    repoRoot: repo(),
    logOpts: "HEAD",
    metadata: [{ label: "pull request title", text: "title\n" }],
    ...(timeoutMs ? { timeoutMs } : {}),
  });

describe.skipIf(process.platform === "win32")("publication scan adapter (INV-146)", () => {
  it("is clean only for exit 0 with an empty JSON finding list", async () => {
    expect(await scan(fakeScanner("[]"))).toEqual({ status: "clean" });
  });

  it.each([
    ["a nonzero exit, even with an empty report", fakeScanner("[]", 1), /exited 1/],
    ["a missing report", fakeScanner(null), /no readable JSON report/],
    ["an empty report file", fakeScanner(""), /no readable JSON report/],
    ["a report that is not a list", fakeScanner("null"), /not a finding list/],
    ["a malformed finding", fakeScanner('[{"File":"x"}]'), /malformed finding/],
  ])("fails, never passes, on %s", async (_label, scanner, reason) => {
    const result = await scan(scanner);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toMatch(reason);
  });

  it("fails on a scan that does not finish in time", async () => {
    const result = await scan(fakeScanner("[]", 0, 5_000), 300);
    expect(result).toEqual({ status: "failed", reason: "history scan timed out" });
  });

  it("projects findings by rule and place, never the matched text", async () => {
    const value = ["ghp", "q".repeat(36)].join("_");
    const report = JSON.stringify([
      {
        RuleID: "github-pat",
        File: "src/x.ts",
        StartLine: 3,
        Commit: "a".repeat(40),
        Secret: value,
        Match: value,
        Line: `t = "${value}"`,
        Message: `commit ${value}`,
      },
    ]);
    const result = await scan(fakeScanner(report));
    expect(result.status).toBe("findings");
    expect(JSON.stringify(result)).not.toContain(value);
    // The stand-in answers both passes: history keeps the file, metadata its label.
    if (result.status === "findings")
      expect(describeFindings(result.findings)).toBe(
        "github-pat in src/x.ts:3 (commit aaaaaaaaaaaa); github-pat in publication metadata:3 (commit aaaaaaaaaaaa)",
      );
  });

  it("withholds every location when the location check cannot run, never clean", async () => {
    const report = JSON.stringify([
      { RuleID: "github-pat", File: "src/x.ts", StartLine: 3, Commit: "a".repeat(40) },
    ]);
    // Answers every pass, but fails the scan of the finding locations.
    const scanner = join(temp("claudexor-fake-scanner-"), "betterleaks");
    writeFileSync(
      scanner,
      `#!${process.execPath}\n` +
        `const a=process.argv;const r=a[a.indexOf("--report-path")+1];` +
        `if(a[2]==="git")require("child_process").execFileSync("git",["-C",a[3],"log","-p","-U0",...a[a.indexOf("--log-opts")+1].split(" ")],{stdio:"ignore"});` +
        `if(a[2]==="dir"&&/locations$/.test(a[3]))process.exit(1);` +
        `require("fs").writeFileSync(r,${JSON.stringify(report)});\n`,
    );
    chmodSync(scanner, 0o755);
    const result = await scan(scanner);
    expect(result.status).toBe("findings");
    if (result.status === "findings")
      for (const finding of result.findings)
        expect(finding).toMatchObject({
          ruleId: "github-pat",
          location: expect.stringMatching(/^withheld location \(sha256 [0-9a-f]{12}\)$/),
          line: 3,
        });
  });

  it("refuses an executable that is not the pinned build, and a missing one", () => {
    const release = scannerRelease();
    const impostor = fakeScanner("[]");
    expect(
      locateScanner({ env: { CLAUDEXOR_BETTERLEAKS_PATH: impostor }, configDir: null }),
    ).toEqual(
      release
        ? {
            ok: false,
            reason: `the scanner at ${impostor} is not the pinned Betterleaks 1.9.0 build`,
          }
        : expect.objectContaining({ ok: false }),
    );
    const root = temp("claudexor-scan-config-");
    expect(locateScanner({ env: {}, configDir: root })).toMatchObject({ ok: false });
    expect(locateScanner({ env: {}, configDir: root, release: null })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no pinned Betterleaks/),
    });
  });

  it("accepts a bundled copy only as the pinned build or the signed copy its provenance records", () => {
    const release = BETTERLEAKS_RELEASES["linux-x64"]!;
    const native = temp("claudexor-scan-native-");
    const layout = bundledScannerLayout(native, "linux-x64");
    mkdirSync(layout.dir, { recursive: true });
    const signed = "signed copy of the pinned build\n";
    writeFileSync(layout.binary, signed);
    const provenance = (fields: Record<string, unknown> = {}) =>
      writeFileSync(
        layout.provenance,
        JSON.stringify({
          name: "betterleaks",
          version: "1.9.0",
          upstreamBinarySha256: release.binarySha256,
          bundledSha256: createHash("sha256").update(signed).digest("hex"),
          ...fields,
        }),
      );
    const locate = (env: NodeJS.ProcessEnv = {}) =>
      locateScanner({ env, configDir: null, release, bundledNativeDir: native });
    const refused = {
      ok: false,
      reason: `the bundled scanner at ${layout.binary} is not the pinned Betterleaks 1.9.0 build`,
    };
    provenance();
    expect(locate()).toEqual({ ok: true, path: layout.binary });
    writeFileSync(layout.binary, `${signed}changed after the release recorded it\n`);
    expect(locate()).toEqual(refused);
    writeFileSync(layout.binary, signed);
    provenance({ upstreamBinarySha256: "0".repeat(64) });
    expect(locate()).toEqual(refused);
    provenance({ version: "1.8.0" });
    expect(locate()).toEqual(refused);
    rmSync(layout.provenance);
    expect(locate()).toEqual(refused);
    // An explicit path is the only candidate when set.
    provenance();
    const impostor = fakeScanner("[]");
    expect(locate({ CLAUDEXOR_BETTERLEAKS_PATH: impostor })).toEqual({
      ok: false,
      reason: `the scanner at ${impostor} is not the pinned Betterleaks 1.9.0 build`,
    });
  });

  it("falls back to the provisioned copy only when nothing is bundled", () => {
    const release = BETTERLEAKS_RELEASES["linux-x64"]!;
    const config = temp("claudexor-scan-config-");
    const native = temp("claudexor-scan-native-");
    const locate = () =>
      locateScanner({ env: {}, configDir: config, release, bundledNativeDir: native });
    expect(locate()).toEqual({
      ok: false,
      reason: "Betterleaks 1.9.0 is not bundled or provisioned",
    });
    const provisioned = provisionedScannerPath(config, release)!;
    mkdirSync(dirname(provisioned), { recursive: true });
    writeFileSync(provisioned, "not the pinned build\n");
    expect(locate()).toEqual({
      ok: false,
      reason: `the scanner at ${provisioned} is not the pinned Betterleaks 1.9.0 build`,
    });
    // A present bundled copy that does not match is reported, never skipped.
    const layout = bundledScannerLayout(native, "linux-x64");
    mkdirSync(layout.dir, { recursive: true });
    writeFileSync(layout.binary, "bundled impostor\n");
    expect(locate()).toMatchObject({ ok: false, reason: expect.stringContaining(layout.binary) });
  });

  it("pins every supported platform's archive and binary digest", () => {
    expect(Object.keys(BETTERLEAKS_RELEASES).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const release of Object.values(BETTERLEAKS_RELEASES)) {
      expect(release.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(release.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(provisionedScannerPath("/cfg", BETTERLEAKS_RELEASES["linux-x64"]!)).toBe(
      "/cfg/tools/betterleaks/1.9.0/linux-x64/betterleaks",
    );
  });
});

/** What the pinned scanner sees in an outgoing range, merges included (#555
 * pass 4, C1/A1). Local throwaway repositories; the GitHub-token-shaped value is
 * assembled at runtime and never part of an assertion message. */
const pinnedScanner = locateScanner({ env: process.env, configDir: null });
describe.runIf(pinnedScanner.ok && process.platform !== "win32")(
  "publication scan of merges and commit messages with the pinned Betterleaks binary",
  () => {
    const token = () => `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
    /** A repository whose `main` is what the destination already has. */
    function history() {
      const root = temp("claudexor-scan-merges-");
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      g("init", "-q", "-b", "main");
      writeFileSync(join(root, "a.txt"), "base\n");
      g("add", "-A");
      g("commit", "-qm", "base");
      return { root, g, dest: () => g("rev-parse", "HEAD") };
    }
    const scanRange = (root: string, dest: string, env?: NodeJS.ProcessEnv) =>
      scanPublication({
        scanner: pinnedScanner.ok ? pinnedScanner.path : "",
        repoRoot: root,
        logOpts: `HEAD --not ${dest}`,
        metadata: [],
        ...(env ? { env } : {}),
      });
    /** Diverge `side` and `main`, then merge `side` into `main` without committing. */
    function startMerge(h: ReturnType<typeof history>) {
      const dest = h.dest();
      h.g("checkout", "-qb", "side");
      writeFileSync(join(h.root, "b.txt"), "side\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "side");
      h.g("checkout", "-q", "main");
      writeFileSync(join(h.root, "c.txt"), "main\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "main2");
      return dest;
    }

    it("finds a credential an evil merge introduced, even after a later commit deletes it", async () => {
      const h = history();
      const dest = startMerge(h);
      h.g("merge", "-q", "--no-ff", "--no-commit", "side");
      writeFileSync(join(h.root, "evil.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "merge side");
      const merge = h.g("rev-parse", "HEAD");
      h.g("rm", "-q", "evil.txt");
      h.g("commit", "-qm", "rm");
      const result = await scanRange(h.root, dest);
      expect(result.status).toBe("findings");
      if (result.status === "findings")
        expect(result.findings).toContainEqual(
          expect.objectContaining({ ruleId: "github-pat", location: "evil.txt", commit: merge }),
        );
    });

    it("finds a credential a conflict resolution introduced", async () => {
      const h = history();
      const dest = h.dest();
      h.g("checkout", "-qb", "side");
      writeFileSync(join(h.root, "a.txt"), "side line\n");
      h.g("commit", "-qam", "side");
      h.g("checkout", "-q", "main");
      writeFileSync(join(h.root, "a.txt"), "main line\n");
      h.g("commit", "-qam", "main2");
      try {
        h.g("merge", "-q", "side");
      } catch {
        // the expected conflict
      }
      writeFileSync(join(h.root, "a.txt"), `token = "${token()}"\n`);
      h.g("add", "a.txt");
      h.g("commit", "-qm", "resolve");
      writeFileSync(join(h.root, "a.txt"), "resolved\n");
      h.g("commit", "-qam", "scrub");
      const result = await scanRange(h.root, dest);
      expect(result.status).toBe("findings");
    });

    it("finds a credential an octopus merge introduced (no remerge view exists for it)", async () => {
      const h = history();
      const dest = h.dest();
      for (const branch of ["x", "y"]) {
        h.g("checkout", "-qb", branch, "main");
        writeFileSync(join(h.root, `${branch}.txt`), `${branch}\n`);
        h.g("add", "-A");
        h.g("commit", "-qm", branch);
      }
      h.g("checkout", "-q", "main");
      writeFileSync(join(h.root, "m.txt"), "m\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "m");
      h.g("merge", "-q", "--no-commit", "x", "y");
      writeFileSync(join(h.root, "evil.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "octopus");
      expect(h.g("log", "-1", "--format=%P").split(" ")).toHaveLength(3);
      h.g("rm", "-q", "evil.txt");
      h.g("commit", "-qm", "rm");
      const result = await scanRange(h.root, dest);
      expect(result.status).toBe("findings");
    });

    it("does not re-flag a fixture the destination already published when a branch merges it in", async () => {
      const h = history();
      h.g("checkout", "-qb", "feature");
      writeFileSync(join(h.root, "f.txt"), "feature\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "feature");
      h.g("checkout", "-q", "main");
      writeFileSync(join(h.root, "published.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "published fixture");
      const dest = h.dest();
      h.g("checkout", "-q", "feature");
      h.g("merge", "-q", "--no-edit", "main");
      expect(await scanRange(h.root, dest)).toEqual({ status: "clean" });
    });

    it("keeps a range without merges as before: a deleted credential found, a clean range clean", async () => {
      const h = history();
      const dest = h.dest();
      writeFileSync(join(h.root, "plain.txt"), "nothing here\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "plain");
      expect(await scanRange(h.root, dest)).toEqual({ status: "clean" });
      writeFileSync(join(h.root, "s.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "add");
      h.g("rm", "-q", "s.txt");
      h.g("commit", "-qm", "rm");
      expect((await scanRange(h.root, dest)).status).toBe("findings");
    });

    it("scans the commit messages of the range, labelled by commit", async () => {
      const h = history();
      const dest = h.dest();
      writeFileSync(join(h.root, "plain.txt"), "nothing here\n");
      h.g("add", "-A");
      h.g("commit", "-qm", `rotate ${token()}`);
      const sha = h.g("rev-parse", "HEAD");
      const result = await scanRange(h.root, dest);
      expect(result.status).toBe("findings");
      if (result.status === "findings")
        expect(result.findings.map((f) => f.location)).toContain(
          `commit message ${sha.slice(0, 12)}`,
        );
    });

    it("scans every tracked blob of the tree, whatever the tree's own export attributes say", async () => {
      const h = history();
      writeFileSync(join(h.root, ".gitattributes"), "tests/ export-ignore\n");
      mkdirSync(join(h.root, "tests"));
      writeFileSync(join(h.root, "tests", "fixture.txt"), `token = "${token()}"\n`);
      mkdirSync(join(h.root, "vendor"));
      writeFileSync(join(h.root, "vendor", ".gitattributes"), "* export-ignore\n");
      writeFileSync(join(h.root, "vendor", "key.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "fixtures the destination already has");
      const dest = h.dest();
      writeFileSync(join(h.root, "README.md"), "docs only\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "readme");
      const tree = await scanPublication({
        scanner: pinnedScanner.ok ? pinnedScanner.path : "",
        repoRoot: h.root,
        logOpts: `HEAD --not ${dest}`,
        treeish: "HEAD",
        metadata: [],
      });
      expect(tree.status).toBe("findings");
      if (tree.status === "findings") {
        expect(tree.findings.map((f) => f.location).sort()).toEqual([
          "tests/fixture.txt",
          "vendor/key.txt",
        ]);
        for (const finding of tree.findings)
          expect({ ruleId: finding.ruleId, commit: finding.commit }).toEqual({
            ruleId: "github-pat",
            commit: null,
          });
      }
      // The README-only range alone is clean: the findings come from the tree.
      expect(await scanRange(h.root, dest)).toEqual({ status: "clean" });
    });

    it("never repeats a detected secret through a finding's location, history or tree", async () => {
      const h = history();
      const dest = h.dest();
      const named = `config-${token()}.txt`;
      writeFileSync(join(h.root, named), `token = "${token()}"\n`);
      writeFileSync(join(h.root, "ordinary.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "two fixtures");
      const commit = h.g("rev-parse", "HEAD");
      const result = await scanPublication({
        scanner: pinnedScanner.ok ? pinnedScanner.path : "",
        repoRoot: h.root,
        logOpts: `HEAD --not ${dest}`,
        treeish: "HEAD",
        metadata: [],
      });
      expect(result.status).toBe("findings");
      if (result.status !== "findings") return;
      const leaked = JSON.stringify(result).includes(token());
      expect(leaked, "a finding repeats the detected value").toBe(false);
      expect(describeFindings(result.findings).includes(token()), "description repeats it").toBe(
        false,
      );
      const withheld = expect.stringMatching(/^withheld location \(sha256 [0-9a-f]{12}\)$/);
      // History keeps rule, line and commit; the tree keeps rule and line.
      expect(result.findings).toEqual(
        expect.arrayContaining([
          { ruleId: "github-pat", location: withheld, line: 1, commit },
          { ruleId: "github-pat", location: "ordinary.txt", line: 1, commit },
          { ruleId: "github-pat", location: withheld, line: 1, commit: null },
          { ruleId: "github-pat", location: "ordinary.txt", line: 1, commit: null },
        ]),
      );
    });

    it("scans the tree's own ignore files as tracked files", async () => {
      const h = history();
      // Betterleaks 1.9 loads a scanned root's .gitleaksignore and
      // .betterleaksignore but honours only absolute fingerprints from them.
      // The extraction path is private and unpredictable, so the entry below
      // cannot match either way: this test shows the two files are scanned as
      // content; keeping them from being loaded rests on the private rename.
      writeFileSync(
        join(h.root, ".gitleaksignore"),
        `# token = "${token()}"\nother.txt:github-pat:1\n`,
      );
      writeFileSync(join(h.root, ".betterleaksignore"), `# token = "${token()}"\n`);
      writeFileSync(join(h.root, "other.txt"), `token = "${token()}"\n`);
      h.g("add", "-A");
      h.g("commit", "-qm", "ignore files the destination already has");
      const dest = h.dest();
      writeFileSync(join(h.root, "README.md"), "docs only\n");
      h.g("add", "-A");
      h.g("commit", "-qm", "readme");
      const tree = await scanPublication({
        scanner: pinnedScanner.ok ? pinnedScanner.path : "",
        repoRoot: h.root,
        logOpts: `HEAD --not ${dest}`,
        treeish: "HEAD",
        metadata: [],
      });
      expect(tree.status).toBe("findings");
      if (tree.status === "findings")
        expect(tree.findings.map((f) => `${f.ruleId} ${f.location}`).sort()).toEqual([
          "github-pat .betterleaksignore",
          "github-pat .gitleaksignore",
          "github-pat other.txt",
        ]);
      expect(await scanRange(h.root, dest)).toEqual({ status: "clean" });
    });

    // Only a case-insensitive temp file system (default macOS APFS, Windows
    // NTFS) can fold two tracked paths into one; elsewhere this test is skipped.
    const caseInsensitiveTemp = (() => {
      const dir = temp("claudexor-case-probe-");
      writeFileSync(join(dir, "sensitivity"), "x");
      return existsSync(join(dir, "SENSITIVITY"));
    })();
    it.runIf(caseInsensitiveTemp)(
      "fails, never clean, when the temp file system folds two tracked paths into one",
      async () => {
        const h = history();
        const git = (args: string[], input: string) =>
          execFileSync("git", ["-C", h.root, ...args], { input, encoding: "utf8" }).trim();
        const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
        const tree = (readme: string) =>
          git(
            ["mktree"],
            [
              `100644 blob ${blob(`token = "${token()}"\n`)}\tA.txt\n`,
              `100644 blob ${blob(readme)}\tREADME\n`,
              `100644 blob ${blob("ordinary content\n")}\ta.txt\n`,
            ].join(""),
          );
        const base = h.g("commit-tree", tree("base\n"), "-p", "HEAD", "-m", "two spellings");
        const head = h.g("commit-tree", tree("updated\n"), "-p", base, "-m", "readme only");
        h.g("update-ref", "refs/heads/main", head);
        const scan = (logOpts: string, treeish?: string) =>
          scanPublication({
            scanner: pinnedScanner.ok ? pinnedScanner.path : "",
            repoRoot: h.root,
            logOpts,
            ...(treeish ? { treeish } : {}),
            metadata: [],
          });
        const result = await scan(`${base}..${head}`, "HEAD");
        expect(result.status).toBe("failed");
        if (result.status === "failed") expect(result.reason).toContain("A.txt = a.txt");
        // Positive control: the history of the commit that added both finds the token.
        const added = await scan(`${base}^..${base}`);
        expect(added.status).toBe("findings");
        if (added.status === "findings")
          expect(added.findings.map((f) => f.location)).toEqual(["A.txt"]);
      },
    );

    it.runIf(caseInsensitiveTemp)(
      "names folded tracked paths without repeating a secret they carry",
      async () => {
        const h = history();
        const blob = execFileSync("git", ["-C", h.root, "hash-object", "-w", "--stdin"], {
          input: "ordinary\n",
          encoding: "utf8",
        }).trim();
        const tree = execFileSync("git", ["-C", h.root, "mktree"], {
          input: `100644 blob ${blob}\tK-${token()}.txt\n100644 blob ${blob}\tk-${token()}.txt\n`,
          encoding: "utf8",
        }).trim();
        const head = h.g("commit-tree", tree, "-p", "HEAD", "-m", "two spellings");
        h.g("update-ref", "refs/heads/main", head);
        const result = await scanPublication({
          scanner: pinnedScanner.ok ? pinnedScanner.path : "",
          repoRoot: h.root,
          logOpts: `${head}^..${head}`,
          treeish: "HEAD",
          metadata: [],
        });
        expect(result.status).toBe("failed");
        if (result.status !== "failed") return;
        expect(result.reason.includes(token()), "the reason repeats the value").toBe(false);
        expect(result.reason).toMatch(
          /^tree scan found tracked paths sharing one extracted file: withheld location \(sha256 [0-9a-f]{12}\) = withheld location \(sha256 [0-9a-f]{12}\)$/,
        );
      },
    );

    it("fails typed, never clean, when Git cannot show merges as remerge diffs", async () => {
      const h = history();
      const dest = h.dest();
      // Stand-in for a Git older than 2.36, which does not know the option.
      const bin = temp("claudexor-old-git-");
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nfor a in "$@"; do case "$a" in --diff-merges=remerge) echo "fatal: unknown value for --diff-merges: remerge" >&2; exit 128;; esac; done\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const result = await scanRange(h.root, dest, {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      expect(result.status).toBe("failed");
    });
  },
);

/** Git's trace2 event lines as one process writes them (#555 pass 5, N2). */
function traceDir(processes: Array<{ sid: string; lines: Array<Record<string, unknown>> }>) {
  const dir = temp("claudexor-git-trace-");
  for (const { sid, lines } of processes)
    writeFileSync(
      join(dir, sid.replace(/\W/g, "_")),
      lines.map((line) => JSON.stringify({ sid, ...line })).join("\n") + "\n",
    );
  return dir;
}
const logStart = { event: "start", argv: ["git", "-C", "/r", "log", "-p", "-U0", "HEAD"] };
const remoteHelper = {
  sid: "helper",
  lines: [
    { event: "start", argv: ["git", "ls-remote", "--quiet", "--get-url"] },
    { event: "cmd_name", name: "ls-remote" },
    { event: "exit", code: 128 },
    { event: "atexit", code: 128 },
  ],
};

/** Deterministic on every platform: hard links stand in for two tracked
 * paths the file system folded into one file. */
describe("extracted tree checked against the commit inventory (INV-146)", () => {
  const entry = (mode: string, path: string) =>
    `${mode} ${mode === "160000" ? "commit" : "blob"} ${"0".repeat(40)}\t${path}\0`;
  const listing = (...entries: string[]) => Buffer.from(entries.join(""), "utf8");
  function extraction() {
    const root = temp("claudexor-materialized-");
    writeFileSync(join(root, "one.txt"), "one\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "two.txt"), "two\n");
    return root;
  }

  it("accepts every blob as its own file and skips gitlinks", () => {
    const root = extraction();
    expect(
      verifyMaterializedTree(
        root,
        listing(
          entry("100644", "one.txt"),
          entry("100755", "sub/two.txt"),
          entry("160000", "vendor/module"),
        ),
      ),
    ).toEqual({ ok: true });
  });

  it("fails when two tracked paths are one extracted file", () => {
    const root = extraction();
    linkSync(join(root, "one.txt"), join(root, "link.txt"));
    expect(
      verifyMaterializedTree(
        root,
        listing(entry("100644", "one.txt"), entry("100644", "link.txt")),
      ),
    ).toEqual({
      ok: false,
      reason: "found tracked paths sharing one extracted file: one.txt = link.txt",
    });
  });

  it("names failing paths through the given display", () => {
    const root = extraction();
    expect(
      verifyMaterializedTree(root, listing(entry("100644", "gone.txt")), (name) => `<${name}>`),
    ).toEqual({ ok: false, reason: "did not extract tracked paths: <gone.txt>" });
  });

  it("accepts a tracked symlink and fails a directory standing in for one", () => {
    const root = extraction();
    expect(verifyMaterializedTree(root, listing(entry("120000", "sub")))).toEqual({
      ok: false,
      reason: "did not extract tracked paths: sub",
    });
    try {
      symlinkSync("one.txt", join(root, "link"));
    } catch (error) {
      // Windows without the symlink privilege cannot create one at all.
      if (process.platform === "win32") return;
      throw error;
    }
    expect(verifyMaterializedTree(root, listing(entry("120000", "link")))).toEqual({ ok: true });
  });

  it("fails when a tracked path was not extracted, or not as a regular file", () => {
    const root = extraction();
    expect(
      verifyMaterializedTree(
        root,
        listing(entry("100644", "one.txt"), entry("100644", "gone.txt")),
      ),
    ).toEqual({ ok: false, reason: "did not extract tracked paths: gone.txt" });
    expect(verifyMaterializedTree(root, listing(entry("100644", "sub")))).toEqual({
      ok: false,
      reason: "did not extract tracked paths: sub",
    });
  });
});

describe("Git stream completion proof from trace2 (INV-146)", () => {
  it("accepts every git log exiting 0 and ignores the scanner's helper commands", () => {
    const dir = traceDir([
      remoteHelper,
      {
        sid: "log",
        lines: [
          logStart,
          { event: "cmd_name", name: "log" },
          { event: "exit", code: 0 },
          { event: "atexit", code: 0 },
        ],
      },
    ]);
    expect(verifyGitStreamTrace(dir)).toEqual({ ok: true });
  });

  it.each([
    [
      "a git log with no exit record (killed)",
      [logStart, { event: "cmd_name", name: "log" }],
      /no exit record/,
    ],
    [
      "a git log that exited non-zero",
      [logStart, { event: "cmd_name", name: "log" }, { event: "exit", code: 128 }],
      /exited 128/,
    ],
    [
      "a git log ended by a signal",
      [
        logStart,
        { event: "cmd_name", name: "log" },
        { event: "signal", signo: 13 },
        { event: "atexit", code: 141 },
      ],
      /signal/,
    ],
    ["a git log recognised from argv alone", [logStart], /no exit record/],
  ])("fails %s", (_label, lines, reason) => {
    const result = verifyGitStreamTrace(traceDir([remoteHelper, { sid: "log", lines }]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });

  it("fails when no git log ran, and when the trace is missing", () => {
    expect(verifyGitStreamTrace(traceDir([remoteHelper]))).toEqual({
      ok: false,
      reason: "no git log process was recorded",
    });
    expect(verifyGitStreamTrace(join(temp("claudexor-no-trace-"), "absent"))).toEqual({
      ok: false,
      reason: "the Git trace is unreadable",
    });
  });
});

describe.runIf(pinnedScanner.ok && process.platform !== "win32")(
  "an interrupted Git stream never reads as clean (pinned Betterleaks binary)",
  () => {
    const token = `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    /** An outgoing branch whose history added then deleted a credential, under
     * newer commits, with `origin` holding only the base. `large` adds a newest
     * commit whose `git log -p` output (about 1.9 MB) exceeds the usual CI
     * pipe buffers. The test separately proves Git was killed before exit. */
    function outgoing(large = false) {
      const root = temp("claudexor-interrupted-");
      const origin = temp("claudexor-interrupted-origin-");
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      execFileSync("git", ["init", "-q", "--bare", origin]);
      g("init", "-q", "-b", "main");
      writeFileSync(join(root, "a.txt"), "base\n");
      g("add", "-A");
      g("commit", "-qm", "base");
      g("remote", "add", "origin", origin);
      g("push", "-q", "origin", "main");
      writeFileSync(join(root, "s.txt"), `token = "${token}"\n`);
      g("add", "-A");
      g("commit", "-qm", "add");
      g("rm", "-q", "s.txt");
      g("commit", "-qm", "rm");
      for (const n of [1, 2, 3]) {
        writeFileSync(join(root, `n${n}.txt`), `newer ${n}\n`.repeat(50));
        g("add", "-A");
        g("commit", "-qm", `newer ${n}`);
      }
      if (large) {
        const lines = Array.from({ length: 100_000 }, (_, i) => `filler line ${i}\n`);
        writeFileSync(join(root, "big.txt"), lines.join(""));
        g("add", "-A");
        g("commit", "-qm", "big");
      }
      return { root, g };
    }
    const gate = (root: string, g: (...a: string[]) => string, env?: NodeJS.ProcessEnv) =>
      gatePublication({
        repoRoot: root,
        tree: g("rev-parse", "HEAD^{tree}"),
        parent: g("rev-parse", "HEAD"),
        message: "publish",
        branch: "claudexor/interrupted",
        configDir: temp("claudexor-interrupted-config-"),
        env: { ...process.env, ...env },
      });
    /** A `git` that dies by SIGKILL in the middle of the scanner's `git log -p`
     * stream, writing nothing to stderr (an OOM kill); every other Git call,
     * the adapter's own `git log` reads included, runs the real Git. After the
     * first chunk it stops reading, so the real Git blocks on the full pipe,
     * kills that still-running Git and records how it ended in `proof`; only
     * then does it die itself. Without the pause and a stream larger than the
     * pipe, Git can finish first and its trace rightly reads complete. */
    function killMidStream(proof: string) {
      const bin = temp("claudexor-kill-git-");
      writeFileSync(
        join(bin, "git"),
        `#!${process.execPath}\n` +
          `const { spawn } = require("node:child_process");\n` +
          `const args = process.argv.slice(2);\n` +
          `const stream = args.includes("log") && args.includes("-p");\n` +
          `const child = spawn(${JSON.stringify(realGit)}, args, { stdio: ["inherit", stream ? "pipe" : "inherit", "inherit"] });\n` +
          `if (!stream) child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code)));\n` +
          `else child.stdout.once("data", (chunk) => {\n` +
          `  child.stdout.pause();\n` +
          `  child.once("exit", (code, signal) => {\n` +
          `    require("node:fs").writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ code, signal }));\n` +
          `    process.kill(process.pid, "SIGKILL");\n` +
          `  });\n` +
          `  process.stdout.write(chunk.subarray(0, 64), () => child.kill("SIGKILL"));\n` +
          `});\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      return { PATH: `${bin}:${process.env.PATH ?? ""}` };
    }

    it("refuses as failed when the scanner's git log dies mid-stream", async () => {
      const { root, g } = outgoing(true);
      const control = await gate(root, g); // control: the credential is found
      expect(!control.ok && control.refusal.code).toBe("publication_scan_findings");
      const proof = join(temp("claudexor-kill-proof-"), "git-exit.json");
      const result = await gate(root, g, killMidStream(proof));
      // The interruption is causal: the real Git was killed while still writing.
      expect(JSON.parse(readFileSync(proof, "utf8"))).toEqual({ code: null, signal: "SIGKILL" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("publication_scan_failed");
        expect(result.refusal.detail).toMatch(
          /complete Git history \(git log (has no exit record|ended by a signal)\)/,
        );
      }
    });

    it("refuses as failed when an object of the outgoing range is missing", async () => {
      const { root, g } = outgoing();
      const blob = g("rev-parse", "HEAD:n3.txt");
      rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      const result = await gate(root, g);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("publication_scan_failed");
    });

    it("keeps a clean range clean and a credential a finding", async () => {
      const { root, g } = outgoing();
      const found = await gate(root, g);
      expect(!found.ok && found.refusal.code).toBe("publication_scan_findings");
      // Publish the scrubbed history: only an ordinary new commit is outgoing.
      g("push", "-q", "origin", "HEAD:main");
      writeFileSync(join(root, "plain.txt"), "nothing here\n");
      g("add", "-A");
      g("commit", "-qm", "plain");
      const clean = await gate(root, g);
      expect(clean.ok).toBe(true);
      if (clean.ok) clean.cleanup();
    });
  },
);
