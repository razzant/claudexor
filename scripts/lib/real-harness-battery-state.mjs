import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isBatteryRepoRoot(reposDir, repoRoot) {
  return typeof repoRoot === "string" && isWithin(resolve(reposDir), resolve(repoRoot));
}

export function validateBatteryTaskIdentity({ job, task, taskSchema }) {
  if (
    typeof job?.runId !== "string" ||
    job.runId.length === 0 ||
    typeof job?.taskId !== "string" ||
    job.taskId.length === 0
  ) {
    return { valid: false, reason: "task_contract_missing_or_malformed", task: null };
  }
  const parsed = taskSchema.safeParse(task);
  if (!parsed.success) {
    return { valid: false, reason: "task_contract_missing_or_malformed", task: null };
  }
  if (parsed.data.task_id !== job.taskId) {
    return { valid: false, reason: "artifact_identity_mismatch", task: null };
  }
  return { valid: true, reason: null, task: parsed.data };
}

export function validateBatteryRunArtifacts({
  job,
  task,
  eventText,
  telemetry,
  telemetryPresent,
  runEventSchema,
  harnessEventSchema,
  telemetrySchema,
}) {
  const lines =
    typeof eventText === "string"
      ? eventText.split("\n").filter((line) => line.trim().length > 0)
      : [];
  if (lines.length === 0) {
    return { valid: false, reason: "run_events_missing_or_malformed" };
  }
  const events = [];
  for (const line of lines) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return { valid: false, reason: "run_events_missing_or_malformed" };
    }
    const parsed = runEventSchema.safeParse(raw);
    if (!parsed.success) {
      return { valid: false, reason: "run_events_missing_or_malformed" };
    }
    const event = parsed.data;
    if (event.run_id !== job.runId || event.task_id !== task.task_id) {
      return { valid: false, reason: "artifact_identity_mismatch" };
    }
    if (event.type === "harness.started" || event.type === "harness.event") {
      if (
        typeof event.payload.harness_id !== "string" ||
        event.payload.harness_id.length === 0 ||
        typeof event.payload.attempt_id !== "string" ||
        event.payload.attempt_id.length === 0
      ) {
        return { valid: false, reason: "run_events_missing_or_malformed" };
      }
    }
    if (event.type === "harness.event" && !harnessEventSchema.safeParse(event.payload).success) {
      return { valid: false, reason: "run_events_missing_or_malformed" };
    }
    events.push(event);
  }

  if (!telemetryPresent) return { valid: true, reason: null, events, telemetry: null };
  const parsedTelemetry = telemetrySchema.safeParse(telemetry);
  if (!parsedTelemetry.success) {
    return { valid: false, reason: "attempt_telemetry_missing_or_malformed" };
  }
  if (parsedTelemetry.data.run_id !== job.runId || parsedTelemetry.data.task_id !== task.task_id) {
    return { valid: false, reason: "artifact_identity_mismatch" };
  }
  return { valid: true, reason: null, events, telemetry: parsedTelemetry.data };
}

function canonicalFuturePath(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`battery path has no existing ancestor: ${absolute}`);
    suffix.unshift(ancestor.slice(parent.length + 1));
    ancestor = parent;
  }
  const stat = lstatSync(ancestor);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(ancestor) !== ancestor) {
    throw new Error(`battery path ancestor is not canonical: ${ancestor}`);
  }
  const canonical = join(ancestor, ...suffix);
  if (canonical !== absolute) throw new Error(`battery path is not canonical: ${absolute}`);
  return canonical;
}

/** Project the strict daemon writer-lease status into the battery's three
 * authority facts. A stale owner is healable by the normal start path, but
 * only physical absence proves cleanup and only a capable owner can be bound
 * as this battery's shutdown target. */
export function projectBatteryDaemonLease(status) {
  if (status?.status === "absent") {
    return { startAllowed: true, capableOwner: null, physicallyAbsent: true };
  }
  if (status?.status === "owned" && status.capability?.status === "proven_stale") {
    return { startAllowed: true, capableOwner: null, physicallyAbsent: false };
  }
  if (status?.status === "owned" && status.capability?.status === "capable") {
    return {
      startAllowed: false,
      capableOwner: status.owner ?? null,
      physicallyAbsent: false,
    };
  }
  return { startAllowed: false, capableOwner: null, physicallyAbsent: false };
}

export function assertNoPreexistingDaemon({ statusCode, socketIsAlive, lease }) {
  if (statusCode === 0) throw new Error("refusing a pre-existing Claudexor daemon");
  if (socketIsAlive || !lease.startAllowed) {
    throw new Error("daemon preflight found a live socket or writer-lease owner");
  }
}

