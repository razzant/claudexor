import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateModel } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";
import { claudexorOwnedRoot } from "@claudexor/util";
import { createAgyAdapter } from "./index.js";
import { parseAgyModelList } from "./models.js";

const captured = readFileSync(
  fileURLToPath(new URL("../fixtures/models.tsv", import.meta.url)),
  "utf8",
);
const originalBin = process.env.CLAUDEXOR_AGY_BIN;
const roots: string[] = [];
afterEach(() => {
  if (originalBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
  else process.env.CLAUDEXOR_AGY_BIN = originalBin;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function fixture(script: string) {
  const parent = join(claudexorOwnedRoot(), "profiles");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "agy-models-"));
  roots.push(root);
  const bin = join(root, "fake-agy");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.CLAUDEXOR_AGY_BIN = bin;
  const profile = (id: string): CredentialProfile => {
    const home = join(root, id);
    mkdirSync(home);
    return {
      profile_id: id,
      harness_id: "agy",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: home,
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
  };
  return { root, bin, profile };
}

const adapter = () => createAgyAdapter({ prepareProfileKeychain: () => undefined });

describe("Antigravity model inventory", () => {
  it("parses the recorded vendor table without inventing context windows", () => {
    const rows = parseAgyModelList(captured);
    expect(rows.map((row) => row.id)).toContain("claude-opus-5-5-high");
    expect(rows.map((row) => row.id)).toContain("claude-sonnet-5-5-low");
    expect(rows.map((row) => row.id)).toContain("gemini-3.8-flash-high");
    expect(rows.every((row) => row.context_window === null && row.origin === "live")).toBe(true);
  });

  it("reads each profile through pipe EOF with self-update disabled and no JSON flag", async () => {
    const { root, profile } = fixture(`
[ "$#" = 1 ] && [ "$1" = models ] || exit 11
[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = true ] || exit 12
[ "$HOME" = "$USERPROFILE" ] || exit 13
[ -z "$GEMINI_API_KEY$GOOGLE_API_KEY" ] || exit 14
if read input; then exit 15; fi
cat "$HOME/models.tsv"
`);
    const a = profile("a"),
      b = profile("b");
    writeFileSync(join(a.isolation_locator!, "models.tsv"), captured);
    writeFileSync(
      join(b.isolation_locator!, "models.tsv"),
      captured.replaceAll("claude-opus-5-5-high", "claude-next-generation-high"),
    );
    const models = adapter().models!;
    const first = await models({
      cwd: root,
      credentialProfile: a,
      env: { GEMINI_API_KEY: "redacted" },
    });
    const second = await models({ cwd: root, credentialProfile: b });
    expect(first.map((row) => row.id)).toContain("claude-opus-5-5-high");
    expect(second.map((row) => row.id)).toContain("claude-next-generation-high");
    expect(second.map((row) => row.id)).not.toContain("claude-opus-5-5-high");
  });

  it("failed, malformed, partial and cancelled reads stay unknown without hint fallback", async () => {
    const { root, profile } = fixture('cat "$HOME/models.tsv"; exit 1');
    const account = profile("a");
    writeFileSync(join(account.isolation_locator!, "models.tsv"), captured);
    expect(await adapter().models!({ cwd: root, credentialProfile: account })).toEqual([]);
    expect(
      await adapter().models!({
        cwd: root,
        credentialProfile: account,
        abortSignal: AbortSignal.abort(),
      }),
    ).toEqual([]);
    for (const malformed of ["", "not a model listing", "{}", `${captured}\ntruncated row`]) {
      expect(parseAgyModelList(malformed)).toEqual([]);
    }
  });

  it("unscoped settings get only historical hints and advisory unknown IDs remain explicit", async () => {
    const { root } = fixture('[ "$1" = --version ] && echo 1.1.13 || exit 99');
    const instance = adapter();
    const manifest = await instance.discover();
    const rows = await instance.models!({ cwd: root });
    expect(rows.every((row) => row.origin === "hint")).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(["claude-sonnet-4-6", "claude-opus-4-6-thinking"]),
    );
    expect(manifest.capabilities.model_inventory_absence).toBe("advisory");
    for (const model of ["claude-opus-5-5-high", "claude-sonnet-5-5-medium", "vendor-future-id"]) {
      expect(rows.map((row) => row.id)).not.toContain(model);
      expect(
        validateModel(
          model,
          rows.map((row) => row.id),
          "manifest",
          manifest.capabilities.model_inventory_absence!,
        ),
      ).toMatchObject({ status: "ok", unverified: true });
    }
  });
});
