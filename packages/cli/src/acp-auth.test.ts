import { describe, expect, it } from "vitest";
import { acpTerminalAuthMethods, resolveAcpTerminalAuthHarness } from "./acp-auth.js";

describe("experimental ACP Terminal Auth", () => {
  it.each(["darwin", "linux"] as const)("advertises the proven Codex flow on %s", (platform) => {
    expect(acpTerminalAuthMethods(platform)).toEqual([
      expect.objectContaining({
        type: "terminal",
        id: "codex",
        args: ["auth", "login", "codex"],
      }),
    ]);
  });

  it("does not claim support on an unproven platform", () => {
    expect(acpTerminalAuthMethods("win32")).toEqual([]);
    expect(resolveAcpTerminalAuthHarness(["auth", "login", "codex"], "win32")).toBeNull();
  });

  it("decodes only the exact allowlisted suffix", () => {
    expect(resolveAcpTerminalAuthHarness(["auth", "login", "codex"], "darwin")).toBe("codex");
    expect(resolveAcpTerminalAuthHarness(["auth", "login", "claude"], "darwin")).toBeNull();
    expect(resolveAcpTerminalAuthHarness(["auth", "login", "codex", "extra"], "linux")).toBeNull();
    expect(resolveAcpTerminalAuthHarness(["auth", "logout", "codex"], "linux")).toBeNull();
  });
});