export function sameDaemonLease(expected, current) {
  return Boolean(
    expected && current && expected.pid === current.pid && expected.token === current.token,
  );
}

/** Preserve the serving identity observed from a fresh daemon even when it is
 * not the requested candidate, so cleanup can target that exact process. */
export function runtimeReplacementIdentityFromHandshake(handshake) {
  const engine = handshake?.engine;
  if (
    !engine ||
    typeof engine !== "object" ||
    typeof engine.version !== "string" ||
    engine.version.length === 0 ||
    typeof engine.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(engine.sha)
  ) {
    return null;
  }
  return { version: engine.version, buildSha: engine.sha };
}

export function evaluateRequiredNativeRoutes(requiredHarnesses, observed) {
  const missing = requiredHarnesses.filter(
    (harnessId) => !observed.some((route) => route.harnessId === harnessId),
  );
  const nonNative = observed.filter(
    (route) => route.authMode !== "local_session" || route.authSource !== "native_session",
  );
  return { valid: missing.length === 0 && nonNative.length === 0, missing, nonNative };
}

export function batteryProfileReady(entry) {
  return Boolean(
    entry?.profile?.enabled === true &&
    entry?.status?.availability === "available" &&
    entry?.status?.verification === "passed",
  );
}

/** Select the required exact profile, except for Agy's named-only account
 * contract where any currently ready registered row may replace the preferred
 * row. An unavailable preferred row is never returned as if it were ready. */
export function selectBatteryProfile(entries, harnessId, preferredProfileId) {
  const exact = entries.find(
    (entry) =>
      entry?.profile?.harness_id === harnessId && entry?.profile?.profile_id === preferredProfileId,
  );
  if (batteryProfileReady(exact)) return exact;
  if (harnessId !== "agy") return null;
  return (
    entries.find(
      (entry) => entry?.profile?.harness_id === harnessId && batteryProfileReady(entry),
    ) ?? null
  );
}

/** Project the battery's two deliberately different readiness questions.
 * Automatic rows follow the server-owned pool route (with doctor-only
 * compatibility for older engines); Agy remains named-only and therefore
 * never joins generic unpinned phases from a pool row. Required named rows may
 * still run whenever their exact profile is independently ready. */
export function projectBatteryHarnessReadiness({
  harnessId,
  doctorReport,
  accountPools = [],
  profileEntries = [],
  requiredProfileEntry = null,
}) {
  const doctorReady = doctorReport?.status === "ok";
  const poolNextUp = accountPools.find((pool) => pool?.harness_id === harnessId)?.next_up ?? null;
  const poolProfileId = poolNextUp?.kind === "profile" ? poolNextUp.profileId : null;
  const poolProfileEntry =
    poolProfileId === null
      ? null
      : (profileEntries.find(
          (entry) =>
            entry?.profile?.harness_id === harnessId &&
            entry?.profile?.profile_id === poolProfileId,
        ) ?? null);
  const poolProfileReady = batteryProfileReady(poolProfileEntry);
  const namedProfileReady = batteryProfileReady(requiredProfileEntry);
  const poolRouteReady = harnessId !== "agy" && poolProfileReady;
  const automaticRouteReady = doctorReady || poolRouteReady;
  const requiredRouteReady = harnessId === "agy" ? namedProfileReady : automaticRouteReady;
  const automaticSource = doctorReady ? "doctor" : poolRouteReady ? "account_pool_profile" : null;
  return {
    automaticRouteReady,
    requiredRouteReady,
    automaticSource,
    requiredSource: requiredRouteReady
      ? harnessId === "agy"
        ? "named_profile"
        : automaticSource
      : null,
    poolNextUp,
  };
}

/** Keep generic phases on automatic routes only. The doctor fallback is for
 * harnesses outside the requested/profile projection (for example optional
 * OpenCode) and for legacy doctor-only state. */
export function automaticBatteryHarnesses(harnessIds, readinessByHarness, doctorReports = {}) {
  return harnessIds.filter(
    (harnessId) =>
      readinessByHarness?.[harnessId]?.automaticRouteReady === true ||
      (readinessByHarness?.[harnessId] === undefined &&
        doctorReports?.[harnessId]?.status === "ok"),
  );
}

/** Default rows need an automatic route. Explicit named rows are independent
 * and need only their selected profile's available+passed readiness. */
export function nativeBatteryRowReady({ defaultHarnessReady, requiresProfile, profileEntry }) {
  return requiresProfile ? batteryProfileReady(profileEntry) : defaultHarnessReady === true;
}

