/** Candidate-harness membership shared by requirements admission and execution. */
import type { GlobalConfig, Intent, RouteDropStage } from "@claudexor/schema";
import {
  AccessProfileIncompatibleError,
  AuxiliaryWritableRootsUnsupportedError,
  HarnessUnavailableError,
  ModelSelectionRequiredError,
  type AdapterRegistry,
} from "@claudexor/core";
import type { HarnessStatus } from "@claudexor/gateway";
import { accountPoolRows } from "./account-pool.js";

/** Preserve ordinary admission refusal precedence before Browser projection. */
export function assertCandidatePoolAvailable(
  pool: unknown[],
  intent: Intent,
  droppedLanes: { harnessId: string; stage: RouteDropStage; detail: string }[],
  auxiliaryUnsupported: Set<string>,
): void {
  if (pool.length > 0) return;
  const details = droppedLanes.map((lane) => lane.detail).join(", ");
  if (
    droppedLanes.length > 0 &&
    droppedLanes.every((lane) => auxiliaryUnsupported.has(lane.harnessId))
  )
    throw new AuxiliaryWritableRootsUnsupportedError(
      `no harness can apply the requested auxiliary writable roots (${details})`,
    );
  if (droppedLanes.length > 0 && droppedLanes.every((lane) => lane.stage === "access"))
    throw new AccessProfileIncompatibleError(
      `no harness can enforce the requested access profile (${details})`,
    );
  if (droppedLanes.length > 0 && droppedLanes.every((lane) => lane.stage === "model"))
    throw new ModelSelectionRequiredError(details);
  throw new HarnessUnavailableError(
    `no harness can perform '${intent}' for this mode${details ? ` (skipped: ${details})` : ""}`,
  );
}

export function resolveCandidateHarnessIds(args: {
  harnesses?: string[];
  credentialProfileId?: string | null;
  config: GlobalConfig;
  registry: AdapterRegistry;
  statuses: Array<
    Pick<HarnessStatus, "id" | "status" | "enabledIntents"> &
      Partial<Pick<HarnessStatus, "manifest">>
  >;
  intent: Intent;
}): string[] {
  const { config, registry, statuses, intent } = args;
  const input = args;
  const disabledHarnessIds = new Set(
    Object.entries(config.harnesses)
      .filter(([, settings]) => settings.enabled === false)
      .map(([id]) => id),
  );
  let ids = args.harnesses;
  if (!ids || ids.length === 0) {
    // INV-135: a profile names its enabled harness(es); its scoped probe is
    // authoritative even when the default store is logged out.
    const profilePool = input.credentialProfileId
      ? [
          ...new Set(
            (config.credential_profiles ?? [])
              .filter((p) => p.enabled && p.profile_id === input.credentialProfileId)
              .map((p) => p.harness_id)
              .filter((hid) => !disabledHarnessIds.has(hid) && registry.has(hid)),
          ),
        ]
      : [];
    if (profilePool.length > 0) {
      ids = profilePool;
    } else if (input.credentialProfileId) {
      // A named unknown/disabled profile refuses here; it never falls
      // through and runs on default credentials.
      const registered = (config.credential_profiles ?? []).filter(
        (p) => p.profile_id === input.credentialProfileId,
      );
      throw new HarnessUnavailableError(
        registered.length === 0
          ? `credential profile "${input.credentialProfileId}" is not registered (see \`claudexor profiles list\`)`
          : registered.every((p) => !p.enabled)
            ? `credential profile "${input.credentialProfileId}" is disabled`
            : `credential profile "${input.credentialProfileId}" belongs to unavailable harness(es): ${registered.map((p) => p.harness_id).join(", ")}`,
      );
    } else {
      // Auto-pools take doctor-OK default routes (BIBLE §2: doctor decides
      // default-route readiness; a key string or degraded route is visible
      // but not routable) PLUS harnesses with enabled account rows: the default
      // doctor only sees the default store, and a signed-in registry row is
      // invisible to it (cursor after the host-Keychain retirement, or a
      // named-rows-only claude/codex install). Row-bearing lanes still pass
      // execution's per-lane row probe before they are admitted.
      const registry = config.credential_profiles ?? [];
      ids = statuses
        .filter(
          (s) =>
            s.manifest?.kind !== "fake" &&
            ((s.status === "ok" && s.enabledIntents.includes(intent)) ||
              accountPoolRows(registry, s.id).length > 0),
        )
        .map((s) => s.id);
      if (ids.length === 0) {
        throw new HarnessUnavailableError(
          "no doctor-OK default route or enabled account row for this mode; inspect `claudexor doctor` and `claudexor accounts`, or pass --harness explicitly",
        );
      }
    }
  }
  return ids;
}
