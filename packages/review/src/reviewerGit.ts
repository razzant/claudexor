import { runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";

export async function initializeReviewerWorkspaceGit(root: string): Promise<void> {
  // No hook runs, and the user's attributes file (`core.attributesFile`, else Git's
  // XDG default) is no source either: see reviewerWorkspaceGitEnv.
  const isolated = ["-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null"];
  await runGitOrThrow("init", root, ["-c", "init.templateDir=", ...isolated, "init"]);
  for (const [key, value] of [
    ["user.email", "claudexor-review@example.invalid"],
    ["user.name", "Claudexor Review"],
  ]) {
    await runGitOrThrow(`config ${key}`, root, [...isolated, "config", key, value]);
  }
  await runGitOrThrow("add", root, [...isolated, "add", "-A", "--force"]);
  await runGitOrThrow("commit", root, [
    ...isolated,
    "commit",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    "review baseline",
  ]);
}

async function runGitOrThrow(label: string, cwd: string, args: string[]): Promise<void> {
  const result = await runCapture("git", args, {
    cwd,
    env: reviewerWorkspaceGitEnv(),
    timeoutMs: 60_000,
    windowsConsole: "none",
  });
  if (result.code === 0) return;
  const detail = redactSecrets((result.stderr || result.stdout || `exit ${result.code}`).trim());
  throw new Error(`failed to prepare reviewer workspace (${label}): ${detail}`);
}

/** No Git setting a caller's environment injects and no system configuration. The
 * candidate's own repository is still read with the user's global configuration: its
 * ignore rules decide what is Git-visible there. */
export function reviewerGitEnv(): Record<string, string | null> {
  const gitEnv: Record<string, string | null> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_"))
      .map((key) => [key, null]),
  );
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  return gitEnv;
}

/**
 * The reviewer workspace is Claudexor's own repository over the copied files. No
 * system or global configuration and no system attributes file reaches it, so no
 * filter driver, monitor or signing program of the user's runs while review is
 * prepared, a required filter that cannot run does not keep review from starting, and
 * no line-ending setting of the user's converts or refuses a file. The copied tree's
 * own `.gitattributes` still apply: what the baseline commit stores may differ from
 * the copied bytes (line endings they normalize, for one), and reviewers read the
 * copied bytes on disk (INV-146).
 */
function reviewerWorkspaceGitEnv(): Record<string, string | null> {
  return { ...reviewerGitEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
}
