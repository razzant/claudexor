// #694 r10 C: the startup sweep reads an envelope base whose preparation never
// finished (owner.json `preparing`) before any change: while a process of its
// scope still runs the base stays, named in the actions; once nothing does, it is
// disposed like any orphan. The writer is this test's own child.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunScopeMarker, scopeMarkerEnv } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { commandScopeRoots } from "@claudexor/daemon";
import { describe, expect, it } from "vitest";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

describe.runIf(process.platform !== "win32")(
  "sweep of an unfinished preparation's base (#694 r10 C)",
  () => {
    it("keeps the base while its scope still runs, disposes it after", async () => {
      const root = mkdtempSync(join(tmpdir(), "claudexor-sweep-prep-"));
      try {
        execFileSync("git", ["init", "-q", root]);
        execFileSync("git", [
          "-C",
          root,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "i",
        ]);
        const marker = mintRunScopeMarker();
        const base = join(projectRuntimeDir(root), "workspaces", "task-prep", "a01");
        mkdirSync(join(base, "tree"), { recursive: true });
        // Its creator is gone (a dead pid with no start time to compare).
        writeFileSync(
          join(base, "owner.json"),
          JSON.stringify({
            pid: 999_999_9,
            started: null,
            created_at: new Date().toISOString(),
            execution_root: root,
            workspace_mode: "isolated",
            preparation: { scope_marker: marker, preparing: true },
          }) + "\n",
        );
        const writer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          env: { ...process.env, ...scopeMarkerEnv(marker) },
          stdio: "ignore",
        });
        // Its start is proven by a read of its start time, not by waiting.
        const deadline = Date.now() + 10_000;
        for (;;) {
          let start = "";
          try {
            start = execFileSync("ps", ["-o", "lstart=", "-p", String(writer.pid)])
              .toString()
              .trim();
          } catch {
            /* not listed yet */
          }
          if (start) break;
          if (Date.now() > deadline) throw new Error("the writer did not start");
          await new Promise((r) => setTimeout(r, 20));
        }
        const knownProjectRoots = () =>
          commandScopeRoots([{ params: { scope: { kind: "project", root } } }]);
        try {
          const actions = await sweepOrphanWorkspaces({ knownProjectRoots });
          expect(existsSync(base)).toBe(true);
          expect(
            actions.some((a) => a.includes("task-prep/a01") && a.includes("may still run")),
          ).toBe(true);
          expect(writer.exitCode).toBeNull();
        } finally {
          writer.kill("SIGKILL");
          await new Promise((r) => writer.once("exit", r));
        }
        const after = await sweepOrphanWorkspaces({ knownProjectRoots });
        expect(existsSync(base)).toBe(false);
        expect(after.some((a) => a.includes("task-prep/a01"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);

    it.each(["unparsable", "unreadable"] as const)(
      "keeps a base whose owner.json is %s (unreadable is not absent), disposes it once readable without a preparation",
      async (kind) => {
        const root = mkdtempSync(join(tmpdir(), "claudexor-sweep-owner-"));
        try {
          execFileSync("git", ["init", "-q", root]);
          const base = join(projectRuntimeDir(root), "workspaces", "task-owner", "a01");
          mkdirSync(join(base, "tree"), { recursive: true });
          const owner = join(base, "owner.json");
          writeFileSync(owner, kind === "unparsable" ? '{"pid": 9999999, "prepar' : "{}\n");
          if (kind === "unreadable") chmodSync(owner, 0o000);
          const knownProjectRoots = () =>
            commandScopeRoots([{ params: { scope: { kind: "project", root } } }]);
          const actions = await sweepOrphanWorkspaces({ knownProjectRoots });
          expect(existsSync(base)).toBe(true);
          expect(
            actions.some((a) => a.includes("task-owner/a01") && a.includes("cannot be read")),
          ).toBe(true);
          chmodSync(owner, 0o600);
          writeFileSync(
            owner,
            JSON.stringify({ pid: 999_999_9, started: null, execution_root: root }) + "\n",
          );
          await sweepOrphanWorkspaces({ knownProjectRoots });
          expect(existsSync(base)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
  },
);
