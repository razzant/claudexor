import { deliveryEffectsStatement } from "@claudexor/schema";

type Answer = Record<string, unknown>;

const refusalOf = (answer: Answer) => {
  const refusal = answer["refusal"] as { code?: unknown; paths?: unknown } | undefined;
  return typeof refusal?.code === "string"
    ? {
        code: refusal.code,
        paths: Array.isArray(refusal.paths)
          ? refusal.paths.filter((path): path is string => typeof path === "string")
          : [],
      }
    : undefined;
};

/** What an Apply that did not apply did, as the receipt states it (typed refusal,
 * the path it stopped at, completed writes, a changed target); undefined when it
 * names nothing beyond its detail. */
export function deliveryEffects(answer: Answer): string | undefined {
  const appliedPaths = Array.isArray(answer["appliedPaths"])
    ? answer["appliedPaths"].filter((path): path is string => typeof path === "string")
    : undefined;
  return deliveryEffectsStatement({
    applied: answer["applied"] === true,
    appliedPaths,
    treeMutated: answer["treeMutated"] === true,
    detail: typeof answer["detail"] === "string" ? answer["detail"] : undefined,
    refusal: refusalOf(answer),
  });
}

/** A dry run that was refused: a typed refusal (a verification copy without room
 * proves nothing either way) is never reported as a conflict. */
export function applyCheckRefusal(answer: Answer): string {
  const refusal = refusalOf(answer);
  const stderr = typeof answer["stderr"] === "string" ? answer["stderr"].trim() : "";
  if (!refusal) return "patch does not apply";
  const at = refusal.paths.length > 0 ? ` at ${refusal.paths.join(", ")}` : "";
  return `not confirmed (${refusal.code}${at})${stderr ? `: ${stderr}` : ""}`;
}
