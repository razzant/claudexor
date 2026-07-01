import type { ControlSettingsSnapshot, ResolvedConfig } from "@claudexor/schema";

type RuntimeLine = {
  key: string;
  local: number;
  daemon: number | undefined;
};

export function daemonRuntimeDiffLines(
  local: ResolvedConfig,
  daemon: ControlSettingsSnapshot,
): string[] {
  const lines: RuntimeLine[] = [
    {
      key: "interaction_timeout_ms",
      local: local.global.interaction_timeout_ms,
      daemon: daemon.interactionTimeoutMs,
    },
    {
      key: "runtime.reviewer_timeout_ms",
      local: local.global.runtime.reviewer_timeout_ms,
      daemon: daemon.runtime?.reviewerTimeoutMs,
    },
    {
      key: "runtime.transient_retry.max_retries",
      local: local.global.runtime.transient_retry.max_retries,
      daemon: daemon.runtime?.transientRetry?.maxRetries,
    },
    {
      key: "runtime.transient_retry.initial_delay_ms",
      local: local.global.runtime.transient_retry.initial_delay_ms,
      daemon: daemon.runtime?.transientRetry?.initialDelayMs,
    },
    {
      key: "runtime.transient_retry.max_delay_ms",
      local: local.global.runtime.transient_retry.max_delay_ms,
      daemon: daemon.runtime?.transientRetry?.maxDelayMs,
    },
  ];
  return lines
    .filter((line) => line.daemon !== undefined && line.daemon !== line.local)
    .map((line) => `daemon.effective.${line.key}: ${line.daemon} (local shell: ${line.local})`);
}
