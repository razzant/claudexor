import type { AdapterRegistry } from "@claudexor/core";
import { HarnessGateway } from "@claudexor/gateway";
import { createClaudeAdapter } from "@claudexor/harness-claude";
import { createCodexAdapter } from "@claudexor/harness-codex";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { FAKE_KINDS, createFakeHarness } from "@claudexor/harness-fake";
import { createOpenCodeAdapter } from "@claudexor/harness-opencode";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";

export interface RegistryOptions {
  /** Register the fake-harness suite (so `--harness fake-*` works). Default true. */
  includeFakes?: boolean;
}

/**
 * Build the adapter registry. Real adapters (Codex/Claude; Cursor/OpenCode in
 * later phases) are always registered; the gateway only selects available
 * non-fake harnesses by default. Fakes are registered for explicit `--harness`.
 */
export function buildRegistry(opts: RegistryOptions = {}): AdapterRegistry {
  const registry: AdapterRegistry = new Map();
  for (const adapter of [
    createCodexAdapter(),
    createClaudeAdapter(),
    createCursorAdapter(),
    createOpenCodeAdapter(),
    createRawApiAdapter(),
  ]) {
    registry.set(adapter.id, adapter);
  }
  if (opts.includeFakes !== false) {
    for (const kind of FAKE_KINDS) registry.set(kind, createFakeHarness(kind));
  }
  return registry;
}

export function buildGateway(opts: RegistryOptions = {}): HarnessGateway {
  return new HarnessGateway(buildRegistry(opts));
}
