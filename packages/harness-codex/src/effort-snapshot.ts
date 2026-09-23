/**
 * The RECORDED codex effort catalog — vendor evidence, not logic.
 *
 * Separate from effort-probe.ts on purpose, the same way vendor-cli-version.ts
 * is separate from everything that reads it: this module's contents change on
 * exactly one trigger, a vendor release re-recorded against a new pinned CLI,
 * while the probe/parse/cache/resolution code next door changes on behavior
 * fixes. Keeping them in one file meant every vendor bump edited the same file
 * as every logic fix, and a reviewer could not tell a re-record from a
 * behavior change by the file list alone.
 *
 * Three callers read it: the probe's fallback path, the manifest's
 * `model_effort_levels`, and the model-hints freshness gate.
 */
import type { CodexEffortCatalog } from "./effort-probe.js";
import { CODEX_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

/**
 * Recorded fallback coverage: the pinned CLI's visible `model/list` capture,
 * plus unchanged ladders retained from historical account captures. Presence
 * is a union, not a claim that every account advertises every model: the
 * freshness gate checks live entries while permitting snapshot-only entries.
 * Used ONLY when the live probe cannot answer; it is vendor evidence, never an
 * allow-list this repo maintains by hand. `defaultModel` comes from the pinned
 * CLI capture; historical defaults do not override its `isDefault: true`.
 *
 * The 0.156.1 capture (fixtures/models-0.156.1.json) is the CLI's BUNDLED
 * catalog, taken under a throwaway home with no ChatGPT login, so it describes
 * what this binary ships with — not what any one account is entitled to. That
 * is exactly what a fallback needs to be, and it is why the entries the
 * bundled list dropped are RETAINED below rather than deleted: an account that
 * still serves gpt-5.4 keeps its ladder.
 */
export const CODEX_EFFORT_SNAPSHOT: CodexEffortCatalog = {
  models: {
    "gpt-6-astra": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      // 0.156.1 advertises `low` here; 0.153.3 advertised `medium`. The vendor
      // moved, so the capture does too — a default is recorded, never chosen.
      default: "low",
    },
    // GPT-6 Sol and GPT-6 Luna entered the catalog in codex-cli 0.156.1
    // (rust-v0.156.1, "[hotfix 0.156.0] Add GPT-6 Sol and Luna to the model
    // catalog"). Luna stops at `max`; Sol carries the full ladder through
    // `ultra`, exactly as the pinned CLI's `model/list` reports them.
    "gpt-6-sol": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
    },
    "gpt-6-luna": { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    "gpt-5.6-sol": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
    },
    "gpt-5.6-terra": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
    },
    "gpt-5.6-luna": { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    "gpt-5.5": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    // Retained from earlier captures: the 0.156.1 bundled list stops above
    // this line. Absence from a bundled list is not proof an account lost the
    // model, so these ladders stay available to the accounts that still have
    // them (INV-104: a truth source refuses only what it can prove).
    "gpt-5.4": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-5.4-mini": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-5.3-codex-spark": { levels: ["low", "medium", "high", "xhigh"], default: "high" },
    "gpt-5.2": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  defaultModel: "gpt-6-astra",
};

/** Vendor CLI version `CODEX_EFFORT_SNAPSHOT` was captured from. Aliases the
 * per-package vendor-version SSOT (vendor-cli-version.ts), the same constant
 * the remote installer pins — the freshness gate and the installed bytes can
 * never disagree about which version this release vouches for. */
export const CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST: string = CODEX_VENDOR_CLI_VERSION;
