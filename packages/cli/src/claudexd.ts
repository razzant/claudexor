#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient, DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudex/daemon";
import { DaemonControlApiServer } from "@claudex/control-api";
import { Orchestrator } from "@claudex/orchestrator";
import { buildRegistry } from "./registry.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main(): Promise<void> {
  mkdirSync(daemonDir(), { recursive: true });
  const token = ensureToken();
  const socketPath = defaultSocketPath();
  const orchestrator = new Orchestrator({ registry: buildRegistry() });

  const server = new DaemonServer({
    socketPath,
    token,
    // Durable run registry so the run list survives a daemon/Mac restart.
    persistPath: join(daemonDir(), "jobs.json"),
    runner: async (params, ctx) => {
      const p = (params ?? {}) as any;
      return orchestrator.run({
        repoRoot: p.repoRoot ?? process.cwd(),
        prompt: String(p.prompt ?? ""),
        mode: p.mode,
        harnesses: p.harnesses,
        n: p.n,
        attempts: p.attempts ?? null,
        signal: ctx.signal,
        onRunStart: ctx.onRunStart,
      });
    },
  });

  await server.start();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd listening on ${socketPath}\n`);
  const control =
    process.env.CLAUDEX_NO_CONTROL_API === "1"
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: new DaemonClient(socketPath, token),
          port: Number(process.env.CLAUDEX_CONTROL_PORT ?? 0),
        });
  if (control) {
    const controlAddr = await control.start();
    writeFileSync(
      join(daemonDir(), "control-api.json"),
      JSON.stringify({ ...controlAddr, tokenPath: join(daemonDir(), "token") }, null, 2) + "\n",
      { mode: 0o600 },
    );
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudex control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`);
  } else {
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudex control-api disabled by CLAUDEX_NO_CONTROL_API=1\n`);
  }
  await server.waitForShutdown();
  await control?.stop();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd shut down\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexd: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