/** First-party harnesses whose readonly promise the battery must exercise.
 * Agy routes only through named accounts, so its row pins the named profile. */
export const READONLY_CAPABILITY_HARNESSES = ["codex", "claude", "cursor", "agy"];

/** Readonly keeps what its callers rely on: reading files outside the project
 * and listing a directory there. A write-denial probe and an echo prompt both
 * passed while agy plan mode refused every outside read (claudexor#525), so a
 * row asks for content only a real outside read can produce. */
export function readonlyCapabilityRows(named = {}) {
  return READONLY_CAPABILITY_HARNESSES.map((harness) => {
    const requiresProfile = harness === "agy";
    return {
      id: `${harness}-${requiresProfile ? "named" : "default"}-readonly-capability`,
      name: `${harness[0].toUpperCase()}${harness.slice(1)} readonly reads outside the project`,
      harness,
      access: "readonly",
      ...(requiresProfile
        ? { profileId: named[harness]?.profile?.profile_id, requiresProfile: true }
        : {}),
    };
  });
}

/** One row's outside facts: a random secret word and three to six files whose
 * names are random lowercase letters. The word, the count and the
 * alphabetically first name each come only from a real read or listing. */
export function readonlyCapabilityFixture() {
  // randomInt draws each letter uniformly; a byte modulo 26 would favour a-v.
  const letters = (length) =>
    Array.from({ length }, () => String.fromCharCode(97 + randomInt(26))).join("");
  const names = new Set();
  const count = randomInt(3, 7);
  while (names.size < count) names.add(`entry-${letters(8)}.txt`);
  const listing = [...names];
  return {
    word: `word-${randomBytes(4).toString("hex")}`,
    listing,
    fileCount: listing.length,
    firstName: [...listing].sort()[0],
  };
}

/** The probe prompt: a secret word in a file outside the project, the number of
 * files in an outside directory and the alphabetically first of their names. */
export function readonlyCapabilityPrompt({ secretPath, listingDir }) {
  return (
    `Read the file ${secretPath}, which is outside this project, and list the files in the ` +
    `directory ${listingDir}. Do not edit anything. Answer in one line exactly: ` +
    "WORD=<the secret word>; FILES=<number of files>; FIRST=<alphabetically first file name>."
  );
}

/** The run body of one capability row: an Ask run with readonly access. It
 * carries no reviewerModels, which only Agent runs accept: the shared run-start
 * admission answers such a body with HTTP 400 before any harness starts. */
export function readonlyCapabilityRequest({ row, prompt, projectRoot, modelId, maxUsd }) {
  return {
    prompt,
    mode: "ask",
    scope: { kind: "project", root: projectRoot },
    harnesses: [row.harness],
    primaryHarness: row.harness,
    access: "readonly",
    ...(row.profileId ? { credentialProfileId: row.profileId } : {}),
    ...(modelId ? { model: modelId } : {}),
    web: "auto",
    effort: "low",
    paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
    maxSeconds: 15 * 60,
  };
}

/** The one value after `KEY=`, or undefined when the key is missing or given
 * twice. Wrapping quotes, backticks or asterisks and a closing period or comma
 * are formatting, not part of the value. */
