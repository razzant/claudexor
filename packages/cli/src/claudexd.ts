#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudex/daemon";
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
    runner: async (params) => {
      const p = (params ?? {}) as any;
      return orchestrator.run({
        repoRoot: p.repoRoot ?? process.cwd(),
        prompt: String(p.prompt ?? ""),
        mode: p.mode,
        harnesses: p.harnesses,
        n: p.n,
        attempts: p.attempts ?? null,
      });
    },
  });

  await server.start();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd listening on ${socketPath}\n`);
  await server.waitForShutdown();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd shut down\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexd: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
