import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitFilterCommand, holdUntil, leavingFilter, shellQuote } from "./process-fixtures.js";

// Only short-lived printf/argv filters: no daemon, held process, signal or census.
// Teardown removes exactly the directories created by this file, after each
// synchronous child has exited. Git has no inherited config or filter driver.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
};
const values = [
  "",
  "plain",
  "space and 'apostrophes'",
  'double "quotes" and \\backslash',
  "$VALUE; & | < > ( ) * ? [abc] # ~",
  "$(printf expanded) `printf expanded`",
  "line\nbreak\tтаб",
  "%f %% %x trailing%",
];

describe.runIf(process.platform !== "win32")("preparation fixture command quoting", () => {
  it.each(values)("keeps a literal shell word: %j", (value) => {
    expect(
      execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], {
        env,
        encoding: "utf8",
      }),
    ).toBe(value);
  });

  it("executes a literal filter path and preserves its shell arguments through real Git", () => {
    const root = mkdtempSync(join(tmpdir(), "cx-filter-"));
    dirs.push(root);
    execFileSync("git", ["init", "-q", "--object-format=sha1", root], { env });
    writeFileSync(join(root, ".gitattributes"), "*.held filter=probe\n");
    for (const value of values) {
      const program = join(root, `filter ${value}.sh`);
      writeFileSync(program, `#!/bin/sh\nprintf '%s' ${shellQuote(value)}\n`, { mode: 0o755 });
      const digest = execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          `filter.probe.clean=${gitFilterCommand(program)}`,
          "-c",
          "filter.probe.required=true",
          "hash-object",
          "--path=sample.held",
          "--stdin",
        ],
        { env, input: "", encoding: "utf8" },
      ).trim();
      expect(digest).toBe(
        createHash("sha1")
          .update(`blob ${Buffer.byteLength(value)}\0${value}`)
          .digest("hex"),
      );
    }
  });

  it("quotes each filter argument separately through Git, including empty and percent words", () => {
    const root = mkdtempSync(join(tmpdir(), "cx-filter-argv-"));
    dirs.push(root);
    execFileSync("git", ["init", "-q", "--object-format=sha1", root], { env });
    writeFileSync(join(root, ".gitattributes"), "*.held filter=probe\n");
    const program = join(root, "argv ' %f $.cjs");
    writeFileSync(program, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const args = [process.execPath, program, ...values];
    const run = (command: string) =>
      spawnSync(
        "git",
        [
          "-C",
          root,
          "-c",
          `filter.probe.clean=${command}`,
          "-c",
          "filter.probe.required=true",
          "hash-object",
          "--path=sample.held",
          "--stdin",
        ],
        { env, input: "", encoding: "utf8" },
      );
    const result = run(gitFilterCommand(args[0]!, ...args.slice(1)));
    const output = JSON.stringify(values);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(output)}\0${output}`)
        .digest("hex"),
    );
    // Quoting the whole command as one executable must fail, not execute argv.
    const broken = run(gitFilterCommand(args.map(shellQuote).join(" ")));
    expect(broken.error).toBeUndefined();
    expect(broken.status).not.toBe(0);
  });

  it.each(["hold", "fail", "pass"] as const)(
    "keeps leavingFilter %s argv literal without starting its survivor",
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), "cx-leaving ' %f $-"));
      dirs.push(root);
      const filter = leavingFilter(root, mode, 1500);
      // Replace BEFORE execution: the real generated filter/child never runs.
      writeFileSync(
        join(root, "leaving-filter.cjs"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      );
      execFileSync("git", ["init", "-q", "--object-format=sha1", root], { env });
      writeFileSync(join(root, ".gitattributes"), "*.held filter=probe\n");
      const output = JSON.stringify([
        mode,
        join(root, "left.cjs"),
        join(root, "left"),
        root,
        "1500",
      ]);
      const digest = execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          `filter.probe.clean=${filter.command}`,
          "-c",
          "filter.probe.required=true",
          "hash-object",
          "--path=sample.held",
          "--stdin",
        ],
        { env, input: "", encoding: "utf8" },
      ).trim();
      expect(digest).toBe(
        createHash("sha1")
          .update(`blob ${Buffer.byteLength(output)}\0${output}`)
          .digest("hex"),
      );
      expect(filter.left()).toEqual([]);
    },
  );

  it.each(["", "release ' %f $(printf expanded)"])(
    "keeps holdUntil argv literal: %j",
    (release) => {
      const root = mkdtempSync(join(tmpdir(), "cx-hold ' %f $-"));
      dirs.push(root);
      const command = holdUntil(root, release);
      // Replace BEFORE execution: no polling holder is ever started.
      writeFileSync(
        join(root, "hold-until.cjs"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      );
      expect(
        JSON.parse(execFileSync("/bin/sh", ["-c", command], { env, encoding: "utf8" })),
      ).toEqual([release, root]);
    },
  );

  it("detects the old apostrophe bug and shell-only quoting of Git's %f", () => {
    // Harmless controls: an unmatched quote and printf, never an injected action.
    const broken = spawnSync("/bin/sh", ["-c", "printf '%s' '/tmp/one'quote'"], { env });
    expect(broken.error).toBeUndefined();
    expect(broken.status).toBe(2);
    const root = mkdtempSync(join(tmpdir(), "cx-filter-control-"));
    dirs.push(root);
    execFileSync("git", ["init", "-q", "--object-format=sha1", root], { env });
    writeFileSync(join(root, ".gitattributes"), "*.held filter=probe\n");
    const digest = execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "filter.probe.clean=printf '%s' '%f'",
        "hash-object",
        "--path=sample.held",
        "--stdin",
      ],
      { env, input: "", encoding: "utf8" },
    ).trim();
    expect(digest).not.toBe(createHash("sha1").update("blob 2\0%f").digest("hex"));
    expect(digest).toBe(createHash("sha1").update("blob 11\0sample.held").digest("hex"));
  });
});
