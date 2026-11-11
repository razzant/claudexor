import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProfile } from "@claudexor/schema";
import { readCursorDashboard } from "./quota.js";
const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function store(sub = "fixture", cachedSub = sub, platform: NodeJS.Platform = process.platform) {
  const root = mkdtempSync(join(process.env.CLAUDEXOR_CONFIG_DIR!, "cursor-dashboard-"));
  roots.push(root);
  mkdirSync(join(root, ".cursor"));
  const authDir =
    platform === "win32"
      ? join(root, "AppData", "Roaming", "Cursor")
      : platform === "darwin"
        ? join(root, ".cursor")
        : join(root, ".config", "cursor");
  mkdirSync(authDir, { recursive: true });
  const token = `fixture.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.fixture`;
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ accessToken: token }));
  writeFileSync(
    join(root, ".cursor", "cli-config.json"),
    JSON.stringify({ authInfo: { authId: cachedSub } }),
  );
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    display_name: "fixture",
    harness_id: "cursor",
    credential_kind: "config_dir_login",
    isolation_locator: root,
  });
  return { root, profile, token, authPath: join(authDir, "auth.json") };
}
describe("Cursor scoped dashboard transport (synthetic auth only)", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "reads %s vendor file-store layout within the named HOME only (source-derived, not native qualification)",
    async (platform) => {
      const { profile, token, authPath } = store("fixture", "fixture", platform);
      const before = readFileSync(authPath);
      const request = vi.fn<typeof fetch>(
        async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
      );
      await readCursorDashboard(profile, request, platform);
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]![1]?.headers).toMatchObject({
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent("fixture::" + token)}`,
      });
      expect(readFileSync(authPath)).toEqual(before);
    },
  );
  it("sends one same-origin request with its own bound subject and never changes auth", async () => {
    const { profile, token, authPath } = store();
    const before = readFileSync(authPath);
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ individualUsage: {} }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await readCursorDashboard(profile, request);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe("https://cursor.com/api/usage-summary");
    expect(request.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      headers: { Cookie: `WorkosCursorSessionToken=${encodeURIComponent("fixture::" + token)}` },
    });
    expect(readFileSync(authPath)).toEqual(before);
  });
  it("mismatched/unrecognized identity does not send, refresh, or login", async () => {
    const { profile } = store("one", "two");
    const request = vi.fn<typeof fetch>();
    await expect(readCursorDashboard(profile, request)).rejects.toThrow(
      "credential_binding_unavailable",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects unauthorized/redirect/content errors without retaining vendor bodies", async () => {
    const { profile, token } = store();
    for (const response of [
      new Response(token, { status: 401 }),
      new Response(token, { status: 302 }),
      new Response(token, { headers: { "content-type": "text/html" } }),
    ]) {
      await expect(readCursorDashboard(profile, async () => response)).rejects.toThrow(
        /^cursor_dashboard_/,
      );
    }
    await expect(
      readCursorDashboard(profile, async () => {
        throw new Error(token);
      }),
    ).rejects.toThrow("cursor_dashboard_transport_failed");
  });
});
