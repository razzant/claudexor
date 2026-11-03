import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONPTY_HELPER_ARCHITECTURE,
  CONPTY_HELPER_PROTOCOL,
  createConptyControlParser,
  resolvePtyWrappedCommand,
} from "./setup-login-pty.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudexor-conpty-resolver-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("setup login terminal transport resolver", () => {
  it("requires a bounded successful ConPTY probe before returning the exact wrapper", async () => {
    const probes: string[] = [];
    const resolved = await resolvePtyWrappedCommand(
      "C:\\Program Files\\Vendor\\agy.exe",
      ["login", "space value", 'quote"value', "trail\\"],
      {
        platform: "win32",
        helperPath: "C:\\runtime\\native\\claudexor-conpty-helper.exe",
        inspectExecutable: async () => "regular_executable",
        probeConpty: async (path) => {
          probes.push(path);
          return "ready";
        },
      },
    );

    expect(probes).toEqual(["C:\\runtime\\native\\claudexor-conpty-helper.exe"]);
    expect(resolved).toEqual({
      status: "ready",
      backend: "windows_conpty",
      command: {
        binary: "C:\\runtime\\native\\claudexor-conpty-helper.exe",
        args: [
          "--",
          "C:\\Program Files\\Vendor\\agy.exe",
          "login",
          "space value",
          'quote"value',
          "trail\\",
        ],
      },
      helperControlStderr: true,
    });
  });

  it.each([
    ["unsupported", "terminal_transport_unsupported", "unsupported"],
    ["failed", "terminal_transport_probe_failed", "probe_failed"],
  ] as const)("maps a %s probe to the frozen typed outcome", async (probe, errorCode, status) => {
    const resolved = await resolvePtyWrappedCommand("C:\\private\\vendor.exe", ["secret-arg"], {
      platform: "win32",
      helperPath: "C:\\private\\helper.exe",
      inspectExecutable: async () => "regular_executable",
      probeConpty: async () => probe,
    });
    expect(resolved).toMatchObject({ status, backend: "windows_conpty", errorCode });
    if (resolved.status === "ready") throw new Error("failure probe unexpectedly resolved ready");
    expect(resolved.detail).not.toContain("private");
    expect(resolved.detail).not.toContain("secret-arg");
  });

  it("treats an absent or irregular adjacent helper as unavailable without probing", async () => {
    let probes = 0;
    for (const inspection of ["missing", "invalid"] as const) {
      const resolved = await resolvePtyWrappedCommand("C:\\vendor.exe", [], {
        platform: "win32",
        helperPath: "C:\\runtime\\helper.exe",
        inspectExecutable: async () => inspection,
        probeConpty: async () => {
          probes += 1;
          return "ready";
        },
      });
      expect(resolved).toMatchObject({
        status: "unavailable",
        errorCode: "terminal_transport_unavailable",
      });
    }
    expect(probes).toBe(0);
  });

  it("keeps POSIX vendor diagnostics on stderr and preserves exact expect/script commands", async () => {
    const expectResolution = await resolvePtyWrappedCommand("/opt/a gy", ["login"], {
      platform: "darwin",
      inspectExecutable: async (path) =>
        path === "/usr/bin/expect" ? "regular_executable" : "missing",
    });
    expect(expectResolution).toMatchObject({
      status: "ready",
      backend: "expect",
      helperControlStderr: false,
    });
    if (expectResolution.status !== "ready") throw new Error("expect did not resolve");
    expect(expectResolution.command.args[1]).toContain("spawn -noecho {/opt/a gy} {login}");

    const scriptResolution = await resolvePtyWrappedCommand("/opt/agy", ["it's", "ok"], {
      platform: "linux",
      inspectExecutable: async (path) =>
        path === "/usr/bin/script" ? "regular_executable" : "missing",
    });
    expect(scriptResolution).toMatchObject({
      status: "ready",
      backend: "script",
      helperControlStderr: false,
    });
    if (scriptResolution.status !== "ready") throw new Error("script did not resolve");
    expect(scriptResolution.command.args).toEqual([
      "-e",
      "-q",
      "-c",
      `'\/opt\/agy' 'it'\"'\"'s' 'ok'`.replaceAll("\\/", "/"),
      "/dev/null",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "executes the real probe contract instead of trusting executable presence",
    async () => {
      const helper = join(root, "fake-conpty-helper");
      writeFileSync(
        helper,
        `#!/bin/sh\n[ "$1" = "--probe" ] || exit 2\nprintf '${CONPTY_HELPER_PROTOCOL}\\t${CONPTY_HELPER_ARCHITECTURE}\\n'\n`,
        { mode: 0o700 },
      );
      chmodSync(helper, 0o700);
      expect(
        await resolvePtyWrappedCommand("/vendor", [], {
          platform: "win32",
          helperPath: helper,
        }),
      ).toMatchObject({ status: "ready", backend: "windows_conpty" });

      writeFileSync(
        helper,
        `#!/bin/sh\nprintf '${CONPTY_HELPER_PROTOCOL}\\terror\\t1\\t127\\n' >&2\nexit 3\n`,
        { mode: 0o700 },
      );
      const unsupported = await resolvePtyWrappedCommand("/private/vendor", ["secret"], {
        platform: "win32",
        helperPath: helper,
      });
      expect(unsupported).toEqual({
        status: "unsupported",
        backend: "windows_conpty",
        errorCode: "terminal_transport_unsupported",
        detail: "terminal transport is unsupported on this host",
      });

      for (const source of [
        "#!/bin/sh\nexit 3\n",
        `#!/bin/sh\nprintf 'wrong-helper-v1\\terror\\t1\\t127\\n' >&2\nexit 3\n`,
        `#!/bin/sh\nprintf '${CONPTY_HELPER_PROTOCOL}\\terror\\t2\\t127\\n' >&2\nexit 3\n`,
        `#!/bin/sh\nprintf '${CONPTY_HELPER_PROTOCOL}\\terror\\t1\\tnot-a-code\\n' >&2\nexit 3\n`,
        `#!/bin/sh\nprintf 'unexpected-stdout\\n'\nprintf '${CONPTY_HELPER_PROTOCOL}\\terror\\t1\\t127\\n' >&2\nexit 3\n`,
      ]) {
        writeFileSync(helper, source, { mode: 0o700 });
        const malformed = await resolvePtyWrappedCommand("/private/vendor", ["secret"], {
          platform: "win32",
          helperPath: helper,
        });
        expect(malformed).toEqual({
          status: "probe_failed",
          backend: "windows_conpty",
          errorCode: "terminal_transport_probe_failed",
          detail: "terminal transport capability probe failed",
        });
      }

      writeFileSync(helper, "#!/bin/sh\nprintf 'wrong-version\\n'\n", { mode: 0o700 });
      expect(
        await resolvePtyWrappedCommand("/vendor", [], {
          platform: "win32",
          helperPath: helper,
        }),
      ).toMatchObject({
        status: "probe_failed",
        errorCode: "terminal_transport_probe_failed",
      });

      const irregular = join(root, "helper-directory");
      mkdirSync(irregular);
      expect(
        await resolvePtyWrappedCommand("/vendor", [], {
          platform: "win32",
          helperPath: irregular,
        }),
      ).toMatchObject({ status: "unavailable" });
    },
  );
});

describe("ConPTY helper control parser", () => {
  it("accepts fragmented started/error frames without exposing raw control bytes", () => {
    const parser = createConptyControlParser();
    parser.push(Buffer.from(`${CONPTY_HELPER_PROTOCOL}\tstar`));
    parser.push(Buffer.from(`ted\t5432\r\n${CONPTY_HELPER_PROTOCOL}\terror\t8\t109\n`));
    expect(parser.finish()).toEqual({
      started: true,
      childPid: 5432,
      error: { phase: 8, code: 109 },
      malformed: false,
    });
    expect(parser.finish()).not.toHaveProperty("raw");
  });

  it.each([
    [Buffer.alloc(17, 0x41), 16],
    [Buffer.from("not-the-protocol\n"), 4096],
    [Buffer.from(`${CONPTY_HELPER_PROTOCOL}\terror\t0\t1\n`), 4096],
    [
      Buffer.from(`${CONPTY_HELPER_PROTOCOL}\tstarted\t1\n${CONPTY_HELPER_PROTOCOL}\tstarted\t2\n`),
      4096,
    ],
    [Buffer.alloc(0), 4096],
  ])("fails closed on bounded or malformed control input", (input, limit) => {
    const parser = createConptyControlParser(limit);
    parser.push(input);
    expect(parser.finish().malformed).toBe(true);
  });
});
