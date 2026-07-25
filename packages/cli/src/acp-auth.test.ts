import { describe, expect, it } from "vitest";
import { ACP_SERVE_USAGE, acpTerminalAuthMethods, resolveAcpServeAuthHarness } from "./acp-auth.js";

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
    expect(
      resolveAcpServeAuthHarness(["acp", "serve", "auth", "login", "codex"], "win32"),
    ).toBeNull();
  });

  it("decodes only the exact full allowlisted command", () => {
    expect(resolveAcpServeAuthHarness(["acp", "serve", "auth", "login", "codex"], "darwin")).toBe(
      "codex",
    );
    expect(
      resolveAcpServeAuthHarness(["acp", "serve", "auth", "login", "claude"], "darwin"),
    ).toBeNull();
    expect(
      resolveAcpServeAuthHarness(["acp", "serve", "auth", "login", "codex", "extra"], "linux"),
    ).toBeNull();
    expect(
      resolveAcpServeAuthHarness(["acp", "serve", "auth", "logout", "codex"], "linux"),
    ).toBeNull();
    expect(ACP_SERVE_USAGE).toBe("serve [auth login codex]");
  });
});