function answerValue(text, key) {
  const values = [...text.matchAll(new RegExp(`\\b${key}\\s*=\\s*([^\\s;]+)`, "g"))].map((match) =>
    match[1]
      .replace(/[.,]+$/, "")
      .replace(/^[`'"*]+|[`'"*]+$/g, "")
      .replace(/[.,]+$/, ""),
  );
  return values.length === 1 ? values[0] : undefined;
}

/** All three facts must match; an answer that never read or listed cannot hold
 * them. The count is a plain integer given once (FILES=4.5 or two counts fail)
 * and FIRST is the exact name, so a guessed count alone never passes. */
export function evaluateReadonlyCapabilityAnswer(answer, { word, fileCount, firstName }) {
  const text = typeof answer === "string" ? answer : "";
  const files = answerValue(text, "FILES");
  return {
    wordFound: text.includes(word),
    filesMatch: files !== undefined && /^\d+$/.test(files) && Number(files) === fileCount,
    firstMatch: typeof firstName === "string" && answerValue(text, "FIRST") === firstName,
  };
}

function sqlitePrimary(path) {
  return /(?:\.db|\.sqlite|state\.vscdb)$/i.test(path);
}

function sqliteSidecarPrimary(path) {
  if (!/-(?:wal|shm)$/i.test(path)) return null;
  const primary = path.replace(/-(?:wal|shm)$/i, "");
  return sqlitePrimary(primary) ? primary : null;
}

function regularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Find a real SQLite primary plus its WAL/SHM sidecar in a Cursor profile.
 * Native Cursor state is searched before unrelated HOME content, then the
 * wider profile is retained as a bounded compatibility fallback. This avoids
 * the old arbitrary first-8k-files result on production profiles containing
 * tens of thousands of repository/transcript files. */
function cursorSqliteState(profileRoot, maxEntries) {
  const preferredRoots = [
    join(profileRoot, ".cursor", "chats"),
    join(profileRoot, ".cursor"),
    profileRoot,
  ];
  const visitedDirs = new Set();
  const primaryFiles = new Set();
  const sidecarFiles = new Map();
  let entriesVisited = 0;

  for (const searchRoot of preferredRoots) {
    if (!existsSync(searchRoot)) continue;
    const pending = [searchRoot];
    while (pending.length > 0 && entriesVisited < maxEntries) {
      const dir = pending.pop();
      if (visitedDirs.has(dir)) continue;
      visitedDirs.add(dir);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch {
        continue;
      }
      const childDirs = [];
      for (const entry of entries) {
        if (entriesVisited >= maxEntries) break;
        entriesVisited += 1;
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          childDirs.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        if (sqlitePrimary(path)) primaryFiles.add(path);
        const sidecarPrimary = sqliteSidecarPrimary(path);
        if (sidecarPrimary) sidecarFiles.set(sidecarPrimary, path);
        if (sidecarPrimary && (primaryFiles.has(sidecarPrimary) || regularFile(sidecarPrimary))) {
          return {
            valid: true,
            files: [sidecarPrimary, path],
            entriesVisited,
            exhausted: false,
          };
        }
        if (sqlitePrimary(path) && sidecarFiles.has(path)) {
          return {
            valid: true,
            files: [path, sidecarFiles.get(path)],
            entriesVisited,
            exhausted: false,
          };
        }
      }
      for (let index = childDirs.length - 1; index >= 0; index -= 1) {
        pending.push(childDirs[index]);
      }
    }
    if (entriesVisited >= maxEntries) break;
  }
  return {
    valid: false,
    files: [],
    entriesVisited,
    exhausted: entriesVisited >= maxEntries,
  };
}

export function canonicalBatteryProfileState(entry, harnessId, { maxEntries = 100_000 } = {}) {
  const locator = entry?.profile?.isolation_locator;
  if (typeof locator !== "string") {
    return { valid: harnessId === "agy", locator: null, files: [] };
  }
  try {
    const absolute = resolve(locator);
    const stat = lstatSync(absolute);
    const canonical =
      stat.isDirectory() && !stat.isSymbolicLink() && realpathSync.native(absolute) === absolute;
    if (!canonical || harnessId !== "cursor") {
      return { valid: canonical, locator: absolute, files: [] };
    }
    const state = cursorSqliteState(absolute, maxEntries);
    return {
      valid: state.valid,
      locator: absolute,
      files: state.files.map((path) => relative(absolute, path)),
      scan: { entriesVisited: state.entriesVisited, exhausted: state.exhausted, maxEntries },
    };
  } catch {
    return { valid: false, locator, files: [] };
  }
}

const preferredBatteryModels = {
  codex: ["gpt-5.3-codex-spark", "gpt-5.3-codex-low"],
  claude: ["claude-haiku-4-5", "haiku"],
  cursor: ["gpt-5.3-codex-low", "gpt-5.6-sol-low"],
  agy: ["gpt-oss-120b-medium", "gemini-3.7-flash-low", "gemini-3.6-flash-low"],
  opencode: [],
};

export function selectRealHarnessBatteryModel(harnessId, catalogIds) {
  const ids = catalogIds.filter((id) => typeof id === "string");
  for (const wanted of preferredBatteryModels[harnessId] ?? []) {
    const exact = ids.find((id) => id === wanted);
    if (exact) return { id: exact, source: "preferred", catalog: ids };
    const alias = ids.find((id) => id.toLowerCase().includes(wanted.toLowerCase()));
    if (alias) return { id: alias, source: "preferred_alias", catalog: ids };
  }
  const cheapPattern =
    harnessId === "claude" ? /haiku/i : /(gpt-oss|haiku|flash|mini|spark|codex.*low|low.*codex)/i;
  const cheap = ids.find((id) => cheapPattern.test(id));
  return {
    id: cheap ?? null,
    source: cheap ? "cheapest_catalog_fallback" : "native_default",
    catalog: ids,
  };
}

const batteryTaskVerbs = new Set(["agent", "ask", "best-of", "create", "plan", "run"]);
const batteryMutatingTaskVerbs = new Set(["agent", "best-of", "create", "run"]);
const cheapBatteryReviewerModels = Object.freeze({
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.4-mini",
});
const cheapBatteryReviewerModelFlag = Object.entries(cheapBatteryReviewerModels)
  .map(([family, model]) => `${family}=${model}`)
  .join(",");

function cliFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] : null;
}

