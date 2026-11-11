import type { ExtraMcpServer, Intent, PaidBudget } from "@claudexor/schema";
import { DELEGATION_ENV } from "@claudexor/util";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import { isFullAccess } from "./requestRequirements.js";

/** The extra MCP servers injected into one agent lane's sandbox. Today only
 * the delegation belt (D32): present when `--delegate` is on, the daemon built
 * a belt descriptor, the lane's adapter can inject MCP servers, and the lane is
 * a WRITING agent intent (the delegator integrates results in its workspace;
 * read lanes and reviewers have nothing to delegate). */
export function delegationBeltFor(
  input: RunInput | undefined,
  intent: Intent,
  routed: RoutedAdapter,
  resolvedBudget: PaidBudget,
): ExtraMcpServer[] {
  if (
    !input?.delegate ||
    !input.delegationBelt ||
    !input.delegationParentRunId ||
    !routed.delegationRequirement.effective
  )
    return [];
  // A lane that sandbox-cancels the belt below full access (codex) must NOT
  // receive a belt it cannot use. Per-lane requirement resolution records the
  // typed degradation, while a mixed pool keeps the belt on lanes that can
  // host it.
  if (routed.mcpInjectionRequiresFullAccess && !isFullAccess(routed.adapterAccess)) return [];
  const writingIntents: Intent[] = ["implement", "create_from_scratch", "repair"];
  if (!writingIntents.includes(intent)) return [];
  // The CLI built the descriptor from the RAW request budget (undefined when
  // the caller relied on a config/dep default), which would leave the belt
  // unlimited while the real run is capped. Rebind the belt's parent-budget
  // env to the RESOLVED budget (resolvePaidBudget output) so sub-run draws are
  // bounded by the same headroom the parent run enforces — one budget owner.
  const env = { ...input.delegationBelt.env };
  for (const [key, value] of [
    [DELEGATION_ENV.processingPreference, input.processingPreference],
    [DELEGATION_ENV.promptCacheTtl, input.promptCacheTtl],
    [DELEGATION_ENV.workspaceKind, input.workspaceKind],
    [
      DELEGATION_ENV.scopePaths,
      input.scopePaths === undefined ? undefined : JSON.stringify(input.scopePaths),
    ],
  ]) {
    if (value === undefined) delete env[key!];
    else env[key!] = value;
  }
  return [
    {
      ...input.delegationBelt,
      env: {
        ...env,
        [DELEGATION_ENV.parentRunId]: input.delegationParentRunId,
        [DELEGATION_ENV.repoRoot]: input.repoRoot,
        [DELEGATION_ENV.budget]: JSON.stringify(resolvedBudget),
      },
    },
  ];
}
