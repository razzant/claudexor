import { runCaptureRaw } from "@claudexor/core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeFindings,
  scanPublication,
  type PublicationFinding,
  type PublicationScanResult,
} from "./publication-scan.js";
import { locateScanner } from "./publication-scanner-pin.js";

// The publication boundary's public surface: the scan and the scanner pin.
export * from "./publication-scan.js";
export * from "./publication-scanner-pin.js";

/** Why `pr` was not published (the wire shape is the schema's
 * PublicationRefusal). `findings` is an ordinary refusal; the other two say
 * the check could not run or could not prove its result. */
type PublicationRefusal =
  | { code: "publication_scan_findings"; detail: string; findings: PublicationFinding[] }
  | { code: "publication_scan_unavailable"; detail: string }
  | { code: "publication_scan_failed"; detail: string };

export type PublicationGate =
  | { ok: true; commit: string; bodyFile: string | undefined; cleanup: () => void }
  | { ok: false; refusal: PublicationRefusal };

const LOCAL_CHOICES = "Apply, branch or commit it locally";

/** The one remote `pr` delivery pushes to (`git push origin <commit>:<branch>`). */
export const PUBLICATION_DESTINATION = "origin";

/**
 * Prepare and check one `pr` publication before anything leaves the machine.
 *
 * The commit object is created here from the exact candidate tree (it stays
 * unreferenced until delivery adopts it and pushes exactly it), so the scanner
 * sees that commit plus every earlier commit a push DESTINATION does not
 * already advertise, plus the text that travels with them. The destinations
 * are the URLs `git push origin` sends to (`remote.origin.pushurl` entries, or
 * every `remote.origin.url` when none is set, `pushInsteadOf` applied), each
 * read now with `git ls-remote`: never the fetch URL when a push URL differs,
 * another remote, or a stale remote-tracking ref. Each distinct destination is
 * scanned for what it lacks. The PR body is copied once into a private file:
 * the scanned bytes are the bytes `gh` later reads.
 */
