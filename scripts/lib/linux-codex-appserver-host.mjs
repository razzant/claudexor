/** Host-side effects of the Linux Codex app-server probe outside any cell: recorded process
 * runs, sysctl and file reads, the host facts, the verified Codex install in the managed npm
 * layout, and the pinned distro profile file. scripts/linux-codex-appserver-probe.mjs wires
 * them into the phases. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DISTRO_PROFILE, profileNames } from "./apparmor-profile-control.mjs";
import {
  CODEX_PIN,
  digestMismatches,
  RECORDED_SYSCTLS,
  TARGET_TRIPLE,
} from "./linux-codex-appserver-phases.mjs";
import { isExecutableFile } from "./linux-codex-appserver-worker.mjs";

const TOOL_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" };

/** Runs a process and keeps complete argv, env, stdout and stderr as `<dir>/<name>.*`. */
export function recorded(
  dir,
  name,
  file,
  args,
  { cwd = "/", env = TOOL_ENV, timeoutMs = 120_000 } = {},
) {
  const started = Date.now();
  const result = spawnSync(file, args, {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const record = {
    argv: [file, ...args],
    cwd,
    env,
    timeoutMs,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.code ?? result.error.message) : null,
    ms: Date.now() - started,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, `${name}.stdout`), result.stdout ?? "");
  writeFileSync(join(dir, `${name}.stderr`), result.stderr ?? "");
  return { ...record, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function tryValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export function readSysctls() {
  return Object.fromEntries(
    RECORDED_SYSCTLS.map((name) => [
      name,
      tryValue(() => readFileSync(`/proc/sys/${name.replaceAll(".", "/")}`, "utf8").trim()),
    ]),
  );
}

export function fileState(path) {
  const stat = tryValue(() => lstatSync(path));
  if (!stat) return { exists: false };
  const type = stat.isFile()
    ? "file"
    : stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "other";
  return {
    exists: true,
    type,
    sha256: type === "file" ? tryValue(() => sha256(readFileSync(path))) : null,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function firstBwrap(pathValue) {
  const dir = pathValue.split(":").find((entry) => entry && isExecutableFile(join(entry, "bwrap")));
  return dir
    ? { path: join(dir, "bwrap"), realpath: tryValue(() => realpathSync(join(dir, "bwrap"))) }
    : null;
}

export function hostFacts(dir, managedPath) {
  const run = (name, file, args) => recorded(dir, name, file, args);
  run("os-release", "cat", ["/etc/os-release"]);
  run("uname", "uname", ["-a"]);
  run("packages", "dpkg-query", ["-W", "bubblewrap", "apparmor", "apparmor-profiles", "systemd"]);
  run("apparmor-parser-version", "/usr/sbin/apparmor_parser", ["--version"]);
  run("apparmor-d", "ls", ["-la", "/etc/apparmor.d"]);
  const selected = firstBwrap(managedPath);
  if (selected) run("selected-bwrap-version", selected.path, ["--version"]);
  return {
    kernel: run("uname-r", "uname", ["-r"]).stdout.trim() || null,
    sysctl: readSysctls(),
    managedPath,
    selectedBwrap: selected,
    user: {
      name: run("id-un", "id", ["-un"]).stdout.trim(),
      group: run("id-gn", "id", ["-gn"]).stdout.trim(),
    },
  };
}

/** The npm global layout the managed installer produces (`<prefix>/bin/codex` ->
 * lib/node_modules/@openai/codex/bin/codex.js), from integrity- and digest-checked bytes. */
export async function installCodex(prefix, dir) {
  rmSync(prefix, { recursive: true, force: true });
  const pkg = join(prefix, "lib", "node_modules", "@openai", "codex");
  const platformPkg = join(pkg, "node_modules", "@openai", "codex-linux-x64");
  const receipt = { version: CODEX_PIN.version, tarballs: [] };
  for (const [name, tarball, target] of [
    ["main", CODEX_PIN.main, pkg],
    ["linux-x64", CODEX_PIN.linux, platformPkg],
  ]) {
    const response = await fetch(tarball.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`GET ${tarball.url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    receipt.tarballs.push({
      url: tarball.url,
      bytes: bytes.length,
      integrity,
      pinned: tarball.integrity,
    });
    json(join(dir, "install.json"), receipt);
    if (integrity !== tarball.integrity) throw new Error(`${tarball.url} integrity is not pinned`);
    mkdirSync(target, { recursive: true });
    const archive = join(prefix, `${name}.tgz`);
    writeFileSync(archive, bytes);
    const tar = recorded(
      dir,
      `tar-${name}`,
      "tar",
      ["-xzf", archive, "-C", target, "--strip-components=1", "--no-same-owner"],
      { timeoutMs: 300_000 },
    );
    if (tar.status !== 0) throw new Error(`tar ${name} exited ${tar.status}`);
    rmSync(archive);
  }
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin", "codex"));
  const vendor = join(platformPkg, "vendor", TARGET_TRIPLE);
  const paths = {
    launcher: join(pkg, "bin", "codex.js"),
    codex: join(vendor, "bin", "codex"),
    bwrap: join(vendor, "codex-resources", "bwrap"),
  };
  receipt.paths = paths;
  receipt.sha256 = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, sha256(readFileSync(path))]),
  );
  json(join(dir, "install.json"), receipt);
  const mismatches = digestMismatches(receipt.sha256);
  if (mismatches.length) throw new Error(mismatches.join("; "));
  return { prefix, paths, receipt };
}

/** The exact packaged profile file: the pinned .deb from the Ubuntu archive, extracted
 * (not installed), its member checked against the pinned digest. */
export async function fetchDistroProfile(dir) {
  const receipt = { ...DISTRO_PROFILE };
  receipt.attempts = [];
  let deb = null;
  for (const url of DISTRO_PROFILE.debUrls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) }).catch((error) => ({
      ok: false,
      status: String(error?.message ?? error),
    }));
    receipt.attempts.push({ url, status: response.status });
    if (!response.ok) continue;
    deb = Buffer.from(await response.arrayBuffer());
    receipt.debUrl = url;
    break;
  }
  if (!deb)
    throw new Error(`apparmor-profiles .deb unavailable: ${JSON.stringify(receipt.attempts)}`);
  receipt.observedDebSha256 = sha256(deb);
  json(join(dir, "receipt.json"), receipt);
  if (receipt.observedDebSha256 !== DISTRO_PROFILE.debSha256)
    throw new Error("apparmor-profiles .deb sha256 is not pinned");
  const debFile = join(dir, "apparmor-profiles.deb");
  writeFileSync(debFile, deb);
  const extracted = recorded(dir, "dpkg-deb-extract", "dpkg-deb", [
    "-x",
    debFile,
    join(dir, "extracted"),
  ]);
  if (extracted.status !== 0) throw new Error(`dpkg-deb -x exited ${extracted.status}`);
  const bytes = readFileSync(join(dir, "extracted", DISTRO_PROFILE.member));
  receipt.observedSha256 = sha256(bytes);
  json(join(dir, "receipt.json"), receipt);
  if (receipt.observedSha256 !== DISTRO_PROFILE.sha256)
    throw new Error("bwrap-userns-restrict sha256 is not pinned");
  const file = join(dir, "bwrap-userns-restrict");
  writeFileSync(file, bytes);
  return { file, names: profileNames(bytes.toString("utf8")), receipt };
}
