import type { AdapterRegistry } from "@claudex/core";
import { createFakeHarness, FAKE_KINDS } from "@claudex/harness-fake";

/**
 * Build the adapter registry. Phase 0 registers the fake-harness suite; later
 * phases replace this with real adapter discovery (Codex/Claude/Cursor/OpenCode)
 * gated by `claudex doctor` conformance.
 */
export function buildRegistry(): AdapterRegistry {
  const registry: AdapterRegistry = new Map();
  for (const kind of FAKE_KINDS) {
    registry.set(kind, createFakeHarness(kind));
  }
  return registry;
}
