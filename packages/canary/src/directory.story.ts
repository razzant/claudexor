import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { parse } from "yaml";
import { cli, makeSandbox, type Sandbox } from "./support.js";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.dispose();
  sandbox = undefined;
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("ordinary folder CLI delivery", () => {
  it.skipIf(process.platform === "win32")(
    "[INV-075:directory-readonly] answers over a live source socket without file capture",
    async () => {
      const sb = makeSandbox();
      sandbox = sb;
      rmSync(join(sb.repo, ".git"), { recursive: true, force: true });
      writeFileSync(
        join(sb.configDir, "config.yaml"),
        "harnesses:\n  codex:\n    enabled: false\n  claude:\n    enabled: false\n  cursor:\n    enabled: false\n  agy:\n    enabled: false\n  opencode:\n    enabled: false\n  raw-api:\n    enabled: false\n  openrouter:\n    enabled: false\ncredential_profiles: []\n",
      );
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(join(sb.repo, "s"), resolve);
      });
      try {
        const response = cli(sb, [
          "agent",
          "Read the folder without changing files",
          "--harness",
          "fake-implement",
          "--model",
          "fake-model",
          "--workspace-kind",
          "directory",
          "--scope-path",
          ".",
          "--in-place",
          "--access",
          "readonly",
          "--json",
        ]);
        expect(response.code, response.stdout + response.stderr).toBe(0);
        const result = response.json() as { runDir: string };
        const facts = parse(readFileSync(join(result.runDir, "final/run_facts.yaml"), "utf8"));
        expect(facts.outcome.lifecycle).toBe("succeeded");
        expect(facts.deliverable).toMatchObject({ present: true, kind: "answer" });
        expect(readFileSync(join(result.runDir, "final/answer.md"), "utf8").trim()).not.toBe("");
        expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
        expect(existsSync(join(result.runDir, "attempts/a01/final/files/manifest.json"))).toBe(
          false,
        );
        expect(existsSync(join(sb.repo, "FAKE_CHANGE.txt"))).toBe(false);
        expect(existsSync(join(sb.repo, ".git"))).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("[INV-075:directory] writes in a copy, applies retained files, discards another copy, and writes directly without Git", async () => {
    const sb = makeSandbox();
    sandbox = sb;
    rmSync(join(sb.repo, ".git"), { recursive: true, force: true });
    writeFileSync(
      join(sb.configDir, "config.yaml"),
      "harnesses:\n  codex:\n    enabled: false\n  claude:\n    enabled: false\n  cursor:\n    enabled: false\n  agy:\n    enabled: false\n  opencode:\n    enabled: false\n  raw-api:\n    enabled: false\n  openrouter:\n    enabled: false\ncredential_profiles: []\n",
    );
    const args = [
      "agent",
      "Create a file in the selected ordinary folder",
      "--harness",
      "fake-implement",
      "--model",
      "fake-model",
      "--workspace-kind",
      "directory",
      "--scope-path",
      ".",
      "--processing",
      "standard",
      "--no-review",
      "--json",
    ];
    const started = cli(sb, args);
    expect(started.code, started.stdout + started.stderr).toBe(0);
    const first = started.json() as { runId: string; runDir: string };
    expect(existsSync(join(sb.repo, ".git"))).toBe(false);
    expect(existsSync(join(sb.repo, "FAKE_CHANGE.txt"))).toBe(false);
    const product = parse(readFileSync(join(first.runDir, "final/work_product.yaml"), "utf8"));
    expect(product.kind).toBe("files");
    const manifest = JSON.parse(readFileSync(join(first.runDir, product.files.manifest), "utf8"));
    expect(manifest).toMatchObject({ sourceRoot: sb.repo, isolation: "envelope", complete: true });
    expect(manifest.executionRoot).not.toBe(sb.repo);
    const descriptor = JSON.parse(
      readFileSync(join(sb.configDir, "daemon/control-api.json"), "utf8"),
    );
    const token = readFileSync(descriptor.tokenPath, "utf8").trim();
    const request = (runId: string, path: string, body: unknown, key: string) =>
      fetch(`http://${descriptor.host}:${descriptor.port}/v2/runs/${runId}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Claudexor-Protocol-Major": "3",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
    const applied = await request(first.runId, "apply", { mode: "apply" }, "apply-first");
    expect(await applied.json()).toMatchObject({ applied: true });
    expect(readFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "utf8")).toBe(
      "fake-implement deterministic change\n",
    );
    expect(existsSync(join(sb.repo, ".git"))).toBe(false);
    writeFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "owner baseline\n");
    const second = cli(sb, args);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const copy = second.json() as { runId: string };
    expect(
      await (await request(copy.runId, "decision", { action: "discard" }, "discard-copy")).json(),
    ).toMatchObject({ accepted: true, status: "discarded" });
    expect(readFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "utf8")).toBe("owner baseline\n");
    const direct = cli(sb, [...args, "--in-place"]);
    expect(direct.code, direct.stdout + direct.stderr).toBe(0);
    const live = direct.json() as { runDir: string };
    expect(parse(readFileSync(join(live.runDir, "final/work_product.yaml"), "utf8"))).toMatchObject(
      { kind: "files", meta: { apply_state: "applied" } },
    );
    expect(readFileSync(join(sb.repo, "FAKE_CHANGE.txt"), "utf8")).toBe(
      "fake-implement deterministic change\n",
    );
    expect(existsSync(join(sb.repo, ".git"))).toBe(false);
  });
});
