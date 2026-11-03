import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// HERMETIC vendor stubs (the settings-service suite's pattern): the codex and
// agy adapters resolve their binaries at module load and discover() requires
// `--version` to answer; without stubs this suite would silently depend on a
// dev machine's installs. The manifest hint lists are what is exercised here.
const stubDir = mkdtempSync(join(tmpdir(), "claudexor-model-truth-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function stub(name: string, version: string): string {
  const bin = join(stubDir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
process.env["CLAUDEXOR_CODEX_BIN"] = stub("codex", "codex-cli 0.0.0-stub");
process.env["CLAUDEXOR_AGY_BIN"] = stub("agy", "agy 0.0.0-stub");
// grok's stub answers only `--version`; an unscoped listing must never spawn
// `grok models` (there is no default account to run it under).
process.env["CLAUDEXOR_GROK_BIN"] = stub("grok", "grok 0.0.0-stub");
// claude's stub answers `--version`, and the model probe's `-p …` argv only
// while an `answer` file sits beside it (rewriting the stub changes its
// identity, so the probe cache re-reads it — no module reset needed).
const claudeBin = stub("claude", "0.0.0-stub (Claude Code)");
const PICKER_LINE = JSON.stringify({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "req_claudexor_init",
    response: {
      models: [{ value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" }],
    },
  },
});
function claudeStubAnswers(picker: boolean): void {
  writeFileSync(
    claudeBin,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "0.0.0-stub (Claude Code)" ;;\n  -p) ${picker ? `cat <<'CLAUDE_STUB_EOF'\n${PICKER_LINE}\nCLAUDE_STUB_EOF\n` : "exit 1\n"} ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(claudeBin, 0o755);
}
process.env["CLAUDEXOR_CLAUDE_BIN"] = claudeBin;
const {
  buildRegistry,
  checkHarnessModel,
  checkHarnessModelTruth,
  harnessModelTruth,
  harnessModels,
} = await import("./registry.js");
const { noModelListLine } = await import("./cli-io.js");

describe("harness model truth = list + declaration (the ONE settings/doctor/catalog gate, INV-104)", () => {
  it("codex: an unlisted model is admitted with the note (advisory), a listed one silently", async () => {
    const truth = await harnessModelTruth("codex", process.cwd(), true);
    expect(truth.absence).toBe("advisory");
    // The unscoped query reads the manifest hints (the live producer is native-route only).
    expect(truth.response.source).toBe("manifest");
    expect(truth.response).toEqual(await harnessModels("codex", process.cwd(), true));
    expect(checkHarnessModelTruth(truth, "gpt-ghost-9000")).toEqual({
      status: "ok",
      unverified: true,
      message: expect.stringMatching(
        /^model "gpt-ghost-9000" is not in this harness's manifest known-model list; .*forwarded to the vendor$/,
      ),
    });
    expect(checkHarnessModelTruth(truth, "gpt-5.5")).toEqual({ status: "ok", message: null });
  }, 30_000);

  it("agy: an unlisted explicit model is disclosed and forwarded, a listed hint passes", async () => {
    const { truth, check } = await checkHarnessModel(
      "agy",
      "ghost-model-9000",
      process.cwd(),
      true,
    );
    expect(truth.source).toBe("manifest");
    expect(check).toMatchObject({ status: "ok", unverified: true });
    expect(check.message).toContain("forwarded to the vendor");
    expect(
      (await checkHarnessModel("agy", "gemini-3.7-flash-high", process.cwd(), true)).check,
    ).toEqual({ status: "ok", message: null });
  }, 30_000);

  it("claude: a probe that could not read the binary reports manifest truth; a live answer reports api", async () => {
    claudeStubAnswers(false);
    const unread = await harnessModelTruth("claude", process.cwd(), true);
    expect(unread.absence).toBe("advisory");
    expect(unread.response.source).toBe("manifest");
    expect(unread.response.verifiedAgainst).toBe("2.1.261");
    expect(unread.response.models.length).toBeGreaterThan(0);
    expect(unread.response.models.every((row) => row.origin === "hint")).toBe(true);
    // Advisory: an id the hints lack is admitted with the note, never refused.
    expect(checkHarnessModelTruth(unread, "claude-opus-5-5")).toMatchObject({
      status: "ok",
      unverified: true,
    });

    claudeStubAnswers(true);
    const live = await harnessModelTruth("claude", process.cwd(), true);
    expect(live.response.source).toBe("api");
    expect(live.response.verifiedAgainst).toBeNull();
    expect(live.response.models.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "opus", origin: "live", resolved_model: "claude-opus-5-5" }),
      expect.objectContaining({ id: "claude-opus-5-5", origin: "live" }),
    ]);
    expect(live.response.models.some((row) => row.origin === "hint")).toBe(true);
    // Presence is proof on the live side too: nothing to disclose.
    expect(checkHarnessModelTruth(live, "claude-opus-5-5")).toEqual({
      status: "ok",
      message: null,
    });
  }, 30_000);

  it("grok: an account-less listing claims no live catalog; an explicit model is forwarded", async () => {
    // Unscoped, and explicitly on the subscription route: neither names an
    // account, so neither may answer an empty `api` catalog.
    expect(
      (await harnessModelTruth("grok", process.cwd(), false, "local_session")).response,
    ).toEqual({ harnessId: "grok", models: [], source: "none", verifiedAgainst: null });
    const truth = await harnessModelTruth("grok", process.cwd());
    expect(truth.response).toEqual({
      harnessId: "grok",
      models: [],
      source: "none",
      verifiedAgainst: null,
    });
    expect(truth.absence).toBe("advisory");
    expect(checkHarnessModelTruth(truth, "grok-4.7")).toMatchObject({
      status: "ok",
      unverified: true,
    });
  });

  it("grok: `claudexor models` says no account was selected, not that Grok cannot list models", async () => {
    // The status rows `claudexor models` reads carry each harness's manifest.
    const statuses = await Promise.all(
      ["grok", "codex"].map(async (id) => ({
        id,
        manifest: await buildRegistry().get(id)!.discover(),
      })),
    );
    for (const route of [undefined, "local_session"] as const) {
      const truth = await harnessModelTruth("grok", process.cwd(), false, route);
      expect(truth.response.source).toBe("none");
      expect(noModelListLine("grok", statuses, route)).toBe(
        "grok: no account selected (models are listed per named account)",
      );
    }
    // Controls: a harness without a per-account inventory or without a
    // manifest, a harness with a default account, and the API-key route Grok
    // does not serve keep the plain wording.
    const plain = "no model enumeration (adapter cannot list models)";
    expect(noModelListLine("cursor", [{ id: "cursor", manifest: null }], undefined)).toBe(
      `cursor: ${plain}`,
    );
    expect(noModelListLine("codex", statuses, "local_session")).toBe(`codex: ${plain}`);
    expect(noModelListLine("grok", statuses, "api_key")).toBe(`grok: ${plain}`);
  });

  it("agy: the same route keeps its non-empty manifest hints (control)", async () => {
    const truth = await harnessModelTruth("agy", process.cwd(), false, "local_session");
    expect(truth.response.source).toBe("manifest");
    expect(truth.response.models.length).toBeGreaterThan(0);
  });

  it("an unknown harness id has no truth at all and refuses every explicit model", async () => {
    const { truth, check } = await checkHarnessModel("no-such-harness", "anything", process.cwd());
    expect(truth).toEqual({
      harnessId: "no-such-harness",
      models: [],
      source: "none",
      verifiedAgainst: null,
    });
    expect(check.status).toBe("rejected");
  });
});
