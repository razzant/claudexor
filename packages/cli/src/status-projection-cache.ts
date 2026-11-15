/**
 * TTL + single-flight cache for the daemon's poll-heavy status projections.
 *
 * Hit live 2026-08-04: a UI polling `/v2/credential-profiles` and
 * `/v2/harnesses` every 5 seconds made the daemon spawn full harness sweeps
 * (discover + doctor for every adapter, plus a doctor probe per registered
 * credential profile) on EVERY tick — each sweep shells out to the vendor
 * CLIs, takes >8s under load, and starves the daemon's request loop until an
 * interactive login POST times out client-side ("Daemon unreachable:
 * ReadTimeout"). The poller needs cheap reads, not fresh probes per tick, so
 * these projections now serve the last computed value inside a short TTL and
 * coalesce concurrent recomputes into one in-flight sweep. An explicit
 * fresh/snapshot request still bypasses the TTL, and a credential-state
 * change (login/logout) invalidates every registered cache so a fresh login
 * is visible on the next poll rather than a TTL later.
 *
 * A cache constructed with `holdMs` (only the capability catalog: its answer
 * dates itself and no admission reads it) also answers a held value past the
 * TTL, while it is younger than TTL + holdMs, and lets one recompute refresh it
 * in the background: the reader who arrives after a quiet spell no longer pays
 * the sweep (11-19 s on a loaded host, 2026-11-14). Only a read starts that
 * recompute; nothing runs while nobody reads.
 */

import { statSync } from "node:fs";
import { globalConfigPath } from "@claudexor/config";

const registry = new Set<{ invalidate(): void }>();

export function registerStatusProjection(cache: { invalidate(): void }): void {
  registry.add(cache);
}

/** Cheap identity stamp of the global config file: any write — service-layer,
 * CLI, or hand edit — changes it, so config-derived projection facts are never
 * served stale. One stat() per poll read. */
export function globalConfigVersion(): string {
  try {
    const s = statSync(globalConfigPath());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

export const STATUS_PROJECTION_TTL_MS = 15_000;
/** The capability catalog's held window past the TTL: the engine's horizon for a recent observation. */
export const CATALOG_HOLD_MS = 5 * 60_000;

export interface StatusProjectionCacheOptions {
  ttlMs?: number;
  now?: () => number;
  /**
   * Cheap version stamp the cached value must match to be served — the global
   * config file's identity for both poll surfaces. Config-derived facts (the
   * Enabled toggle, registered profiles) are cheap to read and mutable through
   * MANY paths (service mutations, the CLI, a hand edit), so they must never
   * lag a TTL: only the expensive probe-derived facts deserve one. A version
   * mismatch recomputes exactly like an invalidation.
   */
  versionOf?: () => string;
  /**
   * How long past the TTL a same-version value is still answered at once while
   * one recompute refreshes it. 0 (the default): every read past the TTL waits.
   */
  holdMs?: number;
}

export class StatusProjectionCache<T> {
  private value: { at: number; version: string; data: T } | null = null;
  private inFlight: { generation: number; version: string; promise: Promise<T> } | null = null;
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly versionOf: () => string;
  private readonly holdMs: number;

  constructor(opts: StatusProjectionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? STATUS_PROJECTION_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.versionOf = opts.versionOf ?? (() => "");
    this.holdMs = opts.holdMs ?? 0;
    registerStatusProjection(this);
  }

  /** Serve the cached value inside the TTL (same version); otherwise compute
   * once, shared by every concurrent reader. With `holdMs`, a same-version
   * value younger than TTL + holdMs is still served at once while that shared
   * compute refreshes it in the background. `fresh` bypasses the TTL but
   * still coalesces with a current in-flight compute and re-primes the cache
   * on completion. An invalidation or version change during an in-flight
   * compute keeps that compute's result OUT of the cache (its data predates
   * the change) and later readers start a new one. */
  async read(compute: () => Promise<T>, opts?: { fresh?: boolean }): Promise<T> {
    const version = this.versionOf();
    const held = !opts?.fresh && this.value && this.value.version === version ? this.value : null;
    const age = held ? this.now() - held.at : Infinity;
    if (held && age < this.ttlMs) return held.data;
    const flight = this.flight(compute, version);
    if (held && age < this.ttlMs + this.holdMs) {
      // Nobody awaits this recompute: consume its failure (an unhandled
      // rejection ends the daemon); the held value keeps its own time.
      flight.catch(() => undefined);
      return held.data;
    }
    return flight;
  }

  /** The in-flight recompute of this generation and version, or a new one. */
  private flight(compute: () => Promise<T>, version: string): Promise<T> {
    if (
      this.inFlight &&
      this.inFlight.generation === this.generation &&
      this.inFlight.version === version
    ) {
      return this.inFlight.promise;
    }
    const generation = this.generation;
    const entry = {
      generation,
      version,
      promise: compute().then(
        (data) => {
          // Stamp with the version CAPTURED at read() entry, never re-read at
          // completion: a config change DURING the computation must not label
          // pre-change data as post-change (wave finding, both reviewers). A
          // stale-versioned late completion also never clobbers a value that
          // is current; it may still prime an empty or equally-stale slot.
          const primeable =
            !this.value || this.value.version === version || version === this.versionOf();
          if (this.generation === generation && primeable) {
            this.value = { at: this.now(), version, data };
          }
          if (this.inFlight === entry) this.inFlight = null;
          return data;
        },
        (err) => {
          // A failed sweep must not poison the cache: the next reader retries.
          if (this.inFlight === entry) this.inFlight = null;
          throw err;
        },
      ),
    };
    this.inFlight = entry;
    return entry.promise;
  }

  invalidate(): void {
    this.value = null;
    this.generation += 1;
  }
}

/** Credential state changed (login/logout): every projection that embeds
 * harness/profile status is stale at once. */
export function invalidateStatusProjections(): void {
  for (const cache of registry) cache.invalidate();
}

/** A harness program changed (install, update): the cached status projections
 * (the `/v2/harnesses` poll, the capability catalog and the Accounts harness
 * statuses) are stale, while account observations keep their own per-harness
 * invalidation (dropping them all would abort every harness's acquisition). */
export function invalidateStatusProjectionCaches(): void {
  for (const cache of registry) if (cache instanceof StatusProjectionCache) cache.invalidate();
}