function reviewerModelFlagIsCheap(value) {
  const entries = Object.fromEntries(
    value.split(",").map((entry) => {
      const splitAt = entry.indexOf("=");
      return splitAt > 0
        ? [entry.slice(0, splitAt).trim(), entry.slice(splitAt + 1).trim()]
        : [entry.trim(), ""];
    }),
  );
  return (
    Object.keys(entries).length === Object.keys(cheapBatteryReviewerModels).length &&
    Object.entries(cheapBatteryReviewerModels).every(([family, model]) => entries[family] === model)
  );
}

export function batteryReviewerModels() {
  return { ...cheapBatteryReviewerModels };
}

/** Stamp direct Control API bodies with the same cheap cross-family review
 * models. Existing conflicting choices fail rather than silently spending a
 * forbidden Fable/Spark route. */
export function withBatteryReviewerModels(input) {
  if (
    input?.reviewerModels !== undefined &&
    !isDeepStrictEqual(input.reviewerModels, cheapBatteryReviewerModels)
  ) {
    throw new Error("real-harness battery refuses non-smoke reviewer models");
  }
  return { ...input, reviewerModels: batteryReviewerModels() };
}

export function batteryReviewerPanelEntry(harnessId) {
  if (harnessId === "claude") return "claude=claude-haiku-4-5:low";
  if (harnessId === "codex") return "codex=gpt-5.4-mini:low";
  if (harnessId === "cursor") return "cursor=gpt-5.3-codex-low:low";
  return harnessId;
}

/** Make every mutating CLI task explicit about cheap non-Fable/non-Spark
 * reviewer models, and every task that can route through Claude explicit
 * about Haiku. For a mixed pool the scalar task model is bound to an explicit
 * Claude primary, leaving sibling harness task models intact. */
export function withExplicitBatteryModels(args, selectModel) {
  if (!batteryTaskVerbs.has(args[0])) return args;
  let routed = args;
  if (batteryMutatingTaskVerbs.has(args[0])) {
    const reviewerModels = cliFlagValue(args, "--reviewer-model");
    if (reviewerModels && !reviewerModelFlagIsCheap(reviewerModels)) {
      throw new Error("real-harness battery refuses non-smoke reviewer models");
    }
    if (!reviewerModels) {
      routed = [...routed, "--reviewer-model", cheapBatteryReviewerModelFlag];
    }
  }
  const harnesses = (cliFlagValue(args, "--harness") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!harnesses.includes("claude")) return routed;

  const explicitModel = cliFlagValue(args, "--model");
  if (explicitModel) {
    if (/fable/i.test(explicitModel) || explicitModel.toLowerCase() === "best") {
      throw new Error(`real-harness battery refuses unsafe Claude model alias: ${explicitModel}`);
    }
    return routed;
  }

  const selected = selectModel("claude");
  if (!selected?.id || !/haiku/i.test(selected.id)) {
    throw new Error("real-harness battery requires an explicit catalog-backed Claude Haiku model");
  }
  if (harnesses.length === 1) return [...routed, "--model", selected.id];

  const primary = cliFlagValue(args, "--primary-harness");
  if (primary && primary !== "claude") {
    throw new Error(
      `real-harness battery cannot bind Claude Haiku while primary harness is ${primary}`,
    );
  }
  return [...routed, ...(primary ? [] : ["--primary-harness", "claude"]), "--model", selected.id];
}

/** Consume a public adapter run far enough to prove an unsupported access
 * profile refuses before any adapter event. The battery pairs this typed/event
 * assertion with a sentinel executable so no-spawn is independently observable. */
export async function probeHarnessAccessRefusal({ adapter, spec, wantedCode }) {
  let eventsEmitted = 0;
  try {
    for await (const _event of adapter.run(spec)) eventsEmitted += 1;
  } catch (error) {
    const code = error && typeof error === "object" ? (error.code ?? null) : null;
    return {
      valid: code === wantedCode && eventsEmitted === 0,
      code,
      errorName: error instanceof Error ? error.name : null,
      eventsEmitted,
    };
  }
  return { valid: false, code: null, errorName: null, eventsEmitted };
}

/** Accept only the canonical top-level convergence preflight refusal. Searching
 * the whole JSON for `review` is invalid because every RunFacts receipt carries
 * a `review` field, including unrelated routing failures. */
