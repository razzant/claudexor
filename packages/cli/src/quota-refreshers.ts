import type { QuotaRefreshCycle, QuotaVendorRefresher } from "@claudexor/daemon";
import { ACCOUNT_RESOURCE_REFRESH_SOURCES, type QuotaSource } from "@claudexor/schema";
import { refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";
import { refreshClaudeStatuslineQuota } from "./claude-statusline.js";
import { refreshCodexQuota } from "./codex-quota-source.js";
import { refreshAgyQuota } from "./agy-quota-source.js";
import { refreshCursorQuota } from "./cursor-quota-source.js";
import { refreshOpenRouterKeyAllowance } from "./openrouter-key-source.js";
import type { QuotaDiagnosticSink } from "./quota-refresh-diagnostics.js";

export interface QuotaRefresherRegistration {
  readonly source: QuotaSource | keyof typeof ACCOUNT_RESOURCE_REFRESH_SOURCES;
  /** Pacing lane (per-vendor poll pacing): the vendor whose credential
   * fan-out this refresher performs. Must equal the source trait's
   * refreshDemandHarness whenever that is non-null (parity test);
   * claude_statusline reads a local spool but publishes claude-subject
   * evidence, so it rides the claude lane. */
  readonly vendor: QuotaVendorRefresher["vendor"];
  readonly refresh: (
    cycle?: QuotaRefreshCycle,
    diagnostic?: QuotaDiagnosticSink,
  ) => ReturnType<QuotaVendorRefresher["refresh"]>;
}

/** The daemon's top-level refreshers and the source each owns. Schema traits
 * independently declare which sources must appear here; the parity test keeps
 * composition, vocabulary, and pacing-lane assignment in lockstep. Every
 * account-polling source receives the cycle (exact target, due-subject and
 * poll-floor controls) and the diagnostic sink; the claude OAuth source also
 * reads the cycle kind (an explicit foreground refresh re-presents a token it
 * remembers as rejected). The local statusline spool answers only untargeted
 * cycles. */
export const QUOTA_REFRESHER_REGISTRATIONS = [
  {
    source: "codex_app_server",
    vendor: "codex",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshCodexQuota({ diagnostic, foreground: cycle?.foreground, cycle }),
  },
  {
    source: "claude_statusline",
    vendor: "claude",
    refresh: (cycle?: QuotaRefreshCycle) =>
      cycle?.target ? Promise.resolve({ snapshots: [] }) : refreshClaudeStatuslineQuota(),
  },
  {
    source: "claude_oauth_usage",
    vendor: "claude",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshClaudeOauthUsageQuota(diagnostic ? { diagnostic } : {}, cycle),
  },
  {
    source: "agy_command_usage",
    vendor: "agy",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshAgyQuota(diagnostic ? { diagnostic } : {}, cycle),
  },
  {
    source: "cursor_dashboard",
    vendor: "cursor",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshCursorQuota(diagnostic ? { diagnostic } : {}, cycle),
  },
  {
    source: "openrouter_key",
    vendor: "openrouter",
    refresh: (cycle?: QuotaRefreshCycle, diagnostic?: QuotaDiagnosticSink) =>
      refreshOpenRouterKeyAllowance(diagnostic ? { diagnostic } : {}, cycle),
  },
] as const satisfies readonly QuotaRefresherRegistration[];

export function quotaRefreshers(diagnostic?: QuotaDiagnosticSink): QuotaVendorRefresher[] {
  return QUOTA_REFRESHER_REGISTRATIONS.map(({ vendor, refresh }) => ({
    vendor,
    refresh: (cycle) => refresh(cycle, diagnostic),
  }));
}
