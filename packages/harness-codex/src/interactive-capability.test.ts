import { expect, it } from "vitest";
import { createCodexAdapter } from "./index.js";

it.each([true, false])(
  "declares interactive only for app-server transport: %s",
  async (appServer) => {
    const adapter = createCodexAdapter({
      detectVersion: async () => "fixture",
      hasApiKey: () => false,
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      probeEfforts: async () => null,
      ...(appServer ? {} : { runCliHarness: async function* () {} }),
    });
    expect((await adapter.discover()).capabilities.interactive).toBe(appServer);
  },
);
