import { expect, test, vi } from "vitest";
import { windowsPowerShellEnv, powershellFacts, fetchHandle64 } from "./c672-capture-prep.mjs";

test("windowsPowerShellEnv removes PSModulePath case-insensitively and preserves everything else", () => {
  const source = {
    PSModulePath: "C:\\PS7\\Modules",
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
  };
  const { env, removed } = windowsPowerShellEnv(source);
  expect("PSModulePath" in env).toBe(false);
  expect(env.Path).toBe("C:\\Windows");
  expect(env.SystemRoot).toBe("C:\\Windows");
  expect(removed).toEqual({ PSModulePath: "C:\\PS7\\Modules" });
  // Source is never mutated.
  expect(source.PSModulePath).toBe("C:\\PS7\\Modules");

  // Windows compares names without case: a lower/odd-case key is still removed.
  const odd = windowsPowerShellEnv({ psmodulepath: "a", PSMODULEPATH: "b", Keep: "c" });
  expect(Object.keys(odd.env)).toEqual(["Keep"]);
  expect(odd.removed).toEqual({ psmodulepath: "a", PSMODULEPATH: "b" });
});

test("fetchHandle64 spawns powershell with PSModulePath removed and admits only a valid Microsoft signature", () => {
  const source = { PSModulePath: "C:\\PS7\\Modules", Path: "C:\\Windows" };
  const spawn = vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({
      status: "Valid",
      subject: "CN=Microsoft Corporation, O=Microsoft Corporation",
    }),
    stderr:
      "c672-ps version=5.1.26100.0\nc672-ps edition=Desktop\nc672-ps PSModulePath=C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules\nc672-ps securityModule=3.0.0.0 C:\\...\\Microsoft.PowerShell.Security.psd1",
  }));
  const result = fetchHandle64({
    toolsDir: "T",
    zip: "T\\Handle.zip",
    exe: "T\\handle64.exe",
    source,
    spawn,
  });

  expect(spawn).toHaveBeenCalledTimes(1);
  const [binary, , options] = spawn.mock.calls[0];
  expect(binary).toBe("powershell.exe");
  // The actually invoked env must NOT carry PSModulePath — the regression guard.
  expect(Object.keys(options.env).some((k) => k.toUpperCase() === "PSMODULEPATH")).toBe(false);
  expect(options.env.Path).toBe("C:\\Windows");

  expect(result.handle).toEqual({
    path: "T\\handle64.exe",
    signer: "CN=Microsoft Corporation, O=Microsoft Corporation",
  });
  expect(result.gap).toBe(null);
  expect(result.evidence.removedPsModulePath).toEqual({ PSModulePath: "C:\\PS7\\Modules" });
  expect(result.evidence.facts.securityModule).toMatch(/Microsoft\.PowerShell\.Security/);
});

test("fetchHandle64 returns a gap, not a throw, on a non-Microsoft or failed signature", () => {
  const unsigned = fetchHandle64({
    toolsDir: "T",
    zip: "T\\z",
    exe: "T\\h.exe",
    source: {},
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({ status: "NotSigned", subject: null }),
      stderr: "",
    }),
  });
  expect(unsigned.handle).toBe(null);
  expect(unsigned.gap).toMatch(/not Microsoft-signed|unavailable/);

  const wrongSigner = fetchHandle64({
    toolsDir: "T",
    zip: "T\\z",
    exe: "T\\h.exe",
    source: {},
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({ status: "Valid", subject: "CN=Someone Else" }),
      stderr: "",
    }),
  });
  expect(wrongSigner.handle).toBe(null);
  expect(wrongSigner.gap).toMatch(/not Microsoft-signed|unavailable/);

  const failed = fetchHandle64({
    toolsDir: "T",
    zip: "T\\z",
    exe: "T\\h.exe",
    source: {},
    spawn: () => ({ status: 1, stdout: "", stderr: "download failed" }),
  });
  expect(failed.handle).toBe(null);
  expect(failed.gap).toMatch(/unavailable/);
});

test("powershellFacts parses bounded c672-ps lines only", () => {
  const facts = powershellFacts(
    "noise\nc672-ps version=5.1\nc672-ps edition=Desktop\nc672-ps other=ignored",
  );
  expect(facts).toEqual({ version: "5.1", edition: "Desktop" });
});