export function isCrossFamilyConvergenceRefusal(result) {
  const message = result?.json?.error ?? result?.json?.summary;
  return Boolean(
    result?.code !== 0 &&
    result?.json?.status === "failed" &&
    typeof message === "string" &&
    message.startsWith("convergence requires a cross-family clean review ("),
  );
}

/** Discover every required-harness attempt that reached either admission or a
 * raw harness event in the canonical top-level run journal. */
export function relevantRunAttemptKeys(events, requiredHarnesses) {
  const required = new Set(requiredHarnesses);
  const attempts = new Map();
  for (const event of events) {
    if (event?.type !== "harness.started" && event?.type !== "harness.event") continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || !required.has(payload.harness_id)) continue;
    const key = `${payload.harness_id}\0${typeof payload.attempt_id}:${String(payload.attempt_id)}`;
    attempts.set(key, {
      harnessId: payload.harness_id,
      attemptId: payload.attempt_id,
    });
  }
  return [...attempts.values()];
}

/** Normalize every durable route interval/switch. Top-level run projection
 * deliberately omits credential_source, so an exact native/native telemetry
 * anchor may fill only that missing source; event route changes still win. */
export function durableAttemptRouteEvidence(events, sourceAnchor = null) {
  const observed = [];
  let sawStarted = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "started") {
      sawStarted = true;
      observed.push({
        kind: "started",
        authMode:
          event.credential_route === "vendor_native"
            ? "local_session"
            : event.credential_route === "managed_api_key"
              ? "api_key"
              : null,
        authSource:
          typeof event.credential_source === "string"
            ? event.credential_source
            : event.credential_route === "vendor_native" &&
                sourceAnchor?.authMode === "local_session" &&
                sourceAnchor?.authSource === "native_session"
              ? "native_session"
              : null,
      });
      continue;
    }
    if (event.credential_route === "managed_api_key") {
      observed.push({
        kind: "api_route_event",
        authMode: "api_key",
        authSource: typeof event.credential_source === "string" ? event.credential_source : null,
      });
    }
    if (event.type === "message" && event.payload?.auth_switched === true) {
      const toAuthMode = event.payload.to_auth_mode;
      const switchedToNative = toAuthMode === "local_session" || toAuthMode === "subscription";
      observed.push({
        kind: "auth_switched",
        authMode: toAuthMode === "api_key" ? "api_key" : switchedToNative ? "local_session" : null,
        authSource: switchedToNative ? "native_session" : null,
      });
    }
  }
  return { sawStarted, observed };
}

/** Resolve the battery's storage mode before any directory or daemon mutation. */
export function resolveRealHarnessBatteryLayout({
  home,
  sourceRoot,
  defaultBatteryRoot,
  batteryDir,
  requestedConfigDir,
  ambientConfigDir,
}) {
  const canonicalHome = realpathSync.native(resolve(home));
  const canonicalSource = realpathSync.native(resolve(sourceRoot));
  const requested = requestedConfigDir?.trim();
  if (!requested) {
    const batteryRoot = canonicalFuturePath(batteryDir?.trim() || defaultBatteryRoot);
    return {
      mode: "scratch",
      batteryRoot,
      configDir: join(batteryRoot, "config"),
      exportConfigDir: true,
    };
  }

  if (ambientConfigDir?.trim()) {
    throw new Error(
      "CLAUDEXOR_BATTERY_CONFIG_DIR cannot be combined with CLAUDEXOR_CONFIG_DIR; unset the latter",
    );
  }
  if (!isAbsolute(requested)) {
    throw new Error("CLAUDEXOR_BATTERY_CONFIG_DIR must be an absolute path");
  }
  const expectedConfigDir = join(canonicalHome, ".claudexor", "v3");
  const requestedAbsolute = resolve(requested);
  const requestedStat = lstatSync(requestedAbsolute);
  if (
    requestedAbsolute !== expectedConfigDir ||
    requestedStat.isSymbolicLink() ||
    !requestedStat.isDirectory() ||
    realpathSync.native(requestedAbsolute) !== expectedConfigDir
  ) {
    throw new Error(
      `CLAUDEXOR_BATTERY_CONFIG_DIR must be the canonical default config directory ${expectedConfigDir}`,
    );
  }
  if (!batteryDir?.trim() || !isAbsolute(batteryDir.trim())) {
    throw new Error(
      "CLAUDEXOR_BATTERY_DIR must be an explicit absolute path in existing-default mode",
    );
  }
  const batteryRoot = canonicalFuturePath(batteryDir.trim());
  const ownedRoot = join(canonicalHome, ".claudexor");
  if (isWithin(ownedRoot, batteryRoot)) {
    throw new Error("CLAUDEXOR_BATTERY_DIR must be outside the Claudexor runtime tree");
  }
  if (isWithin(canonicalSource, batteryRoot)) {
    throw new Error("CLAUDEXOR_BATTERY_DIR must be outside the Claudexor source checkout");
  }
  return {
    mode: "existing_default",
    batteryRoot,
    configDir: expectedConfigDir,
    // Omitting the override is semantically important: an explicit override
    // would narrow claudexorOwnedRoot() and invalidate existing profile paths.
    exportConfigDir: false,
  };
}

