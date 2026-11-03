/** Golden contract for a raw-api model catalog that cannot be read: the built
 * CLI, through its own daemon, names the failed read instead of printing an
 * empty list. Under owner decision A (#393) a settings write of an explicit
 * model is kept with a note that it could not be verified, never a claim that
 * it is absent; a declared refused variant and a rejected key still refuse.
 * Offline: the endpoints are loopback ports, a just-closed one (the read fails
 * at connect) and a local server answering 401. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

/** A loopback port nothing listens on (port 1 would be refused by fetch's
 * blocked-port list before any socket, which is a different failure). */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A loopback endpoint answering every request 401, in its own process: `cli`
 * runs synchronously, so a server in this process could not answer. */
async function rejectingRouter(): Promise<{ port: number; stop: () => void }> {
  const script =
    'import { createServer } from "node:http";' +
    "const server = createServer((_req, res) => { res.statusCode = 401; res.end('invalid key'); });" +
    'server.listen(0, "127.0.0.1", () => console.log(server.address().port));';
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    child.once("exit", (code) => reject(new Error(`401 endpoint exited (${code})`)));
  });
  return { port, stop: () => child.kill() };
}

describe("model catalog canary golden stories", () => {
  it("[INV-104:models-catalog-unavailable] `claudexor models` names a failed catalog read and a settings write keeps the model unverified", async () => {
    const UNREADABLE_ROUTER = {
      OPENROUTER_API_KEY: "canary-placeholder-credential",
      CLAUDEXOR_OPENROUTER_BASE_URL: `http://127.0.0.1:${await closedLoopbackPort()}/api/v1`,
    };
    const text = cli(sb, ["models", "--harness", "openrouter"], { env: UNREADABLE_ROUTER });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(
      "openrouter: model catalog unavailable [source=api] — the live model catalog could not " +
        "be read (network; fetch failed (ECONNREFUSED))",
    );
    expect(text.stdout).not.toContain("0 model(s)");

    const json = cli(sb, ["models", "--harness", "openrouter", "--json"], {
      env: UNREADABLE_ROUTER,
    });
    expect(json.code, json.stderr).toBe(0);
    expect(json.json()).toMatchObject({
      harnesses: [
        {
          harnessId: "openrouter",
          source: "api",
          models: [],
          problem: {
            code: "model_catalog_unavailable",
            retryable: true,
            context: { cause: "network", httpStatus: null },
          },
        },
      ],
    });

    // The capability catalog's text line keeps the failed read too: no count of
    // a catalog that was never read.
    const capabilities = cli(sb, ["capabilities"], { env: UNREADABLE_ROUTER });
    expect(capabilities.code, capabilities.stderr).toBe(0);
    const row = capabilities.stdout.split("\n").find((line) => line.includes(" openrouter: "));
    expect(row).toContain(
      "models=unavailable (api: the live model catalog could not be read (network; fetch failed " +
        "(ECONNREFUSED)))",
    );
    expect(row).not.toContain("models=0");

    const set = cli(sb, ["settings", "set", "harness.openrouter.default_model", "vendor/m"], {
      env: UNREADABLE_ROUTER,
    });
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain(
      "note: harness 'openrouter' defaultModel 'vendor/m' (truth source: api): the live model " +
        "catalog could not be read (network; fetch failed (ECONNREFUSED)), so model " +
        '"vendor/m" could not be verified; it is sent unchanged on the same key and the ' +
        "provider accepts or refuses it",
    );
    expect(set.stdout).not.toContain("is not in the harness's live model inventory");
    const show = cli(sb, ["settings", "show", "--json"], { env: UNREADABLE_ROUTER });
    expect(show.json()).toMatchObject({ harnesses: { openrouter: { defaultModel: "vendor/m" } } });

    // A declared refused variant is refused on the same unreadable catalog.
    const online = cli(
      sb,
      ["settings", "set", "harness.openrouter.default_model", "vendor/m:online", "--json"],
      { env: UNREADABLE_ROUTER },
    );
    expect(online.code).not.toBe(0);
    expect(JSON.parse(online.stdout)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(online.stdout).toContain("carries the :online variant, which this harness refuses");
  });

  it("[INV-104:models-catalog-key-rejected] a settings write refuses typed when the endpoint rejects the key", async () => {
    const { port, stop } = await rejectingRouter();
    try {
      const REJECTING_ROUTER = {
        OPENROUTER_API_KEY: "canary-placeholder-credential",
        CLAUDEXOR_OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      };
      const set = cli(
        sb,
        ["settings", "set", "harness.openrouter.default_model", "vendor/m", "--json"],
        { env: REJECTING_ROUTER },
      );
      expect(set.code).not.toBe(0);
      expect(JSON.parse(set.stdout)).toMatchObject({
        ok: false,
        code: "model_catalog_unavailable",
      });
      expect(set.stdout).toContain("could not be read (auth_rejected; HTTP 401: invalid key)");
      const show = cli(sb, ["settings", "show", "--json"], { env: REJECTING_ROUTER });
      expect(show.stdout).not.toContain("vendor/m");
    } finally {
      stop();
    }
  });
});
