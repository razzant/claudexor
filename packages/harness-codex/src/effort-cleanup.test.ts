import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";
import { clearCodexEffortCache, createCodexAdapter } from "./index.js";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

it.each(
  (["profile", "default"] as const).flatMap((route) =>
    (["reject", "close"] as const).map((exit) => ({ route, exit })),
  ),
)("cleans $route API auth after $exit", async ({ route, exit }) => {
  clearCodexEffortCache();
  vi.stubEnv("OPENAI_API_KEY", "FAKEKEYS-default");
  const generation = vi.fn();
  let home = "";
  const adapter = createCodexAdapter({
    detectVersion: async () => "codex 0.156.1",
    codexApiKey: () => "FAKEKEYS-default",
    resolveProfileSecret: () => "FAKEKEYS-profile",
    probeLogin: async () => {
      throw new Error("API route must not probe login");
    },
    probeEfforts: async (_bin, env) => {
      home = env?.CODEX_HOME as string;
      homes.push(home);
      expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).toEqual({
        auth_mode: "apikey",
        OPENAI_API_KEY: `FAKEKEYS-${route}`,
      });
      return {
        models: { fixture: { levels: ["low", "high"], default: "low" } },
        defaultModel: "fixture",
      };
    },
    runCliHarness: async function* () {
      generation();
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: `cleanup-${route}-${exit}`,
    intent: "explain",
    prompt: "fixture",
    cwd: process.cwd(),
    access: "readonly",
    auth_preference: "api_key",
    model_hint: "fixture",
    effort_hint: exit === "reject" ? "future-unplaced" : "low",
    ...(route === "profile"
      ? {
          credential_profile: CredentialProfile.parse({
            profile_id: "fixture",
            harness_id: "codex",
            display_name: "Fixture",
            credential_kind: "api_key",
            secret_ref: "openai:fixture",
          }),
        }
      : {}),
  });
  const iterator = adapter.run(spec)[Symbol.asyncIterator]();
  const prepared = await iterator.next();
  expect(prepared.value).toMatchObject({
    type: "status",
    effort_resolution: {
      resolution: exit === "reject" ? "rejected" : "exact",
      submitted: exit === "reject" ? null : "low",
    },
  });
  expect(existsSync(join(home, "auth.json"))).toBe(true);
  if (exit === "reject") await expect(iterator.next()).rejects.toThrow(/cannot place/);
  else await iterator.return!();
  expect(generation).not.toHaveBeenCalled();
  expect(existsSync(home)).toBe(false);
});