export function snapshotRegularFile(path) {
  if (!existsSync(path)) return { exists: false, bytes: null, digest: null, mode: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`refusing unsafe battery state file: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    exists: true,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    mode: stat.mode & 0o777,
  };
}

export function describeFileSnapshot(snapshot) {
  return {
    exists: snapshot.exists,
    digest: snapshot.digest,
    mode: snapshot.mode,
  };
}

export function assertRegularFileUnchanged(path, before) {
  const after = snapshotRegularFile(path);
  const same =
    before.exists === after.exists &&
    before.mode === after.mode &&
    (before.bytes === null ? after.bytes === null : before.bytes.equals(after.bytes));
  if (!same) throw new Error(`battery changed protected state file: ${path}`);
  return after;
}

function sameFileSnapshot(left, right) {
  return Boolean(
    left &&
    right &&
    left.exists === right.exists &&
    left.mode === right.mode &&
    (left.bytes === null
      ? right.bytes === null
      : Buffer.isBuffer(right.bytes) && left.bytes.equals(right.bytes)),
  );
}

function parseSnapshot(snapshot, label, parser) {
  if (!snapshot?.exists || !Buffer.isBuffer(snapshot.bytes)) {
    throw new Error(`${label} is missing`);
  }
  try {
    return parser(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function migrationFile(snapshot, migrationSchema, label) {
  if (!snapshot?.exists) return {};
  const raw = parseSnapshot(snapshot, label, JSON.parse);
  const parsed = migrationSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${label} does not match AccountsUnifiedMigrationFile`);
  return parsed.data;
}

