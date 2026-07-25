import type { ModeKind } from "@claudexor/schema";
import { canonicalProjectRoot } from "@claudexor/util";

/** Refuse restriction policies that a live-tree write cannot contain. */
export function assertWriteIsolation(input: {
  mode: ModeKind;
  protectedPaths: readonly string[];
  denyPaths?: readonly string[];
  inPlace?: boolean;
  repoRoot: string;
  executionRoot: string;
}): void {
  const liveProject =
    input.inPlace === true &&
    canonicalProjectRoot(input.executionRoot) === canonicalProjectRoot(input.repoRoot);
  if (input.mode === "agent" && input.protectedPaths.length > 0 && liveProject) {
    throw new Error(
      "project protected_paths require an isolated execution root before an agent run can mutate files; use an isolated thread or drop --in-place",
    );
  }
  if ((input.denyPaths?.length ?? 0) > 0 && input.inPlace === true) {
    throw new Error(
      "denyPaths requires an isolated/envelope run: the post-diff policy gate blocks a violating patch before delivery, which an in-place run cannot guarantee; drop --deny-path or run isolated",
    );
  }
}
