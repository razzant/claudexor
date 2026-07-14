import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  process.stdout.write("process-identity helper: non-Darwin build skipped\n");
  process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "native", "claudexor-process-identity.c");
const output = resolve(packageRoot, "dist", "native", "claudexor-process-identity");
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
rmSync(temporary, { force: true });

const compile = spawnSync(
  "/usr/bin/xcrun",
  [
    "clang",
    "-std=c11",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=13.0",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    source,
    "-o",
    temporary,
  ],
  { encoding: "utf8" },
);
if (compile.status !== 0) {
  rmSync(temporary, { force: true });
  process.stderr.write(compile.stderr || "failed to compile Darwin process identity helper\n");
  process.exit(1);
}

chmodSync(temporary, 0o755);
const sign = spawnSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "--timestamp=none", temporary],
  { encoding: "utf8" },
);
if (sign.status !== 0) {
  rmSync(temporary, { force: true });
  process.stderr.write(sign.stderr || "failed to ad-hoc sign Darwin process identity helper\n");
  process.exit(1);
}

const architectures = spawnSync("/usr/bin/lipo", ["-archs", temporary], { encoding: "utf8" });
const archSet = new Set((architectures.stdout ?? "").trim().split(/\s+/).filter(Boolean));
if (architectures.status !== 0 || !archSet.has("arm64") || !archSet.has("x86_64")) {
  rmSync(temporary, { force: true });
  process.stderr.write(
    `process identity helper is not universal: ${architectures.stdout || architectures.stderr}\n`,
  );
  process.exit(1);
}

const probe = spawnSync(temporary, ["--pid", String(process.pid)], {
  encoding: "utf8",
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
});
const fields = (probe.stdout ?? "").trimEnd().split("\t");
if (
  probe.status !== 0 ||
  fields.length !== 5 ||
  fields[0] !== "claudexor-process-identity-v2" ||
  fields[1] !== String(process.pid) ||
  !/^[1-9][0-9]*$/.test(fields[2] ?? "") ||
  !/^(0|[1-9][0-9]*)$/.test(fields[3] ?? "") ||
  !/^[0-9]{6}$/.test(fields[4] ?? "")
) {
  rmSync(temporary, { force: true });
  process.stderr.write(probe.stderr || "process identity helper returned malformed smoke output\n");
  process.exit(1);
}

renameSync(temporary, output);
chmodSync(output, 0o755);
process.stdout.write(`process-identity helper: built universal binary at ${output}\n`);
