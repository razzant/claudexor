/**
 * The client version the Codex HTTP transport declares on a catalog read
 * (issue #339): the transport's own verified level, raised to a newer installed
 * CLI, never lowered, never an unparseable string, memoised per binary identity.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HTTP_CLIENT_VERSION,
  codexCatalogClientVersion,
  codexVersionTriple,
  describeCodexClientVersion,
} from "./http-client-version.js";
import { observeHarnessProgram } from "@claudexor/core";
import { CODEX_PROGRAM } from "./program.js";
import { CODEX_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

describe("codexVersionTriple", () => {
  it.each([
    ["codex-cli 0.156.1", [0, 156, 1]],
    ["codex-cli 0.157.0-alpha.3", [0, 157, 0]],
    ["1.2.3", [1, 2, 3]],
  ])("reads the first strict major.minor.patch token of %j", (text, triple) => {
    expect(codexVersionTriple(text)).toEqual(triple);
  });
  it.each(["codex (version unknown)", "", null, undefined, "v1.2", "1.2.3.4"])(
    "refuses %j, because client_version is a required query parameter",
    (text) => {
      expect(codexVersionTriple(text as string | null | undefined)).toBeNull();
    },
  );
});

describe("codexCatalogClientVersion", () => {
  let dir: string;
  let bin: string;
  const env = () => ({ PATH: "" }) as NodeJS.ProcessEnv;
  const stub = (marker: string): void => {
    writeFileSync(bin, `#!/bin/sh\necho ${marker}\n`);
    chmodSync(bin, 0o755);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-http-client-version-"));
    bin = join(dir, "codex");
    stub("stub");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("declares the verified transport level as its own constant, separate from the installer pin", () => {
    expect(CODEX_HTTP_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The two constants may coincide in a given release, but the URL must never
    // read the installer pin: the catalog is about what the TRANSPORT verified.
    expect(codexVersionTriple(CODEX_HTTP_CLIENT_VERSION)).not.toBeNull();
    expect(codexVersionTriple(CODEX_VENDOR_CLI_VERSION)).not.toBeNull();
  });

  it("raises the declared version to a NEWER installed CLI and names that source", async () => {
    const declared = await codexCatalogClientVersion({
      bin,
      env: env(),
      detectVersion: async () => "codex-cli 9.0.1-alpha.2",
    });
    expect(declared).toMatchObject({ version: "9.0.1", source: "installed_cli" });
  });

  it.each(["codex-cli 0.1.0", "codex (version unknown)", null])(
    "never drops below the verified level (installed %j)",
    async (reported) => {
      const declared = await codexCatalogClientVersion({
        bin,
        env: env(),
        detectVersion: async () => reported,
      });
      expect(declared).toMatchObject({
        version: CODEX_HTTP_CLIENT_VERSION,
        source: "verified_transport",
      });
    },
  );

  it("declares the verified level when no runnable CLI resolves, without spawning", async () => {
    let spawned = 0;
    const declared = await codexCatalogClientVersion({
      bin: join(dir, "missing"),
      env: env(),
      detectVersion: async () => {
        spawned += 1;
        return "codex-cli 9.0.0";
      },
    });
    expect(declared.source).toBe("verified_transport");
    expect(spawned).toBe(0);
  });

  it("reuses the real wrapper answer until a fresh observation supplies another version or failure", async () => {
    const target = join(dir, "reported-version");
    writeFileSync(target, "codex-cli 9.0.0");
    writeFileSync(bin, `#!/bin/sh\n/bin/cat '${target}'\n`);
    const deps = { bin, env: env() };
    expect((await codexCatalogClientVersion(deps)).version).toBe("9.0.0");
    writeFileSync(target, "codex-cli 9.1.0");
    expect((await codexCatalogClientVersion(deps)).version).toBe("9.0.0");
    await observeHarnessProgram(CODEX_PROGRAM, env(), bin, { fresh: true });
    expect(await codexCatalogClientVersion(deps)).toMatchObject({
      version: "9.1.0",
      program: { path: bin, version: "9.1.0" },
    });
    writeFileSync(target, "");
    await observeHarnessProgram(CODEX_PROGRAM, env(), bin, { fresh: true });
    expect((await codexCatalogClientVersion(deps)).source).toBe("verified_transport");
  });
  it("honors injected version answers, including detection failure", async () => {
    const answers = ["codex-cli 9.0.0", "codex-cli 9.1.0", null, "codex-cli 9.2.0"];
    const deps = { bin, env: env(), detectVersion: async () => answers.shift() ?? null };
    expect((await codexCatalogClientVersion(deps)).version).toBe("9.0.0");
    expect((await codexCatalogClientVersion(deps)).version).toBe("9.1.0");
    expect((await codexCatalogClientVersion(deps)).source).toBe("verified_transport");
    expect((await codexCatalogClientVersion(deps)).version).toBe("9.2.0");
  });
});

describe("describeCodexClientVersion", () => {
  it("phrases the declared version and its source, and says when a catalog predates the field", () => {
    expect(
      describeCodexClientVersion({
        clientVersion: "0.156.1",
        clientVersionSource: "verified_transport",
      }),
    ).toBe(
      "client_version 0.156.1 (the version this Claudexor release verified its Codex HTTP transport against)",
    );
    expect(
      describeCodexClientVersion({
        clientVersion: "0.170.0",
        clientVersionSource: "installed_cli",
      }),
    ).toBe("client_version 0.170.0 (the installed Codex CLI)");
    expect(describeCodexClientVersion({ clientVersion: null, clientVersionSource: null })).toBe(
      "an undeclared client_version (catalog from an older engine)",
    );
  });
});