export async function gatePublication(input: {
  repoRoot: string;
  tree: string;
  parent: string;
  message: string;
  branch: string;
  prBodyFile?: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PublicationGate> {
  const env = input.env ?? process.env;
  const scanner = locateScanner({ env, configDir: input.configDir });
  if (!scanner.ok)
    return refuse(
      "publication_scan_unavailable",
      `refusing 'pr' delivery: the publication scanner is unavailable (${scanner.reason}). ${LOCAL_CHOICES}, or provision the pinned scanner and re-run.`,
    );
  const commit = await git(input.repoRoot, [
    "-c",
    "user.email=claudexor@local",
    "-c",
    "user.name=claudexor",
    "commit-tree",
    input.tree,
    "-p",
    input.parent,
    "-m",
    input.message,
  ]);
  const commitId = commit.stdout.trim();
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commitId))
    return refuse(
      "publication_scan_failed",
      `refusing 'pr' delivery: the outgoing commit could not be prepared for the publication scan. ${LOCAL_CHOICES}.`,
    );
  const destinations = await pushDestinations(input.repoRoot, env);
  if (!destinations.ok)
    return refuse(
      "publication_scan_failed",
      `refusing 'pr' delivery: what '${PUBLICATION_DESTINATION}' pushes to already has could not be read (${destinations.reason}), so the outgoing range is unknown and nothing was sent. ${LOCAL_CHOICES}.`,
    );
  const work = mkdtempSync(join(tmpdir(), "claudexor-pr-body-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  let bodyFile: string | undefined;
  let body = "";
  if (input.prBodyFile) {
    try {
      body = readFileSync(input.prBodyFile, "utf8");
    } catch {
      cleanup();
      return refuse(
        "publication_scan_failed",
        `refusing 'pr' delivery: the PR body file cannot be read. ${LOCAL_CHOICES}.`,
      );
    }
    bodyFile = join(work, "body.md");
    writeFileSync(bodyFile, body, { mode: 0o600 });
  }
  const metadata = [
    { label: "branch name", text: `${input.branch}\n` },
    { label: "pull request title", text: `${input.message}\n` },
    ...(bodyFile ? [{ label: "pull request body", text: body }] : []),
  ];
  for (const tips of destinations.tipSets) {
    // `<commit> --not <tips…>`: the adapter scans this range's history, merges
    // and commit messages.
    const range = [commitId, ...(tips.length ? ["--not", ...tips] : [])];
    const result = await scanPublication({
      scanner: scanner.path,
      repoRoot: input.repoRoot,
      logOpts: range.join(" "),
      metadata,
      env,
    });
    if (result.status === "clean") continue;
    cleanup();
    return scanRefusal(result);
  }
  return { ok: true, commit: commitId, bodyFile, cleanup };
}

function scanRefusal(result: Exclude<PublicationScanResult, { status: "clean" }>): PublicationGate {
  if (result.status === "findings")
    return {
      ok: false,
      refusal: {
        code: "publication_scan_findings",
        findings: result.findings,
        detail: `refusing 'pr' delivery: the publication scanner reported ${result.findings.length} finding(s) in what would be pushed: ${describeFindings(result.findings)}. ${LOCAL_CHOICES}, or remove that content from the outgoing commits and re-run.`,
      },
    };
  return refuse(
    "publication_scan_failed",
    `refusing 'pr' delivery: the publication scan did not complete (${result.reason}). ${LOCAL_CHOICES}, or re-run when the scanner works.`,
  );
}

function refuse(
  code: "publication_scan_unavailable" | "publication_scan_failed",
  detail: string,
): PublicationGate {
  return { ok: false, refusal: { code, detail } };
}

/**
 * Every URL `git push origin` sends to, each with the commits it already has.
 * Destinations with the same tips are scanned once. A URL is never echoed (it
 * may carry credentials); reasons name its position.
 */
async function pushDestinations(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; tipSets: string[][] } | { ok: false; reason: string }> {
  const listed = await git(repoRoot, [
    "remote",
    "get-url",
    "--push",
    "--all",
    PUBLICATION_DESTINATION,
  ]);
  const urls =
    listed.code === 0
      ? listed.stdout
          .split("\n")
          .map((url) => url.trim())
          .filter(Boolean)
      : [];
  if (!urls.length)
    return { ok: false, reason: `no push URL is configured for '${PUBLICATION_DESTINATION}'` };
  const tipSets = new Map<string, string[]>();
  for (const [index, url] of urls.entries()) {
    const where = `push URL ${index + 1} of ${urls.length}`;
    // An option-shaped URL would be read as a git option, never as a remote.
    if (url.startsWith("-")) return { ok: false, reason: `${where} is not a repository URL` };
    const base = await destinationBase(repoRoot, url, env);
    if (!base.ok) return { ok: false, reason: `${where}: ${base.reason}` };
    tipSets.set([...base.tips].sort().join(" "), base.tips);
  }
  return { ok: true, tipSets: [...tipSets.values()] };
}

/**
 * The commits one destination already has, as the fewest independent local
 * tips: every ref it advertises now whose commit exists here. A tip this
 * repository does not have cannot bound anything and is left out, so the range
 * only grows (more is scanned, never less). An empty destination has no tips:
 * the whole history of the outgoing commit is outgoing.
 */
async function destinationBase(
  repoRoot: string,
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; tips: string[] } | { ok: false; reason: string }> {
  // Never prompt: a destination that needs interactive credentials is
  // unreadable here, and the push would need them too.
  const listed = await git(repoRoot, ["ls-remote", url], {
    env: { ...pickString(env, ["GIT_SSH_COMMAND", "SSH_AUTH_SOCK"]), GIT_TERMINAL_PROMPT: "0" },
  });
  if (listed.code !== 0) return { ok: false, reason: `git ls-remote exited ${listed.code}` };
  const advertised = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.split("\t")[0]?.trim() ?? "")
        .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)),
    ),
  ];
  if (!advertised.length) return { ok: true, tips: [] };
  // Peel each advertised object to a commit that exists locally.
  const checked = await git(repoRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: advertised.map((sha) => `${sha}^{commit}`).join("\n") + "\n",
  });
  if (checked.code !== 0) return { ok: false, reason: "local object lookup failed" };
  const local = checked.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([sha, type]) => type === "commit" && /^[0-9a-f]{40,64}$/.test(sha ?? ""))
    .map(([sha]) => sha!);
  // Independent tips keep the argument list bounded by branches, not tags.
  let tips = [...new Set(local)];
  while (tips.length > 1) {
    const reduced: string[] = [];
    for (let index = 0; index < tips.length; index += 1000) {
      const chunk = tips.slice(index, index + 1000);
      const independent = await git(repoRoot, ["merge-base", "--independent", ...chunk]);
      if (independent.code !== 0) return { ok: false, reason: "merge-base failed" };
      reduced.push(...independent.stdout.split(/\s+/).filter(Boolean));
    }
    const next = [...new Set(reduced)];
    if (next.length >= tips.length) break;
    tips = next;
  }
  return { ok: true, tips };
}

async function git(
  cwd: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
) {
  const result = await runCaptureRaw("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeoutMs: 60_000,
    windowsConsole: "none",
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  }).catch(() => null);
  return result
    ? { code: result.code, stdout: result.stdout.toString() }
    : { code: 1 as number | null, stdout: "" };
}

function pickString(env: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) if (typeof env[key] === "string") picked[key] = env[key];
  return picked;
}
