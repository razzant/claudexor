import { CONTINUITY_PROFILE_LOCATOR_ENV, type AdapterRegistry } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import type { DiskRetentionReferences, ProjectThreadPort } from "@claudexor/daemon";
import { type CredentialProfile, type GcHold, type GcNativeHomeReport } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildRegistry } from "./registry.js";
import { collectNativeRunSessions, retainedNativeSessions } from "@claudexor/control-api";

export interface NativeRetentionRequest {
  signal?: AbortSignal;
  /** Borrowed from the enclosing run pass; that caller owns observer cleanup. */
  references?: DiskRetentionReferences;
  dryRun: boolean;
  olderThan: number;
  ignoredRunIds: ReadonlySet<string>;
  ignoredThreadIds: ReadonlySet<string>;
}
export interface NativeRetentionResult {
  reports: GcNativeHomeReport[];
  errors: string[];
  freedBytes: number;
  truncated: boolean;
  heldHomes?: number;
  holds?: GcHold[];
}
export function createNativeHomeRetention(deps: {
  threads: ProjectThreadPort;
  /** Rechecked synchronously before every unlink; inventory never fences admission. */
  isBusy: () => boolean;
  registry?: () => AdapterRegistry;
  profiles?: () => CredentialProfile[];
  maxDeletions?: number;
}): (request: NativeRetentionRequest) => Promise<NativeRetentionResult> {
  return async (request) => {
    const result: NativeRetentionResult = {
      reports: [],
      errors: [],
      freedBytes: 0,
      truncated: false,
    };
    const holds: GcHold[] = [];
    result.holds = holds;
    result.heldHomes = 0;
    const hold = (kind: GcHold["class"], example: string) => {
      holds.push({ class: kind, count: 1, example });
      if (kind === "native_home_veto") result.heldHomes! += 1;
    };
    let closeReferences = () => {};
    try {
      let references = new Map<string, Set<string>>();
      let blocked: string | null = null;
      let canPrune = () => false;
      try {
        const snapshot =
          request.references ??
          (await deps.threads.retentionReferences(request.ignoredThreadIds, request.signal));
        if (!request.references) closeReferences = () => snapshot.close?.();
        request.signal?.throwIfAborted();
        const seenRunDirs = new Set<string>();
        references = snapshot.nativeSessions;
        canPrune = () => {
          if (request.signal?.aborted || deps.isBusy()) return false;
          const current = (snapshot.recheck ?? snapshot.isCurrent)();
          if (snapshot.blocked) throw new Error(snapshot.blocked);
          if (snapshot.protectedProjectRoots.size)
            throw new Error(
              `native homes kept: ${(snapshot.errors ?? [...snapshot.protectedProjectRoots]).join("; ")}`,
            );
          if (!current) return false;
          const uncertainty = snapshot.nativeReferenceError?.();
          if (uncertainty) throw new Error(uncertainty);
          for (const run of snapshot.nativeWatchRunDirs ?? [])
            collectNativeRunSessions(
              run,
              references,
              seenRunDirs,
              request.ignoredRunIds,
              request.signal,
            );
          return true;
        };
        await snapshot.refresh?.();
        if (!canPrune()) throw new Error("native references or setup state changed; homes kept");
        await retainedNativeSessions(
          references,
          request.ignoredRunIds,
          request.signal,
          snapshot.nativeRunDirs,
          seenRunDirs,
        );
        await snapshot.refresh?.();
        if (!canPrune()) throw new Error("native references or setup state changed; homes kept");
      } catch (error) {
        blocked = error instanceof Error ? error.message : String(error);
        result.errors.push(`native retention: ${blocked}`);
      }
      const registry = (deps.registry ?? (() => buildRegistry({ includeFakes: false })))();
      const profiles = (
        deps.profiles ?? (() => loadConfig(noProjectRepoRoot()).global.credential_profiles)
      )();
      let remaining = deps.maxDeletions ?? 500;
      for (const [harness, adapter] of registry) {
        if (request.signal?.aborted) break;
        const lifetime = adapter.nativeHomeLifetime;
        if (!lifetime) continue; // API-only/fake adapters own no native home.
        const seen = new Set<string>();
        const homes = [
          null,
          ...profiles.filter(
            (profile) =>
              profile.harness_id === harness && profile.credential_kind === "config_dir_login",
          ),
        ];
        for (const profile of homes) {
          if (request.signal?.aborted) break;
          const report: GcNativeHomeReport = {
            harness_id: harness,
            profile_id: profile?.profile_id ?? null,
            home: null,
            status: "not_pruned",
            reason: "",
            deleted_files: [],
            errors: [],
            freed_bytes: 0,
            kept_referenced: 0,
            kept_recent: 0,
            kept_unknown: 0,
            truncated: false,
          };
          result.reports.push(report);
          if (lifetime.status === "not_pruned") {
            report.reason = lifetime.reason;
            continue;
          }
          try {
            report.home = lifetime.home(
              profile?.isolation_locator
                ? { [CONTINUITY_PROFILE_LOCATOR_ENV]: profile.isolation_locator }
                : {},
            );
            if (seen.has(report.home)) {
              report.reason = "same native home already considered this pass";
              continue;
            }
            seen.add(report.home);
            if (!blocked && !canPrune()) {
              blocked = "native retention references or setup state changed; remaining homes kept";
              result.errors.push(`native retention: ${blocked}`);
            }
            if (blocked) {
              report.reason = blocked;
              hold("native_home_veto", `${report.home}: ${blocked}`);
              continue;
            }
            // Preserve this Set identity: SQL and producer rechecks add to it
            // while the adapter walks its home.
            const ids = references.get(harness) ?? new Set<string>();
            references.set(harness, ids);
            let vetoed = false;
            const pruned = await lifetime.prune({
              signal: request.signal,
              home: report.home,
              protectedSessionIds: ids,
              olderThan: request.olderThan,
              dryRun: request.dryRun,
              maxDeletions: remaining,
              canPrune: () => {
                try {
                  const current = canPrune();
                  vetoed ||= !current;
                  return current;
                } catch (error) {
                  vetoed = true;
                  throw error;
                }
              },
            });
            Object.assign(report, pruned, { status: "checked", reason: lifetime.preserves });
            if (vetoed)
              hold("native_home_veto", `${report.home}: ownership or setup changed during pruning`);
            remaining -= pruned.deleted_files.length;
            result.freedBytes += pruned.freed_bytes;
            result.errors.push(...pruned.errors);
            result.truncated ||= pruned.truncated;
          } catch (error) {
            report.reason = error instanceof Error ? error.message : String(error);
            hold("native_home_veto", `${harness}: ${report.reason}`);
            result.errors.push(
              `native home ${harness}/${profile?.profile_id ?? "default"}: ${report.reason}`,
            );
          }
        }
      }
      if (request.signal?.aborted) {
        result.truncated = true;
        result.errors.push("native retention cancelled; remaining homes kept for next pass");
      }
      return result;
    } finally {
      closeReferences();
    }
  };
}