function globalConfig(snapshot, raw, globalConfigSchema, label) {
  if (!snapshot?.exists || !Buffer.isBuffer(snapshot.bytes)) throw new Error(`${label} is missing`);
  const parsed = globalConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${label} does not match GlobalConfig`);
  return parsed.data;
}

function matchingMigrationProfile(config, harnessId, record) {
  return config.credential_profiles.find(
    (profile) =>
      profile.harness_id === harnessId &&
      profile.profile_id === record.row_id &&
      profile.credential_kind === "config_dir_login" &&
      profile.isolation_locator === record.locator &&
      profile.secret_ref === null,
  );
}

/** Validate the narrowly permitted first-start mutation in existing-default
 * mode. This is deliberately filesystem-free: callers supply immutable file
 * snapshots plus the referenced backup snapshots, so every transition can be
 * reproduced deterministically in unit tests. */
export function validateExistingDefaultStartupTransition({
  configBefore,
  migrationBefore,
  configAfter,
  migrationAfter,
  configBeforeValue,
  configAfterValue,
  backupSnapshots = {},
  globalConfigSchema,
  migrationSchema,
}) {
  const beforeConfig = globalConfig(
    configBefore,
    configBeforeValue,
    globalConfigSchema,
    "config before startup",
  );
  const afterConfig = globalConfig(
    configAfter,
    configAfterValue,
    globalConfigSchema,
    "config after startup",
  );
  const beforeMigration = migrationFile(
    migrationBefore,
    migrationSchema,
    "accounts migration before startup",
  );
  const afterMigration = migrationFile(
    migrationAfter,
    migrationSchema,
    "accounts migration after startup",
  );

  if (configBefore.mode !== configAfter.mode) {
    throw new Error("startup changed config.yaml mode");
  }
  if (migrationBefore.exists && migrationBefore.mode !== migrationAfter.mode) {
    throw new Error("startup changed accounts-unified.json mode");
  }
  if (!migrationBefore.exists && migrationAfter.exists && migrationAfter.mode !== 0o600) {
    throw new Error("startup created accounts-unified.json with a non-private mode");
  }

  const validatedRows = [];
  for (const [harnessId, record] of Object.entries(afterMigration)) {
    if (record.phase !== "completed") {
      throw new Error(`accounts migration for ${harnessId} is incomplete (${record.phase})`);
    }
    if (!matchingMigrationProfile(afterConfig, harnessId, record)) {
      throw new Error(
        `accounts migration for ${harnessId} has no matching config_dir_login profile`,
      );
    }
    if (typeof record.backup_ref !== "string" || record.backup_ref.length === 0) {
      throw new Error(`accounts migration for ${harnessId} has no backup_ref`);
    }
    validatedRows.push({
      harnessId,
      rowId: record.row_id,
      locator: record.locator,
      backupRef: record.backup_ref,
    });
  }

  for (const [harnessId, record] of Object.entries(beforeMigration)) {
    if (record.phase !== "completed") {
      throw new Error(`pre-start accounts migration for ${harnessId} is incomplete`);
    }
    if (!isDeepStrictEqual(afterMigration[harnessId], record)) {
      throw new Error(`startup changed an existing accounts migration record for ${harnessId}`);
    }
  }

  const configSame = sameFileSnapshot(configBefore, configAfter);
  const migrationSame = sameFileSnapshot(migrationBefore, migrationAfter);
  if (configSame && migrationSame) {
    return {
      classification: "already_migrated_unchanged",
      validatedRows,
    };
  }

  const { credential_profiles: beforeProfiles, ...beforeRest } = beforeConfig;
  const { credential_profiles: afterProfiles, ...afterRest } = afterConfig;
  if (!isDeepStrictEqual(beforeRest, afterRest)) {
    throw new Error("startup changed config fields outside credential_profiles");
  }
  if (
    afterProfiles.length < beforeProfiles.length ||
    !isDeepStrictEqual(afterProfiles.slice(0, beforeProfiles.length), beforeProfiles)
  ) {
    throw new Error("startup changed or reordered existing credential profiles");
  }
  const appendedProfiles = afterProfiles.slice(beforeProfiles.length);
  const addedRecords = Object.entries(afterMigration).filter(
    ([harnessId]) => beforeMigration[harnessId] === undefined,
  );
  if (appendedProfiles.length === 0 || appendedProfiles.length !== addedRecords.length) {
    throw new Error("startup migration rows and appended credential profiles do not match");
  }

  for (const [harnessId, record] of addedRecords) {
    const recordIndex = addedRecords.findIndex(([candidate]) => candidate === harnessId);
    const profile = appendedProfiles[recordIndex];
    if (
      !profile ||
      profile.harness_id !== harnessId ||
      profile.profile_id !== record.row_id ||
      profile.credential_kind !== "config_dir_login" ||
      profile.isolation_locator !== record.locator ||
      profile.secret_ref !== null
    ) {
      throw new Error(`new migration row/profile mismatch for ${harnessId}`);
    }
    const backup = backupSnapshots[record.backup_ref];
    if (!backup?.exists || !Buffer.isBuffer(backup.bytes)) {
      throw new Error(`accounts migration backup is missing for ${harnessId}`);
    }
    if (backup.mode !== configBefore.mode) {
      throw new Error(`accounts migration backup mode does not match config for ${harnessId}`);
    }
    const backupConfig = globalConfig(
      backup,
      backup.value,
      globalConfigSchema,
      `accounts migration backup for ${harnessId}`,
    );
    const { credential_profiles: backupProfiles, ...backupRest } = backupConfig;
    if (
      !isDeepStrictEqual(backupRest, beforeRest) ||
      !isDeepStrictEqual(backupProfiles, [
        ...beforeProfiles,
        ...appendedProfiles.slice(0, recordIndex),
      ])
    ) {
      throw new Error(`accounts migration backup does not match config chain for ${harnessId}`);
    }
    if (recordIndex === 0 && !backup.bytes.equals(configBefore.bytes)) {
      throw new Error(`first accounts migration backup is not byte-identical to pre-start config`);
    }
  }

  return {
    classification: "one_time_accounts_unified_migration",
    validatedRows: validatedRows.filter((row) => beforeMigration[row.harnessId] === undefined),
  };
}

/** The second identity-bound startup has no migration authority at all. */
export function assertExistingDefaultSecondStartupStable({
  configAfterFirst,
  migrationAfterFirst,
  configAfterSecond,
  migrationAfterSecond,
}) {
  if (!sameFileSnapshot(configAfterFirst, configAfterSecond)) {
    throw new Error("second startup changed config.yaml bytes or mode");
  }
  if (!sameFileSnapshot(migrationAfterFirst, migrationAfterSecond)) {
    throw new Error("second startup changed accounts-unified.json bytes or mode");
  }
  return {
    config: describeFileSnapshot(configAfterSecond),
    migration: describeFileSnapshot(migrationAfterSecond),
  };
}
